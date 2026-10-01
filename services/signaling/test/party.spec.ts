import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const API = "http://signaling.test";
const ORIGIN = "http://127.0.0.1:8765";
const SERVER = { Authorization: "Bearer test-only-host-service-token-32-bytes-min" };
let address = 0;
let nextBuild = 0;
let nextMachine = 0x500;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  address += 1;
  const response = await exports.default.fetch(new Request(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": `198.51.100.${address % 250}`, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, body: await response.json<Record<string, any>>() };
}

function player(name: string) {
  nextMachine += 1;
  return {
    playerKey: `party-test-key-${name}-${nextMachine}`,
    identifier: nextMachine.toString(16).padStart(12, "0"),
    profile: { name, style: "sage" },
  };
}

function freshBuild(): string {
  nextBuild += 1;
  return `party-test-build-${nextBuild}`;
}

describe("parties", () => {
  it("are created with a code, joined by it, and show everyone", async () => {
    const buildId = freshBuild();
    const leader = player("Leader");
    const friend = player("Friend");
    const created = await call("POST", "/v1/parties", { buildId, ...leader });
    expect(created.status).toBe(200);
    const code = created.body.party.code as string;
    expect(code).toMatch(/^[A-HJ-KM-NP-Z2-9]{6}$/u);
    expect(created.body.party.leader).toBe(true);

    const joined = await call("POST", `/v1/parties/${code.toLowerCase()}/join`, friend);
    expect(joined.status).toBe(200);
    expect(joined.body.party.leader).toBe(false);
    expect(joined.body.party.members.map((member: { name: string }) => member.name)).toEqual(["Leader", "Friend"]);
    /* nobody sees another member's private key */
    expect(JSON.stringify(joined.body)).not.toContain(leader.playerKey);

    expect((await call("POST", "/v1/parties/ZZZZZZ/join", friend)).status).toBe(404);
  });

  it("let only the leader change settings and start, and pass the lead on", async () => {
    const buildId = freshBuild();
    const leader = player("Leader");
    const friend = player("Friend");
    const code = (await call("POST", "/v1/parties", { buildId, ...leader })).body.party.code as string;
    await call("POST", `/v1/parties/${code}/join`, friend);
    expect((await call("POST", `/v1/parties/${code}/settings`, { ...friend, lobby: "custom" })).status).toBe(403);
    expect((await call("POST", `/v1/parties/${code}/start`, friend)).status).toBe(403);
    const changed = await call("POST", `/v1/parties/${code}/settings`, { ...leader, lobby: "custom", mapIndex: 4, modeIndex: 0 });
    expect(changed.body.party).toMatchObject({ lobby: "custom", mapIndex: 4, modeIndex: 0 });
    await call("POST", `/v1/parties/${code}/leave`, { playerKey: leader.playerKey });
    const after = await call("POST", `/v1/parties/${code}/poll`, friend);
    expect(after.body.party.leader).toBe(true);
    expect(after.body.party.members).toHaveLength(1);
  });

  it("start a custom game on a server of their own", async () => {
    const buildId = freshBuild();
    const leader = player("Leader");
    const friend = player("Friend");
    const code = (await call("POST", "/v1/parties", { buildId, ...leader, lobby: "custom", mapIndex: 6, modeIndex: 0 })).body.party.code;
    /* alone: a custom game needs two */
    expect((await call("POST", `/v1/parties/${code}/start`, leader)).status).toBe(409);
    await call("POST", `/v1/parties/${code}/join`, friend);
    /* no server free yet */
    expect((await call("POST", `/v1/parties/${code}/start`, leader)).status).toBe(503);
    const server = await call("POST", "/v1/pool/servers", { buildId }, SERVER);
    const started = await call("POST", `/v1/parties/${code}/start`, leader);
    expect(started.status).toBe(200);
    expect(started.body.party.activity).toMatchObject({ kind: "custom" });
    const ticket = started.body.party.activity.ticket as string;
    const friendView = await call("POST", `/v1/parties/${code}/poll`, friend);
    expect(friendView.body.party.activity.ticket).not.toBe(ticket);
    const beat = await call("POST", `/v1/pool/servers/${server.body.serverId}/heartbeat`, {}, SERVER);
    expect(beat.body.assignment).toMatchObject({ playlist: "custom", mapIndex: 6, modeIndex: 0 });
    expect(beat.body.assignment.roster).toHaveLength(2);
    expect((await call("GET", `/v1/queue/${ticket}`)).body.ticket.state).toBe("assigning");
  });

  it("queue together and land in one match", async () => {
    const buildId = freshBuild();
    const leader = player("Leader");
    const friend = player("Friend");
    const code = (await call("POST", "/v1/parties", { buildId, ...leader, playlist: "duel" })).body.party.code;
    await call("POST", `/v1/parties/${code}/join`, friend);
    await call("POST", "/v1/pool/servers", { buildId }, SERVER);
    const started = await call("POST", `/v1/parties/${code}/start`, leader);
    expect(started.body.party.activity).toMatchObject({ kind: "queue", playlist: "duel" });
    const mine = await call("GET", `/v1/queue/${started.body.party.activity.ticket}`);
    const theirs = await call("GET", `/v1/queue/${(await call("POST", `/v1/parties/${code}/poll`, friend)).body.party.activity.ticket}`);
    expect(mine.body.ticket.state).toBe("assigning");
    expect(mine.body.ticket.match.id).toBe(theirs.body.ticket.match.id);
  });

  it("refuse a party bigger than the playlist", async () => {
    const buildId = freshBuild();
    const leader = player("Leader");
    const code = (await call("POST", "/v1/parties", { buildId, ...leader, playlist: "duel" })).body.party.code;
    await call("POST", `/v1/parties/${code}/join`, player("Two"));
    await call("POST", `/v1/parties/${code}/join`, player("Three"));
    expect((await call("POST", `/v1/parties/${code}/start`, leader)).status).toBe(409);
  });
});
