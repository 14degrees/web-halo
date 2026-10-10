import type { RuntimeEnv } from "./env";
import { HttpError } from "./errors";
import { findProgramAddress } from "./escrow";
import { fomoChain, fomoFeePayer, type FomoChain } from "./fomo";
import { answer } from "./profile";
import { PROFILES_NAME } from "./profiles";
import { base58Decode, type TransactionJson } from "./solana";
import { requireWallet } from "./wallet";

/* The fomo.family handle claim, and the transfer proof of a fomo wallet.

   A player claims their fomo handle on their profile. fomo publishes
   nothing that ties a handle to a wallet, so a claim proves nothing by
   itself: it is stored unverified and private. Two checks happen here:

   - The handle exists: fomo's public profile card
     (image-renderer.fomo.cloud/og/profile/<handle>/card.png) answers 200
     for a real handle and redirects for an unknown one. One HEAD request
     per claim, the answer cached a day per handle, a global cap per hour;
     FOMO_HANDLE_CHECK = "off" stops it. A handle fomo doesn't know is
     refused; one that could not be checked is kept.
   - The player controls a fomo wallet: detected automatically (src/fomo.ts,
     a linked wallet fomo paid fees for), or proven here by a transfer. The
     player is given a small, random USDC amount and sends exactly that from
     fomo to their signed-in wallet; fomo pays the fee for its users'
     withdrawals, so the transfer is one fomo's fee payer paid for, and its
     sender is the player's fomo wallet. The player keeps the money.

   The handle becomes verified only when an admin confirms it against the
   proven fomo wallet (src/profile.ts, POST /v1/admin/profiles/fomo-handle),
   e.g. by the masked address fomo shows on the handle's profile. Other
   players see the handle only then, and only if the owner shows it.

     PUT    /v1/profile/fomo/handle          { handle }: claim it
     DELETE /v1/profile/fomo/handle          drop it
     POST   /v1/profile/fomo/transfer        the amount to send, and where
     POST   /v1/profile/fomo/transfer/check  look for the transfer now */

/* fomo's handle rule is not published; this one takes what its profile
   URLs show (letters, digits, underscores, dots) */
export const FOMO_HANDLE_PATTERN = /^[A-Za-z0-9_.]{1,30}$/u;
const FOMO_CARD_URL = "https://image-renderer.fomo.cloud/og/profile/";
const FOMO_CARD_TIMEOUT_MS = 5_000;
export const FOMO_HANDLE_SEEN_TTL_SECONDS = 24 * 60 * 60;
/* claims per wallet per hour */
export const FOMO_HANDLE_CLAIMS_PER_HOUR = 10;
/* card requests the whole Worker makes per hour; past it, claims are
   stored unchecked */
export const FOMO_HANDLE_CHECKS_PER_HOUR = 500;
const HOUR_MS = 60 * 60_000;

/* the transfer proof: USDC on mainnet, what fomo balances are held in */
export const FOMO_TRANSFER_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const FOMO_TRANSFER_DECIMALS = 6;
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/* the amount asked for: a whole number of cents in this range */
export const FOMO_TRANSFER_CENTS_MINIMUM = 10;
export const FOMO_TRANSFER_CENTS_MAXIMUM = 99;
export const FOMO_TRANSFER_TTL_SECONDS = 30 * 60;
/* KV keeps a key at least 60 seconds */
export const FOMO_TRANSFER_CHECK_COOLDOWN_SECONDS = 60;
/* how many of the token account's newest transactions one check reads */
export const FOMO_TRANSFER_SIGNATURES = 25;
/* a transfer may carry a block time slightly before the challenge */
const FOMO_TRANSFER_CLOCK_SLACK_SECONDS = 120;
const FOMO_TRANSFER_BATCH = 5;

/* The handle a player typed, made canonical: `handle` as typed, `key`
   lowercase for comparing. A pasted profile or referral link, or a leading
   @, is accepted. */
export function normaliseFomoHandle(input: unknown): { handle: string; key: string } | { message: string } {
  if (typeof input !== "string") return { message: "handle must be a string." };
  const handle = input.trim()
    .replace(/^https?:\/\/(?:www\.)?fomo\.family\/(?:profile|r)\//iu, "")
    .replace(/[?#].*$/u, "")
    .replace(/\/+$/u, "")
    .replace(/^@/u, "");
  if (!FOMO_HANDLE_PATTERN.test(handle) || !/[A-Za-z0-9]/u.test(handle)) {
    return { message: "A fomo handle is 1 to 30 letters, digits, underscores or dots." };
  }
  return { handle, key: handle.toLowerCase() };
}

export function fomoHandleCheckEnabled(env: Pick<RuntimeEnv, "FOMO_HANDLE_CHECK">): boolean {
  return (env.FOMO_HANDLE_CHECK ?? "on").trim().toLowerCase() !== "off";
}

/* Whether fomo knows the handle, from its profile card: true (200), false
   (a redirect to the generic card), or null when it could not be told (the
   check is off, over its cap, or fomo answered something else). */
export async function fomoHandleSeen(env: RuntimeEnv, key: string, now: number): Promise<boolean | null> {
  if (!fomoHandleCheckEnabled(env)) return null;
  const cacheKey = `fomo-handle-seen:${key}`;
  const cached = await env.HALO_ABUSE.get(cacheKey);
  if (cached === "1" || cached === "0") return cached === "1";

  const capKey = `fomo-handle-checks:${Math.floor(now / HOUR_MS)}`;
  const made = Number(await env.HALO_ABUSE.get(capKey)) || 0;
  if (made >= FOMO_HANDLE_CHECKS_PER_HOUR) return null;
  await env.HALO_ABUSE.put(capKey, String(made + 1), { expirationTtl: 2 * 60 * 60 });

  let status: number;
  try {
    const response = await fetch(`${FOMO_CARD_URL}${encodeURIComponent(key)}/card.png`, {
      method: "HEAD",
      redirect: "manual",
      headers: { "User-Agent": "halo-web-signaling/1" },
      signal: AbortSignal.timeout(FOMO_CARD_TIMEOUT_MS),
    });
    status = response.status;
  } catch {
    return null;
  }
  const seen = status === 200 ? true : status >= 300 && status < 400 ? false : null;
  if (seen !== null) {
    await env.HALO_ABUSE.put(cacheKey, seen ? "1" : "0", { expirationTtl: FOMO_HANDLE_SEEN_TTL_SECONDS });
  }
  return seen;
}

/* The wallet's token account for a mint (its associated token account),
   where a transfer of that token to the wallet lands. */
export async function tokenAccountAddress(owner: string, mint: string): Promise<string> {
  const seeds = [owner, TOKEN_PROGRAM_ID, mint].map((value) => {
    const bytes = base58Decode(value);
    if (bytes === null || bytes.length !== 32) throw new Error(`Not an address: ${value}`);
    return bytes;
  });
  return (await findProgramAddress(seeds, ASSOCIATED_TOKEN_PROGRAM_ID))[0];
}

/* The sender of a transfer fomo paid for, of exactly `units` of `mint`, to
   a token account `to` owns; null when the transaction is not one. */
export function fomoTransferSender(
  transaction: TransactionJson,
  to: string,
  mint: string,
  units: bigint,
  feePayer: string,
): string | null {
  const meta = transaction.meta;
  if (meta === null || meta.err !== null && meta.err !== undefined) return null;
  if (transaction.transaction.message.accountKeys[0] !== feePayer) return null;
  const changes = new Map<number, { owner: string | undefined; delta: bigint }>();
  for (const [balances, sign] of [[meta.preTokenBalances, -1n], [meta.postTokenBalances, 1n]] as const) {
    for (const balance of balances ?? []) {
      if (balance.mint !== mint) continue;
      const entry = changes.get(balance.accountIndex) ?? { owner: balance.owner, delta: 0n };
      entry.owner ??= balance.owner;
      entry.delta += sign * BigInt(balance.uiTokenAmount.amount);
      changes.set(balance.accountIndex, entry);
    }
  }
  const entries = [...changes.values()];
  if (!entries.some((entry) => entry.owner === to && entry.delta === units)) return null;
  const sender = entries.find((entry) =>
    entry.owner !== undefined && entry.owner !== to && entry.owner !== feePayer && entry.delta === -units);
  return sender?.owner ?? null;
}

export interface FomoTransferChallenge {
  profileId: string;
  /* the signed-in wallet the transfer goes to */
  to: string;
  mint: string;
  /* the amount, in the token's smallest unit, as text */
  units: string;
  issuedAt: number;
  expiresAt: number;
}

/* Look through the receiving token account's newest transactions for the
   transfer the challenge asks for. */
export async function findFomoTransfer(
  chain: FomoChain,
  challenge: FomoTransferChallenge,
  feePayer: string,
): Promise<{ sender: string; signature: string } | null> {
  const account = await tokenAccountAddress(challenge.to, challenge.mint);
  const since = Math.floor(challenge.issuedAt / 1_000) - FOMO_TRANSFER_CLOCK_SLACK_SECONDS;
  const entries = (await chain.signaturesForAddress(account, FOMO_TRANSFER_SIGNATURES))
    .filter((entry) => entry.err === null && (entry.blockTime === undefined || entry.blockTime === null || entry.blockTime >= since));
  const units = BigInt(challenge.units);
  for (let start = 0; start < entries.length; start += FOMO_TRANSFER_BATCH) {
    const batch = entries.slice(start, start + FOMO_TRANSFER_BATCH);
    const transactions = await Promise.all(batch.map((entry) => chain.transaction(entry.signature)));
    for (let index = 0; index < batch.length; index += 1) {
      const transaction = transactions[index];
      if (transaction === null || transaction === undefined) continue;
      const sender = fomoTransferSender(transaction, challenge.to, challenge.mint, units, feePayer);
      if (sender !== null) return { sender, signature: batch[index]!.signature };
    }
  }
  return null;
}

function profiles(env: RuntimeEnv) {
  return env.PROFILES.getByName(PROFILES_NAME);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "VALIDATION_FAILED", "Body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

/* A counter in KV for the current hour: true while under `limit`. */
async function underHourlyLimit(env: RuntimeEnv, key: string, limit: number, now: number): Promise<boolean> {
  const hourKey = `${key}:${Math.floor(now / HOUR_MS)}`;
  const count = Number(await env.HALO_ABUSE.get(hourKey)) || 0;
  if (count >= limit) return false;
  await env.HALO_ABUSE.put(hourKey, String(count + 1), { expirationTtl: 2 * 60 * 60 });
  return true;
}

function transferAmount(units: bigint): string {
  const scale = 10n ** BigInt(FOMO_TRANSFER_DECIMALS);
  return `${units / scale}.${(units % scale).toString().padStart(FOMO_TRANSFER_DECIMALS, "0").replace(/0+$/u, "").padEnd(2, "0")}`;
}

function challengeView(challenge: FomoTransferChallenge, tokenAccount: string): Record<string, unknown> {
  return {
    to: challenge.to,
    tokenAccount,
    asset: "USDC",
    mint: challenge.mint,
    amount: transferAmount(BigInt(challenge.units)),
    units: challenge.units,
    expiresAt: challenge.expiresAt,
  };
}

/* The fomo handle and transfer routes, from src/profile.ts. */
export async function handleFomoHandleRequest(
  request: Request,
  env: RuntimeEnv,
  path: string,
  now: number,
  readBody: () => Promise<unknown>,
): Promise<Record<string, unknown> | null> {
  if (path === "/v1/profile/fomo/handle" && request.method === "PUT") {
    const wallet = await requireWallet(request, env);
    const name = normaliseFomoHandle(record(await readBody()).handle);
    if ("message" in name) throw new HttpError(400, "VALIDATION_FAILED", name.message);
    const current = await profiles(env).profileForWallet(wallet, now);
    if (current === null) throw new HttpError(404, "PROFILE_NOT_FOUND", "Claim a username first.");
    if (!(await underHourlyLimit(env, `fomo-handle-claims:${wallet}`, FOMO_HANDLE_CLAIMS_PER_HOUR, now))) {
      throw new HttpError(429, "FOMO_HANDLE_RATE_LIMITED", "Too many handle changes. Try again later.");
    }
    const seen = await fomoHandleSeen(env, name.key, now);
    if (seen === false) throw new HttpError(404, "FOMO_HANDLE_UNKNOWN", "fomo doesn't know that handle.");
    return answer(await profiles(env).claimFomoHandle(wallet, name.handle, name.key, seen, now));
  }

  if (path === "/v1/profile/fomo/handle" && request.method === "DELETE") {
    const wallet = await requireWallet(request, env);
    return answer(await profiles(env).releaseFomoHandle(wallet, now));
  }

  if (path === "/v1/profile/fomo/transfer" && request.method === "POST") {
    const wallet = await requireWallet(request, env);
    if (fomoChain(env) === null) throw new HttpError(503, "FOMO_DETECTION_OFF", "fomo detection isn't configured.");
    const profile = await profiles(env).profileForWallet(wallet, now);
    if (profile === null) throw new HttpError(404, "PROFILE_NOT_FOUND", "Claim a username first.");
    const span = FOMO_TRANSFER_CENTS_MAXIMUM - FOMO_TRANSFER_CENTS_MINIMUM + 1;
    const cents = FOMO_TRANSFER_CENTS_MINIMUM + crypto.getRandomValues(new Uint32Array(1))[0]! % span;
    const challenge: FomoTransferChallenge = {
      profileId: profile.id,
      to: wallet,
      mint: FOMO_TRANSFER_MINT,
      units: String(BigInt(cents) * 10n ** BigInt(FOMO_TRANSFER_DECIMALS - 2)),
      issuedAt: now,
      expiresAt: now + FOMO_TRANSFER_TTL_SECONDS * 1_000,
    };
    await env.HALO_ABUSE.put(`fomo-transfer:${profile.id}`, JSON.stringify(challenge), {
      expirationTtl: FOMO_TRANSFER_TTL_SECONDS,
    });
    return { transfer: challengeView(challenge, await tokenAccountAddress(challenge.to, challenge.mint)) };
  }

  if (path === "/v1/profile/fomo/transfer/check" && request.method === "POST") {
    const wallet = await requireWallet(request, env);
    const chain = fomoChain(env);
    if (chain === null) throw new HttpError(503, "FOMO_DETECTION_OFF", "fomo detection isn't configured.");
    const profile = await profiles(env).profileForWallet(wallet, now);
    if (profile === null) throw new HttpError(404, "PROFILE_NOT_FOUND", "Claim a username first.");
    const key = `fomo-transfer:${profile.id}`;
    const challenge = await env.HALO_ABUSE.get<FomoTransferChallenge>(key, "json");
    if (challenge === null || challenge.expiresAt <= now || challenge.profileId !== profile.id) {
      throw new HttpError(410, "FOMO_TRANSFER_EXPIRED", "That transfer request has expired. Start again.");
    }
    const cooldownKey = `fomo-transfer-check:${profile.id}`;
    if ((await env.HALO_ABUSE.get(cooldownKey)) !== null) {
      throw new HttpError(429, "FOMO_TRANSFER_RATE_LIMITED", "Checked a moment ago. Try again shortly.");
    }
    await env.HALO_ABUSE.put(cooldownKey, String(now), { expirationTtl: FOMO_TRANSFER_CHECK_COOLDOWN_SECONDS });
    let found: { sender: string; signature: string } | null;
    try {
      found = await findFomoTransfer(chain, challenge, fomoFeePayer(env));
    } catch (error) {
      console.warn(JSON.stringify({
        message: "fomo transfer check failed", wallet, error: error instanceof Error ? error.message : String(error),
      }));
      throw new HttpError(503, "FOMO_CHECK_UNAVAILABLE", "Couldn't read the chain. Try again later.");
    }
    if (found === null) {
      throw new HttpError(404, "FOMO_TRANSFER_NOT_FOUND", "No matching transfer from fomo yet.");
    }
    await env.HALO_ABUSE.delete(key);
    console.log(JSON.stringify({ message: "fomo transfer proof", wallet, sender: found.sender }));
    return { ...answer(await profiles(env).recordFomoTransfer(wallet, found.sender, found.signature, now)), signature: found.signature };
  }

  return null;
}
