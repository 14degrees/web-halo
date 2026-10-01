import { DurableObject } from "cloudflare:workers";

import { randomToken } from "./crypto";

/* The matchmaker: one singleton Durable Object that queues players, groups
   them into matches, and gives each match a dedicated server from the pool.
   It handles one request at a time, so no ticket or server can ever land in
   two matches.

   A player's browser holds a ticket and polls it about once a second; the
   poll keeps the ticket alive. Servers (services/game-server, pool mode)
   register, then heartbeat every two seconds; a heartbeat is also how a
   server learns its assignment. The life of a match:

     assigning  a server and players are chosen; the server is opening a
                private room for them
     ready      the room is open; the players' polls return its invite
     ended      the server reported the end (finished or void)

   A server that stops heartbeating is dropped. If its match was still being
   set up, its players go back to the front of the queue; otherwise the match
   is void. Matches are accepted automatically: there is no prompt. */

export const MATCHMAKER_NAME = "main";

/* the queue's playlists: players per match, and how long a match waits for
   more than the minimum before it forms */
export const PLAYLISTS = {
  ffa: { label: "Free-for-all", minimum: 2, maximum: 8, fillMs: 10_000, rotation: [[5, 0]] },
  /* Halo puts joining players on red and blue in turn, and each match has
     a fresh server, so four players make two teams of two */
  team: { label: "2v2 Team Slayer", minimum: 2, maximum: 4, fillMs: 10_000, rotation: [[0, 1]] },
  duel: { label: "1v1", minimum: 2, maximum: 2, fillMs: 0, rotation: [[4, 0], [6, 0], [10, 0]] },
} as const satisfies Record<string, {
  label: string; minimum: number; maximum: number; fillMs: number; rotation: ReadonlyArray<readonly [number, number]>;
}>;
export type Playlist = keyof typeof PLAYLISTS;
export function isPlaylist(value: unknown): value is Playlist {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PLAYLISTS, value);
}

/* a ticket not polled in this long is abandoned */
const TICKET_TIMEOUT_MS = 15_000;
/* a server not heard from in this long is gone */
const SERVER_TIMEOUT_MS = 15_000;
/* a server that has not opened its room in this long has failed */
const ASSIGNING_TIMEOUT_MS = 30_000;
/* a match that never reports its end is cleared after this long */
const MATCH_TIMEOUT_MS = 30 * 60_000;
/* ended matches and tickets are kept this long, for late polls and the log */
const HISTORY_MS = 10 * 60_000;

export type TicketState = "queued" | "assigning" | "ready" | "ended" | "cancelled" | "expired";

export interface TicketView {
  id: string;
  playlist: Playlist;
  state: TicketState;
  queued: number;
  waitedSeconds: number;
  /* this player's finished matches (their rank) */
  matches: number;
  match?: {
    id: string;
    inviteCode: string | null;
    mapIndex: number;
    modeIndex: number;
    players: number;
    endReason: string | null;
  };
}

export interface EnqueueInput {
  buildId: string;
  identifier: string;
  /* the browser's lasting player ID (its machine identifier changes on
     every load) */
  playerKey: string | null;
  playlist: Playlist;
  wallet: string | null;
  now: number;
}

export interface Assignment {
  matchId: string;
  playlist: Playlist;
  mapIndex: number;
  modeIndex: number;
  /* the players' machine identifiers: the only machines the server admits */
  roster: string[];
}

export interface HeartbeatInput {
  serverId: string;
  matchState?: string;
  players?: number;
  now: number;
}

interface TicketRow extends Record<string, SqlStorageValue> {
  id: string;
  playlist: string;
  build_id: string;
  identifier: string;
  wallet: string | null;
  player_key: string | null;
  state: string;
  created_at: number;
  polled_at: number;
  match_id: string | null;
}

interface MatchRow extends Record<string, SqlStorageValue> {
  id: string;
  playlist: string;
  build_id: string;
  server_id: string;
  state: string;
  created_at: number;
  updated_at: number;
  map_index: number;
  mode_index: number;
  roster: string;
  room_id: string | null;
  invite_code: string | null;
  end_reason: string | null;
  match_state: string | null;
  players: number;
}

interface ServerRow extends Record<string, SqlStorageValue> {
  id: string;
  build_id: string;
  colo: string | null;
  state: string;
  match_id: string | null;
  registered_at: number;
  seen_at: number;
}

export class Matchmaker extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        playlist TEXT NOT NULL,
        build_id TEXT NOT NULL,
        identifier TEXT NOT NULL,
        wallet TEXT,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        polled_at INTEGER NOT NULL,
        match_id TEXT
      );
      CREATE INDEX IF NOT EXISTS tickets_queue ON tickets(playlist, build_id, state, created_at);
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        playlist TEXT NOT NULL,
        build_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        map_index INTEGER NOT NULL,
        mode_index INTEGER NOT NULL,
        roster TEXT NOT NULL,
        room_id TEXT,
        invite_code TEXT,
        end_reason TEXT,
        match_state TEXT,
        players INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        build_id TEXT NOT NULL,
        colo TEXT,
        state TEXT NOT NULL,
        match_id TEXT,
        registered_at INTEGER NOT NULL,
        seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS counters (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS players (
        key TEXT PRIMARY KEY,
        matches INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(tickets)").toArray().map(({ name }) => name);
    if (!columns.includes("player_key")) {
      this.ctx.storage.sql.exec("ALTER TABLE tickets ADD COLUMN player_key TEXT");
    }
  }

  /* ---------- the event log */

  private log(now: number, kind: string, subject: string | null, detail?: unknown): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO events (at, kind, subject, detail) VALUES (?, ?, ?, ?)",
      now, kind, subject, detail === undefined ? null : JSON.stringify(detail),
    );
  }

  private nextRotation(playlist: Playlist): readonly [number, number] {
    const rotation = PLAYLISTS[playlist].rotation;
    const name = `rotation:${playlist}`;
    const current = this.ctx.storage.sql
      .exec<{ value: number }>("SELECT value FROM counters WHERE name = ?", name).toArray()[0]?.value ?? 0;
    this.ctx.storage.sql.exec(
      "INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      name, current + 1,
    );
    return rotation[current % rotation.length] ?? rotation[0]!;
  }

  /* ---------- players */

  /* A ticket for a player. A wallet (or, without one, a machine) holds one
     ticket: a second request while queued replaces the first, and one while
     in a match returns that match's ticket, so a refreshed page rejoins. */
  async enqueue(input: EnqueueInput): Promise<TicketView> {
    this.sweep(input.now);
    const owner = input.wallet ?? `machine:${input.identifier}`;
    const existing = this.ctx.storage.sql.exec<TicketRow>(
      `SELECT * FROM tickets WHERE (wallet = ? OR identifier = ? OR player_key = ?)
         AND state IN ('queued', 'assigning', 'ready')`,
      input.wallet ?? owner, input.identifier, input.playerKey ?? owner,
    ).toArray();
    for (const ticket of existing) {
      const match = ticket.match_id ? this.match(ticket.match_id) : null;
      /* Halo admits nobody once a match is live: a player back from a
         refresh then queues for the next match instead */
      const live = match !== null && (match.match_state === "ingame" || match.match_state === "postgame");
      if ((ticket.state === "ready" || ticket.state === "assigning") && !live) {
        this.ctx.storage.sql.exec("UPDATE tickets SET polled_at = ? WHERE id = ?", input.now, ticket.id);
        return this.view(ticket.id, input.now)!;
      }
      if (live) {
        this.ctx.storage.sql.exec("UPDATE tickets SET state = 'ended' WHERE id = ?", ticket.id);
        this.log(input.now, "ticket_left_match", ticket.id, { match: ticket.match_id });
        continue;
      }
      this.ctx.storage.sql.exec("UPDATE tickets SET state = 'cancelled' WHERE id = ?", ticket.id);
      this.log(input.now, "ticket_replaced", ticket.id);
    }
    const id = randomToken(24);
    this.ctx.storage.sql.exec(
      `INSERT INTO tickets (id, playlist, build_id, identifier, wallet, player_key, state, created_at, polled_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      id, input.playlist, input.buildId, input.identifier, input.wallet, input.playerKey, input.now, input.now,
    );
    this.log(input.now, "ticket_queued", id, { playlist: input.playlist, wallet: input.wallet });
    this.formMatches(input.now);
    await this.schedule(input.now);
    return this.view(id, input.now)!;
  }

  /* A player's poll: what their ticket is doing, and keeping it alive. */
  async poll(ticketId: string, now: number): Promise<TicketView | null> {
    this.sweep(now);
    this.ctx.storage.sql.exec(
      "UPDATE tickets SET polled_at = ? WHERE id = ? AND state IN ('queued', 'assigning', 'ready')",
      now, ticketId,
    );
    this.formMatches(now);
    await this.schedule(now);
    return this.view(ticketId, now);
  }

  async cancel(ticketId: string, now: number): Promise<boolean> {
    const ticket = this.ticket(ticketId);
    if (!ticket || ticket.state !== "queued") return false;
    this.ctx.storage.sql.exec("UPDATE tickets SET state = 'cancelled' WHERE id = ?", ticketId);
    this.log(now, "ticket_cancelled", ticketId);
    return true;
  }

  private ticket(id: string): TicketRow | null {
    return this.ctx.storage.sql.exec<TicketRow>("SELECT * FROM tickets WHERE id = ?", id).toArray()[0] ?? null;
  }

  private match(id: string): MatchRow | null {
    return this.ctx.storage.sql.exec<MatchRow>("SELECT * FROM matches WHERE id = ?", id).toArray()[0] ?? null;
  }

  private view(ticketId: string, now: number): TicketView | null {
    const ticket = this.ticket(ticketId);
    if (!ticket) return null;
    const queued = this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM tickets WHERE playlist = ? AND build_id = ? AND state = 'queued'",
      ticket.playlist, ticket.build_id,
    ).one().count;
    const key = ticket.wallet ?? ticket.player_key;
    const matches = key ? this.ctx.storage.sql.exec<{ matches: number }>(
      "SELECT matches FROM players WHERE key = ?", key,
    ).toArray()[0]?.matches ?? 0 : 0;
    const view: TicketView = {
      id: ticket.id,
      playlist: ticket.playlist as Playlist,
      state: ticket.state as TicketState,
      matches,
      queued,
      waitedSeconds: Math.max(0, Math.round((now - ticket.created_at) / 1000)),
    };
    const match = ticket.match_id ? this.match(ticket.match_id) : null;
    if (match) {
      view.match = {
        id: match.id,
        inviteCode: match.state === "ready" ? match.invite_code : null,
        mapIndex: match.map_index,
        modeIndex: match.mode_index,
        players: (JSON.parse(match.roster) as string[]).length,
        endReason: match.end_reason,
      };
    }
    return view;
  }

  /* ---------- servers */

  async registerServer(buildId: string, colo: string | null, now: number): Promise<string> {
    const id = randomToken(16);
    this.ctx.storage.sql.exec(
      `INSERT INTO servers (id, build_id, colo, state, registered_at, seen_at) VALUES (?, ?, ?, 'idle', ?, ?)`,
      id, buildId, colo, now, now,
    );
    this.log(now, "server_registered", id, { buildId, colo });
    this.formMatches(now);
    await this.schedule(now);
    return id;
  }

  /* A server's heartbeat; the answer is its assignment, if it has one. Null
     with known false means the server is unknown (dropped): it must register
     again. */
  async heartbeat(input: HeartbeatInput): Promise<{ known: boolean; assignment: Assignment | null }> {
    this.sweep(input.now);
    const server = this.ctx.storage.sql
      .exec<ServerRow>("SELECT * FROM servers WHERE id = ?", input.serverId).toArray()[0];
    if (!server) return { known: false, assignment: null };
    this.ctx.storage.sql.exec("UPDATE servers SET seen_at = ? WHERE id = ?", input.now, input.serverId);
    const match = server.match_id ? this.match(server.match_id) : null;
    if (match && (input.matchState !== undefined || input.players !== undefined)) {
      if (match.match_state !== (input.matchState ?? null)) {
        this.log(input.now, "match_state", match.id, { state: input.matchState, players: input.players });
      }
      this.ctx.storage.sql.exec(
        "UPDATE matches SET match_state = ?, players = ?, updated_at = ? WHERE id = ?",
        input.matchState ?? null, input.players ?? 0, input.now, match.id,
      );
    }
    this.formMatches(input.now);
    await this.schedule(input.now);
    if (!match || match.state === "ended") return { known: true, assignment: null };
    return {
      known: true,
      assignment: {
        matchId: match.id,
        playlist: match.playlist as Playlist,
        mapIndex: match.map_index,
        modeIndex: match.mode_index,
        roster: JSON.parse(match.roster) as string[],
      },
    };
  }

  /* The server has opened its private room: the players may join. */
  async matchReady(serverId: string, matchId: string, roomId: string, inviteCode: string, now: number): Promise<boolean> {
    const match = this.match(matchId);
    if (!match || match.server_id !== serverId || match.state !== "assigning") return false;
    this.ctx.storage.sql.exec(
      "UPDATE matches SET state = 'ready', room_id = ?, invite_code = ?, updated_at = ? WHERE id = ?",
      roomId, inviteCode, now, matchId,
    );
    this.ctx.storage.sql.exec("UPDATE tickets SET state = 'ready' WHERE match_id = ? AND state = 'assigning'", matchId);
    this.ctx.storage.sql.exec("UPDATE servers SET state = 'hosting' WHERE id = ?", serverId);
    this.log(now, "match_ready", matchId, { roomId: roomId.slice(0, 9) });
    return true;
  }

  /* The server's report that its match is over: finished (played to its
     end) or void (it never went live). The server leaves the pool; a fresh
     one registers. */
  async matchEnded(serverId: string, matchId: string, reason: string, now: number): Promise<boolean> {
    const match = this.match(matchId);
    if (!match || match.server_id !== serverId) return false;
    if (match.state !== "ended") this.endMatch(match, reason, now);
    this.ctx.storage.sql.exec("DELETE FROM servers WHERE id = ?", serverId);
    return true;
  }

  /* Matches a machine's player has finished (their rank), by the player
     their latest ticket carried; null for a machine never queued. */
  async matchesFor(identifier: string): Promise<number | null> {
    const ticket = this.ctx.storage.sql.exec<TicketRow>(
      "SELECT * FROM tickets WHERE identifier = ? ORDER BY created_at DESC LIMIT 1", identifier,
    ).toArray()[0];
    const key = ticket ? ticket.wallet ?? ticket.player_key : null;
    if (!key) return null;
    return this.ctx.storage.sql.exec<{ matches: number }>(
      "SELECT matches FROM players WHERE key = ?", key,
    ).toArray()[0]?.matches ?? 0;
  }

  private endMatch(match: MatchRow, reason: string, now: number): void {
    /* a finished match counts for everyone who was in it */
    if (reason.startsWith("finished")) {
      const players = this.ctx.storage.sql.exec<TicketRow>(
        "SELECT * FROM tickets WHERE match_id = ?", match.id,
      ).toArray();
      for (const ticket of players) {
        const key = ticket.wallet ?? ticket.player_key;
        if (!key) continue;
        this.ctx.storage.sql.exec(
          `INSERT INTO players (key, matches, updated_at) VALUES (?, 1, ?)
           ON CONFLICT(key) DO UPDATE SET matches = matches + 1, updated_at = excluded.updated_at`,
          key, now,
        );
      }
    }
    this.ctx.storage.sql.exec(
      "UPDATE matches SET state = 'ended', end_reason = ?, updated_at = ? WHERE id = ?", reason, now, match.id,
    );
    this.ctx.storage.sql.exec(
      "UPDATE tickets SET state = 'ended' WHERE match_id = ? AND state IN ('assigning', 'ready')", match.id,
    );
    this.log(now, "match_ended", match.id, { reason });
  }

  /* A match that never got its room: its players go back to the front of
     the queue (their tickets keep their age), and its server is dropped. */
  private requeue(match: MatchRow, why: string, now: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE tickets SET state = 'queued', match_id = NULL WHERE match_id = ? AND state = 'assigning'", match.id,
    );
    this.ctx.storage.sql.exec(
      "UPDATE matches SET state = 'ended', end_reason = ?, updated_at = ? WHERE id = ?", `void: ${why}`, now, match.id,
    );
    this.ctx.storage.sql.exec("DELETE FROM servers WHERE id = ?", match.server_id);
    this.log(now, "match_requeued", match.id, { why });
  }

  /* ---------- forming matches */

  private formMatches(now: number): void {
    for (const playlist of Object.keys(PLAYLISTS) as Playlist[]) {
      const rules = PLAYLISTS[playlist];
      for (;;) {
        const builds = this.ctx.storage.sql.exec<{ build_id: string; count: number; oldest: number }>(
          `SELECT build_id, COUNT(*) AS count, MIN(created_at) AS oldest FROM tickets
            WHERE playlist = ? AND state = 'queued' GROUP BY build_id`,
          playlist,
        ).toArray();
        let formed = false;
        for (const build of builds) {
          if (build.count < rules.minimum) continue;
          if (build.count < rules.maximum && now - build.oldest < rules.fillMs) continue;
          const server = this.ctx.storage.sql.exec<ServerRow>(
            `SELECT * FROM servers WHERE build_id = ? AND state = 'idle' AND seen_at > ?
              ORDER BY registered_at ASC LIMIT 1`,
            build.build_id, now - SERVER_TIMEOUT_MS,
          ).toArray()[0];
          if (!server) continue;
          const tickets = this.ctx.storage.sql.exec<TicketRow>(
            `SELECT * FROM tickets WHERE playlist = ? AND build_id = ? AND state = 'queued'
              ORDER BY created_at ASC LIMIT ?`,
            playlist, build.build_id, rules.maximum,
          ).toArray();
          const [mapIndex, modeIndex] = this.nextRotation(playlist);
          const matchId = randomToken(12);
          const roster = tickets.map((ticket) => ticket.identifier);
          this.ctx.storage.sql.exec(
            `INSERT INTO matches (id, playlist, build_id, server_id, state, created_at, updated_at,
               map_index, mode_index, roster) VALUES (?, ?, ?, ?, 'assigning', ?, ?, ?, ?, ?)`,
            matchId, playlist, build.build_id, server.id, now, now, mapIndex, modeIndex, JSON.stringify(roster),
          );
          for (const ticket of tickets) {
            this.ctx.storage.sql.exec(
              "UPDATE tickets SET state = 'assigning', match_id = ? WHERE id = ?", matchId, ticket.id,
            );
          }
          this.ctx.storage.sql.exec(
            "UPDATE servers SET state = 'assigned', match_id = ? WHERE id = ?", matchId, server.id,
          );
          this.log(now, "match_formed", matchId, {
            playlist, server: server.id, mapIndex, modeIndex,
            wallets: tickets.map((ticket) => ticket.wallet),
          });
          formed = true;
        }
        if (!formed) break;
      }
    }
  }

  /* ---------- timeouts */

  private sweep(now: number): void {
    const abandoned = this.ctx.storage.sql.exec<{ id: string }>(
      "SELECT id FROM tickets WHERE state = 'queued' AND polled_at <= ?", now - TICKET_TIMEOUT_MS,
    ).toArray();
    for (const { id } of abandoned) {
      this.ctx.storage.sql.exec("UPDATE tickets SET state = 'expired' WHERE id = ?", id);
      this.log(now, "ticket_expired", id);
    }
    const gone = this.ctx.storage.sql.exec<ServerRow>(
      "SELECT * FROM servers WHERE seen_at <= ?", now - SERVER_TIMEOUT_MS,
    ).toArray();
    for (const server of gone) {
      this.log(now, "server_lost", server.id);
      const match = server.match_id ? this.match(server.match_id) : null;
      if (match && match.state === "assigning") this.requeue(match, "server lost", now);
      else if (match && match.state === "ready") this.endMatch(match, "void: server lost", now);
      this.ctx.storage.sql.exec("DELETE FROM servers WHERE id = ?", server.id);
    }
    const stuck = this.ctx.storage.sql.exec<MatchRow>(
      "SELECT * FROM matches WHERE state = 'assigning' AND created_at <= ?", now - ASSIGNING_TIMEOUT_MS,
    ).toArray();
    for (const match of stuck) this.requeue(match, "room not opened", now);
    const overdue = this.ctx.storage.sql.exec<MatchRow>(
      "SELECT * FROM matches WHERE state = 'ready' AND created_at <= ?", now - MATCH_TIMEOUT_MS,
    ).toArray();
    for (const match of overdue) this.endMatch(match, "void: no end reported", now);
    this.ctx.storage.sql.exec(
      "DELETE FROM tickets WHERE state IN ('ended', 'cancelled', 'expired') AND polled_at <= ?", now - HISTORY_MS,
    );
    this.ctx.storage.sql.exec("DELETE FROM matches WHERE state = 'ended' AND updated_at <= ?", now - HISTORY_MS);
    this.ctx.storage.sql.exec("DELETE FROM events WHERE at <= ?", now - 24 * 60 * 60_000);
  }

  /* While anyone is queued or any server is up, wake every few seconds so
     fill windows close and timeouts fire without a poll to drive them. */
  private async schedule(now: number): Promise<void> {
    const pending = this.ctx.storage.sql.exec<{ count: number }>(
      `SELECT (SELECT COUNT(*) FROM tickets WHERE state IN ('queued', 'assigning'))
            + (SELECT COUNT(*) FROM servers) AS count`,
    ).one().count;
    if (pending > 0 && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + 2_000);
    }
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    this.sweep(now);
    this.formMatches(now);
    await this.schedule(now);
  }

  /* ---------- the dashboard */

  async snapshot(now: number): Promise<{
    queues: Array<{ playlist: Playlist; label: string; queued: number; oldestSeconds: number | null }>;
    servers: Array<{ id: string; buildId: string; colo: string | null; state: string; match: string | null;
      seenSeconds: number; upSeconds: number }>;
    matches: Array<{ id: string; playlist: string; state: string; mapIndex: number; modeIndex: number;
      roster: number; players: number; matchState: string | null; ageSeconds: number; endReason: string | null }>;
    /* detail: JSON text */
    events: Array<{ at: number; kind: string; subject: string | null; detail: string | null }>;
  }> {
    this.sweep(now);
    const queues = (Object.keys(PLAYLISTS) as Playlist[]).map((playlist) => {
      const row = this.ctx.storage.sql.exec<{ count: number; oldest: number | null }>(
        "SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM tickets WHERE playlist = ? AND state = 'queued'",
        playlist,
      ).one();
      return {
        playlist, label: PLAYLISTS[playlist].label, queued: row.count,
        oldestSeconds: row.oldest === null ? null : Math.round((now - row.oldest) / 1000),
      };
    });
    const servers = this.ctx.storage.sql.exec<ServerRow>("SELECT * FROM servers ORDER BY registered_at").toArray()
      .map((server) => ({
        id: server.id.slice(0, 6), buildId: server.build_id, colo: server.colo, state: server.state,
        match: server.match_id ? server.match_id.slice(0, 6) : null,
        seenSeconds: Math.round((now - server.seen_at) / 1000),
        upSeconds: Math.round((now - server.registered_at) / 1000),
      }));
    const matches = this.ctx.storage.sql.exec<MatchRow>(
      "SELECT * FROM matches ORDER BY created_at DESC LIMIT 20",
    ).toArray().map((match) => ({
      id: match.id.slice(0, 6), playlist: match.playlist, state: match.state,
      mapIndex: match.map_index, modeIndex: match.mode_index,
      roster: (JSON.parse(match.roster) as string[]).length, players: match.players,
      matchState: match.match_state, ageSeconds: Math.round((now - match.created_at) / 1000),
      endReason: match.end_reason,
    }));
    const events = this.ctx.storage.sql.exec<{ at: number; kind: string; subject: string | null; detail: string | null }>(
      "SELECT * FROM events ORDER BY at DESC LIMIT 40",
    ).toArray().map((event) => ({
      at: event.at, kind: event.kind, subject: event.subject ? event.subject.slice(0, 6) : null,
      detail: event.detail,
    }));
    return { queues, servers, matches, events };
  }
}
