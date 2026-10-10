import type { RuntimeEnv } from "./env";
import { HttpError } from "./errors";
import { PROFILES_NAME } from "./profiles";
import { requireWallet } from "./wallet";

/* Linking an X account with a tweet: no X developer app, no API key.

     POST   /v1/profile/x/challenge   a one-time code, the text to post and
                                      an x.com intent link that fills it in
     POST   /v1/profile/x/verify      { url } of the post: the Worker reads
                                      it through X's public embed endpoint
                                      (oEmbed), checks who wrote it and that
                                      the code is in it, and links the handle
     DELETE /v1/profile/x             unlink

   The post only has to exist while the Worker reads it; the player is told
   they can delete it afterwards. The code is stored with the profile
   (src/profiles.ts), lasts X_CHALLENGE_TTL_MS and is used up by the proof.
   A handle belongs to one profile; a fresh proof from the same X account
   moves it. Other players see it only when the owner shows it (showX). */

export const X_OEMBED_ENDPOINT = "https://publish.x.com/oembed";
/* letters and digits that can't be misread, as the player may type the
   code by hand */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const X_CODE_LENGTH = 8;
const OEMBED_TIMEOUT_MS = 8_000;
/* X's own rule for a username */
const X_HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/u;
const TWEET_HOSTS = new Set([
  "x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com",
]);
/* paths under x.com that are not usernames */
const RESERVED_PATHS = new Set(["i", "intent", "home", "search", "settings", "explore"]);

export function xCode(): string {
  const bytes = new Uint8Array(X_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  /* 256 is a multiple of the alphabet's 32 letters, so no letter is
     favoured */
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

export function xChallengeText(code: string): string {
  return `Linking my Halo Spartan: ${code}`;
}

export function xIntentUrl(text: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}

export interface TweetRef {
  user: string;
  id: string;
  /* the post's canonical address */
  url: string;
}

/* A post's link as the player pastes it: x.com or twitter.com, with or
   without www or mobile, /<user>/status/<id>, and whatever X adds after it
   (/photo/1, ?s=20). */
export function parseTweetUrl(input: unknown): TweetRef | null {
  if (typeof input !== "string") return null;
  let text = input.trim();
  if (text.length === 0 || text.length > 512) return null;
  if (!/^https?:\/\//iu.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!TWEET_HOSTS.has(url.hostname.toLowerCase())) return null;
  const match = /^\/([^/]+)\/status(?:es)?\/(\d{1,25})(?:\/.*)?$/u.exec(url.pathname);
  if (match === null) return null;
  const user = match[1]!;
  const id = match[2]!;
  if (!X_HANDLE_PATTERN.test(user) || RESERVED_PATHS.has(user.toLowerCase())) return null;
  return { user, id, url: `https://x.com/${user}/status/${id}` };
}

/* The handle in an oEmbed `author_url` (https://twitter.com/<handle> or
   https://x.com/<handle>). */
export function handleFromAuthorUrl(authorUrl: unknown): string | null {
  if (typeof authorUrl !== "string") return null;
  let url: URL;
  try {
    url = new URL(authorUrl);
  } catch {
    return null;
  }
  if (!TWEET_HOSTS.has(url.hostname.toLowerCase())) return null;
  const match = /^\/([^/]+)\/?$/u.exec(url.pathname);
  if (match === null || !X_HANDLE_PATTERN.test(match[1]!)) return null;
  return match[1]!;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/gu, "\"")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&nbsp;/gu, " ")
    .replace(/&amp;/gu, "&");
}

/* What the post says: the embed's first paragraph, without its markup.
   The rest of the embed is the author's name and the date, which the code
   must not be found in. */
export function tweetText(html: string): string {
  const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/iu.exec(html);
  if (paragraph === null) return "";
  return decodeEntities(paragraph[1]!.replace(/<br\s*\/?>/giu, "\n").replace(/<[^>]*>/gu, ""));
}

export type TweetFetch =
  | { found: true; handle: string; text: string }
  | { found: false; reason: "missing" | "unavailable" };

/* Read a post through X's embed endpoint. A post that is gone, never was,
   or is behind a protected account is "missing"; anything else that goes
   wrong is "unavailable". */
export async function fetchTweet(url: string): Promise<TweetFetch> {
  let response: Response;
  try {
    response = await fetch(`${X_OEMBED_ENDPOINT}?url=${encodeURIComponent(url)}&omit_script=1&dnt=true`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(OEMBED_TIMEOUT_MS),
    });
  } catch {
    return { found: false, reason: "unavailable" };
  }
  if (response.status === 404 || response.status === 403) return { found: false, reason: "missing" };
  if (!response.ok) return { found: false, reason: "unavailable" };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { found: false, reason: "unavailable" };
  }
  if (typeof body !== "object" || body === null) return { found: false, reason: "unavailable" };
  const { author_url: authorUrl, html } = body as Record<string, unknown>;
  const handle = handleFromAuthorUrl(authorUrl);
  if (handle === null || typeof html !== "string") return { found: false, reason: "unavailable" };
  return { found: true, handle, text: tweetText(html) };
}

function profiles(env: RuntimeEnv) {
  return env.PROFILES.getByName(PROFILES_NAME);
}

function noProfile(): never {
  throw new HttpError(404, "PROFILE_NOT_FOUND", "Claim a username first.");
}

function expired(): never {
  throw new HttpError(410, "X_CHALLENGE_EXPIRED", "That code has expired or was used. Get a new one.");
}

/* /v1/profile/x*, from src/profile.ts. */
export async function handleXRequest(
  request: Request,
  env: RuntimeEnv,
  path: string,
  now: number,
  readBody: () => Promise<unknown>,
): Promise<Record<string, unknown> | null> {
  if (request.method === "POST" && path === "/v1/profile/x/challenge") {
    const wallet = await requireWallet(request, env);
    const result = await profiles(env).startXChallenge(wallet, xCode(), now);
    if ("error" in result) {
      if (result.error === "PROFILE_NOT_FOUND") noProfile();
      throw new HttpError(429, "X_CHALLENGE_RATE_LIMITED", "Too many codes this hour. Try again later.");
    }
    const text = xChallengeText(result.code);
    return { code: result.code, text, intentUrl: xIntentUrl(text), expiresAt: result.expiresAt };
  }

  if (request.method === "POST" && path === "/v1/profile/x/verify") {
    const wallet = await requireWallet(request, env);
    const body = await readBody();
    const tweet = parseTweetUrl(typeof body === "object" && body !== null ? (body as Record<string, unknown>).url : undefined);
    if (tweet === null) {
      throw new HttpError(400, "X_URL_INVALID", "Paste the link to your post, like https://x.com/you/status/123.");
    }
    const store = profiles(env);
    const attempt = await store.beginXVerify(wallet, tweet.url, now);
    if ("error" in attempt) {
      switch (attempt.error) {
        case "PROFILE_NOT_FOUND": noProfile();
        case "X_CHALLENGE_EXPIRED": expired();
        case "X_VERIFY_RATE_LIMITED":
          throw new HttpError(429, "X_VERIFY_RATE_LIMITED", "Too many tries. Wait a few minutes.");
        case "X_VERIFY_BUSY":
          throw new HttpError(503, "X_VERIFY_BUSY", "Lots of players are linking X right now. Try again in a minute.");
      }
    }
    const fail = async (status: number, code: string, message: string): Promise<never> => {
      await store.recordXFailure(wallet, attempt.profileId, code, now);
      throw new HttpError(status, code, message);
    };
    const fetched = await fetchTweet(tweet.url);
    if (!fetched.found) {
      if (fetched.reason === "missing") {
        return fail(404, "X_TWEET_NOT_FOUND", "We couldn't see that post. Check the link and that your account is public.");
      }
      console.warn(JSON.stringify({ message: "x oembed unavailable", wallet, url: tweet.url }));
      return fail(503, "X_UNAVAILABLE", "Couldn't reach X. Try again in a minute.");
    }
    if (fetched.handle.toLowerCase() !== tweet.user.toLowerCase()) {
      return fail(422, "X_HANDLE_MISMATCH", "That post was written by a different account than its link says.");
    }
    if (!fetched.text.toUpperCase().includes(attempt.code)) {
      return fail(422, "X_CODE_MISSING", `That post doesn't contain your code ${attempt.code}.`);
    }
    const proofUrl = `https://x.com/${fetched.handle}/status/${tweet.id}`;
    const linked = await store.linkX(wallet, { profileId: attempt.profileId, code: attempt.code, handle: fetched.handle, proofUrl }, now);
    if ("error" in linked) {
      if (linked.error === "PROFILE_NOT_FOUND") noProfile();
      expired();
    }
    return {
      profile: linked.profile,
      handle: fetched.handle,
      moved: linked.movedFrom !== null,
      message: `Linked @${fetched.handle}. You can delete the post now.`,
    };
  }

  if (request.method === "DELETE" && path === "/v1/profile/x") {
    const wallet = await requireWallet(request, env);
    const result = await profiles(env).unlinkX(wallet, now);
    if ("error" in result) noProfile();
    return { profile: result.profile };
  }

  return null;
}
