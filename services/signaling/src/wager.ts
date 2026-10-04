import { DurableObject } from "cloudflare:workers";

import { ed25519 } from "@noble/curves/ed25519.js";

import type { RuntimeEnv } from "./env";
import {
  ESCROW_PROGRAM_ID,
  assembleTransaction,
  closeMatchInstruction,
  compileMessage,
  createMatchInstruction,
  decodeMatch,
  decodeVault,
  escrowMatchId,
  type Instruction,
  joinMatchInstruction,
  matchAddress,
  settleInstruction,
  vaultAddress,
  voidMatchInstruction,
} from "./escrow";
import { alert } from "./alerts";
import { MATCHMAKER_NAME } from "./matchmaker";
import { SolanaRpc, SolanaRpcError, base58Encode, keypairFromSecret, type Keypair, walletPlayerName } from "./solana";

/* A wagered match's money: one Durable Object per match (named by the
   matchmaker's match ID) that locks the players' stakes in the escrow
   program (services/escrow), keeps the match's per-kill balances, and pays
   the match out when it ends.

   Bounty rules: everyone stakes the same. Each kill moves the per-kill
   amount (or what the victim has left, if less) from the victim's balance to
   the killer's; suicides and betrayals move nothing. A player whose balance
   is spent plays on for nothing. At the end each player is paid their
   balance, less the fee on what they won.

   Team rules (Team Stakes; stakesOutcome below): players are scoring
   groups, a team game's teams or each player alone in a free-for-all.
   Everyone who stayed in a top-scoring group wins. Each winner gets their
   stake back; every other stake (the losers', and any quitter's) is
   forfeited and, less the fee, is the prize. A share of the prize (the
   team share) is split evenly among the winners; the rest (the kill pool)
   pays each winner's kills at kill pool / kill target. Kill money nobody
   earned is split evenly too. A whole group that dropped out while another
   stayed puts the match on hold for an admin: the stakes stay locked until
   a decision, or forfeit by themselves at the hold's deadline. A tie among
   everyone who stayed, or no result, is void.

   A void (the server lost, or the match never went live) returns every
   stake.

   Every chain step reads the match's account first, so a retry after an
   unknown outcome never does anything twice. */

export interface WagerPlayer {
  wallet: string;
  name: string;
  /* lamports this player holds in the match */
  balance: number;
  kills: number;
  deaths: number;
}

export type WagerMode = "bounty" | "team";

/* How a Team Stakes match pays (the "team" mode), from the playlist or,
   later, a custom game's settings; stored with the match when it forms. */
export interface StakesConfig {
  /* lamports per player */
  stake: number;
  /* the variant's score to win: one group's kill limit, at least 1 */
  killTarget: number;
  /* the part of the prize split evenly among the winners, 0..10000 */
  teamShareBps: number;
  /* scoring groups to expect, for the projection during the match: 2 for a
     two-team game, 0 for a free-for-all (every player their own group) */
  groups: number;
}

/* A dedicated server's result for a match as it ended
   (services/game-server/gateway, matchResult). */
export interface MatchResult {
  teams: boolean;
  teamScores: [number, number];
  players: Array<{ name: string; team: number; score: number; quit: boolean }>;
}

/* "held": the stakes stay locked, waiting for an admin or the hold's
   deadline (a whole group dropped out). */
export type WagerState = "locking" | "locked" | "failed" | "held" | "settling" | "voiding" | "settled" | "void";

/* A Team Stakes settlement: what each player is paid, in join order. */
export interface StakesSettlement {
  payouts: number[];
  fee: number;
  /* the top-scoring groups whose stayers won (a team index, or a player's
     index in a free-for-all) */
  winningGroups: number[];
  /* what one kill paid */
  perKill: number;
  killShares: number[];
  evenShares: number[];
}

export type StakesOutcome =
  | { kind: "void"; reason: string }
  | { kind: "hold"; reason: string; dropped: number[]; proposed: StakesSettlement }
  | ({ kind: "settle" } & StakesSettlement);

export interface WagerHoldEntry {
  at: number;
  by: string;
  action: "held" | "extended" | "decided" | "expired";
  detail: unknown;
}

export interface WagerHold {
  reason: string;
  /* the groups with nobody left */
  dropped: number[];
  since: number;
  /* when the hold forfeits by itself (the alarm), ms */
  deadline: number;
  /* the latest deadline an extension may set: an hour before the players
     can reclaim their stakes themselves; null until the chain has been read */
  limit: number | null;
  history: WagerHoldEntry[];
  decision: { at: number; by: string; action: "forfeit" | "void"; note: string } | null;
}

interface WagerRecord {
  matchId: string;
  /* the match's 16-byte ID on chain, hex */
  escrowId: string;
  stake: number;
  perKill: number;
  /* absent on wagers from before team matches: bounty */
  mode?: WagerMode;
  /* a team match's rules; absent on records from before (see stakesConfigOf) */
  config?: StakesConfig;
  feeBps: number;
  state: WagerState;
  /* an end that arrived while the stakes were still locking, and the hold
     it asks for */
  ending: "settle" | "void" | "hold" | null;
  pendingHold?: { reason: string; dropped: number[] } | null;
  /* a team match's payouts, decided from the server's result at the end
     (records from before this field's settlement) */
  teamPayouts?: number[] | null;
  settlement?: StakesSettlement | null;
  /* the server's result, as received, for the audit trail */
  result?: MatchResult | null;
  hold?: WagerHold | null;
  /* the winning team (0 red, 1 blue), for the lobby */
  winningTeam?: number | null;
  players: WagerPlayer[];
  /* the match's account has been closed (its rent refunded) */
  closed: boolean;
  attempts: number;
  signatures: Partial<Record<"lock" | "settle" | "void" | "close", string>>;
  payouts: number[] | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WagerView {
  matchId: string;
  state: WagerState;
  mode: WagerMode;
  winningTeam: number | null;
  stake: number;
  /* a bounty's per kill; a team match's projected value of one kill */
  perKill: number;
  feeBps: number;
  pot: number;
  /* a team match: its rules, the projected even share of a winner, and the
     hold if it is held */
  config: StakesConfig | null;
  floor: number | null;
  hold: { reason: string; dropped: number[]; since: number; deadline: number; limit: number | null } | null;
  players: Array<WagerPlayer & {
    net: number;
    payout: number | null;
    spent: boolean;
    /* a team match: what this player takes home if their group wins now */
    projected: number | null;
    /* a settled team match: the parts of a winner's payout */
    killShare: number | null;
    evenShare: number | null;
  }>;
  signatures: WagerRecord["signatures"];
  cluster: string;
  error: string | null;
}

/* The full record, for an admin. */
export interface WagerAdminView {
  view: WagerView;
  config: StakesConfig | null;
  hold: WagerHold | null;
  result: MatchResult | null;
  settlement: StakesSettlement | null;
  payouts: number[] | null;
  createdAt: number;
  updatedAt: number;
}

export interface WagerStart {
  matchId: string;
  stake: number;
  perKill: number;
  mode?: WagerMode;
  /* a team match's rules */
  stakes?: StakesConfig | null;
  wallets: string[];
}

const RECORD_KEY = "wager";
/* tries at a transaction the network refuses before giving up on it */
const LOCK_ATTEMPTS = 3;
const SETTLE_ATTEMPTS = 12;
/* a hold forfeits by itself after this long, unless extended */
export const HOLD_MS = 12 * 60 * 60_000;
/* a hold always ends this long before the players can reclaim their stakes
   themselves (the program's reclaim delay), or the settle would fail */
export const HOLD_MARGIN_MS = 60 * 60_000;
export const DEFAULT_TEAM_SHARE_BPS = 2_500;
/* the kill target a record from before the stakes configuration played by:
   the dedicated Team Slayer variant's score to win */
const LEGACY_KILL_TARGET = 50;

/* ---------- the rules, kept pure for the tests */

/* What a kill moves: the per-kill amount, or what the victim has left. */
export function killTransfer(players: WagerPlayer[], killer: number, victim: number, perKill: number): number {
  if (killer === victim || killer < 0 || victim < 0) return 0;
  return Math.max(0, Math.min(perKill, players[victim]!.balance));
}

/* Each player's payout: their balance, less the fee on what they won. The
   fee is what the payouts leave of the pot, at most feeBps of the winnings
   and so of the pot. */
export function bountyPayouts(stake: number, balances: number[], feeBps: number): { payouts: number[]; fee: number } {
  const payouts = balances.map((balance) => {
    const won = balance - stake;
    return won > 0 ? balance - Math.floor((won * feeBps) / 10_000) : balance;
  });
  const fee = stake * balances.length - payouts.reduce((sum, payout) => sum + payout, 0);
  return { payouts, fee };
}

/* A stakes configuration a match may run under, or why not. */
export function stakesConfigProblem(config: StakesConfig): string | null {
  if (!Number.isSafeInteger(config.stake) || config.stake <= 0) return "the stake must be a positive number of lamports";
  if (!Number.isSafeInteger(config.killTarget) || config.killTarget < 1) return "the kill target must be at least 1";
  if (!Number.isSafeInteger(config.teamShareBps) || config.teamShareBps < 0 || config.teamShareBps > 10_000) {
    return "the team share must be 0 to 10000 basis points";
  }
  if (!Number.isSafeInteger(config.groups) || config.groups < 0) return "the groups must be 0 (free-for-all) or more";
  return null;
}

/* A Team Stakes match's outcome from the server's result, every amount in
   whole lamports (the arithmetic is BigInt: no lamport is ever rounded
   away). `players` are the match's players as they joined, with the kills
   the Worker counted for each (enemy kills: the server never reports
   suicides or betrayals).

   Groups: a team game's teams, by the result's team index; a free-for-all's
   players, each their own. A player missing from the result, or flagged
   quit, did not stay.

   - Every group gone: void. Some gone while others stayed: hold, with the
     settlement below (the gone groups as losers) as what a forfeit pays.
   - The winners are everyone who stayed in a top-scoring group among the
     groups that stayed; equal top scores all win. Everyone a winner: void.
   - L = pot − stake × winners is forfeited; F = L × feeBps / 10000 is the
     fee; D = L − F the prize; T = D × teamShareBps / 10000 the team share
     pool; Kp = D − T the kill pool.
   - A kill is worth Kp / max(killTarget, the winners' kills): exactly
     Kp / killTarget unless the winners made more kills than the target
     (betrayals cost Halo's score, not the kill count), when the pool is
     shared pro rata so it never overpays. Winner i's kill share is
     Kp × kills_i / that, floored.
   - E = D − the kill shares (the team share, kill money nobody earned, and
     rounding dust) is split evenly; the odd lamports go one each to the
     winners with the most kills, join order breaking ties.
   - A winner is paid stake + kill share + even share; everyone else 0. The
     payouts and the fee add up to the pot exactly; the fee is within the
     program's cap because L ≤ pot. */
export function stakesOutcome(
  config: StakesConfig,
  players: Array<{ name: string; kills: number }>,
  result: MatchResult | null,
  feeBps: number,
): StakesOutcome {
  if (!result) return { kind: "void", reason: "no result" };
  const byName = new Map(result.players.map((player) => [player.name, player]));
  const rows = players.map((player) => byName.get(player.name));
  const groupOf = (index: number): number => {
    const row = rows[index];
    if (!row) return -1;
    return result.teams ? row.team : index;
  };
  const stayed = (index: number): boolean => {
    const row = rows[index];
    return row !== undefined && !row.quit && groupOf(index) >= 0;
  };
  const scoreOf = (group: number): number => {
    if (result.teams) return result.teamScores[group] ?? 0;
    return rows[group]?.score ?? 0;
  };
  const groups = [...new Set(players.map((_, index) => groupOf(index)).filter((group) => group >= 0))];
  const stayers = (group: number) => players.filter((_, index) => groupOf(index) === group && stayed(index)).length;
  const alive = groups.filter((group) => stayers(group) > 0);
  const dropped = groups.filter((group) => stayers(group) === 0);
  if (alive.length === 0) return { kind: "void", reason: "nobody stayed" };
  const top = Math.max(...alive.map(scoreOf));
  const winningGroups = alive.filter((group) => scoreOf(group) === top);
  const winner = players.map((_, index) => winningGroups.includes(groupOf(index)) && stayed(index));
  const w = BigInt(winner.filter(Boolean).length);
  const S = BigInt(config.stake);
  const P = S * BigInt(players.length);
  const L = P - S * w;
  if (L === 0n) return { kind: "void", reason: "everyone who stayed tied" };
  const F = (L * BigInt(feeBps)) / 10_000n;
  const D = L - F;
  const T = (D * BigInt(config.teamShareBps)) / 10_000n;
  const Kp = D - T;
  const K = BigInt(config.killTarget);
  const killsW = players.reduce((sum, player, index) => sum + (winner[index] ? BigInt(Math.max(0, player.kills)) : 0n), 0n);
  const denom = killsW > K ? killsW : K;
  const killShares = players.map((player, index) => (winner[index] ? (Kp * BigInt(Math.max(0, player.kills))) / denom : 0n));
  const E = D - killShares.reduce((sum, share) => sum + share, 0n);
  const even = E / w;
  let dust = E - even * w;
  const evenShares = players.map((_, index) => (winner[index] ? even : 0n));
  const order = players.map((_, index) => index).filter((index) => winner[index])
    .sort((a, b) => players[b]!.kills - players[a]!.kills || a - b);
  for (const index of order) {
    if (dust === 0n) break;
    evenShares[index] = evenShares[index]! + 1n;
    dust -= 1n;
  }
  const settlement: StakesSettlement = {
    payouts: players.map((_, index) => Number(winner[index] ? S + killShares[index]! + evenShares[index]! : 0n)),
    fee: Number(F),
    winningGroups,
    perKill: Number(Kp / denom),
    killShares: killShares.map(Number),
    evenShares: evenShares.map(Number),
  };
  if (dropped.length > 0) {
    return { kind: "hold", reason: `group ${dropped.join(", ")} dropped out`, dropped, proposed: settlement };
  }
  return { kind: "settle", ...settlement };
}

/* What a Team Stakes match looks like before its result: the value of one
   kill and a winner's even share, as if the groups were equal (the Worker
   learns the real groups only from the result). */
export function stakesProjection(
  config: StakesConfig,
  playerCount: number,
  feeBps: number,
): { perKill: number; floor: number; prize: number; winners: number } {
  const winners = config.groups > 0 ? Math.max(1, Math.floor(playerCount / config.groups)) : 1;
  const S = BigInt(config.stake);
  const L = S * BigInt(Math.max(0, playerCount - winners));
  const D = L - (L * BigInt(feeBps)) / 10_000n;
  const T = (D * BigInt(config.teamShareBps)) / 10_000n;
  return {
    perKill: Number((D - T) / BigInt(config.killTarget)),
    floor: Number(T / BigInt(winners)),
    prize: Number(D),
    winners,
  };
}

/* A player's projected take if their group wins now: their stake, the even
   share, and their kills' worth, never more than the whole prize. */
export function stakesProjected(config: StakesConfig, playerCount: number, feeBps: number, kills: number): number {
  const projection = stakesProjection(config, playerCount, feeBps);
  return config.stake + Math.min(projection.prize, projection.floor + Math.max(0, kills) * projection.perKill);
}

/* The rules a record plays by: its own, or the ones a record from before
   the stakes configuration played by. */
function stakesConfigOf(record: WagerRecord): StakesConfig {
  return record.config ?? { stake: record.stake, killTarget: LEGACY_KILL_TARGET, teamShareBps: DEFAULT_TEAM_SHARE_BPS, groups: 2 };
}

/* ---------- configuration */

export interface EscrowSetup {
  authority: Keypair;
  feeVault: string;
  feeBps: number;
  sessionSecret: string;
  cluster: string;
}

export async function escrowSetup(env: RuntimeEnv): Promise<EscrowSetup | null> {
  if (!env.ESCROW_AUTHORITY_SECRET_KEY || !env.ESCROW_SESSION_SECRET || !env.ESCROW_FEE_VAULT) return null;
  const feeBps = Number(env.ESCROW_FEE_BPS ?? "500");
  return {
    authority: await keypairFromSecret(env.ESCROW_AUTHORITY_SECRET_KEY),
    feeVault: env.ESCROW_FEE_VAULT,
    feeBps: Number.isSafeInteger(feeBps) && feeBps >= 0 && feeBps <= 1_000 ? feeBps : 500,
    sessionSecret: env.ESCROW_SESSION_SECRET,
    cluster: env.SOLANA_CLUSTER ?? "devnet",
  };
}

/* The session key the game joins matches with for a wallet: derived from a
   secret, so it is never stored. The player approves it, with a spending
   limit and an expiry, when they load up their vault. */
export async function sessionKeypair(secret: string, wallet: string): Promise<Keypair> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const seed = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`halo-session:${ESCROW_PROGRAM_ID}:${wallet}`)),
  );
  const secretKey = new Uint8Array(64);
  secretKey.set(seed);
  secretKey.set(ed25519.getPublicKey(seed), 32);
  return keypairFromSecret(base58Encode(secretKey));
}

/* A private RPC endpoint (it carries an API key) first, then the public ones. */
export function escrowRpc(env: RuntimeEnv): SolanaRpc {
  return new SolanaRpc(
    [env.SOLANA_RPC_PRIVATE_URL, env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com"]
      .filter((url) => typeof url === "string" && url.length > 0)
      .join(","),
  );
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unhex(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../gu)!.map((pair) => parseInt(pair, 16)));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Wager extends DurableObject<Env> {
  private get env_(): RuntimeEnv {
    return this.env as unknown as RuntimeEnv;
  }

  private read(): WagerRecord | null {
    return (this.ctx.storage.kv.get(RECORD_KEY) as WagerRecord | undefined) ?? null;
  }

  private write(record: WagerRecord): void {
    record.updatedAt = Date.now();
    this.ctx.storage.kv.put(RECORD_KEY, record);
  }

  /* The matchmaker formed the match: lock the stakes. */
  async start(input: WagerStart): Promise<void> {
    if (this.read()) return;
    const setup = await escrowSetup(this.env_);
    const now = Date.now();
    const mode = input.mode ?? "bounty";
    let config: StakesConfig | undefined;
    if (mode === "team") {
      config = input.stakes ?? { stake: input.stake, killTarget: LEGACY_KILL_TARGET, teamShareBps: DEFAULT_TEAM_SHARE_BPS, groups: 2 };
      const problem = stakesConfigProblem(config);
      if (problem !== null || config.stake !== input.stake) throw new Error(`bad stakes configuration: ${problem ?? "the stake differs"}`);
    }
    this.write({
      matchId: input.matchId,
      escrowId: hex(await escrowMatchId(input.matchId)),
      stake: input.stake,
      perKill: input.perKill,
      mode,
      ...(config ? { config } : {}),
      feeBps: setup?.feeBps ?? 500,
      state: "locking",
      ending: null,
      players: input.wallets.map((wallet) => ({
        wallet, name: walletPlayerName(wallet), balance: input.stake, kills: 0, deaths: 0,
      })),
      closed: false,
      attempts: 0,
      signatures: {},
      payouts: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    });
    await this.ctx.storage.setAlarm(now);
  }

  /* A kill on the match's server, by in-game names. */
  async kill(killerName: string, victimName: string): Promise<{ moved: number; view: WagerView } | null> {
    const record = this.read();
    if (!record || record.state !== "locked") return null;
    const killer = record.players.findIndex((player) => player.name === killerName);
    const victim = record.players.findIndex((player) => player.name === victimName);
    if (victim >= 0) record.players[victim]!.deaths += 1;
    if (killer >= 0 && killer !== victim) record.players[killer]!.kills += 1;
    /* a team match's money follows only its result */
    const moved = record.mode === "team" ? 0 : killTransfer(record.players, killer, victim, record.perKill);
    if (moved > 0) {
      record.players[victim]!.balance -= moved;
      record.players[killer]!.balance += moved;
    }
    this.write(record);
    return { moved, view: this.view(record) };
  }

  /* The match is over: finished pays it out (a team match by the server's
     result, or holds it when a whole group dropped out), anything else
     voids it. */
  async end(finished: boolean, result: MatchResult | null = null): Promise<void> {
    const record = this.read();
    if (!record) return;
    let outcome: "settle" | "void" | "hold";
    let hold: { reason: string; dropped: number[] } | null = null;
    if (record.mode === "team") {
      const stakes = finished ? stakesOutcome(stakesConfigOf(record), record.players, result, record.feeBps) :
        { kind: "void" as const, reason: "not finished" };
      const settlement = stakes.kind === "settle" ? stakes : stakes.kind === "hold" ? stakes.proposed : null;
      record.result = result;
      record.settlement = settlement;
      record.winningTeam = settlement?.winningGroups[0] ?? null;
      outcome = stakes.kind;
      if (stakes.kind === "hold") hold = { reason: stakes.reason, dropped: stakes.dropped };
    } else {
      outcome = finished && record.players.some((player) => player.balance !== record.stake) ? "settle" : "void";
    }
    if (record.state === "locking") {
      record.ending = outcome;
      record.pendingHold = hold;
    } else if (record.state === "locked") {
      if (hold) this.beginHold(record, hold);
      else {
        record.state = outcome === "settle" ? "settling" : "voiding";
        record.attempts = 0;
      }
    } else {
      return;
    }
    this.write(record);
    await this.ctx.storage.setAlarm(Date.now());
  }

  /* The match waits for an admin: the alarm (now) reads the chain for the
     hold's ceiling and tells the log, then fires again at the deadline. */
  private beginHold(record: WagerRecord, hold: { reason: string; dropped: number[] }): void {
    const now = Date.now();
    record.state = "held";
    record.attempts = 0;
    record.hold = {
      reason: hold.reason,
      dropped: hold.dropped,
      since: now,
      deadline: now + HOLD_MS,
      limit: null,
      history: [{ at: now, by: "match", action: "held", detail: {
        reason: hold.reason, dropped: hold.dropped, result: record.result ?? null,
        proposed: record.settlement ?? null,
      } }],
      decision: null,
    };
  }

  async snapshot(): Promise<WagerView | null> {
    const record = this.read();
    return record ? this.view(record) : null;
  }

  /* ---------- a held match, for an admin */

  async adminView(): Promise<WagerAdminView | null> {
    const record = this.read();
    if (!record) return null;
    return {
      view: this.view(record),
      config: record.mode === "team" ? stakesConfigOf(record) : null,
      hold: record.hold ?? null,
      result: record.result ?? null,
      settlement: record.settlement ?? null,
      payouts: record.payouts,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  /* An admin ends a hold: forfeit pays the settlement proposed when the
     match was held; void returns every stake. Null unless the match is
     held. */
  async decide(action: "forfeit" | "void", by: string, note: string): Promise<WagerView | null> {
    const record = this.read();
    if (!record || record.state !== "held" || !record.hold) return null;
    const now = Date.now();
    record.hold.decision = { at: now, by, action, note };
    record.hold.history.push({ at: now, by, action: "decided", detail: { action, note } });
    record.state = action === "forfeit" ? "settling" : "voiding";
    record.attempts = 0;
    record.error = null;
    this.write(record);
    await this.report(record, "hold_decided", { action, by, note });
    await this.ctx.storage.setAlarm(now);
    return this.view(record);
  }

  /* An admin gives a hold longer, up to its ceiling. Null unless held. */
  async extendHold(hours: number, by: string, note: string): Promise<{ deadline: number; limit: number | null; clamped: boolean } | null> {
    const record = this.read();
    if (!record || record.state !== "held" || !record.hold) return null;
    const now = Date.now();
    const wanted = Math.max(record.hold.deadline, now) + hours * 60 * 60_000;
    const clamped = record.hold.limit !== null && wanted > record.hold.limit;
    record.hold.deadline = clamped ? record.hold.limit! : wanted;
    record.hold.history.push({ at: now, by, action: "extended", detail: { hours, note, deadline: record.hold.deadline, clamped } });
    this.write(record);
    await this.report(record, "hold_extended", { by, note, deadline: record.hold.deadline, limit: record.hold.limit, clamped });
    await this.ctx.storage.setAlarm(record.hold.deadline);
    return { deadline: record.hold.deadline, limit: record.hold.limit, clamped };
  }

  /* The payouts a settle pays: the team result's, or the bounty balances'. */
  private payoutsFor(record: WagerRecord): number[] {
    if (record.mode === "team") {
      return record.settlement?.payouts ?? record.teamPayouts ?? record.players.map(() => record.stake);
    }
    return bountyPayouts(record.stake, record.players.map((player) => player.balance), record.feeBps).payouts;
  }

  private view(record: WagerRecord): WagerView {
    const payouts = record.payouts ?? (record.state === "settling" || record.state === "settled" ?
      this.payoutsFor(record) : null);
    const team = record.mode === "team";
    const config = team ? stakesConfigOf(record) : null;
    const projection = config ? stakesProjection(config, record.players.length, record.feeBps) : null;
    const settled = record.state === "settling" || record.state === "settled" ? record.settlement ?? null : null;
    const live = record.state === "locking" || record.state === "locked";
    return {
      matchId: record.matchId,
      state: record.state,
      mode: record.mode ?? "bounty",
      winningTeam: record.winningTeam ?? null,
      stake: record.stake,
      perKill: settled ? settled.perKill : projection ? projection.perKill : record.perKill,
      feeBps: record.feeBps,
      pot: record.stake * record.players.length,
      config,
      floor: projection ? projection.floor : null,
      hold: record.hold && record.state === "held" ? {
        reason: record.hold.reason, dropped: record.hold.dropped, since: record.hold.since,
        deadline: record.hold.deadline, limit: record.hold.limit,
      } : null,
      players: record.players.map((player, index) => ({
        ...player,
        net: player.balance - record.stake,
        payout: record.state === "void" || record.state === "voiding" ? record.stake : payouts?.[index] ?? null,
        spent: !team && player.balance === 0,
        projected: config && live ? stakesProjected(config, record.players.length, record.feeBps, player.kills) : null,
        killShare: settled?.killShares[index] ?? null,
        evenShare: settled?.evenShares[index] ?? null,
      })),
      signatures: record.signatures,
      cluster: this.env_.SOLANA_CLUSTER ?? "devnet",
      error: record.error,
    };
  }

  /* ---------- the chain work, driven by the alarm */

  override async alarm(): Promise<void> {
    const record = this.read();
    if (!record) return;
    const setup = await escrowSetup(this.env_);
    if (!setup) {
      record.error = "The escrow is not set up on this server.";
      if (record.state === "locking") await this.lockFailed(record, record.error);
      else this.write(record);
      return;
    }
    try {
      const again = await this.step(record, setup);
      if (again !== null) await this.ctx.storage.setAlarm(Date.now() + again);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ message: "wager step failed", matchId: record.matchId, state: record.state, error: message }));
      const latest = this.read() ?? record;
      latest.error = message.slice(0, 300);
      this.write(latest);
      await this.ctx.storage.setAlarm(Date.now() + Math.min(60_000, 2_000 * 2 ** Math.min(latest.attempts, 5)));
    }
  }

  /* One step; the delay before the next, or null when there is nothing more
     to do. */
  private async step(record: WagerRecord, setup: EscrowSetup): Promise<number | null> {
    const rpc = escrowRpc(this.env_);
    const matchId = unhex(record.escrowId);
    const address = await matchAddress(matchId);
    const owners = record.players.map((player) => player.wallet);

    if (record.state === "locking") {
      const onChain = decodeMatch((await rpc.accountData(address)) ?? new Uint8Array());
      if (onChain && onChain.players.length === owners.length) {
        if (record.ending === "hold") {
          this.beginHold(record, record.pendingHold ?? { reason: "a group dropped out", dropped: [] });
        } else {
          record.state = record.ending === "settle" ? "settling" : record.ending === "void" ? "voiding" : "locked";
          record.attempts = 0;
        }
        record.error = null;
        this.write(record);
        await this.env.MATCHMAKER.getByName(MATCHMAKER_NAME).escrowLocked(record.matchId, true, null);
        return record.state === "locked" ? null : 0;
      }
      if (record.ending !== null) {
        /* over before it was locked: nothing on chain to undo */
        await this.lockFailed(record, "The match ended before the stakes were locked.");
        return null;
      }
      const instructions: Instruction[] = [
        await createMatchInstruction(setup.authority.address, matchId, BigInt(record.stake), owners.length),
      ];
      const sessions: Keypair[] = [];
      for (const owner of owners) {
        const session = await sessionKeypair(setup.sessionSecret, owner);
        sessions.push(session);
        instructions.push(await joinMatchInstruction(setup.authority.address, matchId, owner, session.address));
      }
      const outcome = await this.submit(rpc, setup.authority, instructions, sessions, record, "lock");
      if (outcome === "rejected") {
        record.attempts += 1;
        if (record.attempts >= LOCK_ATTEMPTS) {
          await this.lockFailed(record, record.error ?? "The stakes could not be locked.");
          return null;
        }
        this.write(record);
        return 1_000;
      }
      return 0;
    }

    if (record.state === "held" && record.hold) {
      const hold = record.hold;
      const now = Date.now();
      if (hold.limit === null) {
        /* the ceiling: the players can reclaim their stakes themselves once
           the program's reclaim delay has passed, and a settle after that
           fails; an hour's margin before it */
        const onChain = decodeMatch((await rpc.accountData(address)) ?? new Uint8Array());
        if (onChain) {
          hold.limit = Math.max(now, (onChain.createdAt + onChain.reclaimDelay) * 1000 - HOLD_MARGIN_MS);
          if (hold.deadline > hold.limit) hold.deadline = hold.limit;
        }
        this.write(record);
        await this.report(record, "held", {
          reason: hold.reason, dropped: hold.dropped, deadline: hold.deadline, limit: hold.limit,
        });
        await alert(this.env_, `hold:${record.matchId}`,
          `match ${record.matchId}: ${hold.reason}; its stakes are held for an admin until ` +
          `${new Date(hold.deadline).toISOString()} (GET /v1/admin/wagers/held; POST .../${record.matchId}/decide or /hold)`);
      }
      if (now < hold.deadline) return hold.deadline - now;
      /* the deadline: the forfeit proposed when the match was held */
      hold.decision = { at: now, by: "deadline", action: "forfeit", note: "the hold expired" };
      hold.history.push({ at: now, by: "deadline", action: "expired", detail: { deadline: hold.deadline } });
      record.state = "settling";
      record.attempts = 0;
      record.error = null;
      this.write(record);
      await this.report(record, "hold_expired", { deadline: hold.deadline });
      return 0;
    }

    if (record.state === "settling" || record.state === "voiding") {
      const data = await rpc.accountData(address);
      const onChain = data ? decodeMatch(data) : null;
      if (!data || (onChain && onChain.state !== "open")) {
        record.state = !onChain ? (record.state === "settling" ? "settled" : "void") :
          onChain.state === "settled" ? "settled" : "void";
        record.closed = !data;
        record.attempts = 0;
        record.error = null;
        this.write(record);
        await this.report(record, record.state);
        return record.closed ? null : 0;
      }
      let instruction: Instruction;
      if (record.state === "settling") {
        const payouts = this.payoutsFor(record);
        record.payouts = payouts;
        const summary = new TextEncoder().encode(JSON.stringify(
          record.players.map((player) => [player.wallet, player.kills, player.deaths, player.balance]),
        ));
        const resultHash = new Uint8Array(await crypto.subtle.digest("SHA-256", summary));
        instruction = await settleInstruction(
          setup.authority.address, matchId, owners, payouts.map(BigInt), resultHash, setup.feeVault,
        );
      } else {
        instruction = await voidMatchInstruction(setup.authority.address, matchId, owners);
      }
      const kind = record.state === "settling" ? "settle" : "void";
      const outcome = await this.submit(rpc, setup.authority, [instruction], [], record, kind);
      if (outcome === "rejected") {
        record.attempts += 1;
        this.write(record);
        /* the players can reclaim their stakes themselves after the delay */
        if (record.attempts >= SETTLE_ATTEMPTS) {
          await this.giveUp(record, kind);
          return null;
        }
        return 5_000 * record.attempts;
      }
      return 0;
    }

    if ((record.state === "settled" || record.state === "void") && !record.closed) {
      if (!(await rpc.accountData(address))) {
        record.closed = true;
        this.write(record);
        return null;
      }
      const outcome = await this.submit(
        rpc, setup.authority, [await closeMatchInstruction(setup.authority.address, matchId)], [], record, "close",
      );
      if (outcome === "rejected") {
        record.attempts += 1;
        this.write(record);
        return record.attempts >= SETTLE_ATTEMPTS ? null : 10_000;
      }
      return 0;
    }
    return null;
  }

  /* Sends a transaction and waits up to half a minute for it. "rejected": the
     network refused it (its checks failed); "sent": confirmed or still
     unknown, which the next step's read of the account settles. */
  private async submit(
    rpc: SolanaRpc,
    feePayer: Keypair,
    instructions: Instruction[],
    signers: Keypair[],
    record: WagerRecord,
    kind: keyof WagerRecord["signatures"],
  ): Promise<"rejected" | "sent"> {
    const message = compileMessage(feePayer.address, instructions, await rpc.latestBlockhash());
    const signatures = new Map<string, Uint8Array>();
    for (const signer of [feePayer, ...signers]) signatures.set(signer.address, await signer.sign(message.bytes));
    let signature: string;
    try {
      signature = await rpc.sendTransaction(assembleTransaction(message, signatures));
    } catch (error) {
      if (!(error instanceof SolanaRpcError)) throw error;
      record.error = error.message.slice(0, 300);
      return "rejected";
    }
    record.signatures[kind] = signature;
    this.write(record);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await sleep(1_000);
      const status = await rpc.signatureStatus(signature);
      if (status === "confirmed") return "sent";
      if (status === "failed") {
        record.error = `${kind} transaction failed on chain`;
        return "rejected";
      }
    }
    return "sent";
  }

  /* A settle or void the network kept refusing: the players' stakes stay
     locked until someone fixes it, or until they reclaim them themselves. */
  private async giveUp(record: WagerRecord, kind: string): Promise<void> {
    await this.report(record, `${kind}_gave_up`);
    await alert(this.env_, `gave-up:${record.matchId}`,
      `match ${record.matchId}: the ${kind} failed ${record.attempts} times (${record.error ?? "no error"}); ` +
      `its stakes stay locked until it is retried or the players reclaim them`);
  }

  /* The matchmaker's log (the dashboard) hears how each wagered match ends,
     and when one is held. */
  private async report(record: WagerRecord, outcome: string, detail: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.env.MATCHMAKER.getByName(MATCHMAKER_NAME).wagerReport(record.matchId, outcome, {
        error: record.error, signatures: record.signatures, payouts: record.payouts, ...detail,
      });
    } catch {
      /* the log is best effort */
    }
  }

  private async lockFailed(record: WagerRecord, reason: string): Promise<void> {
    record.state = "failed";
    record.error = reason;
    this.write(record);
    if (reason !== "The match ended before the stakes were locked.") {
      await alert(this.env_, `lock:${record.matchId}`, `match ${record.matchId}: the stakes didn't lock (${reason})`);
    }
    await this.env.MATCHMAKER.getByName(MATCHMAKER_NAME).escrowLocked(record.matchId, false, reason);
  }
}

/* Whether a wallet can stake in a match now: its vault holds the stake free,
   and its session (the game's key for it) is approved, unexpired for a while
   yet, and has the stake left in its limit. Null when it can; otherwise why
   not, for the player. */
export async function stakeProblem(env: RuntimeEnv, wallet: string, stake: number): Promise<string | null> {
  const setup = await escrowSetup(env);
  if (!setup) return "Wagered playlists are not set up on this server.";
  const data = await escrowRpc(env).accountData(await vaultAddress(wallet));
  const vault = data ? decodeVault(data) : null;
  if (!vault) return "Load up your vault first.";
  if (vault.free < BigInt(stake)) return "Your vault does not hold enough for this playlist's buy-in.";
  const session = await sessionKeypair(setup.sessionSecret, wallet);
  if (vault.sessionKey !== session.address) return "Approve a play session first.";
  if (vault.sessionExpiry < Math.floor(Date.now() / 1000) + 30 * 60) return "Your play session has run out. Approve a new one.";
  if (vault.sessionLimit - vault.sessionSpent < BigInt(stake)) {
    return "Your play session's limit is used up. Approve a new one.";
  }
  return null;
}
