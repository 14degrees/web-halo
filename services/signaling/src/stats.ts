import { DurableObject } from "cloudflare:workers";

import { HttpError } from "./errors";
import type { RuntimeEnv } from "./env";
import { PROFILES_NAME, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, USERNAME_PATTERN } from "./profiles";
import { walletPlayerName } from "./solana";
import type { MatchResult } from "./wager";

/* Player stats and the leaderboard: one singleton Durable Object that keeps
   every player's lasting record from the matches dedicated servers report.

   Only a dedicated server's end-of-match report (the matchmaker's
   matchEnded, src/matchmaker.ts) counts: the server saw the whole match,
   so every number here is verified. Player-hosted rooms report nothing and
   count for nothing. Kills and deaths come from the server's kill reports
   as the match's room counted them (src/room.ts, matchRoster); the score,
   team and quit flag from the result itself.

   A player is known by the strongest identity they played with:

     profile:<id>     a username (src/profiles.ts): the wallet they played
                      with belongs to a profile. The id never changes when
                      the username does.
     wallet:<address> a signed-in wallet with no username yet
     guest:<hash>     a browser only (the matchmaker's lasting player key,
                      hashed so the key itself is never published)

   When a player's identity grows (a guest signs in, a wallet claims a
   username) the weaker record folds into the stronger one, so nothing is
   lost or doubled. Each match is recorded once, by its ID: a second report
   of the same match is ignored. */

export const STATS_NAME = "main";

export type StatsIdentity = "username" | "wallet" | "guest";
export type MatchOutcome = "win" | "loss" | "draw";

export const LEADERBOARD_SORTS = ["kills", "wins", "kd", "matches", "score", "net"] as const;
export type LeaderboardSort = (typeof LEADERBOARD_SORTS)[number];
export const LEADERBOARD_PAGE_MAX = 100;
const LEADERBOARD_PAGE_DEFAULT = 25;
const RECENT_MATCHES = 10;
/* a player's wallet hash: enough to tell players apart, not enough to find
   the key it came from */
const GUEST_ID_LENGTH = 16;
const GUEST_ID_PATTERN = /^[0-9a-f]{16}$/u;
const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;
const PLAYER_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;

/* one player of a finished match, as the matchmaker resolved them */
export interface MatchStatsPlayer {
  name: string;
  team: number;
  score: number;
  quit: boolean;
  kills: number;
  deaths: number;
  wallet: string | null;
  playerKey: string | null;
}

export interface MatchStatsReport {
  matchId: string;
  playlist: string;
  mapIndex: number;
  modeIndex: number;
  teams: boolean;
  teamScores: [number, number];
  /* a wagered match's buy-in in lamports */
  stake: number | null;
  endedAt: number;
  players: MatchStatsPlayer[];
}

export interface PlayerStats {
  /* what to put in GET /v1/players/:id */
  id: string;
  name: string;
  identity: StatsIdentity;
  /* every number comes from a dedicated server's report */
  verified: true;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  quits: number;
  kills: number;
  deaths: number;
  /* kills per death, with one death at least */
  kd: number;
  score: number;
  /* wagered matches settled, and their lamports won or lost */
  wagered: number;
  wagerNet: number;
  firstAt: number;
  updatedAt: number;
}

export interface LeaderboardEntry extends PlayerStats {
  rank: number;
}

export interface LeaderboardView {
  sort: LeaderboardSort;
  order: "asc" | "desc";
  limit: number;
  offset: number;
  total: number;
  /* where the numbers come from: dedicated servers' match reports only */
  source: "dedicated";
  entries: LeaderboardEntry[];
}

export interface PlayerMatchView {
  matchId: string;
  playlist: string;
  mapIndex: number;
  modeIndex: number;
  teams: boolean;
  team: number;
  score: number;
  kills: number;
  deaths: number;
  outcome: MatchOutcome;
  quit: boolean;
  wagerNet: number | null;
  endedAt: number;
}

export interface PlayerView extends PlayerStats {
  ranks: { kills: number; wins: number };
  recent: PlayerMatchView[];
}

interface PlayerRow extends Record<string, SqlStorageValue> {
  key: string;
  identity: string;
  name: string;
  public_id: string;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  quits: number;
  kills: number;
  deaths: number;
  score: number;
  wagered: number;
  wager_net: number;
  first_at: number;
  updated_at: number;
}

interface MatchPlayerRow extends Record<string, SqlStorageValue> {
  match_id: string;
  key: string;
  name: string;
  team: number;
  score: number;
  kills: number;
  deaths: number;
  outcome: string;
  quit: number;
  wager_net: number | null;
  playlist: string;
  map_index: number;
  mode_index: number;
  teams: number;
  ended_at: number;
}

/* a resolved identity: the row key and what to show for it */
interface Identity {
  key: string;
  identity: StatsIdentity;
  name: string;
  publicId: string;
}

const SORT_SQL: Record<LeaderboardSort, string> = {
  kills: "kills",
  wins: "wins",
  kd: "CAST(kills AS REAL) / MAX(deaths, 1)",
  matches: "matches",
  score: "score",
  net: "wager_net",
};

export function isLeaderboardSort(value: unknown): value is LeaderboardSort {
  return typeof value === "string" && (LEADERBOARD_SORTS as readonly string[]).includes(value);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/* a browser's public id: its lasting player key, hashed */
export async function guestId(playerKey: string): Promise<string> {
  return (await sha256Hex(`halo-stats-guest:${playerKey}`)).slice(0, GUEST_ID_LENGTH);
}

/* Who won: in a team match the team with the higher score, in a
   free-for-all whoever has the top score; equal top scores draw. A player
   who quit lost whatever the scores say. */
export function outcomeOf(
  report: { teams: boolean; teamScores: [number, number]; players: Array<Pick<MatchStatsPlayer, "score" | "quit">> },
  player: Pick<MatchStatsPlayer, "team" | "score" | "quit">,
): MatchOutcome {
  if (player.quit) return "loss";
  if (report.teams) {
    const [red, blue] = report.teamScores;
    if (red === blue) return "draw";
    const winner = red > blue ? 0 : 1;
    return player.team === winner ? "win" : "loss";
  }
  const top = Math.max(...report.players.filter((other) => !other.quit).map((other) => other.score));
  if (player.score < top) return "loss";
  const atTop = report.players.filter((other) => !other.quit && other.score === top).length;
  return atTop > 1 ? "draw" : "win";
}

export class Stats extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS players (
        key TEXT PRIMARY KEY,
        identity TEXT NOT NULL,
        name TEXT NOT NULL,
        public_id TEXT NOT NULL,
        matches INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        draws INTEGER NOT NULL DEFAULT 0,
        quits INTEGER NOT NULL DEFAULT 0,
        kills INTEGER NOT NULL DEFAULT 0,
        deaths INTEGER NOT NULL DEFAULT 0,
        score INTEGER NOT NULL DEFAULT 0,
        wagered INTEGER NOT NULL DEFAULT 0,
        wager_net INTEGER NOT NULL DEFAULT 0,
        first_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS players_public_id ON players(public_id);
      CREATE INDEX IF NOT EXISTS players_kills ON players(kills);
      CREATE INDEX IF NOT EXISTS players_wins ON players(wins);
      CREATE INDEX IF NOT EXISTS players_matches ON players(matches);
      /* every match recorded, once: the guard against counting it twice */
      CREATE TABLE IF NOT EXISTS matches (
        match_id TEXT PRIMARY KEY,
        playlist TEXT NOT NULL,
        map_index INTEGER NOT NULL,
        mode_index INTEGER NOT NULL,
        teams INTEGER NOT NULL,
        team_scores TEXT NOT NULL,
        stake INTEGER,
        players INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL
      );
      /* each player's line of each match: a player's history, and the
         ledger a tournament or a season can be scored from later */
      CREATE TABLE IF NOT EXISTS match_players (
        match_id TEXT NOT NULL,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        team INTEGER NOT NULL,
        score INTEGER NOT NULL,
        kills INTEGER NOT NULL,
        deaths INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        quit INTEGER NOT NULL,
        wager_net INTEGER,
        PRIMARY KEY (match_id, key)
      );
      CREATE INDEX IF NOT EXISTS match_players_key ON match_players(key, match_id);
      /* wagered matches whose settlement has been counted, once */
      CREATE TABLE IF NOT EXISTS wager_nets (
        match_id TEXT PRIMARY KEY,
        recorded_at INTEGER NOT NULL
      );
    `);
  }

  /* ---------- identities */

  /* The profiles behind a set of wallets, in one call to the store. */
  private async profilesFor(wallets: string[]): Promise<Record<string, { id: string; username: string }>> {
    const unique = Array.from(new Set(wallets));
    if (unique.length === 0) return {};
    try {
      return await this.env.PROFILES.getByName(PROFILES_NAME).publicProfilesForWallets(unique);
    } catch {
      /* without the store the wallet stands for itself this time */
      return {};
    }
  }

  private static profileIdentity(profile: { id: string; username: string }): Identity {
    return { key: `profile:${profile.id}`, identity: "username", name: profile.username, publicId: profile.username };
  }

  private static walletIdentity(wallet: string): Identity {
    return { key: `wallet:${wallet}`, identity: "wallet", name: walletPlayerName(wallet), publicId: wallet };
  }

  private static guestIdentity(id: string, name: string): Identity {
    return { key: `guest:${id}`, identity: "guest", name, publicId: id };
  }

  /* The identities a player may have records under, strongest first. */
  private async identitiesOf(
    player: { name: string; wallet: string | null; playerKey: string | null },
    profiles: Record<string, { id: string; username: string }>,
  ): Promise<Identity[]> {
    const out: Identity[] = [];
    if (player.wallet !== null) {
      const profile = profiles[player.wallet];
      if (profile) out.push(Stats.profileIdentity(profile));
      out.push(Stats.walletIdentity(player.wallet));
    }
    if (player.playerKey !== null) out.push(Stats.guestIdentity(await guestId(player.playerKey), player.name));
    return out;
  }

  private playerRow(key: string): PlayerRow | null {
    return this.ctx.storage.sql.exec<PlayerRow>("SELECT * FROM players WHERE key = ?", key).toArray()[0] ?? null;
  }

  /* The row for an identity, made if missing; weaker records of the same
     player fold into it. */
  private claimRow(identities: Identity[], now: number): PlayerRow {
    const strongest = identities[0]!;
    let row = this.playerRow(strongest.key);
    if (row === null) {
      this.ctx.storage.sql.exec(
        `INSERT INTO players (key, identity, name, public_id, first_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        strongest.key, strongest.identity, strongest.name, strongest.publicId, now, now,
      );
    } else if (row.name !== strongest.name || row.public_id !== strongest.publicId) {
      /* a renamed profile, or a guest's new in-game name */
      this.ctx.storage.sql.exec(
        "UPDATE players SET name = ?, public_id = ? WHERE key = ?", strongest.name, strongest.publicId, strongest.key,
      );
    }
    for (const weaker of identities.slice(1)) this.absorb(weaker.key, strongest.key, now);
    row = this.playerRow(strongest.key)!;
    return row;
  }

  /* A weaker record folds into a stronger one: its totals add up, its
     match lines move over (a line already there for the same match stays
     as it is), and the weaker row goes. */
  private absorb(fromKey: string, intoKey: string, now: number): void {
    const from = this.playerRow(fromKey);
    if (from === null || fromKey === intoKey) return;
    this.ctx.storage.sql.exec(
      `UPDATE players SET
         matches = matches + ?, wins = wins + ?, losses = losses + ?, draws = draws + ?, quits = quits + ?,
         kills = kills + ?, deaths = deaths + ?, score = score + ?, wagered = wagered + ?, wager_net = wager_net + ?,
         first_at = MIN(first_at, ?), updated_at = ?
       WHERE key = ?`,
      from.matches, from.wins, from.losses, from.draws, from.quits, from.kills, from.deaths, from.score,
      from.wagered, from.wager_net, from.first_at, now, intoKey,
    );
    this.ctx.storage.sql.exec("UPDATE OR IGNORE match_players SET key = ? WHERE key = ?", intoKey, fromKey);
    this.ctx.storage.sql.exec("DELETE FROM match_players WHERE key = ?", fromKey);
    this.ctx.storage.sql.exec("DELETE FROM players WHERE key = ?", fromKey);
  }

  /* ---------- recording */

  /* A finished match, from the matchmaker. Returns false when the match
     was already recorded (or has nobody to record). */
  async recordMatch(report: MatchStatsReport, now = Date.now()): Promise<boolean> {
    const players = report.players.filter((player) => player.wallet !== null || player.playerKey !== null);
    if (players.length === 0) return false;
    const profiles = await this.profilesFor(players.flatMap((player) => player.wallet === null ? [] : [player.wallet]));
    const identities = await Promise.all(players.map((player) => this.identitiesOf(player, profiles)));
    return this.ctx.storage.transactionSync(() => {
      const known = this.ctx.storage.sql
        .exec<{ match_id: string }>("SELECT match_id FROM matches WHERE match_id = ?", report.matchId).toArray();
      if (known.length > 0) return false;
      this.ctx.storage.sql.exec(
        `INSERT INTO matches (match_id, playlist, map_index, mode_index, teams, team_scores, stake, players, ended_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        report.matchId, report.playlist, report.mapIndex, report.modeIndex, report.teams ? 1 : 0,
        JSON.stringify(report.teamScores), report.stake, report.players.length, report.endedAt, now,
      );
      const seen = new Set<string>();
      players.forEach((player, index) => {
        const row = this.claimRow(identities[index]!, now);
        /* one line per player per match, whatever names they came in under */
        if (seen.has(row.key)) return;
        seen.add(row.key);
        const outcome = outcomeOf(report, player);
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO match_players (match_id, key, name, team, score, kills, deaths, outcome, quit)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          report.matchId, row.key, player.name, player.team, player.score, player.kills, player.deaths, outcome,
          player.quit ? 1 : 0,
        );
        this.ctx.storage.sql.exec(
          `UPDATE players SET matches = matches + 1, wins = wins + ?, losses = losses + ?, draws = draws + ?,
             quits = quits + ?, kills = kills + ?, deaths = deaths + ?, score = score + ?, updated_at = ?
           WHERE key = ?`,
          outcome === "win" ? 1 : 0, outcome === "loss" ? 1 : 0, outcome === "draw" ? 1 : 0, player.quit ? 1 : 0,
          player.kills, player.deaths, player.score, now, row.key,
        );
      });
      return true;
    });
  }

  /* A wagered match's settlement, from its wager (src/wager.ts): what each
     wallet won or lost, in lamports. Counted once per match, whether it
     lands before or after the match's own report. */
  async recordWagerNet(matchId: string, nets: Array<{ wallet: string; net: number }>, now = Date.now()): Promise<boolean> {
    if (nets.length === 0) return false;
    const profiles = await this.profilesFor(nets.map((entry) => entry.wallet));
    const identities = await Promise.all(nets.map((entry) =>
      this.identitiesOf({ name: walletPlayerName(entry.wallet), wallet: entry.wallet, playerKey: null }, profiles)));
    return this.ctx.storage.transactionSync(() => {
      const known = this.ctx.storage.sql
        .exec<{ match_id: string }>("SELECT match_id FROM wager_nets WHERE match_id = ?", matchId).toArray();
      if (known.length > 0) return false;
      this.ctx.storage.sql.exec("INSERT INTO wager_nets (match_id, recorded_at) VALUES (?, ?)", matchId, now);
      nets.forEach((entry, index) => {
        const row = this.claimRow(identities[index]!, now);
        this.ctx.storage.sql.exec(
          "UPDATE players SET wagered = wagered + 1, wager_net = wager_net + ?, updated_at = ? WHERE key = ?",
          entry.net, now, row.key,
        );
        this.ctx.storage.sql.exec(
          "UPDATE match_players SET wager_net = ? WHERE match_id = ? AND key = ?", entry.net, matchId, row.key,
        );
      });
      return true;
    });
  }

  /* ---------- reading */

  private static stats(row: PlayerRow): PlayerStats {
    return {
      id: row.public_id,
      name: row.name,
      identity: row.identity as StatsIdentity,
      verified: true,
      matches: row.matches,
      wins: row.wins,
      losses: row.losses,
      draws: row.draws,
      quits: row.quits,
      kills: row.kills,
      deaths: row.deaths,
      kd: Math.round((row.kills / Math.max(row.deaths, 1)) * 100) / 100,
      score: row.score,
      wagered: row.wagered,
      wagerNet: row.wager_net,
      firstAt: row.first_at,
      updatedAt: row.updated_at,
    };
  }

  async leaderboard(input: { sort?: LeaderboardSort; order?: "asc" | "desc"; limit?: number; offset?: number }):
    Promise<LeaderboardView> {
    const sort = input.sort ?? "kills";
    const order = input.order ?? "desc";
    const limit = Math.max(1, Math.min(LEADERBOARD_PAGE_MAX, Math.floor(input.limit ?? LEADERBOARD_PAGE_DEFAULT)));
    const offset = Math.max(0, Math.floor(input.offset ?? 0));
    const direction = order === "asc" ? "ASC" : "DESC";
    /* a wager column lists only players who wagered; a stable order after
       the sort column, so pages never overlap */
    const where = sort === "net" ? "WHERE wagered > 0" : "";
    const total = this.ctx.storage.sql
      .exec<{ total: number }>(`SELECT COUNT(*) AS total FROM players ${where}`).toArray()[0]?.total ?? 0;
    const rows = this.ctx.storage.sql.exec<PlayerRow>(
      `SELECT * FROM players ${where} ORDER BY ${SORT_SQL[sort]} ${direction}, kills DESC, matches DESC, key ASC
       LIMIT ? OFFSET ?`,
      limit, offset,
    ).toArray();
    return {
      sort, order, limit, offset, total, source: "dedicated",
      entries: rows.map((row, index) => ({ ...Stats.stats(row), rank: offset + index + 1 })),
    };
  }

  /* A player's record by their row key (profile:…, wallet:…, guest:…),
     or by their public id; null for nobody. */
  async player(lookup: { key?: string; publicId?: string }): Promise<PlayerView | null> {
    let row: PlayerRow | null = null;
    if (lookup.key !== undefined) row = this.playerRow(lookup.key);
    if (row === null && lookup.publicId !== undefined) {
      row = this.ctx.storage.sql
        .exec<PlayerRow>("SELECT * FROM players WHERE public_id = ? COLLATE NOCASE", lookup.publicId).toArray()[0] ?? null;
    }
    if (row === null) return null;
    const rankBy = (column: "kills" | "wins"): number => (this.ctx.storage.sql
      .exec<{ ahead: number }>(`SELECT COUNT(*) AS ahead FROM players WHERE ${column} > ?`, row![column])
      .toArray()[0]?.ahead ?? 0) + 1;
    const recent = this.ctx.storage.sql.exec<MatchPlayerRow>(
      `SELECT mp.*, m.playlist, m.map_index, m.mode_index, m.teams, m.ended_at
       FROM match_players mp JOIN matches m ON m.match_id = mp.match_id
       WHERE mp.key = ? ORDER BY m.ended_at DESC LIMIT ?`,
      row.key, RECENT_MATCHES,
    ).toArray();
    return {
      ...Stats.stats(row),
      ranks: { kills: rankBy("kills"), wins: rankBy("wins") },
      recent: recent.map((line) => ({
        matchId: line.match_id,
        playlist: line.playlist,
        mapIndex: line.map_index,
        modeIndex: line.mode_index,
        teams: line.teams === 1,
        team: line.team,
        score: line.score,
        kills: line.kills,
        deaths: line.deaths,
        outcome: line.outcome as MatchOutcome,
        quit: line.quit === 1,
        wagerNet: line.wager_net,
        endedAt: line.ended_at,
      })),
    };
  }
}

/* ---------- the matchmaker's report */

/* a finished match's ticket, as the matchmaker holds it */
export interface MatchStatsTicket {
  identifier: string;
  wallet: string | null;
  playerKey: string | null;
}

/* the room's record of a match (src/room.ts): who sat where under which
   name, and the kills the server reported, by name */
export interface RoomSeat {
  identifier: string;
  name: string;
  wallet: string | null;
}

export interface RoomKillCount {
  name: string;
  kills: number;
  deaths: number;
}

export interface RoomRoster {
  seats: RoomSeat[];
  kills: RoomKillCount[];
}

/* The server's result names players; the tickets name machines and
   wallets. The room, which saw each player's profile, joins the two. A
   wagering player plays under their wallet's name, so a wallet ticket
   matches its name even without a seat. A name two players shared is
   nobody's: no stats for either. */
export function resolveMatchPlayers(
  result: MatchResult, tickets: MatchStatsTicket[], roster: RoomRoster,
): MatchStatsPlayer[] {
  const byIdentifier = new Map(tickets.map((ticket) => [ticket.identifier.toLowerCase(), ticket]));
  const byWalletName = new Map<string, MatchStatsTicket>();
  for (const ticket of tickets) if (ticket.wallet !== null) byWalletName.set(walletPlayerName(ticket.wallet), ticket);
  const killsByName = new Map(roster.kills.map((count) => [count.name, count]));
  const out: MatchStatsPlayer[] = [];
  for (const player of result.players) {
    const seats = roster.seats.filter((seat) => seat.name === player.name);
    if (seats.length > 1) continue;
    const seat = seats[0];
    const ticket = seat ? byIdentifier.get(seat.identifier.toLowerCase()) ?? null : byWalletName.get(player.name) ?? null;
    const wallet = seat?.wallet ?? ticket?.wallet ?? null;
    const playerKey = ticket?.playerKey ?? null;
    if (wallet === null && playerKey === null) continue;
    const counted = killsByName.get(player.name);
    out.push({
      name: player.name,
      team: player.team,
      score: player.score,
      quit: player.quit,
      /* without the room's count, the score is the nearest thing to kills */
      kills: counted ? counted.kills : Math.max(0, player.score),
      deaths: counted ? counted.deaths : 0,
      wallet,
      playerKey,
    });
  }
  return out;
}

export interface FinishedMatch {
  matchId: string;
  playlist: string;
  mapIndex: number;
  modeIndex: number;
  roomId: string | null;
  stake: number | null;
  tickets: MatchStatsTicket[];
  result: MatchResult;
  now: number;
}

/* The matchmaker's hand-off of a finished match: asks the room who played
   under which name, then records the match. Best effort: a failure here
   never touches the match itself. */
export async function reportMatchStats(env: Pick<Env, "ROOMS" | "STATS">, match: FinishedMatch): Promise<boolean> {
  let roster: RoomRoster = { seats: [], kills: [] };
  if (match.roomId !== null) {
    try {
      roster = await env.ROOMS.getByName(match.roomId).matchRoster();
    } catch {
      /* the room is gone: wallets still match by name */
    }
  }
  const players = resolveMatchPlayers(match.result, match.tickets, roster);
  if (players.length === 0) return false;
  try {
    return await env.STATS.getByName(STATS_NAME).recordMatch({
      matchId: match.matchId,
      playlist: match.playlist,
      mapIndex: match.mapIndex,
      modeIndex: match.modeIndex,
      teams: match.result.teams,
      teamScores: match.result.teamScores,
      stake: match.stake,
      endedAt: match.now,
      players,
    }, match.now);
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      matchId: match.matchId,
      message: "match stats not recorded",
    }));
    return false;
  }
}

/* A settled wager's hand-off (src/wager.ts): each wallet's payout against
   its stake. */
export async function reportWagerNet(
  env: Pick<Env, "STATS">,
  record: { matchId: string; stake: number; payouts: number[] | null; players: Array<{ wallet: string }> },
): Promise<boolean> {
  if (record.payouts === null) return false;
  const nets = record.players.flatMap((player, index) => {
    const payout = record.payouts![index];
    return payout === undefined ? [] : [{ wallet: player.wallet, net: payout - record.stake }];
  });
  try {
    return await env.STATS.getByName(STATS_NAME).recordWagerNet(record.matchId, nets);
  } catch (error) {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      matchId: record.matchId,
      message: "wager net not recorded",
    }));
    return false;
  }
}

/* ---------- the routes */

const PLAYER_ROUTE = /^\/v1\/players\/([^/]{1,64})$/u;

function looksLikeUsername(value: string): boolean {
  return value.length >= USERNAME_MIN_LENGTH && value.length <= USERNAME_MAX_LENGTH && USERNAME_PATTERN.test(value);
}

/* GET /v1/leaderboard?sort=kills|wins|kd|matches|score|net&order=desc&limit=25&offset=0
   GET /v1/players/:id   a username (with or without @), a wallet, a guest's
                         public id, or a browser's own player key (which is
                         never echoed back)
   Null for any other request. */
export async function handleStatsRequest(request: Request, env: RuntimeEnv, url: URL): Promise<unknown | null> {
  if (request.method !== "GET") return null;
  if (url.pathname === "/v1/leaderboard") {
    const sort = url.searchParams.get("sort") ?? "kills";
    if (!isLeaderboardSort(sort)) {
      throw new HttpError(400, "VALIDATION_FAILED", `sort is one of ${LEADERBOARD_SORTS.join(", ")}.`);
    }
    const order = url.searchParams.get("order") ?? "desc";
    if (order !== "asc" && order !== "desc") throw new HttpError(400, "VALIDATION_FAILED", "order is asc or desc.");
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : LEADERBOARD_PAGE_DEFAULT;
    const offset = url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > LEADERBOARD_PAGE_MAX || !Number.isInteger(offset) || offset < 0) {
      throw new HttpError(400, "VALIDATION_FAILED", `limit is 1 to ${LEADERBOARD_PAGE_MAX}; offset is 0 or more.`);
    }
    return { leaderboard: await env.STATS.getByName(STATS_NAME).leaderboard({ sort, order, limit, offset }) };
  }
  const playerMatch = PLAYER_ROUTE.exec(url.pathname);
  if (playerMatch) {
    const id = decodeURIComponent(playerMatch[1]!);
    const player = await lookUpPlayer(env, id);
    if (player === null) throw new HttpError(404, "PLAYER_NOT_FOUND", "No matches on record for that player.");
    return { player };
  }
  return null;
}

async function lookUpPlayer(env: RuntimeEnv, id: string): Promise<PlayerView | null> {
  const stats = env.STATS.getByName(STATS_NAME);
  const named = id.startsWith("@") ? id.slice(1) : id;
  if (looksLikeUsername(named)) {
    const profile = await env.PROFILES.getByName(PROFILES_NAME).publicProfile(named.toLowerCase());
    if (profile !== null) return stats.player({ key: `profile:${profile.id}` });
    if (id.startsWith("@")) return null;
  }
  if (WALLET_PATTERN.test(id)) {
    const profiles = await env.PROFILES.getByName(PROFILES_NAME).publicProfilesForWallets([id]);
    const profile = profiles[id];
    return stats.player(profile ? { key: `profile:${profile.id}` } : { key: `wallet:${id}` });
  }
  if (GUEST_ID_PATTERN.test(id)) return stats.player({ key: `guest:${id}` });
  if (PLAYER_KEY_PATTERN.test(id)) return stats.player({ key: `guest:${await guestId(id)}` });
  return null;
}
