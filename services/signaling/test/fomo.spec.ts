import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEnv } from "../src/env";
import {
  DEFAULT_FOMO_FEE_PAYER,
  FOMO_SIGNATURES_PER_CHECK,
  checkFomoWallet,
  detectFomoWallet,
  handleFomoRequest,
  isFomoTransaction,
  transactionWrites,
  walletsDue,
  type FomoChain,
} from "../src/fomo";
import { FOMO_RECHECK_MS, PROFILES_NAME } from "../src/profiles";
import { fomoReferralUrl, siteInfo, xProfileUrl } from "../src/site";
import { base58Encode, type SignatureInfo, type TransactionJson } from "../src/solana";

/* fomo detection: a wallet is a fomo wallet when fomo's fee payer paid for
   one of its mainnet transactions. The chain is never read here: the
   detector is fed a fake chain, and the Worker's RPC calls go to a stubbed
   fetch for the host vitest.config.ts points FOMO_RPC_URL at. */

const API_ORIGIN = "http://signaling.test";
const GAME_ORIGIN = "http://127.0.0.1:8765";
const RPC_URL = "http://fomo-rpc.test/rpc";
const FEE_PAYER = DEFAULT_FOMO_FEE_PAYER;
let nextAddress = 0;
let nextName = 0;
let nextSignature = 0;

function freshName(prefix = "fomo"): string {
  nextName += 1;
  return `${prefix}${nextName}`.slice(0, 11);
}

function address(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base58Encode(bytes);
}

function signature(): string {
  nextSignature += 1;
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  bytes[0] = nextSignature & 0xff;
  return base58Encode(bytes);
}

interface Wallet { address: string; sign(message: string): Promise<string> }

async function newWallet(): Promise<Wallet> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return {
    address: base58Encode(raw),
    async sign(message: string): Promise<string> {
      const signed = await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(message));
      return base58Encode(new Uint8Array(signed));
    },
  };
}

/* A transaction as the RPC's json encoding gives it: the fee payer first,
   then the other accounts in the order the header expects (writable
   signers, read-only signers, writable others, read-only others). */
function transaction(input: {
  feePayer: string;
  writableSigners?: string[];
  readonlySigners?: string[];
  writable?: string[];
  readonly?: string[];
  loadedWritable?: string[];
  loadedReadonly?: string[];
  err?: unknown;
}): TransactionJson {
  const writableSigners = input.writableSigners ?? [];
  const readonlySigners = input.readonlySigners ?? [];
  const writable = input.writable ?? [];
  const readonly = input.readonly ?? [];
  return {
    meta: {
      err: input.err ?? null,
      loadedAddresses: { writable: input.loadedWritable ?? [], readonly: input.loadedReadonly ?? [] },
    },
    transaction: {
      message: {
        accountKeys: [input.feePayer, ...writableSigners, ...readonlySigners, ...writable, ...readonly],
        header: {
          numRequiredSignatures: 1 + writableSigners.length + readonlySigners.length,
          numReadonlySignedAccounts: readonlySigners.length,
          numReadonlyUnsignedAccounts: readonly.length,
        },
      },
    },
  };
}

/* A fake chain: each wallet's transactions, newest first. */
class FakeChain implements FomoChain {
  readonly history = new Map<string, Array<{ signature: string; transaction: TransactionJson | null }>>();
  readonly calls = { signatures: 0, transactions: 0, rateLimited: 0 };
  failing = false;
  /* answer 429 to every n-th request, as a plan's requests-per-second cap does */
  rateLimitEvery = 0;
  requests = 0;
  /* the transactions' version: a node refuses one newer than the caller
     says it supports (fomo's trades are version 1) */
  version = 0;
  versionRefusals = 0;

  add(wallet: string, transactions: Array<TransactionJson | null>): string[] {
    const entries = transactions.map((entry) => ({ signature: signature(), transaction: entry }));
    this.history.set(wallet, [...entries, ...(this.history.get(wallet) ?? [])]);
    return entries.map((entry) => entry.signature);
  }

  async signaturesForAddress(wallet: string, limit: number): Promise<SignatureInfo[]> {
    this.calls.signatures += 1;
    if (this.failing) throw new Error("chain down");
    return (this.history.get(wallet) ?? []).slice(0, limit).map((entry) => ({ signature: entry.signature, slot: 1, err: null }));
  }

  async transaction(wanted: string): Promise<TransactionJson | null> {
    this.calls.transactions += 1;
    if (this.failing) throw new Error("chain down");
    for (const entries of this.history.values()) {
      const found = entries.find((entry) => entry.signature === wanted);
      if (found) return found.transaction;
    }
    return null;
  }

  /* Serve JSON-RPC for the Worker, as the fetch stub. */
  async rpc(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== RPC_URL) throw new Error(`unexpected fetch of ${url}`);
    if (this.failing) return new Response("nope", { status: 502 });
    this.requests += 1;
    if (this.rateLimitEvery > 0 && this.requests % this.rateLimitEvery === 0) {
      this.calls.rateLimited += 1;
      return new Response("slow down", { status: 429, headers: { "Retry-After": "0.01" } });
    }
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    let result: unknown;
    if (body.method === "getSignaturesForAddress") {
      const [wallet, options] = body.params as [string, { limit: number }];
      result = await this.signaturesForAddress(wallet, options.limit);
    } else if (body.method === "getTransaction") {
      const [wanted, options] = body.params as [string, { maxSupportedTransactionVersion: number }];
      if (options.maxSupportedTransactionVersion < this.version) {
        this.versionRefusals += 1;
        return Response.json({ jsonrpc: "2.0", id: 1, error: {
          code: -32015,
          message: `Transaction version (${this.version}) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": ${this.version}`,
        } });
      }
      result = await this.transaction(wanted);
    } else {
      return Response.json({ jsonrpc: "2.0", id: 1, error: { message: `unknown method ${body.method}` } });
    }
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  }
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

async function link(auth: Record<string, string>, wallet: Wallet) {
  const challenge = await call("POST", "/v1/profile/wallets/challenge", { wallet: wallet.address }, auth);
  expect(challenge.status).toBe(200);
  const result = await call("POST", "/v1/profile/wallets", {
    wallet: wallet.address, nonce: challenge.body.nonce, signature: await wallet.sign(challenge.body.message),
  }, auth);
  expect(result.status).toBe(200);
  return result;
}

function store() {
  return env.PROFILES.getByName(PROFILES_NAME);
}

/* the sign-in's background check: wait for it to have been recorded */
async function recordedCheck(wallet: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const checks = await store().fomoChecks([wallet]);
    if (checks.length > 0) return checks[0]!;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no fomo check recorded for ${wallet}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a fomo transaction", () => {
  const wallet = address();
  const other = address();

  it("is one fomo's fee payer paid for in which the wallet is writable", () => {
    expect(isFomoTransaction(transaction({ feePayer: FEE_PAYER, writableSigners: [wallet] }), wallet, FEE_PAYER)).toBe(true);
    expect(isFomoTransaction(transaction({ feePayer: FEE_PAYER, writable: [other, wallet] }), wallet, FEE_PAYER)).toBe(true);
    expect(isFomoTransaction(transaction({ feePayer: FEE_PAYER, loadedWritable: [wallet] }), wallet, FEE_PAYER)).toBe(true);
    /* a failed trade is still a trade fomo paid for */
    expect(isFomoTransaction(transaction({ feePayer: FEE_PAYER, writableSigners: [wallet], err: { x: 1 } }), wallet, FEE_PAYER)).toBe(true);
  });

  it("is not one someone else paid for, nor one that only reads the wallet", () => {
    expect(isFomoTransaction(transaction({ feePayer: wallet }), wallet, FEE_PAYER)).toBe(false);
    expect(isFomoTransaction(transaction({ feePayer: other, writableSigners: [wallet] }), wallet, FEE_PAYER)).toBe(false);
    expect(isFomoTransaction(transaction({ feePayer: FEE_PAYER, readonlySigners: [wallet] }), wallet, FEE_PAYER)).toBe(false);
    expect(isFomoTransaction(transaction({ feePayer: FEE_PAYER, writable: [other], readonly: [wallet] }), wallet, FEE_PAYER)).toBe(false);
    expect(isFomoTransaction(transaction({ feePayer: FEE_PAYER, loadedReadonly: [wallet] }), wallet, FEE_PAYER)).toBe(false);
    expect(isFomoTransaction(transaction({ feePayer: FEE_PAYER, writable: [other] }), wallet, FEE_PAYER)).toBe(false);
    /* fomo's own wallet is not a fomo user */
    expect(isFomoTransaction(transaction({ feePayer: FEE_PAYER }), FEE_PAYER, FEE_PAYER)).toBe(false);
  });

  it("reads the header for who is writable, and trusts a transaction without one", () => {
    const mixed = transaction({
      feePayer: FEE_PAYER, writableSigners: ["w1"], readonlySigners: ["r1"], writable: ["w2"], readonly: ["r2"],
    });
    expect(["AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51", "w1", "w2"].map((key) => transactionWrites(mixed, key))).toEqual([true, true, true]);
    expect(["r1", "r2", "absent"].map((key) => transactionWrites(mixed, key))).toEqual([false, false, false]);
    const headerless: TransactionJson = { meta: null, transaction: { message: { accountKeys: [FEE_PAYER, wallet] } } };
    expect(transactionWrites(headerless, wallet)).toBe(true);
  });
});

describe("the detector", () => {
  it("stops at the first fomo transaction and reports how many it looked at", async () => {
    const chain = new FakeChain();
    const wallet = address();
    const noise = () => transaction({ feePayer: wallet, writable: [address()] });
    /* newest first: 35 of the wallet's own, a fomo one, 20 more of its
       own, an older fomo one: 57, of which a check reads at most 50 */
    chain.add(wallet, [...Array.from({ length: 20 }, noise), transaction({ feePayer: FEE_PAYER, writableSigners: [wallet] })]);
    const signatures = chain.add(wallet, [...Array.from({ length: 35 }, noise), transaction({ feePayer: FEE_PAYER, writableSigners: [wallet] })]);
    const found = await detectFomoWallet(chain, wallet, FEE_PAYER);
    /* the batch of five holding the hit is the last one read */
    expect(found).toEqual({ detected: true, signature: signatures[35], scanned: 40 });
    expect(chain.calls).toEqual({ signatures: 1, transactions: 40, rateLimited: 0 });
  });

  it("finds nothing in a wallet fomo never paid for, and in an empty one", async () => {
    const chain = new FakeChain();
    const wallet = address();
    chain.add(wallet, Array.from({ length: 60 }, () => transaction({ feePayer: wallet, writable: [address()] })));
    expect(await detectFomoWallet(chain, wallet, FEE_PAYER)).toEqual({ detected: false, signature: null, scanned: FOMO_SIGNATURES_PER_CHECK });
    expect(await detectFomoWallet(chain, address(), FEE_PAYER)).toEqual({ detected: false, signature: null, scanned: 0 });
  });

  it("skips a transaction the network no longer has", async () => {
    const chain = new FakeChain();
    const wallet = address();
    const [, kept] = chain.add(wallet, [null, transaction({ feePayer: FEE_PAYER, writableSigners: [wallet] })]);
    expect(await detectFomoWallet(chain, wallet, FEE_PAYER)).toEqual({ detected: true, signature: kept, scanned: 2 });
  });

  it("rechecks only undetected wallets, and those only after the interval or when forced", () => {
    const now = 1_000_000_000_000;
    const [fresh, stale, detected, never] = [address(), address(), address(), address()];
    const checks = {
      [fresh]: { wallet: fresh, checkedAt: now - FOMO_RECHECK_MS + 1, detected: false, signature: null },
      [stale]: { wallet: stale, checkedAt: now - FOMO_RECHECK_MS, detected: false, signature: null },
      [detected]: { wallet: detected, checkedAt: now - 10 * FOMO_RECHECK_MS, detected: true, signature: "sig" },
    };
    expect(walletsDue([fresh, stale, detected, never], checks, now, false)).toEqual([stale, never]);
    expect(walletsDue([fresh, stale, detected, never], checks, now, true)).toEqual([fresh, stale, never]);
  });
});

describe("the site's links", () => {
  it("builds the fomo referral link from the configured code, falling back to ARCH", () => {
    expect(fomoReferralUrl("ARCH")).toBe("https://fomo.family/r/ARCH");
    expect(fomoReferralUrl(" halo_117 ")).toBe("https://fomo.family/r/halo_117");
    for (const bad of [undefined, "", "has space", "x".repeat(33), "../etc", "a/b"]) {
      expect(fomoReferralUrl(bad)).toBe("https://fomo.family/r/ARCH");
    }
  });

  it("keeps the X link off until a real X profile URL is set", () => {
    expect(xProfileUrl("")).toBeNull();
    expect(xProfileUrl(undefined)).toBeNull();
    expect(xProfileUrl("https://x.com/fomo")).toBe("https://x.com/fomo");
    expect(xProfileUrl("https://twitter.com/fomo/")).toBe("https://x.com/fomo");
    for (const bad of ["x.com/fomo", "http://x.com/fomo", "https://example.com/fomo", "https://x.com/", "https://x.com/a/status/1", "https://x.com/way_too_long_for_a_handle"]) {
      expect(xProfileUrl(bad)).toBeNull();
    }
  });

  it("answers GET /v1/site for the page", async () => {
    const site = await call("GET", "/v1/site");
    expect(site.status).toBe(200);
    expect(site.body).toEqual({ links: { fomo: "https://fomo.family/r/ARCH", x: null }, fomoDetection: true, v: expect.any(Number) });
    expect(siteInfo({ FOMO_REFERRAL_CODE: "ARCH", X_PROFILE_URL: "https://x.com/halo", FOMO_RPC_URL: "" }))
      .toEqual({ links: { fomo: "https://fomo.family/r/ARCH", x: "https://x.com/halo" }, fomoDetection: false });
  });
});

describe("fomo detection in the Worker", () => {
  it("checks a wallet after it signs in, and verifies its profile once it has one", async () => {
    const chain = new FakeChain();
    vi.stubGlobal("fetch", chain.rpc.bind(chain));
    const wallet = await newWallet();
    chain.add(wallet.address, [
      transaction({ feePayer: wallet.address, writable: [address()] }),
      transaction({ feePayer: FEE_PAYER, writableSigners: [wallet.address], loadedWritable: [address()] }),
    ]);

    const auth = await signIn(wallet);
    const check = await recordedCheck(wallet.address);
    expect(check).toMatchObject({ wallet: wallet.address, detected: true });
    expect(check.signature).toBe(chain.history.get(wallet.address)![1]!.signature);
    expect(chain.calls.signatures).toBe(1);

    /* the profile made later is verified from the cached check: the chain
       is not read again */
    const claimed = await call("POST", "/v1/profile/username", { username: freshName() }, auth);
    expect(claimed.status).toBe(200);
    expect(claimed.body.profile.fomo).toEqual({
      handle: null, wallet: wallet.address, verified: true, verifiedAt: expect.any(Number), method: "fee_payer",
    });
    expect(claimed.body.profile.fomoChecks).toEqual([
      { wallet: wallet.address, checkedAt: check.checkedAt, detected: true, signature: check.signature },
    ]);
    expect(chain.calls.signatures).toBe(1);

    /* private until shown; then other players see the fomo wallet */
    const name = claimed.body.profile.username as string;
    expect((await call("GET", `/v1/profiles/${name}`)).body.profile).toEqual({ id: claimed.body.profile.id, username: name });
    await call("PATCH", "/v1/profile", { showFomo: true }, auth);
    expect((await call("GET", `/v1/profiles/${name}`)).body.profile).toEqual({
      id: claimed.body.profile.id, username: name, fomo: { handle: null, wallet: wallet.address },
    });

    /* a second sign-in of a detected wallet does not read the chain */
    await signIn(wallet);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chain.calls.signatures).toBe(1);
  });

  it("records a wallet fomo never paid for, and looks again only after the interval", async () => {
    const chain = new FakeChain();
    vi.stubGlobal("fetch", chain.rpc.bind(chain));
    const wallet = await newWallet();
    chain.add(wallet.address, [transaction({ feePayer: wallet.address, writable: [address()] })]);

    const auth = await signIn(wallet);
    expect(await recordedCheck(wallet.address)).toMatchObject({ detected: false, signature: null });
    const claimed = await call("POST", "/v1/profile/username", { username: freshName() }, auth);
    expect(claimed.body.profile.fomo).toBeNull();
    expect(claimed.body.profile.fomoChecks).toEqual([expect.objectContaining({ detected: false })]);

    await signIn(wallet);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chain.calls.signatures).toBe(1);

    /* once the interval has passed, the next sign-in looks again */
    await store().recordFomoCheck(wallet.address, { detected: false, signature: null, scanned: 1 }, Date.now() - FOMO_RECHECK_MS);
    chain.add(wallet.address, [transaction({ feePayer: FEE_PAYER, writable: [wallet.address] })]);
    await signIn(wallet);
    for (let attempt = 0; attempt < 50 && chain.calls.signatures < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(chain.calls.signatures).toBe(2);
    expect(await recordedCheck(wallet.address)).toMatchObject({ detected: true });
    expect((await call("GET", "/v1/profile", undefined, auth)).body.profile.fomo).toMatchObject({ verified: true, method: "fee_payer" });
  });

  it("checks on request, every wallet of the profile, once per cooldown", async () => {
    const chain = new FakeChain();
    vi.stubGlobal("fetch", chain.rpc.bind(chain));
    const first = await newWallet();
    const second = await newWallet();
    const auth = await signIn(first);
    await recordedCheck(first.address);
    await call("POST", "/v1/profile/username", { username: freshName() }, auth);
    /* a wallet linked by signature (not signed in) is not checked yet */
    await link(auth, second);
    expect(await store().fomoChecks([second.address])).toEqual([]);
    expect(chain.calls.signatures).toBe(1);

    /* on request, both wallets are read, the first one again although it
       was checked a moment ago; fomo has paid for neither */
    const before = await call("POST", "/v1/profile/fomo/check", undefined, auth);
    expect(before.status).toBe(200);
    expect(before.body.enabled).toBe(true);
    expect(before.body.profile.fomo).toBeNull();
    expect(before.body.checks.map((check: { detected: boolean }) => check.detected)).toEqual([false, false]);
    expect(chain.calls.signatures).toBe(3);

    /* the cooldown */
    const again = await call("POST", "/v1/profile/fomo/check", undefined, auth);
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe("FOMO_CHECK_RATE_LIMITED");
    await env.HALO_ABUSE.delete(`fomo-check:${first.address}`);

    /* the second wallet trades on fomo: the profile is verified through it */
    chain.add(second.address, [transaction({ feePayer: FEE_PAYER, writableSigners: [second.address] })]);
    const found = await call("POST", "/v1/profile/fomo/check", undefined, auth);
    expect(found.status).toBe(200);
    expect(found.body.profile.fomo).toMatchObject({ wallet: second.address, verified: true, method: "fee_payer" });
    expect(found.body.checks).toEqual([
      expect.objectContaining({ wallet: first.address, detected: false }),
      expect.objectContaining({ wallet: second.address, detected: true }),
    ]);

    /* unlinking the detected wallet takes the verification with it;
       linking it back brings it back without reading the chain */
    const calls = chain.calls.signatures;
    const unlinked = await call("DELETE", `/v1/profile/wallets/${second.address}`, undefined, auth);
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.profile.fomo).toBeNull();
    expect(unlinked.body.profile.fomoChecks).toEqual([expect.objectContaining({ wallet: first.address })]);
    const relinked = await link(auth, second);
    expect(relinked.body.profile.fomo).toMatchObject({ wallet: second.address, verified: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(chain.calls.signatures).toBe(calls);

    const lookup = await call("GET", `/v1/admin/profiles?wallet=${first.address}`, undefined, {
      Authorization: "Bearer test-only-admin-token-32-bytes-minimum",
    });
    expect(lookup.status).toBe(200);
    const kinds = (lookup.body.events as Array<{ kind: string }>).map((event) => event.kind);
    expect(kinds).toContain("fomo_verified");
    expect(kinds).toContain("fomo_unverified");
  });

  it("waits out a rate-limited endpoint", async () => {
    const chain = new FakeChain();
    chain.rateLimitEvery = 2;
    vi.stubGlobal("fetch", chain.rpc.bind(chain));
    const wallet = await newWallet();
    chain.add(wallet.address, [
      ...Array.from({ length: 7 }, () => transaction({ feePayer: wallet.address, writable: [address()] })),
      transaction({ feePayer: FEE_PAYER, writableSigners: [wallet.address] }),
    ]);
    const auth = await signIn(wallet);
    const check = await recordedCheck(wallet.address);
    expect(check.detected).toBe(true);
    expect(chain.calls.rateLimited).toBeGreaterThan(0);
    expect((await call("POST", "/v1/profile/username", { username: freshName() }, auth)).body.profile.fomo)
      .toMatchObject({ verified: true, method: "fee_payer" });
  });

  it("reads transactions of a version newer than it asked for", async () => {
    const chain = new FakeChain();
    chain.version = 1;
    vi.stubGlobal("fetch", chain.rpc.bind(chain));
    const wallet = await newWallet();
    chain.add(wallet.address, [transaction({ feePayer: FEE_PAYER, writableSigners: [wallet.address] })]);
    await signIn(wallet);
    expect((await recordedCheck(wallet.address)).detected).toBe(true);
    expect(chain.versionRefusals).toBe(1);
    expect(chain.calls.transactions).toBe(1);
  });

  it("needs a sign-in, and records nothing when the chain cannot be read", async () => {
    const chain = new FakeChain();
    vi.stubGlobal("fetch", chain.rpc.bind(chain));
    expect((await call("POST", "/v1/profile/fomo/check")).status).toBe(401);

    chain.failing = true;
    const wallet = await newWallet();
    const auth = await signIn(wallet);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await store().fomoChecks([wallet.address])).toEqual([]);
    await env.HALO_ABUSE.delete(`fomo-check:${wallet.address}`);
    const failed = await call("POST", "/v1/profile/fomo/check", undefined, auth);
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe("FOMO_CHECK_UNAVAILABLE");
    expect(await store().fomoChecks([wallet.address])).toEqual([]);
  });

  it("is off without FOMO_RPC_URL", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const off = { ...env, FOMO_RPC_URL: "" } as RuntimeEnv;
    const wallet = await newWallet();
    const auth = await signIn(wallet);
    await new Promise((resolve) => setTimeout(resolve, 50));
    /* the real test env has it on: the sign-in above read the (stubbed) chain */
    expect(fetchMock).toHaveBeenCalled();
    fetchMock.mockClear();

    const outcome = await checkFomoWallet(off, wallet.address, Date.now());
    expect(outcome).toMatchObject({ enabled: false, profile: null });
    expect(fetchMock).not.toHaveBeenCalled();
    const request = new Request(`${API_ORIGIN}/v1/profile/fomo/check`, { method: "POST", headers: auth });
    await expect(handleFomoRequest(request, off, "/v1/profile/fomo/check", Date.now()))
      .rejects.toMatchObject({ status: 503, code: "FOMO_DETECTION_OFF" });
  });
});
