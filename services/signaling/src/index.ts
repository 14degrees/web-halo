import {
  activeBan,
  activeTurnUsernames,
  actorIdFor,
  actorIdIsValid,
  recordTurnEvent,
  rememberTurnUsernames,
  requestIsAuthorizedAdmin,
  saveBan,
  verificationIdFor,
} from "./abuse";
import { roomIdSignatureMatches, signedRoomId } from "./crypto";
import { HttpError } from "./errors";
import type { RuntimeEnv } from "./env";
import { DEDICATED_HOST_LEASE_MS, LOBBY_DIRECTORY_NAME } from "./lobby";
import { MATCHMAKER_NAME, isPlaylist, playlistWager } from "./matchmaker";
import {
  LOBBY_MAP_COUNT,
  LOBBY_MODE_COUNT,
  IDENTIFIER_PATTERN,
  MAX_HTTP_BODY_BYTES,
  PLAYER_KEY_PATTERN,
  ROOM_ID_PATTERN,
  SIGNALING_PROTOCOL_VERSION,
  TOKEN_PATTERN,
  isBuildId,
  parseCreateRoomInput,
  parseCreateSessionInput,
  parseLobbySettings,
  parseQuickJoinInput,
  type CreateRoomResponse,
  type CreateSessionResponse,
  type LobbySettings,
  type QuickJoinResponse,
  type RenewRoomResponse,
  type RoomVisibility,
  type SessionDescriptor,
} from "./protocol";
import {
  SignalingRoom,
  type CreateRoomResult,
  type CreateSessionResult,
  type MintedSession,
} from "./room";
import { generateIceServersWithFallback, revokeTurnCredential } from "./turn";
import { enforceTurnBandwidthCaps, turnIsDisabled, turnUsageSummary } from "./turn_cap";
import { requireHumanVerification } from "./turnstile";
import { handleEscrowRequest } from "./vault";
import { type MatchResult, stakeProblem } from "./wager";
import { handleWalletRequest, walletForToken } from "./wallet";

export { Bank } from "./bank";
export { LobbyDirectory } from "./lobby";
export { Matchmaker } from "./matchmaker";
export { SignalingRoom } from "./room";
export { Wager } from "./wager";
export type {
  ClientMessage,
  CreateRoomResponse,
  CreateSessionResponse,
  IceCandidateSignal,
  IceServerDescriptor,
  LobbySettings,
  PlayerProfile,
  PlayerStyle,
  PublicRoomDescriptor,
  QuickJoinResponse,
  RenewRoomResponse,
  RoomVisibility,
  SessionDescriptionSignal,
  SessionDescriptor,
  WebRtcSignal,
} from "./protocol";

const ROOM_ROUTE = /^\/v1\/rooms\/([^/]+)$/u;
const SESSION_ROUTE = /^\/v1\/rooms\/([^/]+)\/sessions$/u;
const RENEW_ROUTE = /^\/v1\/rooms\/([^/]+)\/renew$/u;
const WEBSOCKET_ROUTE = /^\/v1\/rooms\/([^/]+)\/ws$/u;
const ADMIN_BAN_ROUTE = /^\/v1\/admin\/bans\/([0-9a-f]{32})$/u;
const QUEUE_TICKET_ROUTE = /^\/v1\/queue\/([A-Za-z0-9_-]{16,64})$/u;
/* A dedicated server's match result (services/game-server/gateway,
   matchResult), as far as it is well formed; null otherwise. */
function parseMatchResult(value: unknown): MatchResult | null {
  if (typeof value !== "object" || value === null) return null;
  const result = value as Record<string, unknown>;
  const scores = result.teamScores;
  if (typeof result.teams !== "boolean" || !Array.isArray(scores) || scores.length !== 2 ||
      !scores.every((score) => Number.isSafeInteger(score)) || !Array.isArray(result.players)) {
    return null;
  }
  const players: MatchResult["players"] = [];
  for (const entry of result.players.slice(0, 16)) {
    if (typeof entry !== "object" || entry === null) return null;
    const player = entry as Record<string, unknown>;
    if (typeof player.name !== "string" || player.name.length > 12 || !Number.isSafeInteger(player.team) ||
        !Number.isSafeInteger(player.score) || typeof player.quit !== "boolean") {
      return null;
    }
    players.push({ name: player.name, team: player.team as number, score: player.score as number, quit: player.quit });
  }
  return { teams: result.teams, teamScores: [scores[0] as number, scores[1] as number], players };
}

const WAGER_ROUTE = /^\/v1\/wagers\/([A-Za-z0-9_-]{8,64})$/u;
const POOL_HEARTBEAT_ROUTE = /^\/v1\/pool\/servers\/([A-Za-z0-9_-]{16,64})\/heartbeat$/u;
const POOL_MATCH_ROUTE =
  /^\/v1\/pool\/servers\/([A-Za-z0-9_-]{16,64})\/matches\/([A-Za-z0-9_-]{8,64})\/(ready|end)$/u;
const MINIMUM_ROOM_CAPACITY = 2;
const MAXIMUM_ROOM_CAPACITY = 128;


function jsonResponse(
  value: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(value, { headers, status });
}

function errorResponse(error: HttpError, origin: string | null): Response {
  return withCors(
    jsonResponse(
      {
        error: { code: error.code, message: error.message },
        v: SIGNALING_PROTOCOL_VERSION,
      },
      error.status,
    ),
    origin,
  );
}

function parsePositiveInteger(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

function requireRoomIdSecret(env: RuntimeEnv): string {
  if (typeof env.ROOM_ID_SECRET !== "string" || env.ROOM_ID_SECRET.length < 32) {
    throw new Error("ROOM_ID_SECRET must contain at least 32 characters.");
  }
  return env.ROOM_ID_SECRET;
}

async function requireValidRoomId(
  roomId: string,
  env: RuntimeEnv,
): Promise<void> {
  if (
    !ROOM_ID_PATTERN.test(roomId) ||
    !(await roomIdSignatureMatches(roomId, requireRoomIdSecret(env)))
  ) {
    throw new HttpError(404, "ROOM_NOT_FOUND", "Room not found.");
  }
}

function requestActor(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "local-development";
}

async function requireAllowedActor(
  request: Request,
  env: RuntimeEnv,
): Promise<string> {
  const actorId = await actorIdFor(request, env);
  if (await activeBan(env, actorId)) {
    recordTurnEvent(env, "blocked", actorId);
    throw new HttpError(403, "PLAYER_BANNED", "This player is not allowed to create or join rooms.");
  }
  return actorId;
}

/* The dedicated host presents HOST_SERVICE_TOKEN as a bearer credential. It
   is a server-to-server secret: it never appears in the page or an invite. */
async function requestIsDedicatedHost(
  request: Request,
  env: RuntimeEnv,
): Promise<boolean> {
  const configured = env.HOST_SERVICE_TOKEN;
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer\s+/iu, "");
  if (typeof configured !== "string" || configured.length < 32 || !supplied) {
    return false;
  }
  const [configuredDigest, suppliedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(configured)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied)),
  ]);
  return crypto.subtle.timingSafeEqual(configuredDigest, suppliedDigest);
}

function defaultLobby(env: RuntimeEnv): LobbySettings {
  return {
    mapIndex: parsePositiveInteger(
      env.PUBLIC_LOBBY_MAP_INDEX,
      "PUBLIC_LOBBY_MAP_INDEX",
      0,
      LOBBY_MAP_COUNT - 1,
    ),
    modeIndex: parsePositiveInteger(
      env.PUBLIC_LOBBY_MODE_INDEX,
      "PUBLIC_LOBBY_MODE_INDEX",
      0,
      LOBBY_MODE_COUNT - 1,
    ),
  };
}

function parseBanInput(value: unknown): { actorId: string; reason: string; ttlSeconds?: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "VALIDATION_FAILED", "Body must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.actorId !== "string" || !actorIdIsValid(record.actorId)) {
    throw new HttpError(400, "VALIDATION_FAILED", "actorId must be 32 lowercase hexadecimal characters.");
  }
  if (record.reason !== undefined && typeof record.reason !== "string") {
    throw new HttpError(400, "VALIDATION_FAILED", "reason must be a string.");
  }
  if (
    record.ttlSeconds !== undefined &&
    (!Number.isInteger(record.ttlSeconds) || typeof record.ttlSeconds !== "number" || record.ttlSeconds < 60 || record.ttlSeconds > 31_536_000)
  ) {
    throw new HttpError(400, "VALIDATION_FAILED", "ttlSeconds must be between 60 and 31536000.");
  }
  return {
    actorId: record.actorId,
    reason: typeof record.reason === "string" ? record.reason : "Abusive TURN usage",
    ...(typeof record.ttlSeconds === "number" ? { ttlSeconds: record.ttlSeconds } : {}),
  };
}

async function handleAdminRequest(
  request: Request,
  env: RuntimeEnv,
  url: URL,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/v1/admin/")) {
    return null;
  }
  if (!(await requestIsAuthorizedAdmin(request, env))) {
    return jsonResponse({ error: { code: "UNAUTHORIZED", message: "Unauthorized." } }, 401, {
      "WWW-Authenticate": "Bearer",
    });
  }

  if (request.method === "GET" && url.pathname === "/v1/admin/bans") {
    const page = await env.HALO_ABUSE.list({ limit: 1_000, prefix: "ban:" });
    const bans = (await Promise.all(page.keys.map(({ name }) => env.HALO_ABUSE.get(name, "json"))))
      .filter((record) => record !== null);
    return jsonResponse({ bans, cursor: page.list_complete ? null : page.cursor });
  }

  if (url.pathname === "/v1/admin/turn" && request.method === "GET") {
    const hours = Number(url.searchParams.get("hours") ?? "24");
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
      return jsonResponse({ error: { code: "VALIDATION_FAILED", message: "hours must be an integer from 1 to 168." } }, 400);
    }
    const summary = await turnUsageSummary(env, hours);
    return jsonResponse({
      ...summary,
      disabled: await turnIsDisabled(env),
      hours,
    });
  }

  if (url.pathname === "/v1/admin/turn/check" && request.method === "POST") {
    await enforceTurnBandwidthCaps(env);
    return jsonResponse({ checked: true, disabled: await turnIsDisabled(env) });
  }

  if (url.pathname === "/v1/admin/turn/disable" && request.method === "POST") {
    await env.HALO_ABUSE.put("turn:disabled", "manual", { expirationTtl: 86_400 });
    return jsonResponse({ disabled: true });
  }

  if (url.pathname === "/v1/admin/turn/disable" && request.method === "DELETE") {
    await env.HALO_ABUSE.delete("turn:disabled");
    return new Response(null, { status: 204 });
  }

  if (request.method === "POST" && url.pathname === "/v1/admin/bans") {
    const input = parseBanInput(await readJsonBody(request));
    const ban = await saveBan(env, input.actorId, input.reason, input.ttlSeconds);
    const credentials = await activeTurnUsernames(env, input.actorId);
    const revoked = await Promise.all(
      credentials.map(async ({ key, username }) => {
        const ok = await revokeTurnCredential(env, username);
        if (ok) {
          await env.HALO_ABUSE.delete(key);
        }
        return ok;
      }),
    );
    const revokedCount = revoked.filter(Boolean).length;
    recordTurnEvent(env, "banned", input.actorId, revokedCount);
    return jsonResponse({ ban, credentialsFound: credentials.length, revoked: revokedCount }, 201);
  }

  const match = ADMIN_BAN_ROUTE.exec(url.pathname);
  if (request.method === "DELETE" && match?.[1]) {
    await env.HALO_ABUSE.delete(`ban:${match[1]}`);
    recordTurnEvent(env, "unbanned", match[1]);
    return new Response(null, { status: 204 });
  }
  return jsonResponse({ error: { code: "NOT_FOUND", message: "Admin route not found." } }, 404);
}

async function requireRateLimit(
  limiter: RateLimit,
  request: Request,
  scope: string,
): Promise<void> {
  const result = await limiter.limit({ key: `${scope}:${requestActor(request)}` });
  if (!result.success) {
    throw new HttpError(
      429,
      "RATE_LIMITED",
      "Too many requests. Please wait a minute and try again.",
    );
  }
}

function allowedOrigin(request: Request, env: RuntimeEnv): string | null {
  const origin = request.headers.get("Origin");
  if (origin === null) {
    if (env.ENVIRONMENT !== "production" && env.ALLOW_NO_ORIGIN === "true") {
      return null;
    }
    throw new HttpError(403, "ORIGIN_FORBIDDEN", "Origin is required.");
  }

  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    throw new HttpError(403, "ORIGIN_FORBIDDEN", "Origin is invalid.");
  }

  const configured = env.ALLOWED_ORIGINS.split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const developmentWildcard =
    env.ENVIRONMENT !== "production" && configured.includes("*");
  if (!developmentWildcard && !configured.includes(normalized)) {
    throw new HttpError(403, "ORIGIN_FORBIDDEN", "Origin is not allowed.");
  }
  return normalized;
}

function withCors(response: Response, origin: string | null): Response {
  if (origin === null || response.status === 101) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.append("Vary", "Origin");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function readJsonBody(request: Request): Promise<unknown> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
    throw new HttpError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json.",
    );
  }

  const declaredLength = request.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    Number(declaredLength) > MAX_HTTP_BODY_BYTES
  ) {
    throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large.");
  }
  if (request.body === null) {
    throw new HttpError(400, "INVALID_JSON", "A JSON body is required.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    total += result.value.byteLength;
    if (total > MAX_HTTP_BODY_BYTES) {
      await reader.cancel("Request body is too large.");
      throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large.");
    }
    chunks.push(result.value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Body must be valid UTF-8 JSON.");
  }
}

function websocketUrl(
  requestUrl: URL,
  roomId: string,
  session: MintedSession,
): string {
  const url = new URL(`/v1/rooms/${encodeURIComponent(roomId)}/ws`, requestUrl);
  url.protocol = requestUrl.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("peer", session.peerId);
  url.searchParams.set("token", session.token);
  return url.toString();
}

function sessionDescriptor(
  requestUrl: URL,
  roomId: string,
  session: MintedSession,
): SessionDescriptor {
  return {
    identifier: session.identifier,
    peerId: session.peerId,
    role: session.role,
    token: session.token,
    websocketUrl: websocketUrl(requestUrl, roomId, session),
  };
}

function inviteUrl(env: RuntimeEnv, inviteCode: string): string {
  const url = new URL(env.PUBLIC_GAME_URL);
  url.hash = `join=${encodeURIComponent(inviteCode)}`;
  return url.toString();
}

interface RoomAllocation {
  actorId: string;
  wallet?: string;
  buildId: string;
  capacity?: number;
  dedicated: boolean;
  identifier: string;
  lobby: LobbySettings | null;
  protocolVersion: typeof SIGNALING_PROTOCOL_VERSION;
  visibility: RoomVisibility;
}

async function createRoom(
  request: Request,
  env: RuntimeEnv,
  origin: string | null,
): Promise<Response> {
  const parsed = parseCreateRoomInput(await readJsonBody(request));
  if (!parsed.ok) {
    throw new HttpError(400, "VALIDATION_FAILED", parsed.message);
  }
  const actorId = await requireAllowedActor(request, env);
  const dedicated = parsed.value.dedicated === true;
  if (dedicated && !(await requestIsDedicatedHost(request, env))) {
    throw new HttpError(403, "DEDICATED_HOST_UNAUTHORIZED", "Dedicated hosting needs the service credential.");
  }
  if (!dedicated) {
    const verificationId = await verificationIdFor(request, parsed.value.identifier, env);
    try {
      await requireHumanVerification(request, env, verificationId, parsed.value.turnstileToken, "create_room");
    } catch {
      throw new HttpError(403, "TURNSTILE_REJECTED", "Complete the human verification and try again.");
    }
  }
  const visibility: RoomVisibility = parsed.value.visibility ?? (dedicated ? "public" : "private");
  const body = await allocateRoom(request, env, {
    actorId,
    buildId: parsed.value.buildId,
    ...(parsed.value.capacity === undefined ? {} : { capacity: parsed.value.capacity }),
    dedicated,
    identifier: parsed.value.identifier,
    lobby: parsed.value.lobby ?? (visibility === "public" ? defaultLobby(env) : null),
    protocolVersion: parsed.value.protocolVersion,
    visibility,
  });
  return withCors(jsonResponse(body, 201), origin);
}

async function allocateRoom(
  request: Request,
  env: RuntimeEnv,
  allocation: RoomAllocation,
): Promise<CreateRoomResponse> {
  const defaultCapacity = parsePositiveInteger(
    env.DEFAULT_ROOM_CAPACITY,
    "DEFAULT_ROOM_CAPACITY",
    MINIMUM_ROOM_CAPACITY,
    MAXIMUM_ROOM_CAPACITY,
  );
  const maximumCapacity = parsePositiveInteger(
    env.MAX_ROOM_CAPACITY,
    "MAX_ROOM_CAPACITY",
    MINIMUM_ROOM_CAPACITY,
    MAXIMUM_ROOM_CAPACITY,
  );
  const capacity = allocation.capacity ?? defaultCapacity;
  if (capacity > maximumCapacity) {
    throw new HttpError(
      400,
      "CAPACITY_TOO_LARGE",
      `capacity cannot exceed ${maximumCapacity}.`,
    );
  }

  const roomTtlMs = roomTtlMilliseconds(env, allocation.dedicated);
  const sessionTtlMs =
    parsePositiveInteger(
      env.SESSION_TTL_SECONDS,
      "SESSION_TTL_SECONDS",
      30,
      600,
    ) * 1_000;
  const now = Date.now();

  let roomId = "";
  let result: CreateRoomResult | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    roomId = await signedRoomId(requireRoomIdSecret(env));
    result = await env.ROOMS.getByName(roomId).createRoom({
      buildId: allocation.buildId,
      capacity,
      dedicated: allocation.dedicated,
      identifier: allocation.identifier,
      lobby: allocation.lobby,
      now,
      protocolVersion: allocation.protocolVersion,
      roomId,
      roomTtlMs,
      sessionTtlMs,
      visibility: allocation.visibility,
      ...(allocation.wallet === undefined ? {} : { wallet: allocation.wallet }),
      /* where the host is, as the Cloudflare data centre it reached (LAX) */
      ...(typeof request.cf?.colo === "string" ? { colo: request.cf.colo } : {}),
    });
    if (result.ok) {
      break;
    }
  }
  if (result === null || !result.ok) {
    throw new HttpError(
      503,
      "ROOM_ID_COLLISION",
      "Could not allocate a room. Please retry.",
    );
  }

  const requestUrl = new URL(request.url);
  const code = `${roomId}.${result.guestTicket}`;
  const ice = await issueIceServers(env, result.expiresAt, allocation.actorId);
  return {
    host: {
      session: sessionDescriptor(requestUrl, roomId, result.hostSession),
      ticket: result.hostTicket,
    },
    iceServers: ice.iceServers,
    iceServersExpiresAt: ice.expiresAt,
    invite: { code, url: inviteUrl(env, code) },
    room: {
      buildId: allocation.buildId,
      capacity,
      dedicated: allocation.dedicated,
      expiresAt: result.expiresAt,
      id: roomId,
      lobby: allocation.lobby,
      protocolVersion: allocation.protocolVersion,
      visibility: allocation.visibility,
    },
    v: SIGNALING_PROTOCOL_VERSION,
  };
}

function roomTtlMilliseconds(env: RuntimeEnv, dedicated: boolean): number {
  const seconds = dedicated
    ? parsePositiveInteger(
        env.DEDICATED_ROOM_TTL_SECONDS,
        "DEDICATED_ROOM_TTL_SECONDS",
        300,
        86_400,
      )
    : parsePositiveInteger(env.ROOM_TTL_SECONDS, "ROOM_TTL_SECONDS", 300, 86_400);
  return seconds * 1_000;
}

function sessionTtlMilliseconds(env: RuntimeEnv): number {
  return parsePositiveInteger(env.SESSION_TTL_SECONDS, "SESSION_TTL_SECONDS", 30, 600) * 1_000;
}

async function issueIceServers(
  env: RuntimeEnv,
  roomExpiresAt: number,
  actorId: string,
): Promise<{ expiresAt: number | null; iceServers: CreateRoomResponse["iceServers"] }> {
  const ice = (await turnIsDisabled(env)) ?
    { expiresAt: null, iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }], turnUsernames: [] } :
    await generateIceServersWithFallback(env, roomExpiresAt, Date.now(), actorId);
  await rememberTurnUsernames(env, actorId, ice.turnUsernames, ice.expiresAt);
  recordTurnEvent(env, ice.turnUsernames.length ? "issued" : "stun-only", actorId, ice.turnUsernames.length);
  return { expiresAt: ice.expiresAt, iceServers: ice.iceServers };
}

function sessionError(result: Extract<CreateSessionResult, { ok: false }>): HttpError {
  switch (result.code) {
    case "BUILD_MISMATCH":
      return new HttpError(
        409,
        result.code,
        "The host and guest game builds do not match.",
      );
    case "PROTOCOL_MISMATCH":
      return new HttpError(
        409,
        result.code,
        "The host and guest signaling protocols do not match.",
      );
    case "ROOM_FULL":
      return new HttpError(409, result.code, "The room is full.");
    case "HOST_ALREADY_CONNECTED":
      return new HttpError(409, result.code, "The host is already connected.");
    case "IDENTIFIER_IN_USE":
      return new HttpError(
        409,
        result.code,
        "That network identifier is already in use in this room.",
      );
    case "ROOM_EXPIRED":
      return new HttpError(410, result.code, "The room has expired.");
    case "INVALID_TICKET":
    case "ROOM_NOT_FOUND":
      return new HttpError(
        404,
        "ROOM_NOT_FOUND_OR_TICKET_INVALID",
        "The room or invite is invalid.",
      );
  }
}

/* One session request against a room, shared by the invite and quick-join
   routes. */
async function mintSession(
  env: RuntimeEnv,
  roomId: string,
  input: { buildId: string; identifier: string; protocolVersion: number; ticket?: string },
  wallet?: string | null,
): Promise<CreateSessionResult> {
  return env.ROOMS.getByName(roomId).createSession({
    buildId: input.buildId,
    identifier: input.identifier,
    now: Date.now(),
    protocolVersion: input.protocolVersion,
    sessionTtlMs: sessionTtlMilliseconds(env),
    ...(input.ticket === undefined ? {} : { ticket: input.ticket }),
    ...(wallet ? { wallet } : {}),
  });
}

async function sessionResponse(
  request: Request,
  env: RuntimeEnv,
  roomId: string,
  actorId: string,
  result: Extract<CreateSessionResult, { ok: true }>,
): Promise<CreateSessionResponse> {
  const ice = await issueIceServers(env, result.room.expiresAt, actorId);
  return {
    iceServers: ice.iceServers,
    iceServersExpiresAt: ice.expiresAt,
    room: result.room,
    session: sessionDescriptor(new URL(request.url), roomId, result.session),
    v: SIGNALING_PROTOCOL_VERSION,
  };
}

async function createSession(
  request: Request,
  env: RuntimeEnv,
  origin: string | null,
  roomId: string,
): Promise<Response> {
  await requireValidRoomId(roomId, env);
  const parsed = parseCreateSessionInput(await readJsonBody(request));
  if (!parsed.ok) {
    throw new HttpError(400, "VALIDATION_FAILED", parsed.message);
  }
  const actorId = await requireAllowedActor(request, env);
  const verificationId = await verificationIdFor(request, parsed.value.identifier, env);
  try {
    await requireHumanVerification(request, env, verificationId, parsed.value.turnstileToken, "join_room");
  } catch {
    throw new HttpError(403, "TURNSTILE_REJECTED", "Complete the human verification and try again.");
  }

  const wallet = await walletForToken(env, parsed.value.walletToken);
  const result = await mintSession(env, roomId, parsed.value, wallet);
  if (!result.ok) {
    throw sessionError(result);
  }
  const body = await sessionResponse(request, env, roomId, actorId, result);
  return withCors(jsonResponse(body, 201), origin);
}

/* Quick join: seat the caller in the best open public room, or make the
   caller the host of a new one. One Turnstile token (the join action) covers
   either outcome, so the page needs a single button. */
async function quickJoin(
  request: Request,
  env: RuntimeEnv,
  origin: string | null,
): Promise<Response> {
  const parsed = parseQuickJoinInput(await readJsonBody(request));
  if (!parsed.ok) {
    throw new HttpError(400, "VALIDATION_FAILED", parsed.message);
  }
  const actorId = await requireAllowedActor(request, env);
  const verificationId = await verificationIdFor(request, parsed.value.identifier, env);
  try {
    await requireHumanVerification(request, env, verificationId, parsed.value.turnstileToken, "join_room");
  } catch {
    throw new HttpError(403, "TURNSTILE_REJECTED", "Complete the human verification and try again.");
  }

  const directory = env.LOBBY_DIRECTORY.getByName(LOBBY_DIRECTORY_NAME);
  const candidates = await directory.candidates(
    parsed.value.buildId,
    parsed.value.protocolVersion,
    Date.now(),
  );
  const wallet = await walletForToken(env, parsed.value.walletToken);
  for (const candidate of candidates) {
    const result = await mintSession(env, candidate.roomId, parsed.value, wallet);
    if (result.ok) {
      const body: QuickJoinResponse = {
        ...(await sessionResponse(request, env, candidate.roomId, actorId, result)),
        role: "guest",
      };
      return withCors(jsonResponse(body, 201), origin);
    }
    if (result.code === "IDENTIFIER_IN_USE") {
      /* This browser is already in that room (a refresh in flight). Sending it
         to another room would split it from the players it was with. */
      throw sessionError(result);
    }
    if (
      result.code === "ROOM_NOT_FOUND" ||
      result.code === "ROOM_EXPIRED" ||
      result.code === "INVALID_TICKET"
    ) {
      await directory.remove(candidate.roomId);
    }
    /* Full, or a build the directory mislisted: try the next room. */
  }

  /* Nobody to join: the caller hosts. Creating a room counts against the
     same limit as the wizard's route, so quick join cannot mint rooms faster. */
  await requireRateLimit(env.ROOM_CREATE_LIMITER, request, "room-create");
  const body: QuickJoinResponse = {
    ...(await allocateRoom(request, env, {
      actorId,
      buildId: parsed.value.buildId,
      dedicated: false,
      identifier: parsed.value.identifier,
      lobby: defaultLobby(env),
      protocolVersion: parsed.value.protocolVersion,
      visibility: "public",
      ...(wallet ? { wallet } : {}),
    })),
    role: "host",
  };
  return withCors(jsonResponse(body, 201), origin);
}

/* The public lobby's view before joining: the open public rooms on a build,
   with their players' names, map and mode. No capability is listed. */
async function listLobbies(
  _request: Request,
  env: RuntimeEnv,
  origin: string | null,
  url: URL,
): Promise<Response> {
  const buildId = url.searchParams.get("buildId") ?? "";
  if (!/^[A-Za-z0-9._:+-]{1,96}$/u.test(buildId)) {
    throw new HttpError(400, "VALIDATION_FAILED", "buildId must be 1-96 URL-safe characters.");
  }
  const now = Date.now();
  const entries = await env.LOBBY_DIRECTORY.getByName(LOBBY_DIRECTORY_NAME).list(now);
  const lobbies = entries
    /* A room whose host is gone is dead even while stranded guests linger. */
    .filter((entry) => entry.buildId === buildId && entry.protocolVersion === SIGNALING_PROTOCOL_VERSION &&
      entry.hostConnected && (!entry.dedicated || entry.hostSeenAt > now - DEDICATED_HOST_LEASE_MS))
    .slice(0, 16)
    .map((entry) => ({
      capacity: entry.capacity,
      dedicated: entry.dedicated,
      mapIndex: entry.mapIndex,
      modeIndex: entry.modeIndex,
      /* A dedicated host's own player is not a person. */
      names: entry.dedicated ? entry.names.filter((player) => !player.host) : entry.names,
      players: entry.players,
      /* a dedicated server's match (lobby, countdown, ingame, postgame) */
      matchState: entry.matchState || null,
    }));
  return withCors(jsonResponse({ lobbies, v: SIGNALING_PROTOCOL_VERSION }), origin);
}

/* The server dashboard (servers.html on the game site): every dedicated
   server the directory knows, live or lapsed, with its match and players.
   A room's short name is its ID's first two groups, which grant nothing. */
const SERVER_HISTORY_MS = 10 * 60_000;

async function listServers(env: RuntimeEnv, origin: string | null): Promise<Response> {
  const now = Date.now();
  const entries = await env.LOBBY_DIRECTORY.getByName(LOBBY_DIRECTORY_NAME).list(now);
  const servers = entries
    /* a server gone more than ten minutes is history, not news */
    .filter((entry) => entry.dedicated && entry.hostSeenAt > now - SERVER_HISTORY_MS)
    .slice(0, 64)
    .map((entry) => ({
      name: entry.roomId.slice(0, 9),
      buildId: entry.buildId,
      colo: entry.colo || null,
      live: entry.hostConnected && entry.hostSeenAt > now - DEDICATED_HOST_LEASE_MS,
      lastSeenSeconds: entry.hostSeenAt ? Math.round((now - entry.hostSeenAt) / 1000) : null,
      matchState: entry.matchState || null,
      matchSeconds: entry.matchSince ? Math.round((now - entry.matchSince) / 1000) : null,
      mapIndex: entry.mapIndex,
      modeIndex: entry.modeIndex,
      players: entry.players,
      names: entry.names.filter((player) => !player.host).map((player) => player.name),
      uptimeSeconds: Math.round((now - entry.createdAt) / 1000),
    }));
  const browserHosted = entries.filter((entry) => !entry.dedicated && entry.hostConnected).length;
  return withCors(jsonResponse({ browserHosted, now, servers, v: SIGNALING_PROTOCOL_VERSION }), origin);
}

/* ---------- matchmaking (src/matchmaker.ts) */

function matchmaker(env: RuntimeEnv) {
  return env.MATCHMAKER.getByName(MATCHMAKER_NAME);
}

function record(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "VALIDATION_FAILED", "The request body must be an object.");
  }
  return body as Record<string, unknown>;
}

/* A player joins the queue: their machine, build, playlist and (to wager)
   wallet. */
async function enqueue(request: Request, env: RuntimeEnv, origin: string | null): Promise<Response> {
  const body = record(await readJsonBody(request));
  if (body.protocolVersion !== SIGNALING_PROTOCOL_VERSION || !isBuildId(body.buildId) ||
      typeof body.identifier !== "string" || !IDENTIFIER_PATTERN.test(body.identifier)) {
    throw new HttpError(400, "VALIDATION_FAILED", "protocolVersion, buildId and identifier are required.");
  }
  const playlist = body.playlist ?? "ffa";
  if (!isPlaylist(playlist)) {
    throw new HttpError(400, "VALIDATION_FAILED", "playlist is not one the matchmaker runs.");
  }
  await requireAllowedActor(request, env);
  const walletToken = typeof body.walletToken === "string" ? body.walletToken : undefined;
  const wallet = await walletForToken(env, walletToken);
  /* a wagered playlist needs a wallet whose vault and session can stake */
  const wager = playlistWager(playlist);
  if (wager) {
    if (wallet === null) throw new HttpError(401, "WALLET_SIGN_IN_REQUIRED", "Sign in with your wallet to play for SOL.");
    const problem = await stakeProblem(env, wallet, wager.stake);
    if (problem !== null) throw new HttpError(409, "STAKE_NOT_READY", problem);
  }
  const playerKey = typeof body.playerKey === "string" && PLAYER_KEY_PATTERN.test(body.playerKey) ?
    body.playerKey : null;
  const ticket = await matchmaker(env).enqueue({
    buildId: body.buildId,
    identifier: body.identifier,
    playerKey,
    now: Date.now(),
    playlist,
    wallet: wallet ?? null,
  });
  return withCors(jsonResponse({ ticket, v: SIGNALING_PROTOCOL_VERSION }, 201), origin);
}

async function requirePoolServer(request: Request, env: RuntimeEnv): Promise<void> {
  if (!(await requestIsDedicatedHost(request, env))) {
    throw new HttpError(403, "DEDICATED_HOST_UNAUTHORIZED", "Pool servers need the service credential.");
  }
}

async function handleMatchmaking(
  request: Request,
  env: RuntimeEnv,
  origin: string | null,
  url: URL,
): Promise<Response | null> {
  const now = Date.now();
  if (request.method === "POST" && url.pathname === "/v1/queue") {
    await requireRateLimit(env.SESSION_CREATE_LIMITER, request, "session-create");
    return enqueue(request, env, origin);
  }
  const ticketMatch = QUEUE_TICKET_ROUTE.exec(url.pathname);
  if (ticketMatch) {
    const ticketId = ticketMatch[1]!;
    if (request.method === "GET") {
      const ticket = await matchmaker(env).poll(ticketId, now);
      if (!ticket) throw new HttpError(404, "TICKET_NOT_FOUND", "That queue ticket is unknown or has expired.");
      return withCors(jsonResponse({ ticket, v: SIGNALING_PROTOCOL_VERSION }), origin);
    }
    if (request.method === "DELETE") {
      const cancelled = await matchmaker(env).cancel(ticketId, now);
      return withCors(jsonResponse({ cancelled, v: SIGNALING_PROTOCOL_VERSION }), origin);
    }
  }
  if (request.method === "GET" && url.pathname === "/v1/playlists") {
    await requireRateLimit(env.SESSION_CREATE_LIMITER, request, "lobby-list");
    const playlists = await matchmaker(env).playlists(now);
    return withCors(jsonResponse({ playlists, v: SIGNALING_PROTOCOL_VERSION }), origin);
  }
  if (request.method === "GET" && url.pathname === "/v1/matchmaker") {
    await requireRateLimit(env.SESSION_CREATE_LIMITER, request, "lobby-list");
    const snapshot = await matchmaker(env).snapshot(now);
    return withCors(jsonResponse({
      events: snapshot.events.map((event) => ({ ...event, detail: event.detail ? JSON.parse(event.detail) : null })),
      machines: snapshot.machines,
      matches: snapshot.matches,
      now,
      queues: snapshot.queues,
      servers: snapshot.servers,
      v: SIGNALING_PROTOCOL_VERSION,
    }), origin);
  }
  if (request.method === "POST" && url.pathname === "/v1/pool/servers") {
    await requirePoolServer(request, env);
    const body = record(await readJsonBody(request));
    if (!isBuildId(body.buildId)) throw new HttpError(400, "VALIDATION_FAILED", "buildId is required.");
    const colo = typeof request.cf?.colo === "string" ? request.cf.colo : null;
    const machineId = typeof body.machineId === "string" && /^[0-9a-z]{6,32}$/u.test(body.machineId) ?
      body.machineId : null;
    const serverId = await matchmaker(env).registerServer(body.buildId, colo, machineId, now);
    return withCors(jsonResponse({ serverId, v: SIGNALING_PROTOCOL_VERSION }, 201), origin);
  }
  const heartbeatMatch = POOL_HEARTBEAT_ROUTE.exec(url.pathname);
  if (heartbeatMatch && request.method === "POST") {
    await requirePoolServer(request, env);
    const body = record(await readJsonBody(request));
    const result = await matchmaker(env).heartbeat({
      serverId: heartbeatMatch[1]!,
      now,
      ...(typeof body.matchState === "string" ? { matchState: body.matchState.slice(0, 16) } : {}),
      ...(typeof body.players === "number" && Number.isInteger(body.players) ? { players: body.players } : {}),
    });
    if (!result.known) throw new HttpError(404, "SERVER_NOT_FOUND", "Register again.");
    return withCors(jsonResponse({ assignment: result.assignment, v: SIGNALING_PROTOCOL_VERSION }), origin);
  }
  const poolMatch = POOL_MATCH_ROUTE.exec(url.pathname);
  if (poolMatch && request.method === "POST") {
    await requirePoolServer(request, env);
    const [, serverId, matchId, action] = poolMatch;
    const body = record(await readJsonBody(request));
    let ok: boolean;
    if (action === "ready") {
      if (typeof body.roomId !== "string" || !ROOM_ID_PATTERN.test(body.roomId) ||
          typeof body.inviteCode !== "string" || body.inviteCode.length > 512) {
        throw new HttpError(400, "VALIDATION_FAILED", "roomId and inviteCode are required.");
      }
      ok = await matchmaker(env).matchReady(serverId!, matchId!, body.roomId, body.inviteCode, now);
    } else {
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 64) : "finished";
      ok = await matchmaker(env).matchEnded(serverId!, matchId!, reason, now, parseMatchResult(body.result));
    }
    if (!ok) throw new HttpError(409, "MATCH_NOT_ASSIGNED", "That match is not this server's.");
    return withCors(jsonResponse({ ok, v: SIGNALING_PROTOCOL_VERSION }), origin);
  }
  return null;
}

function readTicketBody(body: unknown): string {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    typeof (body as Record<string, unknown>).ticket !== "string" ||
    !TOKEN_PATTERN.test((body as Record<string, unknown>).ticket as string)
  ) {
    throw new HttpError(400, "VALIDATION_FAILED", "ticket is malformed.");
  }
  return (body as { ticket: string }).ticket;
}

async function renewRoom(
  request: Request,
  env: RuntimeEnv,
  origin: string | null,
  roomId: string,
): Promise<Response> {
  await requireValidRoomId(roomId, env);
  const payload = await readJsonBody(request);
  const ticket = readTicketBody(payload);
  let lobby: LobbySettings | undefined;
  if ((payload as Record<string, unknown>).lobby !== undefined) {
    const parsedLobby = parseLobbySettings((payload as Record<string, unknown>).lobby);
    if (!parsedLobby.ok) {
      throw new HttpError(400, "VALIDATION_FAILED", parsedLobby.message);
    }
    lobby = parsedLobby.value;
  }
  const dedicated = await requestIsDedicatedHost(request, env);
  const result = await env.ROOMS.getByName(roomId).renewRoom(
    ticket,
    Date.now(),
    roomTtlMilliseconds(env, dedicated),
    lobby,
  );
  if (!result.ok) {
    throw new HttpError(
      404,
      "ROOM_NOT_FOUND_OR_TICKET_INVALID",
      "The room or host ticket is invalid.",
    );
  }
  const body: RenewRoomResponse = { room: result.room, v: SIGNALING_PROTOCOL_VERSION };
  return withCors(jsonResponse(body, 200), origin);
}

async function closeRoom(
  request: Request,
  env: RuntimeEnv,
  origin: string | null,
  roomId: string,
): Promise<Response> {
  await requireValidRoomId(roomId, env);
  const ticket = readTicketBody(await readJsonBody(request));
  const result = await env.ROOMS.getByName(roomId).closeRoom(ticket);
  if (!result.ok) {
    throw new HttpError(
      404,
      "ROOM_NOT_FOUND_OR_TICKET_INVALID",
      "The room or host ticket is invalid.",
    );
  }
  return withCors(new Response(null, { status: 204 }), origin);
}

async function route(request: Request, env: RuntimeEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/v1/health") {
    return jsonResponse({ ok: true, v: SIGNALING_PROTOCOL_VERSION });
  }
  const adminResponse = await handleAdminRequest(request, env, url);
  if (adminResponse !== null) {
    return adminResponse;
  }

  const origin = allowedOrigin(request, env);
  if (request.method === "OPTIONS") {
    const response = new Response(null, {
      headers: {
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Max-Age": "86400",
      },
      status: 204,
    });
    return withCors(response, origin);
  }
  if (request.method === "POST" && url.pathname === "/v1/rooms") {
    await requireRateLimit(env.ROOM_CREATE_LIMITER, request, "room-create");
    await requireRateLimit(env.TURN_ISSUE_LIMITER, request, "turn-issue");
    return createRoom(request, env, origin);
  }

  const escrowResponse = await handleEscrowRequest(request, env, url, () => readJsonBody(request));
  if (escrowResponse !== null) {
    return withCors(jsonResponse(escrowResponse), origin);
  }

  /* A wagered match's balances and payouts, for the lobby and scoreboard. */
  const wagerMatch = WAGER_ROUTE.exec(url.pathname);
  if (request.method === "GET" && wagerMatch) {
    const view = await env.WAGERS.getByName(wagerMatch[1]!).snapshot();
    if (view === null) throw new HttpError(404, "NOT_FOUND", "No wager for that match.");
    return withCors(jsonResponse({ wager: view }), origin);
  }

  const walletResponse = await handleWalletRequest(request, env, url, () => readJsonBody(request));
  if (walletResponse !== null) {
    return withCors(jsonResponse(walletResponse), origin);
  }

  const matchmakingResponse = await handleMatchmaking(request, env, origin, url);
  if (matchmakingResponse !== null) {
    return matchmakingResponse;
  }

  if (request.method === "GET" && url.pathname === "/v1/servers") {
    await requireRateLimit(env.SESSION_CREATE_LIMITER, request, "lobby-list");
    return listServers(env, origin);
  }

  if (request.method === "GET" && url.pathname === "/v1/lobbies") {
    await requireRateLimit(env.SESSION_CREATE_LIMITER, request, "lobby-list");
    return listLobbies(request, env, origin, url);
  }

  if (request.method === "POST" && url.pathname === "/v1/quickjoin") {
    await requireRateLimit(env.SESSION_CREATE_LIMITER, request, "session-create");
    await requireRateLimit(env.TURN_ISSUE_LIMITER, request, "turn-issue");
    return quickJoin(request, env, origin);
  }

  const sessionMatch = SESSION_ROUTE.exec(url.pathname);
  if (request.method === "POST" && sessionMatch?.[1] !== undefined) {
    await requireRateLimit(env.SESSION_CREATE_LIMITER, request, "session-create");
    await requireRateLimit(env.TURN_ISSUE_LIMITER, request, "turn-issue");
    return createSession(request, env, origin, sessionMatch[1]);
  }

  const renewMatch = RENEW_ROUTE.exec(url.pathname);
  if (request.method === "POST" && renewMatch?.[1] !== undefined) {
    await requireRateLimit(env.SESSION_CREATE_LIMITER, request, "room-renew");
    return renewRoom(request, env, origin, renewMatch[1]);
  }

  const websocketMatch = WEBSOCKET_ROUTE.exec(url.pathname);
  if (request.method === "GET" && websocketMatch?.[1] !== undefined) {
    await requireRateLimit(
      env.SESSION_CREATE_LIMITER,
      request,
      "websocket-upgrade",
    );
    const roomId = websocketMatch[1];
    await requireValidRoomId(roomId, env);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      throw new HttpError(
        426,
        "UPGRADE_REQUIRED",
        "Expected a WebSocket upgrade.",
      );
    }
    return env.ROOMS.getByName(roomId).fetch(request);
  }

  const roomMatch = ROOM_ROUTE.exec(url.pathname);
  if (request.method === "DELETE" && roomMatch?.[1] !== undefined) {
    await requireRateLimit(env.SESSION_CREATE_LIMITER, request, "room-close");
    return closeRoom(request, env, origin, roomMatch[1]);
  }
  if (roomMatch !== null) {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed.");
  }
  throw new HttpError(404, "NOT_FOUND", "Route not found.");
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    const path = new URL(request.url).pathname;
    try {
      const response = await route(request, env);
      console.log(
        JSON.stringify({
          durationMs: Date.now() - startedAt,
          message: "request complete",
          method: request.method,
          path,
          requestId,
          status: response.status,
        }),
      );
      return response;
    } catch (error) {
      if (error instanceof HttpError) {
        let origin: string | null = null;
        try {
          origin = allowedOrigin(request, env);
        } catch {
          // Preserve the original error and omit CORS for a forbidden origin.
        }
        console.warn(
          JSON.stringify({
            code: error.code,
            durationMs: Date.now() - startedAt,
            message: "request rejected",
            method: request.method,
            path,
            requestId,
            status: error.status,
          }),
        );
        return errorResponse(error, origin);
      }

      console.error(
        JSON.stringify({
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          message: "unhandled request error",
          method: request.method,
          path,
          requestId,
        }),
      );
      return errorResponse(
        new HttpError(500, "INTERNAL_ERROR", "Internal server error."),
        null,
      );
    }
  },
  async scheduled(_controller: ScheduledController, env: RuntimeEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(enforceTurnBandwidthCaps(env));
  },
} satisfies ExportedHandler<RuntimeEnv>;
