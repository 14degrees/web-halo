import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { DEDICATED_HOST_LEASE_MS, LOBBY_DIRECTORY_NAME, type LobbyEntry } from "../src/lobby";
import type {
  CreateRoomResponse,
  CreateSessionResponse,
  QuickJoinResponse,
  RenewRoomResponse,
} from "../src/index";

const API_ORIGIN = "http://signaling.test";
const GAME_ORIGIN = "http://127.0.0.1:8765";
const HOST_SERVICE_TOKEN = "test-only-host-service-token-32-bytes-min";

let nextBuild = 0;

/* Each test gets its own build ID so the shared lobby directory never offers
   one test's rooms to another. */
function freshBuild(): string {
  nextBuild += 1;
  return `lobby-test-build-${nextBuild}`;
}

let nextAddress = 0;

function jsonRequest(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  /* Each request from its own address, so the per-address room-creation
     rate limit never trips across this suite. */
  nextAddress += 1;
  return new Request(`${API_ORIGIN}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "CF-Connecting-IP": `198.51.100.${nextAddress % 250}`,
      "Content-Type": "application/json",
      Origin: GAME_ORIGIN,
      ...headers,
    },
    method: "POST",
  });
}

async function quickJoin(buildId: string, identifier: string): Promise<Response> {
  return exports.default.fetch(
    jsonRequest("/v1/quickjoin", { buildId, identifier, protocolVersion: 1 }),
  );
}

async function createRoom(
  buildId: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return exports.default.fetch(
    jsonRequest(
      "/v1/rooms",
      { buildId, identifier: "001122334455", protocolVersion: 1, ...extra },
      headers,
    ),
  );
}

async function connect(websocketUrl: string): Promise<WebSocket> {
  const requestUrl = new URL(websocketUrl);
  requestUrl.protocol = requestUrl.protocol === "wss:" ? "https:" : "http:";
  const response = await exports.default.fetch(
    new Request(requestUrl, { headers: { Origin: GAME_ORIGIN, Upgrade: "websocket" } }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("Upgrade did not return a WebSocket.");
  socket.accept();
  return socket;
}

async function directoryEntries(buildId: string): Promise<Array<{ players: number; roomId: string }>> {
  const all = await env.LOBBY_DIRECTORY.getByName(LOBBY_DIRECTORY_NAME).list(Date.now());
  return all
    .filter((entry) => entry.buildId === buildId)
    .map((entry) => ({ players: entry.players, roomId: entry.roomId }));
}

describe("public lobby", () => {
  it("makes the first player the host of a public room with the default lobby", async () => {
    const buildId = freshBuild();
    const response = await quickJoin(buildId, "0a0a0a0a0a0a");
    expect(response.status).toBe(201);
    const body = await response.json<QuickJoinResponse>();
    expect(body.role).toBe("host");
    if (body.role !== "host") throw new Error("expected host");
    expect(body.room.visibility).toBe("public");
    expect(body.room.dedicated).toBe(false);
    expect(body.room.lobby).toEqual({ mapIndex: 9, modeIndex: 0 });
    expect(body.host.session.role).toBe("host");
    expect(body.invite.code).toContain(".");
    expect(await directoryEntries(buildId)).toEqual([{ players: 0, roomId: body.room.id }]);
  });

  it("seats later players in the open public room as guests", async () => {
    const buildId = freshBuild();
    const first = await (await quickJoin(buildId, "0b0b0b0b0b0b")).json<QuickJoinResponse>();
    if (first.role !== "host") throw new Error("expected host");
    const hostSocket = await connect(first.host.session.websocketUrl);

    const second = await quickJoin(buildId, "0c0c0c0c0c0c");
    expect(second.status).toBe(201);
    const guest = await second.json<QuickJoinResponse>();
    expect(guest.role).toBe("guest");
    if (guest.role !== "guest") throw new Error("expected guest");
    expect(guest.room.id).toBe(first.room.id);
    expect(guest.room.visibility).toBe("public");
    expect(guest.session.role).toBe("guest");

    const guestSocket = await connect(guest.session.websocketUrl);
    expect(await directoryEntries(buildId)).toEqual([{ players: 2, roomId: first.room.id }]);

    guestSocket.close(1000, "test complete");
    hostSocket.close(1000, "test complete");
  });

  it("never offers a private room and rejects ticket-less sessions for it", async () => {
    const buildId = freshBuild();
    const privateRoom = await (await createRoom(buildId)).json<CreateRoomResponse>();
    expect(privateRoom.room.visibility).toBe("private");
    expect(await directoryEntries(buildId)).toEqual([]);

    const ticketless = await exports.default.fetch(
      jsonRequest(`/v1/rooms/${privateRoom.room.id}/sessions`, {
        buildId,
        identifier: "0d0d0d0d0d0d",
        protocolVersion: 1,
      }),
    );
    expect(ticketless.status).toBe(404);

    const body = await (await quickJoin(buildId, "0d0d0d0d0d0d")).json<QuickJoinResponse>();
    expect(body.role).toBe("host");
    expect(body.room.id).not.toBe(privateRoom.room.id);
  });

  it("accepts a ticket-less session for a public room so guests can reconnect", async () => {
    const buildId = freshBuild();
    const first = await (await quickJoin(buildId, "0e0e0e0e0e0e")).json<QuickJoinResponse>();
    const response = await exports.default.fetch(
      jsonRequest(`/v1/rooms/${first.room.id}/sessions`, {
        buildId,
        identifier: "0f0f0f0f0f0f",
        protocolVersion: 1,
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json<CreateSessionResponse>();
    expect(body.session.role).toBe("guest");
    expect(body.room.id).toBe(first.room.id);
  });

  it("skips a full public room and starts another", async () => {
    const buildId = freshBuild();
    const small = await (
      await createRoom(buildId, { capacity: 2, visibility: "public" })
    ).json<CreateRoomResponse>();
    expect(small.room.visibility).toBe("public");
    const hostSocket = await connect(small.host.session.websocketUrl);

    const guest = await (await quickJoin(buildId, "1a1a1a1a1a1a")).json<QuickJoinResponse>();
    expect(guest.role).toBe("guest");
    expect(guest.room.id).toBe(small.room.id);

    const overflow = await (await quickJoin(buildId, "1b1b1b1b1b1b")).json<QuickJoinResponse>();
    expect(overflow.role).toBe("host");
    expect(overflow.room.id).not.toBe(small.room.id);

    hostSocket.close(1000, "test complete");
  });

  it("drops a closed room from the directory", async () => {
    const buildId = freshBuild();
    const first = await (await quickJoin(buildId, "1c1c1c1c1c1c")).json<QuickJoinResponse>();
    if (first.role !== "host") throw new Error("expected host");
    const closed = await exports.default.fetch(
      new Request(`${API_ORIGIN}/v1/rooms/${first.room.id}`, {
        body: JSON.stringify({ ticket: first.host.ticket }),
        headers: { "Content-Type": "application/json", Origin: GAME_ORIGIN },
        method: "DELETE",
      }),
    );
    expect(closed.status).toBe(204);
    expect(await directoryEntries(buildId)).toEqual([]);

    const next = await (await quickJoin(buildId, "1d1d1d1d1d1d")).json<QuickJoinResponse>();
    expect(next.role).toBe("host");
    expect(next.room.id).not.toBe(first.room.id);
  });

  it("keeps a player who is already in a room from being split off", async () => {
    const buildId = freshBuild();
    const first = await (await quickJoin(buildId, "1e1e1e1e1e1e")).json<QuickJoinResponse>();
    if (first.role !== "host") throw new Error("expected host");
    const hostSocket = await connect(first.host.session.websocketUrl);
    const again = await quickJoin(buildId, "1e1e1e1e1e1e");
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "IDENTIFIER_IN_USE" } });
    hostSocket.close(1000, "test complete");
  });

  it("validates lobby settings and visibility on room creation", async () => {
    const buildId = freshBuild();
    expect((await createRoom(buildId, { visibility: "hidden" })).status).toBe(400);
    expect((await createRoom(buildId, { lobby: { mapIndex: 13, modeIndex: 0 } })).status).toBe(400);
    const response = await createRoom(buildId, {
      lobby: { mapIndex: 4, modeIndex: 2 },
      visibility: "public",
    });
    expect(response.status).toBe(201);
    const body = await response.json<CreateRoomResponse>();
    expect(body.room.lobby).toEqual({ mapIndex: 4, modeIndex: 2 });
    const joined = await (await quickJoin(buildId, "2a2a2a2a2a2a")).json<QuickJoinResponse>();
    expect(joined.role).toBe("guest");
    expect(joined.room.lobby).toEqual({ mapIndex: 4, modeIndex: 2 });
  });

  it("requires the service credential for a dedicated host and ranks it first", async () => {
    const buildId = freshBuild();
    const denied = await createRoom(buildId, { dedicated: true });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "DEDICATED_HOST_UNAUTHORIZED" } });

    const wrongToken = await createRoom(buildId, { dedicated: true }, {
      Authorization: "Bearer not-the-service-token-at-all-really",
    });
    expect(wrongToken.status).toBe(403);

    /* A browser-hosted public room exists first and has a player in it. */
    const browserHosted = await (await quickJoin(buildId, "2b2b2b2b2b2b")).json<QuickJoinResponse>();
    if (browserHosted.role !== "host") throw new Error("expected host");
    const browserSocket = await connect(browserHosted.host.session.websocketUrl);

    const before = Date.now();
    const dedicated = await createRoom(
      buildId,
      { dedicated: true, identifier: "2c2c2c2c2c2c" },
      { Authorization: `Bearer ${HOST_SERVICE_TOKEN}` },
    );
    expect(dedicated.status).toBe(201);
    const dedicatedBody = await dedicated.json<CreateRoomResponse>();
    expect(dedicatedBody.room.dedicated).toBe(true);
    expect(dedicatedBody.room.visibility).toBe("public");
    expect(dedicatedBody.room.expiresAt).toBeGreaterThanOrEqual(before + 86_400_000 - 5_000);
    const dedicatedSocket = await connect(dedicatedBody.host.session.websocketUrl);

    const entries = await directoryEntries(buildId);
    expect(entries).toEqual(expect.arrayContaining([
      { players: 1, roomId: browserHosted.room.id },
      { players: 0, roomId: dedicatedBody.room.id },
    ]));

    const joined = await (await quickJoin(buildId, "2d2d2d2d2d2d")).json<QuickJoinResponse>();
    expect(joined.role).toBe("guest");
    expect(joined.room.id).toBe(dedicatedBody.room.id);

    dedicatedSocket.close(1000, "test complete");
    browserSocket.close(1000, "test complete");
  });

  it("lists open public rooms with their players before anyone joins", async () => {
    const buildId = freshBuild();
    const listUrl = `${API_ORIGIN}/v1/lobbies?buildId=${buildId}`;
    const list = async (): Promise<{ lobbies: Array<Record<string, unknown>> }> =>
      (await exports.default.fetch(new Request(listUrl, { headers: { Origin: GAME_ORIGIN } }))).json();
    expect((await list()).lobbies).toEqual([]);

    const room = await (await quickJoin(buildId, "4a4a4a4a4a4a")).json<QuickJoinResponse>();
    if (room.role !== "host") throw new Error("expected host");
    const hostSocket = await connect(room.host.session.websocketUrl);
    hostSocket.send(JSON.stringify({ profile: { name: "Chief", style: "red" }, type: "profile", v: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await list()).lobbies).toEqual([
      {
        capacity: 128,
        dedicated: false,
        mapIndex: 9,
        matchState: null,
        modeIndex: 0,
        names: [{ host: true, name: "Chief", style: "red" }],
        players: 1,
      },
    ]);
    expect(JSON.stringify(await list())).not.toContain(room.room.id);

    const bad = await exports.default.fetch(new Request(`${API_ORIGIN}/v1/lobbies?buildId=bad%20id`, {
      headers: { Origin: GAME_ORIGIN },
    }));
    expect(bad.status).toBe(400);
    hostSocket.close(1000, "test complete");
  });

  it("relays the host's match countdown to guests and refuses it from guests", async () => {
    const buildId = freshBuild();
    const room = await (await quickJoin(buildId, "5a5a5a5a5a5a")).json<QuickJoinResponse>();
    if (room.role !== "host") throw new Error("expected host");
    const host = await connect(room.host.session.websocketUrl);
    const joined = await (await quickJoin(buildId, "5b5b5b5b5b5b")).json<QuickJoinResponse>();
    if (joined.role !== "guest") throw new Error("expected guest");
    const guest = await connect(joined.session.websocketUrl);
    const received = new Promise<Record<string, unknown>>((resolve) => {
      guest.addEventListener("message", (event) => {
        const value = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (value.type === "match") resolve(value);
      });
    });
    host.send(JSON.stringify({ startsIn: 12, state: "countdown", type: "match", v: 1 }));
    expect(await received).toEqual({ startsIn: 12, state: "countdown", type: "match", v: 1 });

    const refused = new Promise<Record<string, unknown>>((resolve) => {
      guest.addEventListener("message", (event) => {
        const value = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (value.type === "error") resolve(value);
      });
    });
    guest.send(JSON.stringify({ state: "ingame", type: "match", v: 1 }));
    expect(await refused).toMatchObject({ code: "MATCH_FORBIDDEN" });

    const waiting = new Promise<Record<string, unknown>>((resolve) => {
      host.addEventListener("message", (event) => {
        const value = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (value.type === "waiting") resolve(value);
      });
    });
    guest.send(JSON.stringify({ type: "waiting", v: 1 }));
    expect(await waiting).toEqual({ from: joined.session.peerId, type: "waiting", v: 1 });
    guest.close(1000, "test complete");
    host.close(1000, "test complete");
  });

  it("lets the host renew a room and refuses a wrong ticket", async () => {
    const buildId = freshBuild();
    const room = await (await createRoom(buildId, { visibility: "public" })).json<CreateRoomResponse>();
    const wrong = await exports.default.fetch(
      jsonRequest(`/v1/rooms/${room.room.id}/renew`, { ticket: "A".repeat(43) }),
    );
    expect(wrong.status).toBe(404);

    const before = Date.now();
    const renewed = await exports.default.fetch(
      jsonRequest(`/v1/rooms/${room.room.id}/renew`, { ticket: room.host.ticket }),
    );
    expect(renewed.status).toBe(200);
    const body = await renewed.json<RenewRoomResponse>();
    expect(body.room.id).toBe(room.room.id);
    expect(body.room.expiresAt).toBeGreaterThanOrEqual(room.room.expiresAt);
    expect(body.room.expiresAt).toBeGreaterThanOrEqual(before + 21_600_000 - 5_000);

    const dedicatedRenewal = await exports.default.fetch(
      jsonRequest(
        `/v1/rooms/${room.room.id}/renew`,
        { ticket: room.host.ticket },
        { Authorization: `Bearer ${HOST_SERVICE_TOKEN}` },
      ),
    );
    expect(dedicatedRenewal.status).toBe(200);
    const longer = await dedicatedRenewal.json<RenewRoomResponse>();
    expect(longer.room.expiresAt).toBeGreaterThanOrEqual(before + 86_400_000 - 5_000);
  });

  it("lets a renewal change the lobby the room advertises", async () => {
    const buildId = freshBuild();
    const room = await (await createRoom(buildId, { visibility: "public" })).json<CreateRoomResponse>();
    const hostSocket = await connect(room.host.session.websocketUrl);
    const bad = await exports.default.fetch(
      jsonRequest(`/v1/rooms/${room.room.id}/renew`, {
        lobby: { mapIndex: 2, modeIndex: 9 },
        ticket: room.host.ticket,
      }),
    );
    expect(bad.status).toBe(400);

    const renewed = await exports.default.fetch(
      jsonRequest(`/v1/rooms/${room.room.id}/renew`, {
        lobby: { mapIndex: 5, modeIndex: 1 },
        ticket: room.host.ticket,
      }),
    );
    expect(renewed.status).toBe(200);
    expect((await renewed.json<RenewRoomResponse>()).room.lobby).toEqual({ mapIndex: 5, modeIndex: 1 });

    const joined = await (await quickJoin(buildId, "3a3a3a3a3a3a")).json<QuickJoinResponse>();
    expect(joined.role).toBe("guest");
    expect(joined.room.lobby).toEqual({ mapIndex: 5, modeIndex: 1 });
    const entries = await env.LOBBY_DIRECTORY.getByName(LOBBY_DIRECTORY_NAME).list(Date.now());
    const entry = entries.find((candidate) => candidate.roomId === room.room.id);
    expect(entry).toMatchObject({ mapIndex: 5, modeIndex: 1 });
    hostSocket.close(1000, "test complete");
  });
  it("stops offering a dedicated server whose lease has lapsed", async () => {
    const buildId = freshBuild();
    const directory = env.LOBBY_DIRECTORY.getByName(LOBBY_DIRECTORY_NAME);
    const now = Date.now();
    const entry = (roomId: string, hostSeenAt: number): LobbyEntry => dedicatedEntry(buildId, roomId, hostSeenAt, now);
    /* a crashed server: its socket still looks open, but it stopped pinging */
    await directory.upsert(entry("lapsed-room", now - DEDICATED_HOST_LEASE_MS - 1_000), now);
    await directory.upsert(entry("leased-room", now - 5_000), now);
    const offered = (await directory.candidates(buildId, 1, now)).map(({ roomId }) => roomId);
    expect(offered).toEqual(["leased-room"]);
  });

  it("offers the fullest server with places to spare, mid-match or not, and lists both", async () => {
    const buildId = freshBuild();
    const directory = env.LOBBY_DIRECTORY.getByName(LOBBY_DIRECTORY_NAME);
    const now = Date.now();
    /* a server mid-match takes players in progress: the fuller one first */
    await directory.upsert({ ...dedicatedEntry(buildId, "busy-room", now, now - 900_000),
      matchState: "ingame", players: 4 }, now);
    await directory.upsert({ ...dedicatedEntry(buildId, "idle-room", now, now),
      matchState: "lobby", colo: "LAX" }, now);
    const offered = (await directory.candidates(buildId, 1, now)).map(({ roomId }) => roomId);
    expect(offered).toEqual(["busy-room", "idle-room"]);
    /* nearly full (within the spare places): the other one first */
    await directory.upsert({ ...dedicatedEntry(buildId, "busy-room", now, now - 900_000),
      matchState: "ingame", players: 12 }, now);
    expect((await directory.candidates(buildId, 1, now)).map(({ roomId }) => roomId)).toEqual(["idle-room", "busy-room"]);
    await directory.upsert({ ...dedicatedEntry(buildId, "busy-room", now, now - 900_000),
      matchState: "ingame", players: 4 }, now);

    const response = await exports.default.fetch(new Request(`${API_ORIGIN}/v1/servers`, {
      headers: { Origin: GAME_ORIGIN, "CF-Connecting-IP": "203.0.113.77" },
    }));
    expect(response.status).toBe(200);
    const body = await response.json<{ servers: Array<Record<string, unknown>> }>();
    expect(body.servers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "idle-room", colo: "LAX", live: true, matchState: "lobby" }),
      expect.objectContaining({ name: "busy-room", live: true, matchState: "ingame", players: 4 }),
    ]));
  });
});

function dedicatedEntry(buildId: string, roomId: string, hostSeenAt: number, now: number): LobbyEntry {
  return {
    buildId, capacity: 16, colo: "", createdAt: now - 600_000, dedicated: true, expiresAt: now + 3_600_000,
    hostConnected: true, hostSeenAt, mapIndex: 5, matchSince: 0, matchState: "", modeIndex: 0, names: [],
    players: 0, protocolVersion: 1, roomId,
  };
}
