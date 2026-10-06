import type { RuntimeEnv } from "./env";
import { HttpError } from "./errors";
import {
  FOMO_RECHECK_MS,
  PROFILES_NAME,
  type FomoCheckView,
  type ProfileView,
} from "./profiles";
import { SolanaRpc, parseWallet, type SignatureInfo, type TransactionJson } from "./solana";
import { requireWallet } from "./wallet";

/* Automatic fomo.family detection.

   fomo pays the network fee for every trade its users make from one
   well-known wallet (the fee payer). A wallet that takes part in a mainnet
   transaction that wallet paid for is a fomo wallet. That is the whole
   test: no fomo API, nothing from the player. The game itself stays on
   devnet; only this check reads mainnet, through FOMO_RPC_URL (a Worker
   secret: a Helius or similar endpoint with its key in the URL). Without
   the secret the feature is off.

   The answer is cached per wallet in the profiles store (src/profiles.ts,
   fomo_checks): a detected wallet stays detected, an undetected one is
   looked at again after FOMO_RECHECK_MS. The check runs after a wallet
   signs in (src/index.ts, in the background) and on request:

     POST /v1/profile/fomo/check   look now (once per FOMO_CHECK_COOLDOWN
                                   per wallet); answers { enabled, checks,
                                   profile }

   When a linked wallet is detected, the store marks the profile verified
   with method "fee_payer". Whether other players see it is the owner's
   choice (showFomo), as for every link. */

/* fomo's fee payer on mainnet (library/t-0003/fomo-x-linking-plan.md);
   FOMO_FEE_PAYER in wrangler.jsonc overrides it without a code change. */
export const DEFAULT_FOMO_FEE_PAYER = "AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51";
/* how many of a wallet's newest transactions one check looks through */
export const FOMO_SIGNATURES_PER_CHECK = 50;
/* transactions fetched at once (within a free RPC plan's requests per
   second, with src/solana.ts waiting out a 429); the first hit stops the
   check */
const FOMO_TRANSACTION_BATCH = 5;
/* the explicit route's cooldown per wallet, in seconds */
export const FOMO_CHECK_COOLDOWN_SECONDS = 600;

/* what the check reads from the chain; src/solana.ts in the Worker, a fake
   in tests */
export interface FomoChain {
  signaturesForAddress(address: string, limit: number): Promise<SignatureInfo[]>;
  transaction(signature: string): Promise<TransactionJson | null>;
}

export interface FomoDetection {
  detected: boolean;
  /* the transaction that proved it */
  signature: string | null;
  /* how many transactions were looked at */
  scanned: number;
}

export function fomoFeePayer(env: Pick<RuntimeEnv, "FOMO_FEE_PAYER">): string {
  return parseWallet(env.FOMO_FEE_PAYER) ?? DEFAULT_FOMO_FEE_PAYER;
}

export function fomoDetectionEnabled(env: Pick<RuntimeEnv, "FOMO_RPC_URL">): boolean {
  return typeof env.FOMO_RPC_URL === "string" && env.FOMO_RPC_URL.trim().length > 0;
}

/* The mainnet connection, or null when the feature is off. */
export function fomoChain(env: Pick<RuntimeEnv, "FOMO_RPC_URL">): FomoChain | null {
  return fomoDetectionEnabled(env) ? new SolanaRpc(env.FOMO_RPC_URL!) : null;
}

/* Whether `account` may be written by the transaction: a static key the
   header marks writable, or an address loaded from a lookup table as
   writable. The fee payer is always the first key and always writable. */
export function transactionWrites(transaction: TransactionJson, account: string): boolean {
  const message = transaction.transaction.message;
  const keys = message.accountKeys;
  const index = keys.indexOf(account);
  if (index >= 0) {
    const header = message.header;
    if (header === undefined) return true;
    const signers = header.numRequiredSignatures;
    if (index < signers) return index < signers - header.numReadonlySignedAccounts;
    return index < keys.length - header.numReadonlyUnsignedAccounts;
  }
  return transaction.meta?.loadedAddresses?.writable?.includes(account) ?? false;
}

/* A transaction fomo paid for on the wallet's behalf: the fee payer is
   fomo's and the wallet is one of its writable accounts (the trader's
   token and SOL balances move). The wallet and the fee payer must differ,
   or fomo's own wallet would detect itself. */
export function isFomoTransaction(transaction: TransactionJson, wallet: string, feePayer: string): boolean {
  if (wallet === feePayer) return false;
  const keys = transaction.transaction.message.accountKeys;
  if (keys[0] !== feePayer) return false;
  return transactionWrites(transaction, wallet);
}

/* Look through the wallet's newest transactions for one fomo paid for. */
export async function detectFomoWallet(
  chain: FomoChain,
  wallet: string,
  feePayer: string,
  limit = FOMO_SIGNATURES_PER_CHECK,
): Promise<FomoDetection> {
  const entries = await chain.signaturesForAddress(wallet, limit);
  let scanned = 0;
  for (let start = 0; start < entries.length; start += FOMO_TRANSACTION_BATCH) {
    const batch = entries.slice(start, start + FOMO_TRANSACTION_BATCH);
    const transactions = await Promise.all(batch.map((entry) => chain.transaction(entry.signature)));
    scanned += batch.length;
    for (let index = 0; index < batch.length; index += 1) {
      const transaction = transactions[index];
      if (transaction !== null && transaction !== undefined && isFomoTransaction(transaction, wallet, feePayer)) {
        return { detected: true, signature: batch[index]!.signature, scanned };
      }
    }
  }
  return { detected: false, signature: null, scanned };
}

function profiles(env: RuntimeEnv) {
  return env.PROFILES.getByName(PROFILES_NAME);
}

/* The wallets a check for `wallet` covers: every wallet of its profile, or
   the wallet alone before it has one. */
async function walletsToCheck(env: RuntimeEnv, wallet: string, now: number): Promise<string[]> {
  const profile = await profiles(env).profileForWallet(wallet, now);
  return profile === null ? [wallet] : profile.wallets.map((entry) => entry.wallet);
}

/* Which of the wallets are due a look at the chain: never checked, or
   undetected for longer than the recheck interval (always, when forced).
   A detected wallet is never rechecked: the fact does not expire. */
export function walletsDue(
  wallets: string[],
  checks: Record<string, FomoCheckView>,
  now: number,
  force: boolean,
): string[] {
  return wallets.filter((wallet) => {
    const check = checks[wallet];
    if (check === undefined) return true;
    if (check.detected) return false;
    return force || now - check.checkedAt >= FOMO_RECHECK_MS;
  });
}

export interface FomoCheckOutcome {
  enabled: boolean;
  checks: FomoCheckView[];
  profile: ProfileView | null;
}

/* Check the wallet (and its profile's other wallets) against mainnet and
   record what was found. Throws when the chain could not be read; nothing
   is recorded then, so the next sign-in tries again. */
export async function checkFomoWallet(
  env: RuntimeEnv,
  wallet: string,
  now: number,
  options: { force?: boolean } = {},
): Promise<FomoCheckOutcome> {
  const chain = fomoChain(env);
  const store = profiles(env);
  const wallets = await walletsToCheck(env, wallet, now);
  if (chain === null) {
    return { enabled: false, checks: await store.fomoChecks(wallets), profile: await store.profileForWallet(wallet, now) };
  }
  const feePayer = fomoFeePayer(env);
  const known = Object.fromEntries((await store.fomoChecks(wallets)).map((check) => [check.wallet, check]));
  for (const candidate of walletsDue(wallets, known, now, options.force ?? false)) {
    const detection = await detectFomoWallet(chain, candidate, feePayer);
    await store.recordFomoCheck(candidate, detection, now);
    console.log(JSON.stringify({
      message: "fomo check", wallet: candidate, detected: detection.detected, scanned: detection.scanned,
    }));
  }
  return { enabled: true, checks: await store.fomoChecks(wallets), profile: await store.profileForWallet(wallet, now) };
}

/* After a sign-in (src/index.ts), in the background: never throws. */
export async function fomoCheckAfterSignIn(env: RuntimeEnv, wallet: string): Promise<void> {
  if (!fomoDetectionEnabled(env)) return;
  try {
    await checkFomoWallet(env, wallet, Date.now());
  } catch (error) {
    console.warn(JSON.stringify({
      message: "fomo check failed", wallet, error: error instanceof Error ? error.message : String(error),
    }));
  }
}

/* POST /v1/profile/fomo/check, from src/profile.ts. */
export async function handleFomoRequest(
  request: Request,
  env: RuntimeEnv,
  path: string,
  now: number,
): Promise<Record<string, unknown> | null> {
  if (request.method !== "POST" || path !== "/v1/profile/fomo/check") return null;
  const wallet = await requireWallet(request, env);
  if (!fomoDetectionEnabled(env)) {
    throw new HttpError(503, "FOMO_DETECTION_OFF", "fomo detection isn't configured.");
  }
  const key = `fomo-check:${wallet}`;
  if ((await env.HALO_ABUSE.get(key)) !== null) {
    throw new HttpError(429, "FOMO_CHECK_RATE_LIMITED", "Checked recently. Try again in a few minutes.");
  }
  await env.HALO_ABUSE.put(key, String(now), { expirationTtl: FOMO_CHECK_COOLDOWN_SECONDS });
  try {
    return { ...(await checkFomoWallet(env, wallet, now, { force: true })) };
  } catch (error) {
    console.warn(JSON.stringify({
      message: "fomo check failed", wallet, error: error instanceof Error ? error.message : String(error),
    }));
    throw new HttpError(503, "FOMO_CHECK_UNAVAILABLE", "Couldn't read the chain. Try again later.");
  }
}
