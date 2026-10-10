import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PROFILES_NAME,
  X_CHALLENGES_PER_HOUR,
  X_CHALLENGE_TTL_MS,
  X_VERIFY_ATTEMPTS,
} from "../src/profiles";
import { base58Encode } from "../src/solana";
import {
  X_CODE_LENGTH,
  X_OEMBED_ENDPOINT,
  handleFromAuthorUrl,
  parseTweetUrl,
  tweetText,
  xChallengeText,
  xCode,
  xIntentUrl,
} from "../src/x";

/* Linking X with a tweet. X is never reached: fetch is stubbed with a fake
   oEmbed endpoint serving recorded-shape responses, and the fomo chain
   check that runs after each sign-in gets an empty history. */

const API_ORIGIN = "http://signaling.test";
const GAME_ORIGIN = "http://127.0.0.1:8765";
const RPC_URL = "http://fomo-rpc.test/rpc";
let nextAddress = 0;
let nextName = 0;
let nextTweet = 1_840_000_000_000_000_000n;

function freshName(): string {
  nextName += 1;
  return `xlink${nextName}`.slice(0, 11);
}

function tweetId(): string {
  nextTweet += 1n;
  return String(nextTweet);
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

/* An oEmbed answer in the shape publish.x.com gave on 2026-10-10. */
function oembed(handle: string, id: string, text: string, name = "Some Spartan") {
  return {
    url: `https://x.com/${handle}/status/${id}`,
    author_name: name,
    author_url: `https://x.com/${handle}`,
    html: `<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">${text}</p>&mdash; ${name} (@${handle}) ` +
      `<a href="https://x.com/${handle}/status/${id}?ref_src=twsrc%5Etfw">October 10, 2026</a></blockquote>\n\n`,
    width: 550,
    height: null,
    type: "rich",
    cache_age: "3153600000",
    provider_name: "X",
    provider_url: "https://x.com",
    version: "1.0",
  };
}

/* The fake X: posts by id. */
class FakeX {
  readonly posts = new Map<string, Record<string, unknown>>();
  readonly requests: string[] = [];
  status: number | null = null;

  post(handle: string, text: string, name?: string): string {
    const id = tweetId();
    this.posts.set(id, oembed(handle, id, text, name));
    return id;
  }

  async fetch(input: RequestInfo | URL): Promise<Response> {
    const url = String(input instanceof Request ? input.url : input);
    if (url === RPC_URL) return Response.json({ jsonrpc: "2.0", id: 1, result: [] });
    if (!url.startsWith(`${X_OEMBED_ENDPOINT}?`)) throw new Error(`unexpected fetch of ${url}`);
    this.requests.push(url);
    if (this.status !== null) return new Response("x is down", { status: this.status });
    const target = new URL(url).searchParams.get("url") ?? "";
    const id = /\/status\/(\d+)$/u.exec(target)?.[1] ?? "";
    const body = this.posts.get(id);
    if (body === undefined) return new Response("", { status: 404 });
    return Response.json(body);
  }
}

let x: FakeX;

beforeEach(() => {
  x = new FakeX();
  vi.stubGlobal("fetch", x.fetch.bind(x));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

/* a signed-in wallet with a profile */
async function player() {
  const wallet = await newWallet();
  const auth = await signIn(wallet);
  const claimed = await call("POST", "/v1/profile/username", { username: freshName() }, auth);
  expect(claimed.status).toBe(200);
  return { wallet, auth, profile: claimed.body.profile as Record<string, any> };
}

async function challenge(auth: Record<string, string>) {
  const result = await call("POST", "/v1/profile/x/challenge", undefined, auth);
  expect(result.status).toBe(200);
  return result.body as { code: string; text: string; intentUrl: string; expiresAt: number };
}

/* an error answer, as src/index.ts writes them */
function failed(status: number, code: string) {
  return { status, body: expect.objectContaining({ error: expect.objectContaining({ code }) }) };
}

function store() {
  return env.PROFILES.getByName(PROFILES_NAME);
}

describe("the pieces", () => {
  it("makes codes of unambiguous letters and digits", () => {
    const codes = Array.from({ length: 50 }, xCode);
    for (const code of codes) expect(code).toMatch(new RegExp(`^[2-9A-HJ-NP-Z]{${X_CODE_LENGTH}}$`, "u"));
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("builds the post text and the intent link that fills it in", () => {
    expect(xChallengeText("ABCD2345")).toBe("Linking my Halo Spartan: ABCD2345");
    expect(xIntentUrl("Linking my Halo Spartan: ABCD2345"))
      .toBe("https://x.com/intent/post?text=Linking%20my%20Halo%20Spartan%3A%20ABCD2345");
  });

  it("reads the post links players paste", () => {
    const canonical = { user: "jack", id: "20", url: "https://x.com/jack/status/20" };
    for (const pasted of [
      "https://x.com/jack/status/20",
      " https://twitter.com/jack/status/20?s=20&t=abc ",
      "https://mobile.twitter.com/jack/status/20",
      "https://www.x.com/jack/status/20/photo/1",
      "x.com/jack/status/20",
      "http://x.com/jack/statuses/20",
    ]) {
      expect(parseTweetUrl(pasted)).toEqual(canonical);
    }
    for (const bad of [
      undefined, 20, "", "https://x.com/jack", "https://example.com/jack/status/20", "https://x.com/i/status/20",
      "https://x.com/i/web/status/20", "https://x.com/way_too_long_handle/status/20", "https://x.com/jack/status/abc",
      "https://x.com.evil.test/jack/status/20", "javascript:alert(1)", `https://x.com/jack/status/${"1".repeat(600)}`,
    ]) {
      expect(parseTweetUrl(bad)).toBeNull();
    }
  });

  it("takes the author from author_url", () => {
    expect(handleFromAuthorUrl("https://twitter.com/Jack")).toBe("Jack");
    expect(handleFromAuthorUrl("https://x.com/jack/")).toBe("jack");
    for (const bad of [null, "", "https://example.com/jack", "https://x.com/jack/status/1", "https://x.com/"]) {
      expect(handleFromAuthorUrl(bad)).toBeNull();
    }
  });

  it("reads the post's own words, not the author's name or the date", () => {
    const html = oembed("jack", "1", "Linking my Halo Spartan: ABCD2345<br>gg &amp; <a href=\"https://t.co/x\">pic.x.com/x</a>", "CODE WXYZ7890").html;
    expect(tweetText(html)).toBe("Linking my Halo Spartan: ABCD2345\ngg & pic.x.com/x");
    expect(tweetText(html)).not.toContain("WXYZ7890");
    expect(tweetText("<blockquote>no paragraph</blockquote>")).toBe("");
  });
});

describe("linking X", () => {
  it("links the handle from a post with the code, once, and says the post can go", async () => {
    const { auth, wallet, profile } = await player();
    const issued = await challenge(auth);
    expect(issued.text).toBe(`Linking my Halo Spartan: ${issued.code}`);
    expect(issued.intentUrl).toBe(xIntentUrl(issued.text));
    expect(issued.expiresAt - Date.now()).toBeGreaterThan(X_CHALLENGE_TTL_MS - 60_000);

    const id = x.post("SpartanJack", `${issued.text} #halo`);
    const verified = await call("POST", "/v1/profile/x/verify", { url: `https://twitter.com/spartanjack/status/${id}?s=20` }, auth);
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({
      handle: "SpartanJack",
      message: "Linked @SpartanJack. You can delete the post now.",
    });
    expect(verified.body.profile.x).toEqual({
      handle: "SpartanJack", verified: true, verifiedAt: expect.any(Number), proofUrl: `https://x.com/SpartanJack/status/${id}`,
    });
    expect(x.requests).toEqual([
      `${X_OEMBED_ENDPOINT}?url=${encodeURIComponent(`https://x.com/spartanjack/status/${id}`)}&omit_script=1&dnt=true`,
    ]);

    /* the code is used up */
    const again = await call("POST", "/v1/profile/x/verify", { url: `https://x.com/SpartanJack/status/${id}` }, auth);
    expect(again).toEqual(failed(410, "X_CHALLENGE_EXPIRED"));
    expect(x.requests).toHaveLength(1);

    /* private until the owner shows it */
    const name = profile.username as string;
    expect((await call("GET", `/v1/profiles/${name}`)).body.profile.x).toBeUndefined();
    await call("PATCH", "/v1/profile", { showX: true }, auth);
    expect((await call("GET", `/v1/profiles/${name}`)).body.profile.x).toEqual({ handle: "SpartanJack" });
    expect((await call("GET", `/v1/profiles?wallets=${wallet.address}`)).body.profiles[wallet.address].x)
      .toEqual({ handle: "SpartanJack" });

    /* the audit trail */
    const events = (await store().adminLookup({ wallet: wallet.address }, Date.now())).events.map((event) => event.kind);
    expect(events.slice(0, 4)).toEqual(["visibility_set", "x_verified", "x_attempt", "x_challenge"]);
  });

  it("refuses a post without the code, by someone else, or that X can't show", async () => {
    const { auth, wallet } = await player();
    const issued = await challenge(auth);

    const noCode = x.post("jack", "just setting up my halo");
    const missing = await call("POST", "/v1/profile/x/verify", { url: `https://x.com/jack/status/${noCode}` }, auth);
    expect(missing).toEqual(failed(422, "X_CODE_MISSING"));

    /* the code in the display name is not the post saying it */
    const inName = x.post("jack", "hello", `jack ${issued.code}`);
    expect((await call("POST", "/v1/profile/x/verify", { url: `https://x.com/jack/status/${inName}` }, auth)).body.error.code)
      .toBe("X_CODE_MISSING");

    /* a link naming another account than the one that posted */
    const other = x.post("jill", issued.text);
    expect((await call("POST", "/v1/profile/x/verify", { url: `https://x.com/jack/status/${other}` }, auth)))
      .toEqual(failed(422, "X_HANDLE_MISMATCH"));

    expect((await call("POST", "/v1/profile/x/verify", { url: "https://x.com/jack/status/1" }, auth)))
      .toEqual(failed(404, "X_TWEET_NOT_FOUND"));

    /* a failed check doesn't use the code up: the right post still works */
    expect((await call("GET", "/v1/profile", undefined, auth)).body.profile.x).toBeNull();
    const good = x.post("jack", issued.text.toLowerCase());
    const linked = await call("POST", "/v1/profile/x/verify", { url: `https://x.com/jack/status/${good}` }, auth);
    expect(linked.status).toBe(200);
    expect(linked.body.profile.x.handle).toBe("jack");

    const kinds = (await store().adminLookup({ wallet: wallet.address }, Date.now())).events.map((event) => event.kind);
    expect(kinds.filter((kind) => kind === "x_failed")).toHaveLength(4);
  });

  it("says when X can't be reached", async () => {
    const { auth } = await player();
    const issued = await challenge(auth);
    const id = x.post("jack", issued.text);
    x.status = 500;
    expect((await call("POST", "/v1/profile/x/verify", { url: `https://x.com/jack/status/${id}` }, auth)))
      .toEqual(failed(503, "X_UNAVAILABLE"));
  });

  it("checks the input and the caller before reaching X", async () => {
    const wallet = await newWallet();
    const auth = await signIn(wallet);
    expect((await call("POST", "/v1/profile/x/challenge")).status).toBe(401);
    expect((await call("POST", "/v1/profile/x/challenge", undefined, auth)).body.error.code).toBe("PROFILE_NOT_FOUND");
    expect((await call("POST", "/v1/profile/x/verify", { url: "nope" }, auth)).body.error.code).toBe("X_URL_INVALID");
    expect((await call("POST", "/v1/profile/x/verify", { url: "https://x.com/jack/status/1" }, auth)).body.error.code)
      .toBe("PROFILE_NOT_FOUND");

    const { auth: withProfile } = await player();
    /* no code asked for yet */
    expect((await call("POST", "/v1/profile/x/verify", { url: "https://x.com/jack/status/1" }, withProfile)).body.error.code)
      .toBe("X_CHALLENGE_EXPIRED");
    expect(x.requests).toEqual([]);
  });

  it("lets a code lapse, and a newer code replace an older one", async () => {
    const { auth, wallet } = await player();
    const first = await challenge(auth);
    const second = await challenge(auth);
    expect(second.code).not.toBe(first.code);
    const old = x.post("jack", first.text);
    expect((await call("POST", "/v1/profile/x/verify", { url: `https://x.com/jack/status/${old}` }, auth)).body.error.code)
      .toBe("X_CODE_MISSING");

    /* a code asked for 15 minutes ago has expired */
    await store().startXChallenge(wallet.address, "LAPSED22", Date.now() - X_CHALLENGE_TTL_MS);
    const late = x.post("jack", xChallengeText("LAPSED22"));
    expect((await call("POST", "/v1/profile/x/verify", { url: `https://x.com/jack/status/${late}` }, auth)))
      .toEqual(failed(410, "X_CHALLENGE_EXPIRED"));
  });

  it("limits codes and checks per profile", async () => {
    const { auth } = await player();
    let issued = await challenge(auth);
    for (let index = 1; index < X_CHALLENGES_PER_HOUR; index += 1) issued = await challenge(auth);
    expect((await call("POST", "/v1/profile/x/challenge", undefined, auth)))
      .toEqual(failed(429, "X_CHALLENGE_RATE_LIMITED"));

    for (let index = 0; index < X_VERIFY_ATTEMPTS; index += 1) {
      expect((await call("POST", "/v1/profile/x/verify", { url: "https://x.com/jack/status/1" }, auth)).body.error.code)
        .toBe("X_TWEET_NOT_FOUND");
    }
    const good = x.post("jack", issued.text);
    expect((await call("POST", "/v1/profile/x/verify", { url: `https://x.com/jack/status/${good}` }, auth)))
      .toEqual(failed(429, "X_VERIFY_RATE_LIMITED"));
    expect(x.requests).toHaveLength(X_VERIFY_ATTEMPTS);
  });

  it("keeps one handle on one profile: another profile's proof is refused until it's unlinked", async () => {
    const first = await player();
    const second = await player();
    const one = await challenge(first.auth);
    const firstPost = x.post("Shared", one.text);
    expect((await call("POST", "/v1/profile/x/verify", { url: `https://x.com/Shared/status/${firstPost}` }, first.auth)).status)
      .toBe(200);

    const two = await challenge(second.auth);
    const secondPost = x.post("shared", two.text);
    const secondUrl = `https://x.com/shared/status/${secondPost}`;
    expect((await call("POST", "/v1/profile/x/verify", { url: secondUrl }, second.auth)))
      .toEqual(failed(409, "X_HANDLE_TAKEN"));
    expect((await call("GET", "/v1/profile", undefined, first.auth)).body.profile.x.handle).toBe("Shared");
    expect((await call("GET", "/v1/profile", undefined, second.auth)).body.profile.x).toBeNull();
    const events = (await store().adminLookup({ id: second.profile.id }, Date.now())).events;
    expect(events[0]).toMatchObject({ kind: "x_failed", profileId: second.profile.id });
    expect(JSON.parse(events[0]!.detail!)).toMatchObject({ reason: "X_HANDLE_TAKEN", holder: first.profile.id });

    /* the owner unlinks, which frees it; the refused code still works */
    expect((await call("DELETE", "/v1/profile/x", undefined, first.auth)).status).toBe(200);
    const freed = await call("POST", "/v1/profile/x/verify", { url: secondUrl }, second.auth);
    expect(freed.status).toBe(200);
    expect(freed.body.profile.x.handle).toBe("shared");

    /* relinking another handle replaces the profile's own */
    const three = await challenge(second.auth);
    const other = x.post("other_one", three.text);
    const replaced = await call("POST", "/v1/profile/x/verify", { url: `https://x.com/other_one/status/${other}` }, second.auth);
    expect(replaced.body.profile.x.handle).toBe("other_one");

    /* and the handle it gave up is free again */
    const four = await challenge(first.auth);
    const back = x.post("Shared", four.text);
    expect((await call("POST", "/v1/profile/x/verify", { url: `https://x.com/Shared/status/${back}` }, first.auth)).status)
      .toBe(200);
  });

  it("unlinks", async () => {
    const { auth, wallet } = await player();
    const issued = await challenge(auth);
    const id = x.post("leaving", issued.text);
    await call("POST", "/v1/profile/x/verify", { url: `https://x.com/leaving/status/${id}` }, auth);
    await call("PATCH", "/v1/profile", { showX: true }, auth);
    const unlinked = await call("DELETE", "/v1/profile/x", undefined, auth);
    expect(unlinked.status).toBe(200);
    expect(unlinked.body.profile.x).toBeNull();
    expect((await call("GET", `/v1/profiles?wallets=${wallet.address}`)).body.profiles[wallet.address].x).toBeUndefined();
    /* idempotent */
    expect((await call("DELETE", "/v1/profile/x", undefined, auth)).status).toBe(200);
  });
});
