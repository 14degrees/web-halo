import type { RuntimeEnv } from "./env";
import { HttpError } from "./errors";
import { randomToken } from "./crypto";
import {
  PROFILES_NAME,
  normaliseUsername,
  type ProfileResult,
  type ProfileView,
  type ProfileVisibility,
} from "./profiles";
import { handleFomoRequest } from "./fomo";
import { handleFomoHandleRequest, normaliseFomoHandle } from "./fomo_handle";
import { base58Decode, parseWallet, verifyWalletSignature } from "./solana";
import { requireWallet } from "./wallet";

/* The profile routes (src/profiles.ts). The caller is the signed-in wallet
   (Authorization: Bearer, from /v1/auth/verify); its profile is the one
   that wallet is linked to.

     GET    /v1/profile                     the caller's profile, or null
     POST   /v1/profile/username            { username }: claim it (a first
                                            claim makes the profile), or rename
     PATCH  /v1/profile                     { showWallets?, showFomo?, showX? }
     POST   /v1/profile/wallets/challenge   { wallet }: the message the new
                                            wallet must sign
     POST   /v1/profile/wallets             { wallet, nonce, signature }: link it
     DELETE /v1/profile/wallets/:wallet     unlink it (the last one stays)
     POST   /v1/profile/fomo/check          look for the wallets on fomo now
                                            (src/fomo.ts)
     PUT    /v1/profile/fomo/handle         { handle }: claim a fomo handle
     DELETE /v1/profile/fomo/handle         drop it
     POST   /v1/profile/fomo/transfer       the transfer that proves a fomo
                                            wallet; then .../transfer/check
                                            (src/fomo_handle.ts)
     GET    /v1/profiles/:username          another player's view (no auth)
     GET    /v1/profiles?wallets=a,b,c      the same for a roster's wallets
                                            (no auth, at most 16)
     GET    /v1/admin/profiles?wallet=|username=|id=   support lookup
     GET    /v1/admin/profiles/fomo-handles  claimed handles waiting for an admin
     POST   /v1/admin/profiles/fomo-handle   { profileId, handle, verified, note? }:
                                            confirm (or take back) a handle */

const LINK_CHALLENGE_TTL_SECONDS = 300;
const ROSTER_LOOKUP_MAXIMUM = 16;
const WALLET_ROUTE = /^\/v1\/profile\/wallets\/([1-9A-HJ-NP-Za-km-z]{32,44})$/u;
const USERNAME_ROUTE = /^\/v1\/profiles\/([^/]{1,64})$/u;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "VALIDATION_FAILED", "Body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function profiles(env: RuntimeEnv) {
  return env.PROFILES.getByName(PROFILES_NAME);
}

export function answer(result: ProfileResult): { profile: ProfileView } {
  if ("profile" in result) return result;
  switch (result.error) {
    case "PROFILE_NOT_FOUND":
      throw new HttpError(404, "PROFILE_NOT_FOUND", "Claim a username first.");
    case "USERNAME_TAKEN":
      throw new HttpError(409, "USERNAME_TAKEN", "That username is taken.");
    case "USERNAME_RATE_LIMITED":
      throw new HttpError(429, "USERNAME_RATE_LIMITED", "You've changed your username enough for today.");
    case "WALLET_ALREADY_LINKED":
      throw new HttpError(409, "WALLET_ALREADY_LINKED", "That wallet already belongs to a profile. Unlink it there first.");
    case "WALLET_NOT_LINKED":
      throw new HttpError(404, "WALLET_NOT_LINKED", "That wallet isn't linked to your profile.");
    case "PROFILE_LAST_WALLET":
      throw new HttpError(409, "PROFILE_LAST_WALLET", "A profile keeps at least one wallet.");
    case "FOMO_HANDLE_TAKEN":
      throw new HttpError(409, "FOMO_HANDLE_TAKEN", "That fomo handle is verified on another profile.");
    case "FOMO_HANDLE_MISSING":
      throw new HttpError(404, "FOMO_HANDLE_MISSING", "That profile has no fomo handle.");
    case "FOMO_HANDLE_CHANGED":
      throw new HttpError(409, "FOMO_HANDLE_CHANGED", "That profile's fomo handle has changed. Look again.");
    case "FOMO_WALLET_UNPROVEN":
      throw new HttpError(409, "FOMO_WALLET_UNPROVEN", "That profile has no proven fomo wallet yet.");
  }
}

/* The domain the signed message binds to: the game's own origin, so a
   signature for another site can never link a wallet here. */
function linkDomain(env: RuntimeEnv): string {
  try {
    return new URL(env.PUBLIC_GAME_URL).host;
  } catch {
    return "halo";
  }
}

export function linkMessage(input: {
  profileId: string; username: string; wallet: string; domain: string; cluster: string;
  nonce: string; issuedAt: string; expiresAt: string;
}): string {
  return [
    "Link this wallet to your Halo profile.",
    "",
    `Profile: ${input.profileId}`,
    `Username: ${input.username}`,
    `Wallet: ${input.wallet}`,
    `Domain: ${input.domain}`,
    `Network: Solana ${input.cluster}`,
    `Nonce: ${input.nonce}`,
    `Issued: ${input.issuedAt}`,
    `Expires: ${input.expiresAt}`,
  ].join("\n");
}

interface LinkChallenge {
  message: string;
  wallet: string;
  owner: string;
  profileId: string;
  expiresAt: number;
}

function visibility(input: Record<string, unknown>): Partial<ProfileVisibility> {
  const out: Partial<ProfileVisibility> = {};
  for (const [field, key] of [["showWallets", "wallets"], ["showFomo", "fomo"], ["showX", "x"]] as const) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== "boolean") {
      throw new HttpError(400, "VALIDATION_FAILED", `${field} must be true or false.`);
    }
    out[key] = input[field];
  }
  if (Object.keys(out).length === 0) {
    throw new HttpError(400, "VALIDATION_FAILED", "Nothing to change: give showWallets, showFomo or showX.");
  }
  return out;
}

export async function handleProfileRequest(
  request: Request,
  env: RuntimeEnv,
  url: URL,
  readBody: () => Promise<unknown>,
): Promise<Record<string, unknown> | null> {
  const path = url.pathname;
  if (!path.startsWith("/v1/profile")) return null;
  const now = Date.now();

  /* ---------- public lookups */

  if (request.method === "GET" && path === "/v1/profiles") {
    const list = (url.searchParams.get("wallets") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    if (list.length === 0 || list.length > ROSTER_LOOKUP_MAXIMUM) {
      throw new HttpError(400, "VALIDATION_FAILED", `wallets is 1 to ${ROSTER_LOOKUP_MAXIMUM} addresses, comma separated.`);
    }
    const wallets = list.map(parseWallet);
    if (wallets.some((wallet) => wallet === null)) {
      throw new HttpError(400, "VALIDATION_FAILED", "wallets must be Solana addresses.");
    }
    return { profiles: await profiles(env).publicProfilesForWallets(wallets as string[]) };
  }
  const usernameMatch = USERNAME_ROUTE.exec(path);
  if (request.method === "GET" && usernameMatch) {
    const name = normaliseUsername(decodeURIComponent(usernameMatch[1]!));
    if ("problem" in name) throw new HttpError(404, "PROFILE_NOT_FOUND", "No such profile.");
    const profile = await profiles(env).publicProfile(name.key);
    if (profile === null) throw new HttpError(404, "PROFILE_NOT_FOUND", "No such profile.");
    return { profile };
  }

  /* ---------- the caller's own profile */

  if (request.method === "GET" && path === "/v1/profile") {
    const wallet = await requireWallet(request, env);
    return { profile: await profiles(env).profileForWallet(wallet, now) };
  }

  if (request.method === "POST" && path === "/v1/profile/username") {
    const wallet = await requireWallet(request, env);
    const name = normaliseUsername(record(await readBody()).username);
    if ("problem" in name) throw new HttpError(400, name.problem, name.message);
    return answer(await profiles(env).claimUsername(wallet, name.username, name.key, now));
  }

  if (request.method === "PATCH" && path === "/v1/profile") {
    const wallet = await requireWallet(request, env);
    return answer(await profiles(env).setVisibility(wallet, visibility(record(await readBody())), now));
  }

  if (request.method === "POST" && path === "/v1/profile/wallets/challenge") {
    const owner = await requireWallet(request, env);
    const wallet = parseWallet(record(await readBody()).wallet);
    if (wallet === null) throw new HttpError(400, "VALIDATION_FAILED", "wallet must be a Solana address.");
    const profile = await profiles(env).profileForWallet(owner, now);
    if (profile === null) throw new HttpError(404, "PROFILE_NOT_FOUND", "Claim a username first.");
    if (profile.wallets.some((entry) => entry.wallet === wallet)) {
      throw new HttpError(409, "WALLET_ALREADY_LINKED", "That wallet is already on your profile.");
    }
    const nonce = randomToken();
    const expiresAt = now + LINK_CHALLENGE_TTL_SECONDS * 1_000;
    const message = linkMessage({
      profileId: profile.id,
      username: profile.username,
      wallet,
      domain: linkDomain(env),
      cluster: env.SOLANA_CLUSTER ?? "devnet",
      nonce,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    });
    const challenge: LinkChallenge = { message, wallet, owner, profileId: profile.id, expiresAt };
    await env.HALO_ABUSE.put(`profile-link:${nonce}`, JSON.stringify(challenge), {
      expirationTtl: LINK_CHALLENGE_TTL_SECONDS,
    });
    return { message, nonce, expiresAt };
  }

  if (request.method === "POST" && path === "/v1/profile/wallets") {
    const owner = await requireWallet(request, env);
    const body = record(await readBody());
    const wallet = parseWallet(body.wallet);
    if (wallet === null || typeof body.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(body.nonce) ||
        typeof body.signature !== "string") {
      throw new HttpError(400, "VALIDATION_FAILED", "wallet, nonce and signature are required.");
    }
    const key = `profile-link:${body.nonce}`;
    const stored = await env.HALO_ABUSE.get<LinkChallenge>(key, "json");
    await env.HALO_ABUSE.delete(key);
    if (stored === null || stored.expiresAt <= now) {
      throw new HttpError(401, "LINK_CHALLENGE_EXPIRED", "That link request has expired. Start again.");
    }
    const signature = base58Decode(body.signature);
    if (
      stored.wallet !== wallet || stored.owner !== owner || signature === null ||
      !(await verifyWalletSignature(wallet, new TextEncoder().encode(stored.message), signature))
    ) {
      throw new HttpError(401, "WALLET_SIGNATURE_INVALID", "The wallet signature did not check out.");
    }
    const result = await profiles(env).linkWallet(owner, wallet, now);
    if ("profile" in result && result.profile.id !== stored.profileId) {
      /* the owner moved to another profile between challenge and proof */
      await profiles(env).unlinkWallet(owner, wallet, now);
      throw new HttpError(409, "PROFILE_CHANGED", "Your profile changed. Start the link again.");
    }
    return answer(result);
  }

  const walletMatch = WALLET_ROUTE.exec(path);
  if (request.method === "DELETE" && walletMatch) {
    const owner = await requireWallet(request, env);
    const wallet = parseWallet(walletMatch[1]);
    if (wallet === null) throw new HttpError(400, "VALIDATION_FAILED", "wallet must be a Solana address.");
    return answer(await profiles(env).unlinkWallet(owner, wallet, now));
  }

  const fomoResponse = await handleFomoRequest(request, env, path, now);
  if (fomoResponse !== null) return fomoResponse;
  const fomoHandleResponse = await handleFomoHandleRequest(request, env, path, now, readBody);
  if (fomoHandleResponse !== null) return fomoHandleResponse;

  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}

/* GET /v1/admin/profiles?wallet=|username=|id= (the admin token is checked
   by the caller). */
export async function adminProfileLookup(env: RuntimeEnv, url: URL): Promise<Record<string, unknown>> {
  const by: { wallet?: string; username?: string; id?: string } = {};
  const wallet = url.searchParams.get("wallet");
  const username = url.searchParams.get("username");
  const id = url.searchParams.get("id");
  if (wallet !== null) {
    const parsed = parseWallet(wallet);
    if (parsed === null) throw new HttpError(400, "VALIDATION_FAILED", "wallet must be a Solana address.");
    by.wallet = parsed;
  } else if (username !== null) {
    const name = normaliseUsername(username);
    by.username = "problem" in name ? username.trim().toLowerCase() : name.key;
  } else if (id !== null && /^[A-Za-z0-9_-]{1,64}$/u.test(id)) {
    by.id = id;
  } else {
    throw new HttpError(400, "VALIDATION_FAILED", "Give wallet, username or id.");
  }
  const lookup = await profiles(env).adminLookup(by, Date.now());
  return {
    events: lookup.events.map((event) => ({ ...event, detail: event.detail === null ? null : JSON.parse(event.detail) })),
    profile: lookup.profile,
    usernames: lookup.usernames,
  };
}

const PENDING_FOMO_HANDLES_SHOWN = 100;

/* GET /v1/admin/profiles/fomo-handles: claimed handles on profiles with a
   proven fomo wallet, not yet confirmed. */
export async function adminPendingFomoHandles(env: RuntimeEnv): Promise<Record<string, unknown>> {
  return { pending: await profiles(env).pendingFomoHandles(PENDING_FOMO_HANDLES_SHOWN) };
}

/* POST /v1/admin/profiles/fomo-handle { profileId, handle, verified, note? }:
   the admin checked (e.g. on fomo's profile page, by the masked address it
   shows) that the handle belongs to the profile's proven fomo wallet, or
   found it doesn't. `by` names the admin in the event log. */
export async function adminVerifyFomoHandle(env: RuntimeEnv, body: unknown, by: string): Promise<Record<string, unknown>> {
  const input = record(body);
  const handle = normaliseFomoHandle(input.handle);
  if (typeof input.profileId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(input.profileId) || "message" in handle ||
      typeof input.verified !== "boolean" || (input.note !== undefined && typeof input.note !== "string")) {
    throw new HttpError(400, "VALIDATION_FAILED", "profileId, handle and verified (true or false) are required.");
  }
  const note = typeof input.note === "string" ? input.note.slice(0, 500) : null;
  return answer(await profiles(env).adminVerifyFomoHandle(input.profileId, handle.key, input.verified, by, note, Date.now()));
}
