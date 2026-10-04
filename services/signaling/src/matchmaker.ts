import { DurableObject } from "cloudflare:workers";

import { randomToken } from "./crypto";
import { FlyMachines, type FlyMachine } from "./fly";
import type { MatchResult, StakesConfig, WagerMode } from "./wager";

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
  /* Halo joins players to red and blue in turn (the server, to the smaller
     team), and each match has a fresh server, so teams come out even */
  /* maps by index (protocol.ts): 0 Battle Creek, 1 Sidewinder, 2 Damnation,
     3 Rat Race, 4 Prisoner, 5 Hang 'Em High, 6 Chill Out, 7 Derelict,
     8 Boarding Action, 9 Blood Gulch, 10 Wizard, 11 Chiron TL-34,
     12 Longest; modes: 0 Slayer, 1 Team Slayer, 2 CTF, 3 Oddball, 4 King,
     5 Race, 6 Team Oddball, 7 Team King */
  team: {
    label: "Team Doubles", minimum: 2, maximum: 4, fillMs: 10_000, teams: true,
    description: "Two on two Team Slayer. Bring a partner, or get one.",
    rotation: [[0, 1], [6, 1], [4, 1], [12, 1], [7, 1], [10, 1], [3, 1]],
  },
  bigteam: {
    label: "Big Team Battle", minimum: 2, maximum: 8, fillMs: 15_000, teams: true,
    description: "Up to four on four Team Slayer on Halo's biggest maps, vehicles and all.",
    rotation: [[9, 1], [1, 1], [2, 1], [8, 1], [0, 1]],
  },
  ctf: {
    label: "Capture the Flag", minimum: 2, maximum: 8, fillMs: 15_000, teams: true,
    description: "Capture the Flag, up to four on four. Take theirs, keep yours.",
    rotation: [[0, 2], [9, 2], [2, 2], [1, 2], [8, 2]],
  },
  objective: {
    label: "Team Objective", minimum: 2, maximum: 8, fillMs: 15_000, teams: true,
    description: "Team Oddball and Team King of the Hill. Hold the ball, hold the hill.",
    rotation: [[6, 6], [5, 7], [7, 6], [3, 7], [4, 6], [0, 7]],
  },
  ffa: {
    label: "Rumble Pit", minimum: 2, maximum: 8, fillMs: 10_000, teams: false,
    description: "Free-for-all Slayer. Every Spartan for themselves.",
    rotation: [[5, 0], [4, 0], [3, 0], [6, 0], [7, 0], [10, 0], [12, 0], [11, 0]],
  },
  oddball: {
    label: "Oddball & King", minimum: 2, maximum: 8, fillMs: 10_000, teams: false,
    description: "Free-for-all Oddball and King of the Hill. Everyone against the ball carrier.",
    rotation: [[6, 3], [5, 4], [7, 3], [4, 4], [3, 3]],
  },
  duel: {
    label: "Head to Head", minimum: 2, maximum: 2, fillMs: 0, teams: false,
    description: "One on one Slayer. No excuses.",
    rotation: [[4, 0], [6, 0], [10, 0], [11, 0], [12, 0]],
  },
  /* Wagered (src/wager.ts): everyone stakes the buy-in, and each kill takes
     the bounty from the victim's stake */
  bountyduel: {
    label: "Bounty Duel", minimum: 2, maximum: 2, fillMs: 0, teams: false,
    description: "One on one Slayer for SOL. 0.05 buy-in, 0.01 a kill.",
    rotation: [[4, 0], [6, 0], [10, 0]],
    stake: 50_000_000, perKill: 10_000_000,
  },
  /* solo only: friends in a free-for-all for SOL could gang up on the
     others' stakes */
  bounty: {
    label: "Bounty Rumble", minimum: 2, maximum: 4, fillMs: 10_000, teams: false,
    description: "Free-for-all Slayer for SOL. 0.05 buy-in, 0.01 a kill.",
    rotation: [[4, 0], [6, 0], [3, 0]],
    stake: 50_000_000, perKill: 10_000_000, soloOnly: true,
  },
  /* Team Stakes (wager.ts, stakesOutcome): the winners get their stake back
     and split the losers' stakes by kills, a quarter of it evenly (the team
     share, in basis points; wager.ts imports this module, so no constant of
     its can be read here at load). The kill target is the dedicated Team
     Slayer variant's score to win (build_game_variant_team_slayer, 50). It
     waits for a full two on two */
  teamstakes: {
    label: "Team Stakes", minimum: 4, maximum: 4, fillMs: 0, teams: true,
    description: "Two on two Team Slayer for SOL. 0.05 buy-in; the winners split the losers' stakes by kills.",
    rotation: [[0, 1], [6, 1], [4, 1]],
    stake: 50_000_000, perKill: 0, mode: "team", killTarget: 50, teamShareBps: 2_500,
  },
} as const satisfies Record<string, {
  label: string; minimum: number; maximum: number; fillMs: number; teams: boolean; description: string;
  rotation: ReadonlyArray<readonly [number, number]>;
  stake?: number; perKill?: number; mode?: WagerMode; soloOnly?: boolean; killTarget?: number; teamShareBps?: number;
}>;
export type Playlist = keyof typeof PLAYLISTS;
export function isPlaylist(value: unknown): value is Playlist {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PLAYLISTS, value);
}

export interface PlaylistWager {
  stake: number;
  perKill: number;
  mode: WagerMode;
  /* a team match's rules (the stake, kill target, team share and the
     number of teams); null for a bounty */
  stakes: StakesConfig | null;
}

/* A wagered playlist's buy-in and bounty, in lamports, and how it pays
   (bounty: per kill; team: Team Stakes); null for a free one. */
export function playlistWager(playlist: Playlist): PlaylistWager | null {
  /* a party's custom game is no playlist */
  const rules = PLAYLISTS[playlist] as (typeof PLAYLISTS)[Playlist] | undefined;
  if (!rules || !("stake" in rules)) return null;
  const mode: WagerMode = "mode" in rules ? rules.mode : "bounty";
  const stakes: StakesConfig | null = mode === "team" ? {
    stake: rules.stake,
    killTarget: "killTarget" in rules ? rules.killTarget : 50,
    teamShareBps: "teamShareBps" in rules ? rules.teamShareBps : 2_500,
    groups: rules.teams ? 2 : 0,
  } : null;
  return { stake: rules.stake, perKill: rules.perKill, mode, stakes };
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

/* The autoscaler (with FLY_APP_NAME and FLY_API_TOKEN): game server machines
   named pool-0 .. pool-N, each running MACHINE_SERVERS servers
   (services/game-server/fly/pool.py). pool-0 always runs. Another machine
   starts when fewer than MINIMUM_IDLE_SERVERS are free; one whose servers
   have all been idle for SCALE_DOWN_IDLE_MS stops, if enough stay free. */
const MACHINE_SERVERS = 3;
const MINIMUM_IDLE_SERVERS = 2;
const SCALE_DOWN_IDLE_MS = 10 * 60_000;
const AUTOSCALE_EVERY_MS = 10_000;
const ALWAYS_ON_MACHINE = "pool-0";

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
    /* a wagered match: its buy-in and bounty, and whether the stakes are
       locked yet (the invite waits for them) */
    wager?: PlaylistWager & { escrow: string | null };
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
  /* a team match's plan: each machine's team (0 red, 1 blue) */
  teams?: Record<string, number>;
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
  party_id: string | null;
}

/* a party member the matchmaker queues or seats (src/party.ts) */
export interface PartyMemberTicket {
  key: string;
  identifier: string;
  wallet: string | null;
}

/* Why a party of `size` cannot queue for a playlist, or null if it can: a
   solo-only playlist takes no party; a team playlist takes a party that
   fits on one team, or one that fills the whole match (it plays itself,
   split in two). */
export function partyProblem(playlist: Playlist, size: number): string | null {
  const rules = PLAYLISTS[playlist];
  if (size <= 1) return null;
  if ("soloOnly" in rules && rules.soloOnly) return `${rules.label} is solo only. Leave the party to play it.`;
  if (size > rules.maximum) return `${rules.label} takes at most ${rules.maximum} players.`;
  if (rules.teams && size > Math.floor(rules.maximum / 2) && size !== rules.maximum) {
    return `A party of ${size} doesn't fit on one ${rules.label} team (${Math.floor(rules.maximum / 2)} a side).`;
  }
  return null;
}

/* A team match's plan: each machine's team (0 red, 1 blue), every party on
   one team, the teams even. `groups` are the match's machines, a party's
   together. A single party that fills the match plays itself, split in
   two. Null when no plan keeps every party together. */
export function planTeams(groups: string[][], maximum: number): Record<string, number> | null {
  const total = groups.reduce((sum, group) => sum + group.length, 0);
  const plan: Record<string, number> = {};
  if (groups.length === 1 && total > 1) {
    if (total !== maximum) return null;
    groups[0]!.forEach((machine, index) => { plan[machine] = index % 2; });
    return plan;
  }
  const capacity = Math.ceil(total / 2);
  const sizes: [number, number] = [0, 0];
  for (const group of [...groups].sort((left, right) => right.length - left.length)) {
    const team: 0 | 1 = sizes[0] <= sizes[1] ? 0 : 1;
    if (sizes[team] + group.length > capacity) {
      const other: 0 | 1 = team === 0 ? 1 : 0;
      if (sizes[other] + group.length > capacity) return null;
      for (const machine of group) plan[machine] = other;
      sizes[other] += group.length;
    } else {
      for (const machine of group) plan[machine] = team;
      sizes[team] += group.length;
    }
  }
  return plan;
}

/* the playlist name a party's custom game is recorded under */
export const CUSTOM_PLAYLIST = "custom";

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
  stake: number | null;
  escrow: string | null;
  teams: string | null;
}

interface ServerRow extends Record<string, SqlStorageValue> {
  id: string;
  build_id: string;
  colo: string | null;
  machine_id: string | null;
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
      /* wagered matches held for an admin (src/wager.ts): the Durable
         Objects cannot be listed, so the wager reports keep this index */
      CREATE TABLE IF NOT EXISTS held_wagers (
        match_id TEXT PRIMARY KEY,
        since INTEGER NOT NULL,
        deadline INTEGER NOT NULL,
        limit_at INTEGER,
        reason TEXT
      );
    `);
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(tickets)").toArray().map(({ name }) => name);
    if (!columns.includes("player_key")) {
      this.ctx.storage.sql.exec("ALTER TABLE tickets ADD COLUMN player_key TEXT");
    }
    if (!columns.includes("party_id")) {
      /* a party's tickets land in one match together */
      this.ctx.storage.sql.exec("ALTER TABLE tickets ADD COLUMN party_id TEXT");
    }
    const serverColumns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(servers)").toArray().map(({ name }) => name);
    if (!serverColumns.includes("machine_id")) {
      this.ctx.storage.sql.exec("ALTER TABLE servers ADD COLUMN machine_id TEXT");
    }
    const matchColumns = this.ctx.storage.sql
      .exec<{ name: string }>("PRAGMA table_info(matches)").toArray().map(({ name }) => name);
    if (!matchColumns.includes("stake")) {
      /* a wagered match's buy-in, and its stakes: locking, locked or failed */
      this.ctx.storage.sql.exec("ALTER TABLE matches ADD COLUMN stake INTEGER");
      this.ctx.storage.sql.exec("ALTER TABLE matches ADD COLUMN escrow TEXT");
    }
    if (!matchColumns.includes("teams")) {
      /* a team match's plan: each machine's team, a party together */
      this.ctx.storage.sql.exec("ALTER TABLE matches ADD COLUMN teams TEXT");
    }
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        state TEXT NOT NULL,
        idle_since INTEGER,
        changed_at INTEGER NOT NULL
      );
      /* Durable Object storage bills (and caps) rows read: every lookup
         and sweep below reads only the rows it needs */
      CREATE INDEX IF NOT EXISTS events_at ON events(at);
      CREATE INDEX IF NOT EXISTS tickets_state ON tickets(state, polled_at);
      CREATE INDEX IF NOT EXISTS tickets_identifier ON tickets(identifier, created_at);
      CREATE INDEX IF NOT EXISTS tickets_wallet ON tickets(wallet);
      CREATE INDEX IF NOT EXISTS tickets_player_key ON tickets(player_key);
      CREATE INDEX IF NOT EXISTS tickets_match ON tickets(match_id);
      CREATE INDEX IF NOT EXISTS tickets_party ON tickets(party_id, state);
      CREATE INDEX IF NOT EXISTS servers_seen ON servers(seen_at);
      CREATE INDEX IF NOT EXISTS servers_machine ON servers(machine_id);
      CREATE INDEX IF NOT EXISTS servers_state ON servers(state, build_id, seen_at);
      CREATE INDEX IF NOT EXISTS matches_state ON matches(state, created_at);
      CREATE INDEX IF NOT EXISTS matches_updated ON matches(state, updated_at);
      CREATE INDEX IF NOT EXISTS matches_playlist ON matches(playlist, state);
    `);
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
      const wager = playlistWager(match.playlist as Playlist);
      /* nobody joins a wagered match before its stakes are locked */
      const open = match.state === "ready" && (match.stake === null || match.escrow === "locked");
      view.match = {
        id: match.id,
        inviteCode: open ? match.invite_code : null,
        mapIndex: match.map_index,
        modeIndex: match.mode_index,
        players: (JSON.parse(match.roster) as string[]).length,
        endReason: match.end_reason,
        ...(wager && match.stake !== null ? { wager: { ...wager, escrow: match.escrow } } : {}),
      };
    }
    return view;
  }

  /* ---------- servers */

  async registerServer(buildId: string, colo: string | null, machineId: string | null, now: number): Promise<string> {
    const id = randomToken(16);
    this.ctx.storage.sql.exec(
      `INSERT INTO servers (id, build_id, colo, machine_id, state, registered_at, seen_at)
       VALUES (?, ?, ?, ?, 'idle', ?, ?)`,
      id, buildId, colo, machineId, now, now,
    );
    this.log(now, "server_registered", id, { buildId, colo, machineId });
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
        ...(match.teams ? { teams: JSON.parse(match.teams) as Record<string, number> } : {}),
      },
    };
  }

  /* The matches for SOL on now, for anyone to watch. */
  async liveMatches(now: number): Promise<Array<{
    id: string; playlist: string; label: string; mapIndex: number; modeIndex: number; players: number;
    matchState: string | null; ageSeconds: number;
  }>> {
    this.sweep(now);
    return this.ctx.storage.sql.exec<{ id: string; playlist: string; map_index: number; mode_index: number;
      roster: string; match_state: string | null; created_at: number }>(
      `SELECT id, playlist, map_index, mode_index, roster, match_state, created_at FROM matches
        WHERE state = 'ready' AND stake IS NOT NULL ORDER BY created_at DESC LIMIT 20`,
    ).toArray().map((match) => ({
      id: match.id,
      playlist: match.playlist,
      label: isPlaylist(match.playlist) ? PLAYLISTS[match.playlist].label : match.playlist,
      mapIndex: match.map_index,
      modeIndex: match.mode_index,
      players: (JSON.parse(match.roster) as string[]).length,
      matchState: match.match_state,
      ageSeconds: Math.round((now - match.created_at) / 1000),
    }));
  }

  /* A match's invite, for a spectator's place in its room; null when it is
     not on. */
  async spectateInvite(matchId: string): Promise<string | null> {
    const match = this.ctx.storage.sql.exec<{ state: string; invite_code: string | null }>(
      "SELECT state, invite_code FROM matches WHERE id = ?", matchId,
    ).toArray()[0];
    return match && match.state === "ready" ? match.invite_code : null;
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
    /* the room passes the match's kills to its wager */
    if (match.stake !== null) this.ctx.waitUntil(this.env.ROOMS.getByName(roomId).attachWager(matchId));
    return true;
  }

  /* How a wagered match's money ended (src/wager.ts), for the log; a hold
     and its changes keep the index of held matches. */
  async wagerReport(matchId: string, outcome: string, detail: unknown): Promise<void> {
    const now = Date.now();
    this.log(now, `wager_${outcome}`, matchId, detail);
    const record = (detail ?? {}) as { reason?: unknown; deadline?: unknown; limit?: unknown };
    if (outcome === "held") {
      this.ctx.storage.sql.exec(
        `INSERT INTO held_wagers (match_id, since, deadline, limit_at, reason) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(match_id) DO UPDATE SET deadline = excluded.deadline, limit_at = excluded.limit_at`,
        matchId, now, typeof record.deadline === "number" ? record.deadline : now,
        typeof record.limit === "number" ? record.limit : null,
        typeof record.reason === "string" ? record.reason : null,
      );
    } else if (outcome === "hold_extended" && typeof record.deadline === "number") {
      this.ctx.storage.sql.exec("UPDATE held_wagers SET deadline = ? WHERE match_id = ?", record.deadline, matchId);
    } else if (outcome !== "hold_decided" && outcome !== "hold_expired") {
      /* settled, void, or given up: no longer held */
      this.ctx.storage.sql.exec("DELETE FROM held_wagers WHERE match_id = ?", matchId);
    }
  }

  /* The wagered matches held for an admin, oldest deadline first. */
  async heldWagers(): Promise<Array<{
    matchId: string; playlist: string | null; since: number; deadline: number; limit: number | null; reason: string | null;
  }>> {
    return this.ctx.storage.sql.exec<{ match_id: string; since: number; deadline: number; limit_at: number | null; reason: string | null }>(
      "SELECT * FROM held_wagers ORDER BY deadline",
    ).toArray().map((row) => ({
      matchId: row.match_id,
      playlist: this.match(row.match_id)?.playlist ?? null,
      since: row.since,
      deadline: row.deadline,
      limit: row.limit_at,
      reason: row.reason,
    }));
  }

  /* The wager's report on the stakes: locked (the players may join) or not
     (the match is void, and its players told why). */
  async escrowLocked(matchId: string, locked: boolean, reason: string | null): Promise<void> {
    const now = Date.now();
    const match = this.match(matchId);
    if (!match || match.stake === null || match.escrow !== "locking") return;
    this.ctx.storage.sql.exec(
      "UPDATE matches SET escrow = ?, updated_at = ? WHERE id = ?", locked ? "locked" : "failed", now, matchId,
    );
    this.log(now, locked ? "stakes_locked" : "stakes_failed", matchId, reason === null ? undefined : { reason });
    if (!locked && match.state !== "ended") this.endMatch(this.match(matchId)!, `void: ${reason ?? "stakes not locked"}`, now);
  }

  /* The server's report that its match is over: finished (played to its
     end) or void (it never went live). The server leaves the pool; a fresh
     one registers. */
  async matchEnded(
    serverId: string, matchId: string, reason: string, now: number, result: MatchResult | null = null,
  ): Promise<boolean> {
    const match = this.match(matchId);
    if (!match || match.server_id !== serverId) return false;
    if (match.state !== "ended") this.endMatch(match, reason, now, result);
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

  private endMatch(match: MatchRow, reason: string, now: number, result: MatchResult | null = null): void {
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
    this.log(now, "match_ended", match.id, result ? { reason, teamScores: result.teamScores } : { reason });
    this.endWager(match, reason.startsWith("finished"), result);
  }

  /* A wagered match's end: finished pays it out (a team match by the
     server's result), anything else voids it. */
  private endWager(match: MatchRow, finished: boolean, result: MatchResult | null = null): void {
    if (match.stake === null) return;
    this.ctx.waitUntil(this.env.WAGERS.getByName(match.id).end(finished, result));
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
    this.endWager(match, false);
  }

  /* ---------- forming matches */

  /* The oldest queued tickets that fit a match: a party's tickets all
     together or none of them. */
  private chooseTickets(playlist: Playlist, buildId: string, maximum: number): TicketRow[] {
    const queued = this.ctx.storage.sql.exec<TicketRow>(
      `SELECT * FROM tickets WHERE playlist = ? AND build_id = ? AND state = 'queued'
        ORDER BY created_at ASC LIMIT 64`,
      playlist, buildId,
    ).toArray();
    const chosen: TicketRow[] = [];
    const parties = new Set<string>();
    for (const ticket of queued) {
      if (chosen.length >= maximum) break;
      if (ticket.party_id === null) {
        chosen.push(ticket);
        continue;
      }
      if (parties.has(ticket.party_id)) continue;
      parties.add(ticket.party_id);
      const party = queued.filter((other) => other.party_id === ticket.party_id);
      if (chosen.length + party.length <= maximum) chosen.push(...party);
    }
    return chosen;
  }

  /* ---------- parties (src/party.ts) */

  /* Who of these members is busy: queued is fine (it is replaced), in a
     match that is setting up or live is not. */
  private busyMember(members: PartyMemberTicket[]): PartyMemberTicket | null {
    for (const member of members) {
      const active = this.ctx.storage.sql.exec<{ id: string }>(
        `SELECT id FROM tickets WHERE (identifier = ? OR player_key = ?) AND state IN ('assigning', 'ready')`,
        member.identifier, member.key,
      ).toArray();
      if (active.length > 0) return member;
    }
    return null;
  }

  private retireQueued(members: PartyMemberTicket[], now: number): void {
    for (const member of members) {
      const queued = this.ctx.storage.sql.exec<{ id: string }>(
        `SELECT id FROM tickets WHERE (identifier = ? OR player_key = ? OR (wallet IS NOT NULL AND wallet = ?))
           AND state = 'queued'`,
        member.identifier, member.key, member.wallet,
      ).toArray();
      for (const { id } of queued) {
        this.ctx.storage.sql.exec("UPDATE tickets SET state = 'cancelled' WHERE id = ?", id);
        this.log(now, "ticket_replaced", id);
      }
    }
  }

  /* A party queues together: a ticket each, which form a match only all
     together. The tickets, by member key, or the member who is busy. */
  async enqueueParty(input: {
    partyId: string; buildId: string; playlist: Playlist; members: PartyMemberTicket[]; now: number;
  }): Promise<{ tickets: Record<string, string> } | { busy: string }> {
    this.sweep(input.now);
    const busy = this.busyMember(input.members);
    if (busy) return { busy: busy.key };
    this.retireQueued(input.members, input.now);
    const tickets: Record<string, string> = {};
    for (const member of input.members) {
      const id = randomToken(24);
      this.ctx.storage.sql.exec(
        `INSERT INTO tickets (id, playlist, build_id, identifier, wallet, player_key, party_id, state, created_at, polled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        id, input.playlist, input.buildId, member.identifier, member.wallet, member.key, input.partyId,
        input.now, input.now,
      );
      tickets[member.key] = id;
    }
    this.log(input.now, "party_queued", input.partyId, { playlist: input.playlist, players: input.members.length });
    this.formMatches(input.now);
    await this.schedule(input.now);
    return { tickets };
  }

  /* A party's custom game: a server of its own, with the leader's map and
     game type. The tickets, by member key; the member who is busy; or no
     server free. */
  async startCustom(input: {
    partyId: string; buildId: string; mapIndex: number; modeIndex: number; members: PartyMemberTicket[]; now: number;
  }): Promise<{ tickets: Record<string, string>; matchId: string } | { busy: string } | { noServer: true }> {
    this.sweep(input.now);
    const busy = this.busyMember(input.members);
    if (busy) return { busy: busy.key };
    const server = this.ctx.storage.sql.exec<ServerRow>(
      `SELECT * FROM servers WHERE build_id = ? AND state = 'idle' AND seen_at > ?
        ORDER BY registered_at ASC LIMIT 1`,
      input.buildId, input.now - SERVER_TIMEOUT_MS,
    ).toArray()[0];
    if (!server) {
      /* the autoscaler starts a machine on its next round */
      await this.schedule(input.now);
      return { noServer: true };
    }
    this.retireQueued(input.members, input.now);
    const matchId = randomToken(12);
    this.ctx.storage.sql.exec(
      `INSERT INTO matches (id, playlist, build_id, server_id, state, created_at, updated_at,
         map_index, mode_index, roster) VALUES (?, ?, ?, ?, 'assigning', ?, ?, ?, ?, ?)`,
      matchId, CUSTOM_PLAYLIST, input.buildId, server.id, input.now, input.now, input.mapIndex, input.modeIndex,
      JSON.stringify(input.members.map((member) => member.identifier)),
    );
    const tickets: Record<string, string> = {};
    for (const member of input.members) {
      const id = randomToken(24);
      this.ctx.storage.sql.exec(
        `INSERT INTO tickets (id, playlist, build_id, identifier, wallet, player_key, party_id, state, created_at,
           polled_at, match_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'assigning', ?, ?, ?)`,
        id, CUSTOM_PLAYLIST, input.buildId, member.identifier, member.wallet, member.key, input.partyId,
        input.now, input.now, matchId,
      );
      tickets[member.key] = id;
    }
    this.ctx.storage.sql.exec("UPDATE servers SET state = 'assigned', match_id = ? WHERE id = ?", matchId, server.id);
    this.log(input.now, "custom_formed", matchId, {
      party: input.partyId, server: server.id, mapIndex: input.mapIndex, modeIndex: input.modeIndex,
      players: input.members.length,
    });
    await this.schedule(input.now);
    return { tickets, matchId };
  }

  /* The party stopped searching: its queued tickets are cancelled. */
  async cancelParty(partyId: string, now: number): Promise<void> {
    const queued = this.ctx.storage.sql.exec<{ id: string }>(
      "SELECT id FROM tickets WHERE party_id = ? AND state = 'queued'", partyId,
    ).toArray();
    for (const { id } of queued) {
      this.ctx.storage.sql.exec("UPDATE tickets SET state = 'cancelled' WHERE id = ?", id);
      this.log(now, "ticket_cancelled", id);
    }
  }

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
          const tickets = this.chooseTickets(playlist, build.build_id, rules.maximum);
          if (tickets.length < rules.minimum) continue;
          /* a team match keeps each party on one team; one that cannot yet
             (a party with nobody else) waits for more players */
          let teams: Record<string, number> | null = null;
          if (rules.teams && tickets.some((ticket) => ticket.party_id !== null)) {
            const groups = new Map<string, string[]>();
            for (const ticket of tickets) {
              const key = ticket.party_id ?? `solo:${ticket.id}`;
              groups.set(key, [...(groups.get(key) ?? []), ticket.identifier]);
            }
            teams = planTeams([...groups.values()], rules.maximum);
            if (!teams) continue;
          }
          const [mapIndex, modeIndex] = this.nextRotation(playlist);
          const matchId = randomToken(12);
          const roster = tickets.map((ticket) => ticket.identifier);
          const wager = playlistWager(playlist);
          this.ctx.storage.sql.exec(
            `INSERT INTO matches (id, playlist, build_id, server_id, state, created_at, updated_at,
               map_index, mode_index, roster, stake, escrow, teams) VALUES (?, ?, ?, ?, 'assigning', ?, ?, ?, ?, ?, ?, ?, ?)`,
            matchId, playlist, build.build_id, server.id, now, now, mapIndex, modeIndex, JSON.stringify(roster),
            wager?.stake ?? null, wager ? "locking" : null, teams ? JSON.stringify(teams) : null,
          );
          if (wager) {
            /* the stakes lock while the server opens its room */
            this.ctx.waitUntil(this.env.WAGERS.getByName(matchId).start({
              matchId, stake: wager.stake, perKill: wager.perKill, mode: wager.mode, stakes: wager.stakes,
              wallets: tickets.map((ticket) => ticket.wallet!),
            }));
          }
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

  private sweptAt = 0;

  /* at most every few seconds: timeouts are seconds long, and every call
     reads rows */
  private sweep(now: number): void {
    if (now - this.sweptAt < 3_000 && now >= this.sweptAt) return;
    this.sweptAt = now;
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
    try {
      await this.autoscale(now);
    } catch (error) {
      this.log(now, "autoscale_failed", null, { error: error instanceof Error ? error.message : String(error) });
    }
    await this.schedule(now);
  }

  /* ---------- the autoscaler */

  private fly(): FlyMachines | null {
    const env = this.env as unknown as { FLY_APP_NAME?: string; FLY_API_TOKEN?: string };
    return env.FLY_APP_NAME && env.FLY_API_TOKEN ? new FlyMachines(env.FLY_APP_NAME, env.FLY_API_TOKEN) : null;
  }

  private async autoscale(now: number): Promise<void> {
    const fly = this.fly();
    if (!fly) return;
    const last = this.ctx.storage.sql
      .exec<{ value: number }>("SELECT value FROM counters WHERE name = 'autoscale_at'").toArray()[0]?.value ?? 0;
    if (now - last < AUTOSCALE_EVERY_MS) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO counters (name, value) VALUES ('autoscale_at', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      now,
    );
    const machines = (await fly.list()).filter((machine) => machine.name.startsWith("pool-"))
      .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
    for (const machine of machines) {
      this.ctx.storage.sql.exec(
        `INSERT INTO machines (id, name, state, changed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, changed_at =
           CASE WHEN machines.state = excluded.state THEN machines.changed_at ELSE excluded.changed_at END,
           state = excluded.state`,
        machine.id, machine.name, machine.state, now,
      );
    }
    this.ctx.storage.sql.exec(
      `DELETE FROM machines WHERE id NOT IN (${machines.map(() => "?").join(",") || "''"})`,
      ...machines.map((machine) => machine.id),
    );
    const running = (machine: FlyMachine) => machine.state === "started" || machine.state === "starting" ||
      machine.state === "created";
    const serversOn = (machine: FlyMachine) => this.ctx.storage.sql.exec<ServerRow>(
      "SELECT * FROM servers WHERE machine_id = ? AND seen_at > ?", machine.id, now - SERVER_TIMEOUT_MS,
    ).toArray();
    const idle = this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM servers WHERE state = 'idle' AND seen_at > ?", now - SERVER_TIMEOUT_MS,
    ).one().count;
    /* a running machine with no servers registered yet is still booting */
    const booting = machines.filter((machine) => running(machine) && serversOn(machine).length === 0).length;

    if (idle + booting * MACHINE_SERVERS < MINIMUM_IDLE_SERVERS) {
      const stopped = machines.find((machine) => !running(machine) && machine.state !== "destroyed");
      if (stopped) {
        await fly.start(stopped.id);
        this.log(now, "machine_started", stopped.name, { idle, booting });
      }
      return;
    }

    for (const machine of machines) {
      if (!running(machine) || machine.name === ALWAYS_ON_MACHINE) continue;
      const servers = serversOn(machine);
      const allIdle = servers.length > 0 && servers.every((server) => server.state === "idle");
      const row = this.ctx.storage.sql.exec<{ idle_since: number | null }>(
        "SELECT idle_since FROM machines WHERE id = ?", machine.id,
      ).one();
      if (!allIdle) {
        this.ctx.storage.sql.exec("UPDATE machines SET idle_since = NULL WHERE id = ?", machine.id);
        continue;
      }
      if (row.idle_since === null) {
        this.ctx.storage.sql.exec("UPDATE machines SET idle_since = ? WHERE id = ?", now, machine.id);
        continue;
      }
      if (now - row.idle_since < SCALE_DOWN_IDLE_MS || idle - servers.length < MINIMUM_IDLE_SERVERS) continue;
      /* out of the pool first, so no match lands on a machine going down */
      this.ctx.storage.sql.exec("DELETE FROM servers WHERE machine_id = ?", machine.id);
      this.ctx.storage.sql.exec("UPDATE machines SET idle_since = NULL WHERE id = ?", machine.id);
      await fly.stop(machine.id);
      this.log(now, "machine_stopped", machine.name, { idleMinutes: Math.round((now - row.idle_since) / 60_000) });
      return;
    }
  }

  /* The playlists, with who is searching and playing in each, for the
     lobby's playlist picker. */
  async playlists(now: number): Promise<Array<{
    id: Playlist; label: string; description: string; minimum: number; maximum: number; teams: boolean;
    maps: number[]; modes: number[]; searching: number; playing: number;
    wager: PlaylistWager | null;
  }>> {
    this.sweep(now);
    return (Object.keys(PLAYLISTS) as Playlist[]).map((id) => {
      const rules = PLAYLISTS[id];
      const searching = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM tickets WHERE playlist = ? AND state IN ('queued', 'assigning')", id,
      ).one().count;
      const playing = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COALESCE(SUM(players), 0) AS count FROM matches WHERE playlist = ? AND state = 'ready'", id,
      ).one().count;
      return {
        id, label: rules.label, description: rules.description, minimum: rules.minimum,
        maximum: rules.maximum, teams: rules.teams,
        maps: rules.rotation.map(([map]) => map), modes: rules.rotation.map(([, mode]) => mode),
        searching, playing, wager: playlistWager(id),
      };
    });
  }

  /* ---------- the dashboard */

  async snapshot(now: number): Promise<{
    queues: Array<{ playlist: Playlist; label: string; queued: number; oldestSeconds: number | null }>;
    servers: Array<{ id: string; buildId: string; colo: string | null; state: string; match: string | null;
      seenSeconds: number; upSeconds: number; machine: string | null }>;
    machines: Array<{ name: string; state: string; servers: number; idleSeconds: number | null;
      stateSeconds: number }>;
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
        machine: server.machine_id
          ? this.ctx.storage.sql.exec<{ name: string }>("SELECT name FROM machines WHERE id = ?", server.machine_id)
            .toArray()[0]?.name ?? null
          : null,
      }));
    const machines = this.ctx.storage.sql.exec<{ id: string; name: string; state: string; idle_since: number | null;
      changed_at: number }>("SELECT * FROM machines ORDER BY name").toArray().map((machine) => ({
      name: machine.name,
      state: machine.state,
      servers: this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM servers WHERE machine_id = ?", machine.id,
      ).one().count,
      idleSeconds: machine.idle_since === null ? null : Math.round((now - machine.idle_since) / 1000),
      stateSeconds: Math.round((now - machine.changed_at) / 1000),
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
    return { queues, servers, machines, matches, events };
  }
}
