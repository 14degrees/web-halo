import type { RuntimeEnv } from "./env";
import { HttpError } from "./errors";

/* The broadcast: a match as a spectator receives it, in chunks of two
   seconds, recorded by its dedicated server while anyone watches
   (services/game-server/gateway/broadcast.go) and kept in R2 for a day.
   Viewers play the chunks into their own game a few seconds behind
   (port/web/online_client.js), so any number of them cost the server
   nothing more than one.

     PUT /v1/broadcast/:room/:sequence   (the room's dedicated host) a chunk,
                                         gzip-compressed
     GET /v1/broadcast/:room/latest      the newest chunk's number; asking
                                         keeps the recording going
     GET /v1/broadcast/:room/:sequence   a chunk, cached at the edge */

const BROADCAST_ROUTE = /^\/v1\/broadcast\/([^/]{8,128})\/(latest|\d{1,9})$/u;
/* which room to watch: the fullest public game, or a matchmade match */
const PUBLIC_ROUTE = "/v1/broadcast/public";
const MATCH_ROUTE = /^\/v1\/broadcast\/match\/([A-Za-z0-9_-]{6,64})$/u;
/* a chunk is at most this big, compressed */
const CHUNK_LIMIT = 4 * 1024 * 1024;

export interface BroadcastDeps {
  requestIsDedicatedHost: (request: Request, env: RuntimeEnv) => Promise<boolean>;
  requireValidRoomId: (roomId: string, env: RuntimeEnv) => Promise<void>;
  /* the fullest public dedicated game of a build with someone in it */
  publicRoom: (buildId: string) => Promise<string | null>;
  /* a matchmade match's room, while it is on */
  matchRoom: (matchId: string) => Promise<string | null>;
}

export async function handleBroadcastRequest(
  request: Request,
  env: RuntimeEnv,
  url: URL,
  deps: BroadcastDeps,
): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === PUBLIC_ROUTE) {
    const buildId = url.searchParams.get("buildId") ?? "";
    const roomId = /^[A-Za-z0-9._-]{1,64}$/u.test(buildId) ? await deps.publicRoom(buildId) : null;
    if (!roomId) throw new HttpError(404, "NOTHING_TO_WATCH", "Nobody is playing on the public servers right now.");
    return new Response(JSON.stringify({ roomId, v: 1 }), {
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  const matchRoute = request.method === "GET" ? MATCH_ROUTE.exec(url.pathname) : null;
  if (matchRoute) {
    const roomId = await deps.matchRoom(matchRoute[1]!);
    if (!roomId) throw new HttpError(404, "MATCH_NOT_LIVE", "That match isn't on right now.");
    return new Response(JSON.stringify({ roomId, v: 1 }), {
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  const route = BROADCAST_ROUTE.exec(url.pathname);
  if (!route) return null;
  const roomId = route[1]!;
  const which = route[2]!;
  if (!env.BROADCASTS) throw new HttpError(503, "BROADCAST_OFF", "Broadcasts are not set up.");
  await deps.requireValidRoomId(roomId, env);
  const room = env.ROOMS.getByName(roomId);
  const headers = { "Access-Control-Allow-Origin": "*" };

  if (request.method === "PUT") {
    if (which === "latest" || !(await deps.requestIsDedicatedHost(request, env))) {
      throw new HttpError(403, "BROADCAST_FORBIDDEN", "Only the room's server records it.");
    }
    const body = await request.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > CHUNK_LIMIT) {
      throw new HttpError(413, "CHUNK_TOO_BIG", "That chunk is too big.");
    }
    await env.BROADCASTS.put(`${roomId}/${which}`, body, {
      httpMetadata: { contentType: "application/octet-stream", contentEncoding: "gzip" },
    });
    await room.noteBroadcastChunk(Number(which), Date.now());
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "GET") return null;

  if (which === "latest") {
    const latest = await room.watchBroadcast(Date.now());
    return new Response(JSON.stringify({ latest, v: 1 }), {
      headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  /* a chunk never changes: cached at the edge, near each viewer */
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  const object = await env.BROADCASTS.get(`${roomId}/${which}`);
  if (!object) {
    return new Response(JSON.stringify({ error: { code: "CHUNK_NOT_YET" }, v: 1 }), {
      status: 404,
      headers: { ...headers, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  const response = new Response(object.body, {
    encodeBody: "manual",
    headers: {
      ...headers,
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "gzip",
      "Cache-Control": "public, max-age=86400, immutable",
    },
  });
  await cache.put(cacheKey, response.clone());
  return response;
}
