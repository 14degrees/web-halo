import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const API_ORIGIN = "http://signaling.test";
const GAME_ORIGIN = "http://127.0.0.1:8765";
const HOST_SERVICE_TOKEN = "test-only-host-service-token-32-bytes-min";
const SERVER = { Authorization: `Bearer ${HOST_SERVICE_TOKEN}` };

let nextBuild = 0;
let nextAddress = 0;

/* Each test has its own build, so the singleton matchmaker never mixes one
   test's players or servers with another's. */
function freshBuild(): string {
  nextBuild += 1;
  return `matchmaker-test-build-${nextBuild}`;
}

function identifier(index: number): string {
  return index.toString(16).padStart(12, "0");
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

function enqueue(buildId: string, machine: number, playlist = "duel") {
  return call("POST", "/v1/queue", { protocolVersion: 1, buildId, identifier: identifier(machine), playlist });
}

async function registerServer(buildId: string): Promise<string> {
  const result = await call("POST", "/v1/pool/servers", { buildId }, SERVER);
  expect(result.status).toBe(201);
  return result.body.serverId as string;
}

describe("matchmaker", () => {
  it("groups two players onto one server and hands them its room", async () => {
    const buildId = freshBuild();
    const serverId = await registerServer(buildId);
    const first = await enqueue(buildId, 0x101);
    expect(first.status).toBe(201);
    expect(first.body.ticket.state).toBe("queued");
    const second = await enqueue(buildId, 0x102);
    /* a duel forms as soon as two are queued and a server is idle */
    expect(second.body.ticket.state).toBe("assigning");

    const beat = await call("POST", `/v1/pool/servers/${serverId}/heartbeat`, {}, SERVER);
    expect(beat.body.assignment).toMatchObject({ playlist: "duel" });
    expect([...beat.body.assignment.roster].sort()).toEqual([identifier(0x101), identifier(0x102)]);
    const matchId = beat.body.assignment.matchId as string;

    /* the players have no invite until the room is open */
    let poll = await call("GET", `/v1/queue/${first.body.ticket.id}`);
    expect(poll.body.ticket.state).toBe("assigning");
    expect(poll.body.ticket.match.inviteCode).toBeNull();

    const roomId = "ABCD-EFGH-JKMN-PQRS_" + "a".repeat(43);
    const ready = await call("POST", `/v1/pool/servers/${serverId}/matches/${matchId}/ready`,
      { roomId, inviteCode: "invite-code" }, SERVER);
    expect(ready.status).toBe(200);
    poll = await call("GET", `/v1/queue/${second.body.ticket.id}`);
    expect(poll.body.ticket).toMatchObject({ state: "ready", match: { inviteCode: "invite-code", players: 2 } });

    const ended = await call("POST", `/v1/pool/servers/${serverId}/matches/${matchId}/end`,
      { reason: "finished" }, SERVER);
    expect(ended.status).toBe(200);
    poll = await call("GET", `/v1/queue/${first.body.ticket.id}`);
    expect(poll.body.ticket).toMatchObject({ state: "ended", match: { endReason: "finished" } });
    /* the server left the pool when its match ended */
    expect((await call("POST", `/v1/pool/servers/${serverId}/heartbeat`, {}, SERVER)).status).toBe(404);
  });

  it("waits for a server, and keeps players queued meanwhile", async () => {
    const buildId = freshBuild();
    await enqueue(buildId, 0x201);
    const second = await enqueue(buildId, 0x202);
    expect(second.body.ticket).toMatchObject({ state: "queued", queued: 2 });
    await registerServer(buildId);
    const poll = await call("GET", `/v1/queue/${second.body.ticket.id}`);
    expect(poll.body.ticket.state).toBe("assigning");
  });

  it("gives one machine one ticket, and a refreshed page its match back", async () => {
    const buildId = freshBuild();
    const first = await enqueue(buildId, 0x301);
    const again = await enqueue(buildId, 0x301);
    expect(again.body.ticket.id).not.toBe(first.body.ticket.id);
    expect((await call("GET", `/v1/queue/${first.body.ticket.id}`)).body.ticket.state).toBe("cancelled");

    await registerServer(buildId);
    await enqueue(buildId, 0x302);
    const refreshed = await enqueue(buildId, 0x301);
    expect(refreshed.body.ticket.id).toBe(again.body.ticket.id);
    expect(refreshed.body.ticket.state).toBe("assigning");
  });

  it("puts players back in the queue when their server never opens a room", async () => {
    const buildId = freshBuild();
    const serverId = await registerServer(buildId);
    const first = await enqueue(buildId, 0x401);
    await enqueue(buildId, 0x402);
    const stub = env.MATCHMAKER.getByName("main");
    /* thirty-one seconds on: the assignment has timed out */
    const later = Date.now() + 31_000;
    const view = await stub.poll(first.body.ticket.id as string, later);
    expect(view?.state).toBe("queued");
    expect((await stub.heartbeat({ serverId, now: later })).known).toBe(false);
  });

  it("refuses pool calls without the service credential and unknown playlists", async () => {
    const buildId = freshBuild();
    expect((await call("POST", "/v1/pool/servers", { buildId })).status).toBe(403);
    expect((await enqueue(buildId, 0x501, "ranked")).status).toBe(400);
  });

  it("forms a free-for-all after its fill window with fewer than eight", async () => {
    const buildId = freshBuild();
    await registerServer(buildId);
    const first = await enqueue(buildId, 0x601, "ffa");
    await enqueue(buildId, 0x602, "ffa");
    expect((await call("GET", `/v1/queue/${first.body.ticket.id}`)).body.ticket.state).toBe("queued");
    const view = await env.MATCHMAKER.getByName("main").poll(first.body.ticket.id as string, Date.now() + 11_000);
    expect(view?.state).toBe("assigning");
  });

  it("queues a player who left a live match for the next one", async () => {
    const buildId = freshBuild();
    const serverId = await registerServer(buildId);
    const first = await enqueue(buildId, 0x701);
    await enqueue(buildId, 0x702);
    const beat = await call("POST", `/v1/pool/servers/${serverId}/heartbeat`, {}, SERVER);
    const matchId = beat.body.assignment.matchId as string;
    await call("POST", `/v1/pool/servers/${serverId}/matches/${matchId}/ready`,
      { roomId: "ABCD-EFGH-JKMN-PQRS_" + "b".repeat(43), inviteCode: "invite" }, SERVER);
    await call("POST", `/v1/pool/servers/${serverId}/heartbeat`, { matchState: "ingame", players: 2 }, SERVER);
    const back = await enqueue(buildId, 0x701);
    expect(back.body.ticket.id).not.toBe(first.body.ticket.id);
    expect(back.body.ticket.state).toBe("queued");
  });

  it("counts a finished match for each player, by their lasting player ID", async () => {
    const buildId = freshBuild();
    const serverId = await registerServer(buildId);
    const enqueueAs = (machine: number, playerKey: string) => call("POST", "/v1/queue",
      { protocolVersion: 1, buildId, identifier: identifier(machine), playlist: "duel", playerKey });
    await enqueueAs(0x801, "player-key-aaaaaaaaaaaa");
    await enqueueAs(0x802, "player-key-bbbbbbbbbbbb");
    const beat = await call("POST", `/v1/pool/servers/${serverId}/heartbeat`, {}, SERVER);
    const matchId = beat.body.assignment.matchId as string;
    const stub = env.MATCHMAKER.getByName("main");
    expect(await stub.matchesFor(identifier(0x801))).toBe(0);
    await call("POST", `/v1/pool/servers/${serverId}/matches/${matchId}/ready`,
      { roomId: "ABCD-EFGH-JKMN-PQRS_" + "c".repeat(43), inviteCode: "invite" }, SERVER);
    await call("POST", `/v1/pool/servers/${serverId}/matches/${matchId}/end`, { reason: "finished" }, SERVER);
    expect(await stub.matchesFor(identifier(0x801))).toBe(1);
    expect(await stub.matchesFor(identifier(0x802))).toBe(1);
    /* the same player on a new page (a new machine) keeps their count */
    await enqueueAs(0x803, "player-key-aaaaaaaaaaaa");
    expect(await stub.matchesFor(identifier(0x803))).toBe(1);
    /* a machine that never queued has no rank */
    expect(await stub.matchesFor(identifier(0x8ff))).toBeNull();
  });

  it("lists the playlists with who is searching in each", async () => {
    const buildId = freshBuild();
    await call("POST", "/v1/queue", { protocolVersion: 1, buildId, identifier: identifier(0x901), playlist: "ctf" });
    const result = await call("GET", "/v1/playlists");
    expect(result.status).toBe(200);
    const ctf = result.body.playlists.find((playlist: { id: string }) => playlist.id === "ctf");
    expect(ctf).toMatchObject({ label: "Team Objective", teams: true, maximum: 8 });
    expect(ctf.modes.every((mode: number) => mode === 2)).toBe(true);
    expect(ctf.searching).toBeGreaterThanOrEqual(1);
  });
});
