import { normaliseChatText } from "./chat";
import type { RuntimeEnv } from "./env";
import { HttpError } from "./errors";
import {
  type CustomStakes,
  MATCHMAKER_NAME,
  STAKE_TIERS,
  chosenStake,
  customStakesProblem,
  isPlaylist,
  partyProblem,
  playlistWager,
} from "./matchmaker";
import { type PartyJoin, type PartyResult, type PartySettings, type PartyView } from "./party";
import {
  IDENTIFIER_PATTERN,
  LOBBY_MAP_COUNT,
  LOBBY_MODE_COUNT,
  PLAYER_KEY_PATTERN,
  isBuildId,
  parsePlayerProfile,
} from "./protocol";
import { parseVote } from "./vote";
import { stakeProblem } from "./wager";
import { walletForToken } from "./wallet";

/* The party routes (src/party.ts):

     POST /v1/parties                  create a party; you lead it
     POST /v1/parties/:code/join       join by its code
     POST /v1/parties/:code/poll       stay in it; its roster and activity
     POST /v1/parties/:code/leave
     POST /v1/parties/:code/settings   (the leader) lobby, playlist, map, game type, stake,
                                       customStakes { stake, killTarget, teamShareBps } or null
     POST /v1/parties/:code/accept     { terms }: accept the stakes shown (their number)
     POST /v1/parties/:code/start      (the leader) search together, or start the custom game;
                                       for SOL, once every member accepted the stakes
     POST /v1/parties/:code/stop       (the leader) stop searching
     POST /v1/parties/:code/chat       { text }: say it to the party

   Every body carries the member: playerKey, identifier, profile and, to
   play for SOL, walletToken. join, poll and chat take chatSince, the number
   of the last chat line the member saw; the answer carries the lines
   after it. */

/* codes people read aloud and type: no 0/O, 1/I/L */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const CODE_PATTERN = /^[A-HJ-KM-NP-Z2-9]{6}$/u;
const PARTY_ROUTE = /^\/v1\/parties\/([A-Za-z0-9]{6})\/(join|poll|leave|settings|accept|start|stop|chat)$/u;

function newCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

function body(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "VALIDATION_FAILED", "Body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

async function member(env: RuntimeEnv, input: Record<string, unknown>): Promise<PartyJoin> {
  if (typeof input.playerKey !== "string" || !PLAYER_KEY_PATTERN.test(input.playerKey) ||
      typeof input.identifier !== "string" || !IDENTIFIER_PATTERN.test(input.identifier)) {
    throw new HttpError(400, "VALIDATION_FAILED", "playerKey and identifier are required.");
  }
  const profile = parsePlayerProfile(input.profile);
  if (!profile.ok) throw new HttpError(400, "VALIDATION_FAILED", profile.message);
  return {
    key: input.playerKey,
    identifier: input.identifier,
    wallet: await walletForToken(env, input.walletToken),
    profile: { name: profile.value.name, style: profile.value.style, emblem: profile.value.emblem ?? null },
  };
}

function settings(input: Record<string, unknown>): PartySettings {
  const out: PartySettings = {};
  if (input.lobby !== undefined) {
    if (input.lobby !== "matchmaking" && input.lobby !== "custom") {
      throw new HttpError(400, "VALIDATION_FAILED", "lobby must be matchmaking or custom.");
    }
    out.lobby = input.lobby;
  }
  if (input.playlist !== undefined) {
    if (!isPlaylist(input.playlist)) throw new HttpError(400, "VALIDATION_FAILED", "playlist is unknown.");
    out.playlist = input.playlist;
  }
  if (input.mapIndex !== undefined) {
    if (!Number.isInteger(input.mapIndex) || (input.mapIndex as number) < 0 || (input.mapIndex as number) >= LOBBY_MAP_COUNT) {
      throw new HttpError(400, "VALIDATION_FAILED", "mapIndex is out of range.");
    }
    out.mapIndex = input.mapIndex as number;
  }
  if (input.modeIndex !== undefined) {
    if (!Number.isInteger(input.modeIndex) || (input.modeIndex as number) < 0 || (input.modeIndex as number) >= LOBBY_MODE_COUNT) {
      throw new HttpError(400, "VALIDATION_FAILED", "modeIndex is out of range.");
    }
    out.modeIndex = input.modeIndex as number;
  }
  if (input.stake !== undefined) {
    if (input.stake !== null && !(STAKE_TIERS as readonly unknown[]).includes(input.stake)) {
      throw new HttpError(400, "VALIDATION_FAILED", "stake is not one of the stake tiers.");
    }
    out.stake = input.stake as number | null;
  }
  if (input.customStakes !== undefined) {
    if (input.customStakes === null) {
      out.customStakes = null;
    } else {
      const raw = body(input.customStakes);
      const terms: CustomStakes = {
        stake: raw.stake as number, killTarget: raw.killTarget as number, teamShareBps: raw.teamShareBps as number,
      };
      const problem = customStakesProblem(terms);
      if (problem) throw new HttpError(400, "VALIDATION_FAILED", problem);
      out.customStakes = terms;
    }
  }
  return out;
}

/* Every member can stake: they accepted the party's terms, and their wallet
   holds the stake in a vault with a session that can spend it. */
async function requireStakes(
  env: RuntimeEnv, members: Array<{ name: string; wallet: string | null; accepted: boolean }>, stake: number,
): Promise<void> {
  const waiting = members.filter((entry) => !entry.accepted).map((entry) => entry.name);
  if (waiting.length > 0) {
    throw new HttpError(409, "STAKES_NOT_ACCEPTED", `Waiting for ${waiting.join(", ")} to accept the stakes.`);
  }
  for (const entry of members) {
    if (!entry.wallet) throw new HttpError(409, "STAKE_NOT_READY", `${entry.name} needs to connect a wallet to play for SOL.`);
    const problem = await stakeProblem(env, entry.wallet, stake);
    if (problem) throw new HttpError(409, "STAKE_NOT_READY", `${entry.name}: ${problem}`);
  }
}

function answer(result: PartyResult): { party: PartyView } {
  if ("party" in result) return result;
  switch (result.error) {
    case "NOT_FOUND": throw new HttpError(404, "PARTY_NOT_FOUND", "That party code doesn't exist anymore.");
    case "FULL": throw new HttpError(409, "PARTY_FULL", "That party is full.");
    case "NOT_MEMBER": throw new HttpError(403, "PARTY_NOT_MEMBER", "You're not in that party anymore.");
    case "CHAT_RATE_LIMITED": throw new HttpError(429, "CHAT_RATE_LIMITED", "You're sending messages too quickly.");
    case "TERMS_CHANGED": throw new HttpError(409, "TERMS_CHANGED", "The leader changed the stakes. Check them and accept again.");
    default: throw new HttpError(403, "PARTY_NOT_LEADER", "Only the party leader can do that.");
  }
}

/* the number of the last chat line the member saw (0: all of them) */
function chatSince(input: Record<string, unknown>): number {
  return typeof input.chatSince === "number" && Number.isInteger(input.chatSince) && input.chatSince >= 0 ? input.chatSince : 0;
}

export async function handlePartyRequest(
  request: Request,
  env: RuntimeEnv,
  url: URL,
  readBody: () => Promise<unknown>,
): Promise<Record<string, unknown> | null> {
  if (!url.pathname.startsWith("/v1/parties") || request.method !== "POST") return null;
  const now = Date.now();
  const input = body(await readBody());

  if (url.pathname === "/v1/parties") {
    if (!isBuildId(input.buildId)) throw new HttpError(400, "VALIDATION_FAILED", "buildId is required.");
    const join = await member(env, input);
    const chosen = {
      lobby: "matchmaking" as const, playlist: "ffa", mapIndex: 0, modeIndex: 1, stake: null, customStakes: null,
      ...settings(input),
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = newCode();
      const party = await env.PARTIES.getByName(code).create(code, input.buildId, join, chosen, now);
      if (party) return { party };
    }
    throw new HttpError(503, "PARTY_CODE_BUSY", "Couldn't find a free party code. Try again.");
  }

  const route = PARTY_ROUTE.exec(url.pathname);
  if (!route) throw new HttpError(404, "NOT_FOUND", "Route not found.");
  const code = route[1]!.toUpperCase();
  if (!CODE_PATTERN.test(code)) throw new HttpError(404, "PARTY_NOT_FOUND", "That isn't a party code.");
  const party = env.PARTIES.getByName(code);
  const action = route[2]!;

  if (action === "leave") {
    if (typeof input.playerKey === "string") await party.leave(input.playerKey, now);
    return { left: true };
  }
  const join = await member(env, input);
  if (action === "join") return answer(await party.join(join, now, chatSince(input)));
  if (action === "poll") return answer(await party.poll(join, now, chatSince(input)));
  if (action === "chat") {
    const text = normaliseChatText(input.text);
    if (text === null) throw new HttpError(400, "VALIDATION_FAILED", "text is empty, too long, or not text.");
    return answer(await party.say(join, text, now, chatSince(input)));
  }
  if (action === "settings") return answer(await party.configure(join.key, settings(input), now));
  if (action === "accept") {
    if (!Number.isInteger(input.terms)) throw new HttpError(400, "VALIDATION_FAILED", "terms is required.");
    return answer(await party.accept(join, input.terms as number, now));
  }

  const starting = await party.startingMembers(join.key, now);
  if ("error" in starting) {
    return answer({ error: starting.error });
  }
  const matchmaker = env.MATCHMAKER.getByName(MATCHMAKER_NAME);
  const name = (key: string) => starting.members.find((candidate) => candidate.key === key)?.name ?? "Someone";

  if (action === "stop") {
    await matchmaker.cancelParty(code, now);
    return answer(await party.setActivity(join.key, null, now));
  }

  /* start */
  const { record, members } = starting;
  if (record.lobby === "custom") {
    if (members.length < 2) throw new HttpError(409, "PARTY_TOO_SMALL", "A custom game needs at least two players.");
    /* for SOL: everyone accepted the leader's terms and can stake them */
    if (record.customStakes) await requireStakes(env, members, record.customStakes.stake);
    const result = await matchmaker.startCustom({
      partyId: code, buildId: record.buildId, mapIndex: record.mapIndex, modeIndex: record.modeIndex,
      members, now, stakes: record.customStakes,
    });
    if ("busy" in result) throw new HttpError(409, "PARTY_MEMBER_BUSY", `${name(result.busy)} is still in a match.`);
    if ("noServer" in result) {
      throw new HttpError(503, "NO_SERVER_FREE", "Every server is busy. One is starting; try again in a minute.");
    }
    return answer(await party.setActivity(join.key, { kind: "custom", playlist: "custom", tickets: result.tickets }, now));
  }

  if (!isPlaylist(record.playlist)) throw new HttpError(409, "VALIDATION_FAILED", "Pick a playlist first.");
  const problem = partyProblem(record.playlist, members.length);
  if (problem) throw new HttpError(409, "PARTY_DOESNT_FIT", problem);
  /* a wagered playlist: at the leader's stake, which every member accepted
     and can stake */
  const stake = playlistWager(record.playlist) ?
    chosenStake(record.playlist, record.stake) ?? chosenStake(record.playlist, undefined) : null;
  if (stake !== null) await requireStakes(env, members, stake);
  const queued = await matchmaker.enqueueParty({
    partyId: code, buildId: record.buildId, playlist: record.playlist, members, now, stake,
    /* the pick from the party's last match */
    vote: parseVote(input.vote),
  });
  if ("busy" in queued) throw new HttpError(409, "PARTY_MEMBER_BUSY", `${name(queued.busy)} is still in a match.`);
  return answer(await party.setActivity(join.key, { kind: "queue", playlist: record.playlist, tickets: queued.tickets }, now));
}
