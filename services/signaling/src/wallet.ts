import { BANK_NAME } from "./bank";
import type { RuntimeEnv } from "./env";
import { HttpError } from "./errors";
import {
  LAMPORTS_PER_SOL,
  SolanaRpc,
  base58Decode,
  keypairFromSecret,
  parseWallet,
  toBase64,
  transactionBytes,
  transferMessage,
  verifyWalletSignature,
  walletPlayerName,
} from "./solana";

/* Wallet accounts for the wager experiment: sign-in with a Solana wallet,
   balances held by the house, deposits and withdrawals on chain. */

const CHALLENGE_TTL_SECONDS = 300;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAXIMUM_DEPOSIT_LAMPORTS = 10 * LAMPORTS_PER_SOL;
const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/u;
/* A payout's network fee, charged to the withdrawal so the house wallet,
   funded only by deposits, never runs short. */
const WITHDRAWAL_FEE_LAMPORTS = 5_000;
/* Devnet only: play balance a wallet may claim once a day, so players can
   wager without finding a faucet. */
const FAUCET_LAMPORTS = 1_000_000_000;
const FAUCET_INTERVAL_SECONDS = 24 * 60 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/=+$/u, "").replaceAll("+", "-").replaceAll("/", "_");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "VALIDATION_FAILED", "Body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function wagersEnabled(env: RuntimeEnv): boolean {
  return typeof env.HOUSE_SECRET_KEY === "string" && env.HOUSE_SECRET_KEY.length > 0;
}

export function wagerLamports(env: RuntimeEnv): number {
  const value = Number(env.WAGER_LAMPORTS ?? "100000000");
  return Number.isSafeInteger(value) && value > 0 ? value : 100_000_000;
}

/* A private RPC endpoint (a secret: it carries an API key) first, then the
   public ones, which may refuse requests from Cloudflare. */
function rpc(env: RuntimeEnv): SolanaRpc {
  return new SolanaRpc([env.SOLANA_RPC_PRIVATE_URL, env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com"]
    .filter((url) => typeof url === "string" && url.length > 0)
    .join(","));
}

function cluster(env: RuntimeEnv): string {
  return env.SOLANA_CLUSTER ?? "devnet";
}

function bank(env: RuntimeEnv): DurableObjectStub<import("./bank").Bank> {
  return env.BANK.getByName(BANK_NAME);
}

function challengeMessage(wallet: string, nonce: string, issuedAt: string, env: RuntimeEnv): string {
  return [
    "Sign in to Halo online.",
    "",
    `Wallet: ${wallet}`,
    `Network: Solana ${cluster(env)}`,
    `Nonce: ${nonce}`,
    `Issued: ${issuedAt}`,
  ].join("\n");
}

/* The wallet a session token belongs to, or null. */
export async function walletForToken(env: RuntimeEnv, token: unknown): Promise<string | null> {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  return env.HALO_ABUSE.get(`wallet-session:${token}`);
}

async function requireWallet(request: Request, env: RuntimeEnv): Promise<string> {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/iu, "");
  const wallet = await walletForToken(env, token);
  if (wallet === null) throw new HttpError(401, "WALLET_SIGN_IN_REQUIRED", "Sign in with your wallet again.");
  return wallet;
}

async function walletSummary(env: RuntimeEnv, wallet: string): Promise<Record<string, unknown>> {
  const house = wagersEnabled(env) ? (await keypairFromSecret(env.HOUSE_SECRET_KEY ?? "")).address : null;
  /* The wallet's own SOL on chain, beside its game balance; null when the
     network cannot be reached. */
  let onchainLamports: number | null = null;
  try {
    onchainLamports = await rpc(env).balance(wallet);
  } catch {
    onchainLamports = null;
  }
  return {
    cluster: cluster(env),
    house,
    lamports: await bank(env).balance(wallet),
    onchainLamports,
    name: walletPlayerName(wallet),
    wager: wagerLamports(env),
    wagersEnabled: wagersEnabled(env),
    wallet,
  };
}

export async function handleWalletRequest(
  request: Request,
  env: RuntimeEnv,
  url: URL,
  readBody: () => Promise<unknown>,
): Promise<Record<string, unknown> | null> {
  const path = url.pathname;
  if (!path.startsWith("/v1/auth/") && !path.startsWith("/v1/wallet")) return null;

  if (request.method === "POST" && path === "/v1/auth/challenge") {
    const wallet = parseWallet(record(await readBody()).wallet);
    if (wallet === null) throw new HttpError(400, "VALIDATION_FAILED", "wallet must be a Solana address.");
    const nonce = randomToken();
    const issuedAt = new Date().toISOString();
    const message = challengeMessage(wallet, nonce, issuedAt, env);
    await env.HALO_ABUSE.put(`wallet-challenge:${nonce}`, JSON.stringify({ message, wallet }), {
      expirationTtl: CHALLENGE_TTL_SECONDS,
    });
    return { message, nonce };
  }

  if (request.method === "POST" && path === "/v1/auth/verify") {
    const body = record(await readBody());
    const wallet = parseWallet(body.wallet);
    if (wallet === null || typeof body.nonce !== "string" || typeof body.signature !== "string") {
      throw new HttpError(400, "VALIDATION_FAILED", "wallet, nonce and signature are required.");
    }
    const key = `wallet-challenge:${body.nonce}`;
    const stored = await env.HALO_ABUSE.get<{ message: string; wallet: string }>(key, "json");
    await env.HALO_ABUSE.delete(key);
    const signature = base58Decode(body.signature);
    if (
      stored === null || stored.wallet !== wallet || signature === null ||
      !(await verifyWalletSignature(wallet, new TextEncoder().encode(stored.message), signature))
    ) {
      throw new HttpError(401, "WALLET_SIGNATURE_INVALID", "The wallet signature did not check out.");
    }
    const token = randomToken();
    await env.HALO_ABUSE.put(`wallet-session:${token}`, wallet, { expirationTtl: SESSION_TTL_SECONDS });
    return { token, ...(await walletSummary(env, wallet)) };
  }

  if (request.method === "GET" && path === "/v1/wallet") {
    return walletSummary(env, await requireWallet(request, env));
  }

  if (request.method === "POST" && path === "/v1/wallet/faucet") {
    const wallet = await requireWallet(request, env);
    if (cluster(env) !== "devnet") {
      throw new HttpError(403, "FAUCET_DEVNET_ONLY", "Test SOL exists only on devnet.");
    }
    const key = `wallet-faucet:${wallet}`;
    if (await env.HALO_ABUSE.get(key)) {
      throw new HttpError(429, "FAUCET_USED", "You already claimed test SOL today.");
    }
    await env.HALO_ABUSE.put(key, "claimed", { expirationTtl: FAUCET_INTERVAL_SECONDS });
    await bank(env).creditFaucet(wallet, FAUCET_LAMPORTS, Date.now());
    return walletSummary(env, wallet);
  }

  if (!wagersEnabled(env)) {
    throw new HttpError(503, "WAGERS_DISABLED", "Wagers are not set up on this server.");
  }

  /* An unsigned transfer to the house for the wallet to sign and send. */
  if (request.method === "POST" && path === "/v1/wallet/deposit-transaction") {
    const wallet = await requireWallet(request, env);
    const lamports = Number(record(await readBody()).lamports);
    if (!Number.isSafeInteger(lamports) || lamports <= 0 || lamports > MAXIMUM_DEPOSIT_LAMPORTS) {
      throw new HttpError(400, "VALIDATION_FAILED", "Deposit between 1 lamport and 10 SOL.");
    }
    const house = await keypairFromSecret(env.HOUSE_SECRET_KEY ?? "");
    const message = transferMessage(wallet, house.address, lamports, await rpc(env).latestBlockhash());
    return { transaction: toBase64(transactionBytes(message)) };
  }

  /* Credits a deposit once its transaction is confirmed on chain. */
  if (request.method === "POST" && path === "/v1/wallet/deposit") {
    const wallet = await requireWallet(request, env);
    const signature = record(await readBody()).signature;
    if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) {
      throw new HttpError(400, "VALIDATION_FAILED", "signature must be a transaction signature.");
    }
    const house = await keypairFromSecret(env.HOUSE_SECRET_KEY ?? "");
    const lamports = await rpc(env).transferredLamports(signature, wallet, house.address);
    if (lamports === null) {
      throw new HttpError(409, "DEPOSIT_NOT_CONFIRMED", "That deposit is not confirmed yet. Try again in a moment.");
    }
    const result = await bank(env).creditDeposit(wallet, signature, lamports, Date.now());
    return { credited: result.credited, ...(await walletSummary(env, wallet)) };
  }

  /* Pays a withdrawal from the house wallet on chain. */
  if (request.method === "POST" && path === "/v1/wallet/withdraw") {
    const wallet = await requireWallet(request, env);
    const body = record(await readBody());
    const available = await bank(env).balance(wallet);
    const lamports = body.lamports === "all" ? available : Number(body.lamports);
    if (!Number.isSafeInteger(lamports) || lamports <= WITHDRAWAL_FEE_LAMPORTS) {
      throw new HttpError(400, "VALIDATION_FAILED", "Nothing to withdraw beyond the network fee.");
    }
    const remaining = await bank(env).reserveWithdrawal(wallet, lamports, Date.now());
    if (remaining === null) throw new HttpError(409, "INSUFFICIENT_BALANCE", "That is more than your balance.");
    try {
      const house = await keypairFromSecret(env.HOUSE_SECRET_KEY ?? "");
      const solana = rpc(env);
      const paid = lamports - WITHDRAWAL_FEE_LAMPORTS;
      const message = transferMessage(house.address, wallet, paid, await solana.latestBlockhash());
      const signature = await solana.sendTransaction(transactionBytes(message, await house.sign(message)));
      return { paid, signature, ...(await walletSummary(env, wallet)) };
    } catch (error) {
      await bank(env).refund(wallet, lamports, Date.now());
      throw new HttpError(502, "WITHDRAWAL_FAILED",
        `The payout could not be sent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}
