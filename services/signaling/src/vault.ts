import type { RuntimeEnv } from "./env";
import { HttpError } from "./errors";
import {
  ESCROW_PROGRAM_ID,
  assembleTransaction,
  compileMessage,
  decodeVault,
  depositInstruction,
  type Instruction,
  openSessionInstruction,
  openVaultInstruction,
  vaultAddress,
  withdrawInstruction,
} from "./escrow";
import { LAMPORTS_PER_SOL, SolanaRpcError, base58Encode, toBase64, walletPlayerName } from "./solana";
import { requireWallet } from "./wallet";
import { escrowRpc, escrowSetup, sessionKeypair } from "./wager";

/* A player's vault in the escrow program, for the lobby: its balances, and
   the transactions the player's wallet signs to load it up (open it, deposit,
   approve a play session) and to withdraw. The Worker builds them; the
   wallet signs and sends them, so the Worker never holds the player's SOL. */

/* Small stakes: what one load-up may deposit, and a session's limit. */
const MAXIMUM_DEPOSIT_LAMPORTS = LAMPORTS_PER_SOL;
const MAXIMUM_SESSION_LIMIT_LAMPORTS = LAMPORTS_PER_SOL;
/* A session lasts a day (the program's longest), less a margin for clocks. */
const SESSION_SECONDS = 24 * 60 * 60 - 5 * 60;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "VALIDATION_FAILED", "Body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function lamports(value: unknown, maximum: number, name: string): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > maximum) {
    throw new HttpError(400, "VALIDATION_FAILED", `${name} must be between 0 and ${maximum / LAMPORTS_PER_SOL} SOL.`);
  }
  return amount;
}

async function unsignedTransaction(env: RuntimeEnv, wallet: string, instructions: Instruction[]): Promise<string> {
  const message = compileMessage(wallet, instructions, await escrowRpc(env).latestBlockhash());
  return toBase64(assembleTransaction(message, new Map()));
}

async function vaultSummary(env: RuntimeEnv, wallet: string): Promise<Record<string, unknown>> {
  const setup = await escrowSetup(env);
  const rpc = escrowRpc(env);
  const [data, onchain] = await Promise.all([
    rpc.accountData(await vaultAddress(wallet)),
    rpc.balance(wallet).catch(() => null),
  ]);
  const vault = data ? decodeVault(data) : null;
  const session = setup ? await sessionKeypair(setup.sessionSecret, wallet) : null;
  const now = Math.floor(Date.now() / 1000);
  const sessionActive = vault !== null && session !== null && vault.sessionKey === session.address &&
    vault.sessionExpiry > now;
  return {
    enabled: setup !== null,
    cluster: setup?.cluster ?? env.SOLANA_CLUSTER ?? "devnet",
    program: ESCROW_PROGRAM_ID,
    wallet,
    name: walletPlayerName(wallet),
    walletLamports: onchain,
    vault: vault === null ? null : {
      address: await vaultAddress(wallet),
      free: Number(vault.free),
      locked: Number(vault.locked),
      holdUntil: vault.holdUntil,
    },
    session: sessionActive ? {
      limit: Number(vault!.sessionLimit),
      spent: Number(vault!.sessionSpent),
      expiresAt: vault!.sessionExpiry,
    } : null,
  };
}

export async function handleEscrowRequest(
  request: Request,
  env: RuntimeEnv,
  url: URL,
  readBody: () => Promise<unknown>,
): Promise<Record<string, unknown> | null> {
  const path = url.pathname;
  if (!path.startsWith("/v1/escrow")) return null;

  if (request.method === "GET" && path === "/v1/escrow") {
    return vaultSummary(env, await requireWallet(request, env));
  }

  const setup = await escrowSetup(env);
  if (!setup) throw new HttpError(503, "ESCROW_DISABLED", "Wagers are not set up on this server.");

  /* Load up: open the vault if needed, deposit, and approve a day's play
     session with a spending limit, in one transaction (one wallet prompt). */
  if (request.method === "POST" && path === "/v1/escrow/load") {
    const wallet = await requireWallet(request, env);
    const body = record(await readBody());
    const deposit = lamports(body.deposit, MAXIMUM_DEPOSIT_LAMPORTS, "deposit");
    const limit = lamports(body.limit, MAXIMUM_SESSION_LIMIT_LAMPORTS, "limit");
    const exists = (await escrowRpc(env).accountData(await vaultAddress(wallet))) !== null;
    const session = await sessionKeypair(setup.sessionSecret, wallet);
    const instructions: Instruction[] = [];
    if (!exists) instructions.push(await openVaultInstruction(wallet));
    if (deposit > 0) instructions.push(await depositInstruction(wallet, BigInt(deposit)));
    if (limit > 0) {
      instructions.push(await openSessionInstruction(
        wallet, session.address, BigInt(limit), Math.floor(Date.now() / 1000) + SESSION_SECONDS,
      ));
    }
    if (instructions.length === 0) throw new HttpError(400, "VALIDATION_FAILED", "Nothing to do.");
    return { transaction: await unsignedTransaction(env, wallet, instructions) };
  }

  /* Withdraw free SOL to the wallet. */
  if (request.method === "POST" && path === "/v1/escrow/withdraw") {
    const wallet = await requireWallet(request, env);
    const body = record(await readBody());
    const data = await escrowRpc(env).accountData(await vaultAddress(wallet));
    const vault = data ? decodeVault(data) : null;
    if (!vault) throw new HttpError(404, "VAULT_NOT_FOUND", "You have no vault yet.");
    const amount = body.lamports === "all" ? Number(vault.free) : lamports(body.lamports, Number(vault.free), "lamports");
    if (amount <= 0) throw new HttpError(400, "VALIDATION_FAILED", "Nothing to withdraw.");
    return { transaction: await unsignedTransaction(env, wallet, [await withdrawInstruction(wallet, BigInt(amount))]) };
  }

  /* Sends a transaction the player's wallet signed (and only signed) to this
     server's cluster: a wallet set to another network (Phantom on mainnet)
     would otherwise send it there, where it fails. Only the signed-in
     wallet's own transactions (it pays the fee) are sent. */
  if (request.method === "POST" && path === "/v1/escrow/submit") {
    const wallet = await requireWallet(request, env);
    const encoded = record(await readBody()).transaction;
    if (typeof encoded !== "string" || encoded.length > 2_000) {
      throw new HttpError(400, "VALIDATION_FAILED", "transaction must be a base64 transaction.");
    }
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    } catch {
      throw new HttpError(400, "VALIDATION_FAILED", "transaction must be a base64 transaction.");
    }
    /* signatures (a one-byte count here), then the message: a 3-byte header,
       the account count, and the fee payer first */
    const signatures = bytes[0] ?? 0;
    const payerOffset = 1 + 64 * signatures + 3 + 1;
    if (signatures < 1 || signatures > 4 || bytes.length < payerOffset + 32 ||
        base58Encode(bytes.slice(payerOffset, payerOffset + 32)) !== wallet) {
      throw new HttpError(400, "VALIDATION_FAILED", "That is not your wallet's transaction.");
    }
    try {
      return { signature: await escrowRpc(env).sendTransaction(bytes) };
    } catch (error) {
      if (error instanceof SolanaRpcError) {
        throw new HttpError(409, "TRANSACTION_REJECTED", error.message.replace(/^Solana RPC sendTransaction: /u, ""));
      }
      throw error;
    }
  }

  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}
