import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  PROFILES_NAME,
  RELEASED_USERNAME_HOLD_MS,
  USERNAME_CHANGES_PER_DAY,
  normaliseUsername,
} from "../src/profiles";
import { base58Encode } from "../src/solana";

const API_ORIGIN = "http://signaling.test";
const GAME_ORIGIN = "http://127.0.0.1:8765";
const ADMIN_TOKEN = "test-only-admin-token-32-bytes-minimum";
let nextAddress = 0;
let nextName = 0;

/* every test's names are its own: the profiles store is a singleton */
function freshName(prefix = "spartan"): string {
  nextName += 1;
  return `${prefix}${nextName}`.slice(0, 11);
}

interface Wallet { address: string; sign(message: string): Promise<string> }

async function newWallet(): Promise<Wallet> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return {
    address: base58Encode(raw),
    async sign(message: string): Promise<string> {
      const signature = await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(message));
      return base58Encode(new Uint8Array(signature));
    },
  };
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  nextAddress += 1;
  const response = await exports.default.fetch(new Request(`${API_ORIGIN}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: GAME_ORIGIN,
      "CF-Connecting-IP": `192.0.2.${nextAddress % 250}`,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, body: await response.json<Record<string, any>>() };
}

async function signIn(wallet: Wallet): Promise<Record<string, string>> {
  const challenge = await call("POST", "/v1/auth/challenge", { wallet: wallet.address });
  const verify = await call("POST", "/v1/auth/verify", {
    nonce: challenge.body.nonce, signature: await wallet.sign(challenge.body.message), wallet: wallet.address,
  });
  expect(verify.status).toBe(200);
  return { Authorization: `Bearer ${verify.body.token}` };
}

async function claim(auth: Record<string, string>, username: string) {
  return call("POST", "/v1/profile/username", { username }, auth);
}

/* link `wallet` to the profile of the wallet behind `auth`, signing with
   `signer` (the wallet itself unless a test forges) */
async function link(auth: Record<string, string>, wallet: Wallet, signer: Wallet = wallet) {
  const challenge = await call("POST", "/v1/profile/wallets/challenge", { wallet: wallet.address }, auth);
  expect(challenge.status).toBe(200);
  const result = await call("POST", "/v1/profile/wallets", {
    wallet: wallet.address, nonce: challenge.body.nonce, signature: await signer.sign(challenge.body.message),
  }, auth);
  return { challenge: challenge.body, ...result };
}

describe("usernames", () => {
  it("normalises and validates", () => {
    expect(normaliseUsername("  @Chief_117 ")).toEqual({ username: "Chief_117", key: "chief_117" });
    expect(normaliseUsername("Chief")).toEqual({ username: "Chief", key: "chief" });
    for (const bad of ["ab", "a".repeat(12), "no spaces", "héllo", "_lead", "trail_", "12345", 7, null]) {
      expect(normaliseUsername(bad)).toMatchObject({ problem: "USERNAME_INVALID" });
    }
    for (const reserved of ["admin", "Admin", "MODERATOR", "admin_bob", "halo", "fomo", "null"]) {
      expect(normaliseUsername(reserved)).toMatchObject({ problem: "USERNAME_RESERVED" });
    }
  });
});

describe("profiles", () => {
  it("needs a wallet sign-in", async () => {
    expect((await call("GET", "/v1/profile")).status).toBe(401);
    expect((await claim({}, freshName())).status).toBe(401);
  });

  it("claims a username, which makes the profile, and keeps names unique without regard to case", async () => {
    const wallet = await newWallet();
    const auth = await signIn(wallet);
    expect((await call("GET", "/v1/profile", undefined, auth)).body).toEqual({ profile: null });

    const name = freshName("Chief");
    const claimed = await claim(auth, name);
    expect(claimed.status).toBe(200);
    expect(claimed.body.profile).toMatchObject({
      username: name,
      wallets: [{ wallet: wallet.address }],
      fomo: null,
      x: null,
      show: { wallets: false, fomo: false, x: false },
      usernameChangesLeft: USERNAME_CHANGES_PER_DAY,
    });
    const id = claimed.body.profile.id as string;
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/u);

    /* the same name in another case is the same name */
    const other = await signIn(await newWallet());
    const taken = await claim(other, name.toUpperCase());
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe("USERNAME_TAKEN");

    /* bad names */
    expect((await claim(other, "ab")).body.error.code).toBe("USERNAME_INVALID");
    expect((await claim(other, "admin")).body.error.code).toBe("USERNAME_RESERVED");

    /* the owner may change its case, and that is not a rename */
    const recased = await claim(auth, name.toUpperCase());
    expect(recased.body.profile).toMatchObject({ id, username: name.toUpperCase(), usernameChangesLeft: USERNAME_CHANGES_PER_DAY });
    expect((await call("GET", "/v1/profile", undefined, auth)).body.profile.username).toBe(name.toUpperCase());
  });

  it("renames a few times a day, holds the old name for its owner, and keeps the history", async () => {
    const wallet = await newWallet();
    const auth = await signIn(wallet);
    const first = freshName("Old");
    const claimed = await claim(auth, first);
    const id = claimed.body.profile.id as string;

    const names = [first];
    for (let change = 1; change <= USERNAME_CHANGES_PER_DAY; change += 1) {
      const next = freshName("New");
      const renamed = await claim(auth, next);
      expect(renamed.status).toBe(200);
      expect(renamed.body.profile).toMatchObject({ id, username: next, usernameChangesLeft: USERNAME_CHANGES_PER_DAY - change });
      names.push(next);
    }
    const tooMany = await claim(auth, freshName("Nope"));
    expect(tooMany.status).toBe(429);
    expect(tooMany.body.error.code).toBe("USERNAME_RATE_LIMITED");

    /* the released first name is held: another profile cannot take it yet */
    const other = await signIn(await newWallet());
    const sniped = await claim(other, first);
    expect(sniped.status).toBe(409);

    const admin = await call("GET", `/v1/admin/profiles?id=${id}`, undefined, { Authorization: `Bearer ${ADMIN_TOKEN}` });
    expect(admin.status).toBe(200);
    expect(admin.body.profile.id).toBe(id);
    const history = admin.body.usernames as Array<{ username: string; profileId: string | null }>;
    expect(history.map((entry) => entry.username).sort()).toEqual([...names].sort());
    expect(history.filter((entry) => entry.profileId === id).map((entry) => entry.username)).toEqual([names.at(-1)]);
    expect(history.find((entry) => entry.username === first)).toMatchObject({ profileId: null });
    expect(admin.body.events.map((event: { kind: string }) => event.kind)).toContain("username_rename");
    expect((await call("GET", `/v1/admin/profiles?id=${id}`)).status).toBe(401);

    /* ... but once the hold is over the first name is free */
    const store = env.PROFILES.getByName(PROFILES_NAME);
    const later = Date.now() + RELEASED_USERNAME_HOLD_MS + 1;
    const freed = await store.claimUsername((await newWallet()).address, first, first.toLowerCase(), later);
    expect(freed).toMatchObject({ profile: { username: first } });
  });

  it("links a second wallet with its signature, refuses forgeries and replays, and unlinks", async () => {
    const first = await newWallet();
    const second = await newWallet();
    const auth = await signIn(first);
    const name = freshName("Two");
    expect((await call("POST", "/v1/profile/wallets/challenge", { wallet: second.address }, auth)).status).toBe(404);
    await claim(auth, name);

    /* a forged signature */
    const stranger = await newWallet();
    const forged = await link(auth, second, stranger);
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe("WALLET_SIGNATURE_INVALID");

    const linked = await link(auth, second);
    expect(linked.status).toBe(200);
    expect(linked.challenge.message).toContain(`Wallet: ${second.address}`);
    expect(linked.challenge.message).toContain("Domain: halois.fun");
    expect(linked.challenge.message).toMatch(/Expires: \d{4}-/u);
    expect(linked.body.profile.wallets.map((entry: { wallet: string }) => entry.wallet))
      .toEqual([first.address, second.address]);

    /* the nonce is single use */
    const replay = await call("POST", "/v1/profile/wallets", {
      wallet: second.address, nonce: linked.challenge.nonce, signature: await second.sign(linked.challenge.message),
    }, auth);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("LINK_CHALLENGE_EXPIRED");

    /* the second wallet signs in to the same profile */
    const secondAuth = await signIn(second);
    expect((await call("GET", "/v1/profile", undefined, secondAuth)).body.profile.username).toBe(name);
    /* a wallet belongs to one profile: a third profile cannot take it */
    const thirdAuth = await signIn(await newWallet());
    await claim(thirdAuth, freshName("Thr"));
    const stolen = await link(thirdAuth, second);
    expect(stolen.status).toBe(409);
    expect(stolen.body.error.code).toBe("WALLET_ALREADY_LINKED");
    /* either wallet renames the one shared profile */
    const renamed = freshName("Ours");
    expect((await claim(secondAuth, renamed)).body.profile.username).toBe(renamed);
    expect((await call("GET", "/v1/profile", undefined, auth)).body.profile.username).toBe(renamed);

    /* unlink from either wallet; the last one stays */
    const unlinked = await call("DELETE", `/v1/profile/wallets/${first.address}`, undefined, secondAuth);
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.profile.wallets).toHaveLength(1);
    expect((await call("GET", "/v1/profile", undefined, auth)).body).toEqual({ profile: null });
    const last = await call("DELETE", `/v1/profile/wallets/${second.address}`, undefined, secondAuth);
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe("PROFILE_LAST_WALLET");
    expect((await call("DELETE", `/v1/profile/wallets/${stranger.address}`, undefined, secondAuth)).status).toBe(404);
  });

  it("shows other players only the name, plus the links the owner shows that are verified", async () => {
    const first = await newWallet();
    const second = await newWallet();
    const auth = await signIn(first);
    const name = freshName("Pub");
    const claimed = await claim(auth, name);
    const id = claimed.body.profile.id as string;
    await link(auth, second);

    const lookup = await call("GET", `/v1/profiles/${name.toLowerCase()}`);
    expect(lookup.status).toBe(200);
    expect(lookup.body.profile).toEqual({ id, username: name });
    expect((await call("GET", `/v1/profiles/${freshName("Nobody")}`)).status).toBe(404);
    expect((await call("GET", "/v1/profiles/bad%20name")).status).toBe(404);

    /* by wallet: each wallet seen playing maps to its name; the other
       wallets stay private until shown */
    const outsider = await newWallet();
    const roster = await call("GET", `/v1/profiles?wallets=${first.address},${outsider.address},${second.address}`);
    expect(roster.status).toBe(200);
    expect(roster.body.profiles).toEqual({ [first.address]: { id, username: name }, [second.address]: { id, username: name } });
    expect((await call("GET", "/v1/profiles?wallets=")).status).toBe(400);
    expect((await call("GET", "/v1/profiles?wallets=notawallet")).status).toBe(400);

    /* an unverified X handle stays hidden even when shown; a verified one
       shows once the owner opts in */
    const store = env.PROFILES.getByName(PROFILES_NAME);
    await store.setVisibility(first.address, { wallets: true, x: true }, Date.now());
    const shown = await call("GET", `/v1/profiles/${name}`);
    expect(shown.body.profile).toEqual({ id, username: name, wallets: [first.address, second.address] });

    const patched = await call("PATCH", "/v1/profile", { showWallets: false }, auth);
    expect(patched.status).toBe(200);
    expect(patched.body.profile.show).toEqual({ wallets: false, fomo: false, x: true });
    expect((await call("PATCH", "/v1/profile", {}, auth)).status).toBe(400);
    expect((await call("PATCH", "/v1/profile", { showX: "yes" }, auth)).status).toBe(400);
    expect((await call("GET", `/v1/profiles/${name}`)).body.profile).toEqual({ id, username: name });
  });
});
