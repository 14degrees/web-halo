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
   balance, less the fee on what they won; a void (the server lost, or the
   match never went live) returns every stake.

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

export type WagerState = "locking" | "locked" | "failed" | "settling" | "voiding" | "settled" | "void";

interface WagerRecord {
  matchId: string;
  /* the match's 16-byte ID on chain, hex */
  escrowId: string;
  stake: number;
  perKill: number;
  feeBps: number;
  state: WagerState;
  /* an end that arrived while the stakes were still locking */
  ending: "settle" | "void" | null;
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
  stake: number;
  perKill: number;
  feeBps: number;
  pot: number;
  players: Array<WagerPlayer & { net: number; payout: number | null; spent: boolean }>;
  signatures: WagerRecord["signatures"];
  cluster: string;
  error: string | null;
}

export interface WagerStart {
  matchId: string;
  stake: number;
  perKill: number;
  wallets: string[];
}

const RECORD_KEY = "wager";
/* tries at a transaction the network refuses before giving up on it */
const LOCK_ATTEMPTS = 3;
const SETTLE_ATTEMPTS = 12;

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
    this.write({
      matchId: input.matchId,
      escrowId: hex(await escrowMatchId(input.matchId)),
      stake: input.stake,
      perKill: input.perKill,
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
    const moved = killTransfer(record.players, killer, victim, record.perKill);
    if (moved > 0) {
      record.players[victim]!.balance -= moved;
      record.players[killer]!.balance += moved;
    }
    this.write(record);
    return { moved, view: this.view(record) };
  }

  /* The match is over: finished pays it out, anything else voids it. */
  async end(finished: boolean): Promise<void> {
    const record = this.read();
    if (!record) return;
    const outcome = finished && record.players.some((player) => player.balance !== record.stake) ? "settle" : "void";
    if (record.state === "locking") {
      record.ending = outcome;
    } else if (record.state === "locked") {
      record.state = outcome === "settle" ? "settling" : "voiding";
      record.attempts = 0;
    } else {
      return;
    }
    this.write(record);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async snapshot(): Promise<WagerView | null> {
    const record = this.read();
    return record ? this.view(record) : null;
  }

  private view(record: WagerRecord): WagerView {
    const payouts = record.payouts ?? (record.state === "settling" || record.state === "settled" ?
      bountyPayouts(record.stake, record.players.map((player) => player.balance), record.feeBps).payouts : null);
    return {
      matchId: record.matchId,
      state: record.state,
      stake: record.stake,
      perKill: record.perKill,
      feeBps: record.feeBps,
      pot: record.stake * record.players.length,
      players: record.players.map((player, index) => ({
        ...player,
        net: player.balance - record.stake,
        payout: record.state === "void" || record.state === "voiding" ? record.stake : payouts?.[index] ?? null,
        spent: player.balance === 0,
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
        record.state = record.ending === "settle" ? "settling" : record.ending === "void" ? "voiding" : "locked";
        record.attempts = 0;
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
        return record.closed ? null : 0;
      }
      let instruction: Instruction;
      if (record.state === "settling") {
        const { payouts } = bountyPayouts(record.stake, record.players.map((player) => player.balance), record.feeBps);
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
        return record.attempts >= SETTLE_ATTEMPTS ? null : 5_000 * record.attempts;
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

  private async lockFailed(record: WagerRecord, reason: string): Promise<void> {
    record.state = "failed";
    record.error = reason;
    this.write(record);
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
