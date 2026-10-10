import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEnv } from "../src/env";
import { DEFAULT_FOMO_FEE_PAYER } from "../src/fomo";
import {
  FOMO_HANDLE_CLAIMS_PER_HOUR,
  FOMO_TRANSFER_MINT,
  fomoHandleSeen,
  fomoTransferSender,
  normaliseFomoHandle,
  tokenAccountAddress,
} from "../src/fomo_handle";
import { base58Encode, type SignatureInfo, type TransactionJson } from "../src/solana";

/* The fomo handle claim and the transfer proof. Nothing here reaches the
   network: fetch is stubbed for the RPC host vitest.config.ts points
   FOMO_RPC_URL at and for fomo's profile card host. */

const API_ORIGIN = "http://signaling.test";
const GAME_ORIGIN = "http://127.0.0.1:8765";
const RPC_URL = "http://fomo-rpc.test/rpc";
const CARD_PREFIX = "https://image-renderer.fomo.cloud/og/profile/";
const ADMIN = { Authorization: "Bearer test-only-admin-token-32-bytes-minimum" };
const FEE_PAYER = DEFAULT_FOMO_FEE_PAYER;
let nextAddress = 0;
let nextName = 0;

function freshName(prefix = "hdl"): string {
  nextName += 1;
  return `${prefix}${nextName}`.slice(0, 11);
}

function freshHandle(prefix = "fan"): string {
  nextName += 1;
  return `${prefix}.${nextName}_${crypto.randomUUID().slice(0, 6)}`;
}

function address(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base58Encode(bytes);
}

function signature(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
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

/* A real fomo withdrawal on mainnet (slot time 2026-10-09): fomo's fee
   payer paid for 500 USDC going from a fomo user's wallet to another
   wallet's token account. Trimmed to what the check reads. */
const FOMO_WITHDRAWAL = {
  signature: "y9viW8AMHiDTvPA93vZK57d8YMryo5g56ED5f47HFHup5vVeFSKhmHkZY9bv7jYPgaEaweUQyPWn1mG51RvwQA3",
  sender: "Bfxfmsp4t2ZUzBDQ2ExSyJoTXHnaG91bED3zr7uEFCai",
  senderTokenAccount: "DBMKwXRDEVQGAYqVVjnpP5pvxHk8acx7Lfxx3wBjG2wF",
  receiver: "B8Q7qi3RS41VA6bckhKegAwhUGYUHCRkVcVEYwnq3Vr6",
  receiverTokenAccount: "CNL9opLMiiVZJnVZ37zWuqXURpoHigj6CLfXBAve9cM8",
  units: 500_000_000n,
  transaction: {
    blockTime: 1791615363,
    meta: {
      err: null,
      preTokenBalances: [
        { accountIndex: 2, mint: FOMO_TRANSFER_MINT, owner: "B8Q7qi3RS41VA6bckhKegAwhUGYUHCRkVcVEYwnq3Vr6", uiTokenAmount: { amount: "6100", decimals: 6 } },
        { accountIndex: 3, mint: FOMO_TRANSFER_MINT, owner: "Bfxfmsp4t2ZUzBDQ2ExSyJoTXHnaG91bED3zr7uEFCai", uiTokenAmount: { amount: "924046031", decimals: 6 } },
      ],
      postTokenBalances: [
        { accountIndex: 2, mint: FOMO_TRANSFER_MINT, owner: "B8Q7qi3RS41VA6bckhKegAwhUGYUHCRkVcVEYwnq3Vr6", uiTokenAmount: { amount: "500006100", decimals: 6 } },
        { accountIndex: 3, mint: FOMO_TRANSFER_MINT, owner: "Bfxfmsp4t2ZUzBDQ2ExSyJoTXHnaG91bED3zr7uEFCai", uiTokenAmount: { amount: "424046031", decimals: 6 } },
      ],
    },
    transaction: {
      message: {
        accountKeys: [
          "AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51",
          "Bfxfmsp4t2ZUzBDQ2ExSyJoTXHnaG91bED3zr7uEFCai",
          "CNL9opLMiiVZJnVZ37zWuqXURpoHigj6CLfXBAve9cM8",
          "DBMKwXRDEVQGAYqVVjnpP5pvxHk8acx7Lfxx3wBjG2wF",
          "ComputeBudget111111111111111111111111111111",
          FOMO_TRANSFER_MINT,
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        ],
      },
    },
  } satisfies TransactionJson,
};

/* A USDC transfer of `units` from `from` to `to`, its fee paid by
   `feePayer`. */
function transfer(input: { feePayer: string; from: string; to: string; units: bigint; mint?: string; err?: unknown }): TransactionJson {
  const mint = input.mint ?? FOMO_TRANSFER_MINT;
  const balance = (accountIndex: number, owner: string, amount: bigint) =>
    ({ accountIndex, mint, owner, uiTokenAmount: { amount: String(amount), decimals: 6 } });
  return {
    meta: {
      err: input.err ?? null,
      preTokenBalances: [balance(2, input.to, 0n), balance(3, input.from, 5_000_000n)],
      postTokenBalances: [balance(2, input.to, input.units), balance(3, input.from, 5_000_000n - input.units)],
    },
    transaction: { message: { accountKeys: [input.feePayer, input.from, address(), address()] } },
  };
}

/* Answers the Worker's fetches: JSON-RPC from a list of transactions per
   address, and fomo's profile card from a table of statuses. */
class FakeNetwork {
  readonly history = new Map<string, Array<{ signature: string; transaction: TransactionJson }>>();
  readonly cards = new Map<string, number>();
  readonly calls = { cards: 0, rpc: 0 };
  chainDown = false;

  add(account: string, transactions: TransactionJson[]): void {
    const entries = transactions.map((transaction) => ({ signature: signature(), transaction }));
    this.history.set(account, [...entries, ...(this.history.get(account) ?? [])]);
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(CARD_PREFIX)) {
      this.calls.cards += 1;
      expect(init?.method).toBe("HEAD");
      expect(init?.redirect).toBe("manual");
      const handle = decodeURIComponent(url.slice(CARD_PREFIX.length).replace(/\/card\.png$/u, ""));
      const status = this.cards.get(handle) ?? 302;
      return new Response(null, {
        status,
        headers: status === 302 ? { Location: "https://fomo.family/images/og-image.png" } : { "Content-Type": "image/png" },
      });
    }
    if (url !== RPC_URL) throw new Error(`unexpected fetch of ${url}`);
    this.calls.rpc += 1;
    if (this.chainDown) return new Response("nope", { status: 502 });
    const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    if (body.method === "getSignaturesForAddress") {
      const [account, options] = body.params as [string, { limit: number }];
      const result: SignatureInfo[] = (this.history.get(account) ?? []).slice(0, options.limit)
        .map((entry) => ({ signature: entry.signature, slot: 1, err: null }));
      return Response.json({ jsonrpc: "2.0", id: 1, result });
    }
    if (body.method === "getTransaction") {
      const [wanted] = body.params as [string];
      for (const entries of this.history.values()) {
        const found = entries.find((entry) => entry.signature === wanted);
        if (found) return Response.json({ jsonrpc: "2.0", id: 1, result: found.transaction });
      }
      return Response.json({ jsonrpc: "2.0", id: 1, result: null });
    }
    return Response.json({ jsonrpc: "2.0", id: 1, error: { message: `unknown method ${body.method}` } });
  }
}

function useNetwork(): FakeNetwork {
  const network = new FakeNetwork();
  vi.stubGlobal("fetch", network.fetch.bind(network));
  return network;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  nextAddress += 1;
  const response = await exports.default.fetch(new Request(`${API_ORIGIN}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: GAME_ORIGIN,
      "CF-Connecting-IP": `198.51.100.${nextAddress % 250}`,
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

/* a signed-in player with a profile (the sign-in's fomo check finds
   nothing on the fake chain) */
async function player() {
  const wallet = await newWallet();
  const auth = await signIn(wallet);
  const claimed = await call("POST", "/v1/profile/username", { username: freshName() }, auth);
  expect(claimed.status).toBe(200);
  return { wallet, auth, id: claimed.body.profile.id as string, username: claimed.body.profile.username as string };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a fomo handle", () => {
  it("is normalised from what a player pastes", () => {
    expect(normaliseFomoHandle("  @Spartan.Fan ")).toEqual({ handle: "Spartan.Fan", key: "spartan.fan" });
    expect(normaliseFomoHandle("https://fomo.family/profile/chief_117?ref=x")).toEqual({ handle: "chief_117", key: "chief_117" });
    expect(normaliseFomoHandle("fomo.family/r/Arbiter/")).toMatchObject({ message: expect.any(String) });
    expect(normaliseFomoHandle("https://www.fomo.family/r/Arbiter/")).toEqual({ handle: "Arbiter", key: "arbiter" });
    for (const bad of ["", "@", "...", "has space", "a/b", "x".repeat(31), 42, null]) {
      expect(normaliseFomoHandle(bad)).toMatchObject({ message: expect.any(String) });
    }
  });

  it("is looked up on fomo's profile card once a day, and not at all when the check is off", async () => {
    const network = useNetwork();
    const key = freshHandle().toLowerCase();
    network.cards.set(key, 200);
    const now = Date.now();
    expect(await fomoHandleSeen(env as unknown as RuntimeEnv, key, now)).toBe(true);
    expect(await fomoHandleSeen(env as unknown as RuntimeEnv, key, now)).toBe(true);
    expect(network.calls.cards).toBe(1);

    const unknown = freshHandle().toLowerCase();
    expect(await fomoHandleSeen(env as unknown as RuntimeEnv, unknown, now)).toBe(false);
    /* an answer that says neither is not cached */
    const flaky = freshHandle().toLowerCase();
    network.cards.set(flaky, 503);
    expect(await fomoHandleSeen(env as unknown as RuntimeEnv, flaky, now)).toBeNull();
    network.cards.set(flaky, 200);
    expect(await fomoHandleSeen(env as unknown as RuntimeEnv, flaky, now)).toBe(true);

    const calls = network.calls.cards;
    const off = { ...env, FOMO_HANDLE_CHECK: "off" } as unknown as RuntimeEnv;
    expect(await fomoHandleSeen(off, freshHandle().toLowerCase(), now)).toBeNull();
    expect(network.calls.cards).toBe(calls);
  });
});

describe("a fomo transfer", () => {
  it("is found in a real fomo withdrawal, sender and all", () => {
    const { transaction, receiver, sender, units } = FOMO_WITHDRAWAL;
    expect(fomoTransferSender(transaction, receiver, FOMO_TRANSFER_MINT, units, FEE_PAYER)).toBe(sender);
    /* another amount, another receiver, another fee payer, another token */
    expect(fomoTransferSender(transaction, receiver, FOMO_TRANSFER_MINT, units + 1n, FEE_PAYER)).toBeNull();
    expect(fomoTransferSender(transaction, sender, FOMO_TRANSFER_MINT, units, FEE_PAYER)).toBeNull();
    expect(fomoTransferSender(transaction, receiver, FOMO_TRANSFER_MINT, units, address())).toBeNull();
    expect(fomoTransferSender(transaction, receiver, address(), units, FEE_PAYER)).toBeNull();
    /* a failed transaction moved nothing */
    expect(fomoTransferSender({ ...transaction, meta: { ...transaction.meta, err: { InstructionError: [0, "x"] } } },
      receiver, FOMO_TRANSFER_MINT, units, FEE_PAYER)).toBeNull();
  });

  it("lands in the wallet's associated token account", async () => {
    expect(await tokenAccountAddress(FOMO_WITHDRAWAL.receiver, FOMO_TRANSFER_MINT)).toBe(FOMO_WITHDRAWAL.receiverTokenAccount);
    expect(await tokenAccountAddress(FOMO_WITHDRAWAL.sender, FOMO_TRANSFER_MINT)).toBe(FOMO_WITHDRAWAL.senderTokenAccount);
  });
});

describe("claiming a fomo handle", () => {
  it("needs a sign-in and a profile", async () => {
    useNetwork();
    expect((await call("PUT", "/v1/profile/fomo/handle", { handle: "chief" })).status).toBe(401);
    const auth = await signIn(await newWallet());
    const missing = await call("PUT", "/v1/profile/fomo/handle", { handle: "chief" }, auth);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("PROFILE_NOT_FOUND");
  });

  it("stores the claim unverified and private, refuses a handle fomo doesn't know, and keeps one it couldn't check", async () => {
    const network = useNetwork();
    const owner = await player();
    const handle = freshHandle("Chief");
    network.cards.set(handle.toLowerCase(), 200);

    const bad = await call("PUT", "/v1/profile/fomo/handle", { handle: "not a handle" }, owner.auth);
    expect(bad.status).toBe(400);

    const claimed = await call("PUT", "/v1/profile/fomo/handle", { handle: `@${handle}` }, owner.auth);
    expect(claimed.status).toBe(200);
    expect(claimed.body.profile.fomo).toEqual({
      handle, handleSeen: true, handleClaimedAt: expect.any(Number), handleVerified: false, handleVerifiedAt: null,
      wallet: null, verified: false, verifiedAt: null, method: null,
    });

    /* shown or not, an unverified claim is not public */
    await call("PATCH", "/v1/profile", { showFomo: true }, owner.auth);
    expect((await call("GET", `/v1/profiles/${owner.username}`)).body.profile).toEqual({ id: owner.id, username: owner.username });

    const unknown = await call("PUT", "/v1/profile/fomo/handle", { handle: freshHandle() }, owner.auth);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("FOMO_HANDLE_UNKNOWN");

    const unchecked = freshHandle();
    network.cards.set(unchecked.toLowerCase(), 500);
    const kept = await call("PUT", "/v1/profile/fomo/handle", { handle: unchecked }, owner.auth);
    expect(kept.status).toBe(200);
    expect(kept.body.profile.fomo).toMatchObject({ handle: unchecked, handleSeen: null, handleVerified: false });

    /* a second player may claim the same unverified handle: a claim alone
       can't lock out the real owner; the card is not asked again */
    const other = await player();
    const cards = network.calls.cards;
    const same = await call("PUT", "/v1/profile/fomo/handle", { handle: handle.toUpperCase() }, other.auth);
    expect(same.status).toBe(200);
    expect(same.body.profile.fomo).toMatchObject({ handle: handle.toUpperCase(), handleSeen: true });
    expect(network.calls.cards).toBe(cards);

    const dropped = await call("DELETE", "/v1/profile/fomo/handle", undefined, other.auth);
    expect(dropped.status).toBe(200);
    expect(dropped.body.profile.fomo).toBeNull();
  });

  it("allows a few claims an hour per wallet", async () => {
    const network = useNetwork();
    const owner = await player();
    const handle = freshHandle();
    network.cards.set(handle.toLowerCase(), 200);
    for (let attempt = 0; attempt < FOMO_HANDLE_CLAIMS_PER_HOUR; attempt += 1) {
      expect((await call("PUT", "/v1/profile/fomo/handle", { handle }, owner.auth)).status).toBe(200);
    }
    const limited = await call("PUT", "/v1/profile/fomo/handle", { handle }, owner.auth);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("FOMO_HANDLE_RATE_LIMITED");
  });
});

describe("verifying a fomo handle", () => {
  it("proves a fomo wallet by transfer, then an admin confirms the handle against it", async () => {
    const network = useNetwork();
    const owner = await player();
    const squatter = await player();
    const handle = freshHandle("Real");
    network.cards.set(handle.toLowerCase(), 200);
    expect((await call("PUT", "/v1/profile/fomo/handle", { handle }, owner.auth)).status).toBe(200);
    expect((await call("PUT", "/v1/profile/fomo/handle", { handle }, squatter.auth)).status).toBe(200);
    await call("PATCH", "/v1/profile", { showFomo: true }, owner.auth);

    /* no proven fomo wallet yet: not in the queue, and not confirmable */
    const queue = async () => (await call("GET", "/v1/admin/profiles/fomo-handles", undefined, ADMIN)).body.pending as Array<{ profileId: string }>;
    expect((await queue()).some((entry) => entry.profileId === owner.id)).toBe(false);
    const early = await call("POST", "/v1/admin/profiles/fomo-handle", { profileId: owner.id, handle, verified: true }, ADMIN);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe("FOMO_WALLET_UNPROVEN");

    /* the transfer request: a small USDC amount to the signed-in wallet */
    const asked = await call("POST", "/v1/profile/fomo/transfer", undefined, owner.auth);
    expect(asked.status).toBe(200);
    const request = asked.body.transfer;
    expect(request).toMatchObject({ to: owner.wallet.address, asset: "USDC", mint: FOMO_TRANSFER_MINT });
    expect(request.tokenAccount).toBe(await tokenAccountAddress(owner.wallet.address, FOMO_TRANSFER_MINT));
    expect(request.amount).toMatch(/^0\.\d\d$/u);
    const units = BigInt(request.units as string);
    expect(units).toBe(BigInt(Math.round(Number(request.amount) * 100)) * 10_000n);

    /* nothing sent yet; then the cooldown */
    const notYet = await call("POST", "/v1/profile/fomo/transfer/check", undefined, owner.auth);
    expect(notYet.status).toBe(404);
    expect(notYet.body.error.code).toBe("FOMO_TRANSFER_NOT_FOUND");
    expect((await call("POST", "/v1/profile/fomo/transfer/check", undefined, owner.auth)).status).toBe(429);
    await env.HALO_ABUSE.delete(`fomo-transfer-check:${owner.id}`);

    /* transfers that don't count: the wrong amount, a fee someone else
       paid; then the one that does */
    const fomoWallet = address();
    network.add(request.tokenAccount, [
      transfer({ feePayer: FEE_PAYER, from: fomoWallet, to: owner.wallet.address, units: units + 10_000n }),
      transfer({ feePayer: fomoWallet, from: fomoWallet, to: owner.wallet.address, units }),
    ]);
    const stillNot = await call("POST", "/v1/profile/fomo/transfer/check", undefined, owner.auth);
    expect(stillNot.status).toBe(404);
    await env.HALO_ABUSE.delete(`fomo-transfer-check:${owner.id}`);
    network.add(request.tokenAccount, [transfer({ feePayer: FEE_PAYER, from: fomoWallet, to: owner.wallet.address, units })]);
    const proven = await call("POST", "/v1/profile/fomo/transfer/check", undefined, owner.auth);
    expect(proven.status).toBe(200);
    expect(proven.body.signature).toEqual(expect.any(String));
    expect(proven.body.profile.fomo).toMatchObject({
      handle, handleVerified: false, wallet: fomoWallet, verified: true, method: "transfer",
    });
    /* the request is used up */
    await env.HALO_ABUSE.delete(`fomo-transfer-check:${owner.id}`);
    expect((await call("POST", "/v1/profile/fomo/transfer/check", undefined, owner.auth)).status).toBe(410);

    /* the wallet shows; the handle does not, until an admin confirms it */
    expect((await call("GET", `/v1/profiles/${owner.username}`)).body.profile.fomo).toEqual({ handle: null, wallet: fomoWallet });
    expect(await queue()).toContainEqual(expect.objectContaining({
      profileId: owner.id, handle, handleSeen: true, wallet: fomoWallet, method: "transfer",
    }));

    expect((await call("POST", "/v1/admin/profiles/fomo-handle", { profileId: owner.id, handle, verified: true })).status).toBe(401);
    const changed = await call("POST", "/v1/admin/profiles/fomo-handle", { profileId: owner.id, handle: "someone_else", verified: true }, ADMIN);
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("FOMO_HANDLE_CHANGED");
    const confirmed = await call("POST", "/v1/admin/profiles/fomo-handle", {
      profileId: owner.id, handle: handle.toLowerCase(), verified: true, note: "masked address matches",
    }, ADMIN);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.profile.fomo).toMatchObject({ handle, handleVerified: true, handleVerifiedAt: expect.any(Number) });
    expect((await call("GET", `/v1/profiles/${owner.username}`)).body.profile.fomo).toEqual({ handle, wallet: fomoWallet });
    expect((await queue()).some((entry) => entry.profileId === owner.id)).toBe(false);

    /* the squatter's claim is gone, and the handle can't be claimed again */
    expect((await call("GET", "/v1/profile", undefined, squatter.auth)).body.profile.fomo).toBeNull();
    const taken = await call("PUT", "/v1/profile/fomo/handle", { handle }, squatter.auth);
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe("FOMO_HANDLE_TAKEN");
    /* the owner re-typing it in another case keeps the confirmation */
    const recased = await call("PUT", "/v1/profile/fomo/handle", { handle: handle.toUpperCase() }, owner.auth);
    expect(recased.body.profile.fomo).toMatchObject({ handle: handle.toUpperCase(), handleVerified: true });

    /* proving another fomo wallet takes the confirmation away */
    await env.HALO_ABUSE.delete(`fomo-transfer-check:${owner.id}`);
    const again = (await call("POST", "/v1/profile/fomo/transfer", undefined, owner.auth)).body.transfer;
    const otherFomoWallet = address();
    network.add(again.tokenAccount, [transfer({ feePayer: FEE_PAYER, from: otherFomoWallet, to: owner.wallet.address, units: BigInt(again.units) })]);
    const moved = await call("POST", "/v1/profile/fomo/transfer/check", undefined, owner.auth);
    expect(moved.status).toBe(200);
    expect(moved.body.profile.fomo).toMatchObject({ wallet: otherFomoWallet, verified: true, handleVerified: false });
    expect((await call("GET", `/v1/profiles/${owner.username}`)).body.profile.fomo).toEqual({ handle: null, wallet: otherFomoWallet });

    /* confirmed again, then taken back by an admin */
    expect((await call("POST", "/v1/admin/profiles/fomo-handle", { profileId: owner.id, handle, verified: true }, ADMIN)).status).toBe(200);
    const rejected = await call("POST", "/v1/admin/profiles/fomo-handle", { profileId: owner.id, handle, verified: false, note: "no match" }, ADMIN);
    expect(rejected.status).toBe(200);
    expect(rejected.body.profile.fomo).toMatchObject({ handle: handle.toUpperCase(), handleVerified: false });

    const lookup = await call("GET", `/v1/admin/profiles?id=${owner.id}`, undefined, ADMIN);
    const kinds = (lookup.body.events as Array<{ kind: string }>).map((event) => event.kind);
    for (const kind of ["fomo_handle_claimed", "fomo_verified", "fomo_handle_verified", "fomo_handle_unverified", "fomo_handle_rejected"]) {
      expect(kinds).toContain(kind);
    }
    const squatterLookup = await call("GET", `/v1/admin/profiles?id=${squatter.id}`, undefined, ADMIN);
    expect((squatterLookup.body.events as Array<{ kind: string }>).map((event) => event.kind)).toContain("fomo_handle_displaced");
  });

  it("needs a profile and detection for the transfer proof, and reports a chain it can't read", async () => {
    const network = useNetwork();
    const auth = await signIn(await newWallet());
    expect((await call("POST", "/v1/profile/fomo/transfer", undefined, auth)).status).toBe(404);
    const owner = await player();
    expect((await call("POST", "/v1/profile/fomo/transfer/check", undefined, owner.auth)).status).toBe(410);
    expect((await call("POST", "/v1/profile/fomo/transfer", undefined, owner.auth)).status).toBe(200);
    network.chainDown = true;
    const down = await call("POST", "/v1/profile/fomo/transfer/check", undefined, owner.auth);
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe("FOMO_CHECK_UNAVAILABLE");
  });
});
