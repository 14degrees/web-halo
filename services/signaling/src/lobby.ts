import { DurableObject } from "cloudflare:workers";

/* The public lobby directory: one singleton Durable Object that lists the
   public rooms quick join may seat a player in.

   Rooms publish their own entries (creation, every membership change, renewal
   and expiry), so the directory holds only presentation and ranking data. It
   never holds a capability: a listed room is joined through the room object,
   which mints a ticket-less guest session only for a public room. A stale
   entry therefore costs a failed attempt, never an unauthorised join. */

export const LOBBY_DIRECTORY_NAME = "public";

/* A freshly created room whose host has not opened its socket yet is still
   offered, so two players who click within the same second meet. */
const HOST_CONNECT_GRACE_MS = 60_000;
/* Entries that stop being refreshed (a room object lost without its alarm)
   drop out after this long without an update. */
const STALE_ENTRY_MS = 3 * 60 * 60 * 1_000;

/* Who is in a room, for the public lobby's player list: display names and
   armor styles only, at most LOBBY_NAMES_LIMIT of them. */
export interface LobbyPlayer {
  host: boolean;
  name: string;
  style: string;
}

export const LOBBY_NAMES_LIMIT = 16;

export interface LobbyEntry {
  buildId: string;
  capacity: number;
  createdAt: number;
  dedicated: boolean;
  expiresAt: number;
  hostConnected: boolean;
  mapIndex: number | null;
  modeIndex: number | null;
  names: LobbyPlayer[];
  players: number;
  protocolVersion: number;
  roomId: string;
}

interface LobbyRow extends Record<string, SqlStorageValue> {
  build_id: string;
  capacity: number;
  created_at: number;
  dedicated: number;
  expires_at: number;
  host_connected: number;
  map_index: number | null;
  mode_index: number | null;
  names: string | null;
  players: number;
  protocol_version: number;
  room_id: string;
}

function parseNames(value: string | null): LobbyPlayer[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as LobbyPlayer[]).slice(0, LOBBY_NAMES_LIMIT) : [];
  } catch {
    return [];
  }
}

function entryFromRow(row: LobbyRow): LobbyEntry {
  return {
    buildId: row.build_id,
    capacity: row.capacity,
    createdAt: row.created_at,
    dedicated: row.dedicated === 1,
    expiresAt: row.expires_at,
    hostConnected: row.host_connected === 1,
    mapIndex: row.map_index,
    modeIndex: row.mode_index,
    names: parseNames(row.names),
    players: row.players,
    protocolVersion: row.protocol_version,
    roomId: row.room_id,
  };
}

export class LobbyDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initializeStorage();
  }

  private initializeStorage(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS lobbies (
        room_id TEXT PRIMARY KEY,
        build_id TEXT NOT NULL,
        protocol_version INTEGER NOT NULL,
        capacity INTEGER NOT NULL,
        players INTEGER NOT NULL,
        host_connected INTEGER NOT NULL,
        dedicated INTEGER NOT NULL,
        map_index INTEGER,
        mode_index INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS lobbies_build ON lobbies(build_id, expires_at);
    `);
    /* Added after the first deployment. */
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(lobbies)")
      .toArray()
      .map(({ name }) => name);
    if (!columns.includes("names")) {
      this.ctx.storage.sql.exec("ALTER TABLE lobbies ADD COLUMN names TEXT");
    }
  }

  async upsert(entry: LobbyEntry, now: number): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO lobbies (
         room_id, build_id, protocol_version, capacity, players, host_connected,
         dedicated, map_index, mode_index, created_at, expires_at, updated_at, names
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(room_id) DO UPDATE SET
         capacity = excluded.capacity,
         players = excluded.players,
         host_connected = excluded.host_connected,
         dedicated = excluded.dedicated,
         map_index = excluded.map_index,
         mode_index = excluded.mode_index,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at,
         names = excluded.names`,
      entry.roomId,
      entry.buildId,
      entry.protocolVersion,
      entry.capacity,
      entry.players,
      entry.hostConnected ? 1 : 0,
      entry.dedicated ? 1 : 0,
      entry.mapIndex,
      entry.modeIndex,
      entry.createdAt,
      entry.expiresAt,
      now,
      JSON.stringify(entry.names.slice(0, LOBBY_NAMES_LIMIT)),
    );
    await this.scheduleSweep(now);
  }

  async remove(roomId: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM lobbies WHERE room_id = ?", roomId);
  }

  /* Open rooms for this build, best first: a dedicated host before a player's
     browser, then the fullest, then the oldest. */
  async candidates(
    buildId: string,
    protocolVersion: number,
    now: number,
    limit = 8,
  ): Promise<LobbyEntry[]> {
    this.prune(now);
    return this.ctx.storage.sql
      .exec<LobbyRow>(
        `SELECT room_id, build_id, protocol_version, capacity, players,
                host_connected, dedicated, map_index, mode_index, created_at,
                expires_at, names
           FROM lobbies
          WHERE build_id = ? AND protocol_version = ?
            AND players < capacity
            AND (host_connected = 1 OR created_at > ?)
          ORDER BY dedicated DESC, players DESC, created_at ASC
          LIMIT ?`,
        buildId,
        protocolVersion,
        now - HOST_CONNECT_GRACE_MS,
        Math.max(1, Math.min(limit, 32)),
      )
      .toArray()
      .map(entryFromRow);
  }

  async list(now: number): Promise<LobbyEntry[]> {
    this.prune(now);
    return this.ctx.storage.sql
      .exec<LobbyRow>(
        `SELECT room_id, build_id, protocol_version, capacity, players,
                host_connected, dedicated, map_index, mode_index, created_at,
                expires_at, names
           FROM lobbies ORDER BY dedicated DESC, players DESC, created_at ASC`,
      )
      .toArray()
      .map(entryFromRow);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    this.prune(now);
    await this.scheduleSweep(now);
  }

  private prune(now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM lobbies WHERE expires_at <= ? OR updated_at <= ?",
      now,
      now - STALE_ENTRY_MS,
    );
  }

  private async scheduleSweep(now: number): Promise<void> {
    const next = this.ctx.storage.sql
      .exec<{ next: number | null }>("SELECT MIN(expires_at) AS next FROM lobbies")
      .one().next;
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const existing = await this.ctx.storage.getAlarm();
    const when = Math.max(now + 1_000, next);
    if (existing === null || existing > when) {
      await this.ctx.storage.setAlarm(when);
    }
  }
}
