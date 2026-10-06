import type { RuntimeEnv } from "./env";
import { HttpError } from "./errors";
import { MATCHMAKER_NAME } from "./matchmaker";
import { LOBBY_MAP_COUNT, LOBBY_MODE_COUNT, SIGNALING_PROTOCOL_VERSION } from "./protocol";

/* The post-match vote (src/matchmaker.ts, vote): after a server match, the
   lobby shows a few maps for the next one and everyone who played picks.

     POST /v1/queue/:ticket/vote   { mapIndex, modeIndex }

   The vote is kept on the ticket, so the ended match's tally shows in every
   player's poll of their ticket, and a player who queues again carries
   their pick on the new ticket (POST /v1/queue, `vote`; a party's start,
   `vote`): the matchmaker plays the plurality's choice when it forms the
   match. A pick outside the playlist's rotation is refused here and
   ignored on a queue. */

export interface GameVote {
  mapIndex: number;
  modeIndex: number;
}

/* a well-formed pick, or null (not given, or malformed) */
export function parseVote(value: unknown): GameVote | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const vote = value as Record<string, unknown>;
  if (!Number.isInteger(vote.mapIndex) || (vote.mapIndex as number) < 0 || (vote.mapIndex as number) >= LOBBY_MAP_COUNT ||
      !Number.isInteger(vote.modeIndex) || (vote.modeIndex as number) < 0 || (vote.modeIndex as number) >= LOBBY_MODE_COUNT) {
    return null;
  }
  return { mapIndex: vote.mapIndex as number, modeIndex: vote.modeIndex as number };
}

const VOTE_ROUTE = /^\/v1\/queue\/([A-Za-z0-9_-]{16,64})\/vote$/u;

export async function handleVoteRequest(
  request: Request,
  env: RuntimeEnv,
  url: URL,
  readBody: () => Promise<unknown>,
): Promise<Record<string, unknown> | null> {
  const route = VOTE_ROUTE.exec(url.pathname);
  if (!route || request.method !== "POST") return null;
  const vote = parseVote(await readBody());
  if (!vote) throw new HttpError(400, "VALIDATION_FAILED", "mapIndex and modeIndex are required.");
  const result = await env.MATCHMAKER.getByName(MATCHMAKER_NAME).vote(route[1]!, vote, Date.now());
  if (result === "unknown") throw new HttpError(404, "TICKET_NOT_FOUND", "That queue ticket is unknown or has expired.");
  if (result === "not_offered") throw new HttpError(409, "VOTE_NOT_OFFERED", "That map isn't up for a vote.");
  return { ticket: result, v: SIGNALING_PROTOCOL_VERSION };
}
