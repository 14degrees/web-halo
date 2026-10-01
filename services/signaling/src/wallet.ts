import type { RuntimeEnv } from "./env";
import { HttpError } from "./errors";
import { base58Decode, parseWallet, verifyWalletSignature, walletPlayerName } from "./solana";

/* Sign-in with a Solana wallet: the wallet signs a one-time challenge and
   gets a session token. The player's SOL lives in their own vault in the
   escrow program (src/vault.ts), not here. */

const CHALLENGE_TTL_SECONDS = 300;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
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

function cluster(env: RuntimeEnv): string {
  return env.SOLANA_CLUSTER ?? "devnet";
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

export async function requireWallet(request: Request, env: RuntimeEnv): Promise<string> {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/iu, "");
  const wallet = await walletForToken(env, token);
  if (wallet === null) throw new HttpError(401, "WALLET_SIGN_IN_REQUIRED", "Sign in with your wallet again.");
  return wallet;
}

function walletSummary(env: RuntimeEnv, wallet: string): Record<string, unknown> {
  return { cluster: cluster(env), name: walletPlayerName(wallet), wallet };
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
    return { token, ...walletSummary(env, wallet) };
  }

  if (request.method === "GET" && path === "/v1/wallet") {
    return walletSummary(env, await requireWallet(request, env));
  }

  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}
