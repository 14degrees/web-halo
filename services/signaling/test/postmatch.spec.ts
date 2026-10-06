import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { QuickJoinResponse } from "../src/index";

/* The post-match vote (src/vote.ts): after a server match its players pick
   the next game on their tickets, see the tally, and carry the pick onto
   the ticket they queue with; the matchmaker plays the plurality's game.
   In a player-hosted room the vote goes through the room to the host. */

const API = "http://signaling.test";
const ORIGIN = "http://127.0.0.1:8765";
const SERVER = { Authorization: "Bearer test-only-host-service-token-32-bytes-min" };
let address = 0;
let nextBuild = 0;
let nextMachine = 0x900;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  address += 1;
  const response = await exports.default.fetch(new Request(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": `198.51.100.${address % 250}`, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, body: await response.json<Record<string, any>>() };
}

function freshBuild(): string {
  nextBuild += 1;
  return `postmatch-test-build-${nextBuild}`;
}

function machine(): string {
  nextMachine += 1;
  return nextMachine.toString(16).padStart(12, "0");
}

function enqueue(buildId: string, identifier: string, extra: Record<string, unknown> = {}) {
  return call("POST", "/v1/queue", { protocolVersion: 1, buildId, identifier, playlist: "duel", ...extra });
}

/* a duel on a fresh server, through to its end: the two tickets and the
   match it was */
async function playDuel(buildId: string, first: string, second: string) {
  const serverId = (await call("POST", "/v1/pool/servers", { buildId }, SERVER)).body.serverId as string;
  const one = (await enqueue(buildId, first)).body.ticket.id as string;
  const two = (await enqueue(buildId, second)).body.ticket.id as string;
  const beat = await call("POST", `/v1/pool/servers/${serverId}/heartbeat`, {}, SERVER);
  const matchId = beat.body.assignment.matchId as string;
  const roomId = "ABCD-EFGH-JKMN-PQRS_" + "b".repeat(43);
  await call("POST", `/v1/pool/servers/${serverId}/matches/${matchId}/ready`, { roomId, inviteCode: "invite" }, SERVER);
  await call("POST", `/v1/pool/servers/${serverId}/matches/${matchId}/end`, { reason: "finished" }, SERVER);
  return { one, two, matchId, mapIndex: beat.body.assignment.mapIndex as number };
}

describe("the post-match vote", () => {
  it("tallies the players' picks on their ended tickets", async () => {
    const buildId = freshBuild();
    const { one, two } = await playDuel(buildId, machine(), machine());
    /* a pick outside the rotation is refused; one in it is kept */
    expect((await call("POST", `/v1/queue/${one}/vote`, { mapIndex: 9, modeIndex: 0 })).status).toBe(409);
    expect((await call("POST", `/v1/queue/${one}/vote`, { mapIndex: 6 })).status).toBe(400);
    expect((await call("POST", `/v1/queue/nobody-has-this-ticket-0001/vote`, { mapIndex: 6, modeIndex: 0 })).status).toBe(404);
    const voted = await call("POST", `/v1/queue/${one}/vote`, { mapIndex: 6, modeIndex: 0 });
    expect(voted.status).toBe(200);
    expect(voted.body.ticket).toMatchObject({ state: "ended", vote: { mapIndex: 6, modeIndex: 0 } });
    expect(voted.body.ticket.match.votes).toEqual([{ mapIndex: 6, modeIndex: 0, votes: 1 }]);
    /* the other player sees the tally on their own ticket, and adds to it */
    await call("POST", `/v1/queue/${two}/vote`, { mapIndex: 10, modeIndex: 0 });
    const theirs = await call("GET", `/v1/queue/${two}`);
    expect(theirs.body.ticket.vote).toEqual({ mapIndex: 10, modeIndex: 0 });
    expect(theirs.body.ticket.match.votes).toEqual([
      { mapIndex: 6, modeIndex: 0, votes: 1 }, { mapIndex: 10, modeIndex: 0, votes: 1 },
    ]);
    /* a change of mind replaces the pick */
    await call("POST", `/v1/queue/${two}/vote`, { mapIndex: 6, modeIndex: 0 });
    expect((await call("GET", `/v1/queue/${one}`)).body.ticket.match.votes).toEqual([{ mapIndex: 6, modeIndex: 0, votes: 2 }]);
  });

  it("plays the plurality's game when the voters queue again", async () => {
    const buildId = freshBuild();
    const first = machine();
    const second = machine();
    await playDuel(buildId, first, second);
    /* both carry Wizard onto their new tickets: the next duel is Wizard,
       not the rotation's next */
    const serverId = (await call("POST", "/v1/pool/servers", { buildId }, SERVER)).body.serverId as string;
    const mine = await enqueue(buildId, first, { vote: { mapIndex: 10, modeIndex: 0 } });
    expect(mine.body.ticket.vote).toEqual({ mapIndex: 10, modeIndex: 0 });
    await enqueue(buildId, second, { vote: { mapIndex: 10, modeIndex: 0 } });
    const beat = await call("POST", `/v1/pool/servers/${serverId}/heartbeat`, {}, SERVER);
    expect(beat.body.assignment).toMatchObject({ playlist: "duel", mapIndex: 10, modeIndex: 0 });
    /* a pick the playlist doesn't offer is dropped, so the rotation decides */
    const third = await enqueue(buildId, machine(), { vote: { mapIndex: 9, modeIndex: 0 } });
    expect(third.body.ticket.vote).toBeNull();
    await call("DELETE", `/v1/queue/${third.body.ticket.id}`);
    await call("POST", `/v1/pool/servers/${serverId}/matches/${beat.body.assignment.matchId}/end`, { reason: "void: test over" }, SERVER);
  });

  it("carries a party's pick onto every member's ticket", async () => {
    const buildId = freshBuild();
    const leader = { playerKey: "postmatch-party-leader-key-1", identifier: machine(), profile: { name: "Leader", style: "sage" } };
    const friend = { playerKey: "postmatch-party-friend-key-1", identifier: machine(), profile: { name: "Friend", style: "sage" } };
    const code = (await call("POST", "/v1/parties", { buildId, ...leader, playlist: "duel" })).body.party.code as string;
    await call("POST", `/v1/parties/${code}/join`, friend);
    const serverId = (await call("POST", "/v1/pool/servers", { buildId }, SERVER)).body.serverId as string;
    const started = await call("POST", `/v1/parties/${code}/start`, { ...leader, vote: { mapIndex: 12, modeIndex: 0 } });
    expect(started.status).toBe(200);
    const mine = await call("GET", `/v1/queue/${started.body.party.activity.ticket}`);
    expect(mine.body.ticket.vote).toEqual({ mapIndex: 12, modeIndex: 0 });
    const beat = await call("POST", `/v1/pool/servers/${serverId}/heartbeat`, {}, SERVER);
    expect(beat.body.assignment).toMatchObject({ mapIndex: 12, modeIndex: 0 });
    await call("POST", `/v1/pool/servers/${serverId}/matches/${beat.body.assignment.matchId}/end`, { reason: "void: test over" }, SERVER);
  });

  it("relays a guest's vote to the host and the host's tally to guests", async () => {
    const buildId = freshBuild();
    const quickJoin = (identifier: string) => call("POST", "/v1/quickjoin", { buildId, identifier, protocolVersion: 1 });
    const connect = async (websocketUrl: string): Promise<WebSocket> => {
      const requestUrl = new URL(websocketUrl);
      requestUrl.protocol = "http:";
      const response = await exports.default.fetch(new Request(requestUrl, { headers: { Origin: ORIGIN, Upgrade: "websocket" } }));
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      socket.accept();
      return socket;
    };
    const next = (socket: WebSocket, type: string) => new Promise<Record<string, unknown>>((resolve) => {
      socket.addEventListener("message", (event) => {
        const value = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (value.type === type) resolve(value);
      });
    });
    const room = (await quickJoin(machine())).body as QuickJoinResponse;
    if (room.role !== "host") throw new Error("expected host");
    const host = await connect(room.host.session.websocketUrl);
    const joined = (await quickJoin(machine())).body as QuickJoinResponse;
    if (joined.role !== "guest") throw new Error("expected guest");
    const guest = await connect(joined.session.websocketUrl);

    const tally = next(guest, "match");
    host.send(JSON.stringify({ state: "postgame", type: "match", v: 1, vote: { offers: [[9, 0], [5, 0]], votes: [1, 0] } }));
    expect(await tally).toEqual({ state: "postgame", type: "match", v: 1, vote: { offers: [[9, 0], [5, 0]], votes: [1, 0] } });

    const pick = next(host, "vote");
    guest.send(JSON.stringify({ mapIndex: 5, modeIndex: 0, type: "vote", v: 1 }));
    expect(await pick).toMatchObject({ mapIndex: 5, modeIndex: 0, type: "vote" });
    expect(typeof (await pick).from).toBe("string");

    /* a host doesn't vote; a malformed tally is refused */
    const refused = next(host, "error");
    host.send(JSON.stringify({ mapIndex: 5, modeIndex: 0, type: "vote", v: 1 }));
    expect(await refused).toMatchObject({ code: "VOTE_FORBIDDEN" });
    const invalid = next(host, "error");
    host.send(JSON.stringify({ state: "postgame", type: "match", v: 1, vote: { offers: [[13, 0]], votes: [0] } }));
    expect(await invalid).toMatchObject({ code: "INVALID_MESSAGE" });
    host.close(1000, "test complete");
  });
});
