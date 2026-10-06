import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { PROFILES_NAME } from "../src/profiles";
import { base58Encode, walletPlayerName } from "../src/solana";
import {
  STATS_NAME,
  guestId,
  outcomeOf,
  resolveMatchPlayers,
  type MatchStatsReport,
} from "../src/stats";

const API_ORIGIN = "http://signaling.test";
const GAME_ORIGIN = "http://127.0.0.1:8765";
const HOST_SERVICE_TOKEN = "test-only-host-service-token-32-bytes-min";
const SERVER = { Authorization: `Bearer ${HOST_SERVICE_TOKEN}` };

let nextBuild = 0;
let nextAddress = 0;
let nextMatch = 0;

function freshBuild(): string {
  nextBuild += 1;
  return `stats-test-build-${nextBuild}`;
}

/* the stats store is a singleton: every test's matches and players are
   its own */
function freshMatch(): string {
  nextMatch += 1;
  return `stats-match-${nextMatch}-${crypto.randomUUID().slice(0, 8)}`;
}

function freshKey(tag: string): string {
  return `${tag}-${crypto.randomUUID().replace(/-/gu, "")}`.slice(0, 48);
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
      "CF-Connecting-IP": `203.0.113.${nextAddress % 250}`,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, body: await response.json<Record<string, any>>() };
}

interface Wallet { address: string; sign(message: string): Promise<string> }

async function newWallet(): Promise<Wallet> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return {
    address: base58Encode(raw),
    async sign(message: string): Promise<string> {
      const signature = await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(message));
      return base58Encode(new Uint8Array(signature));
    },
  };
}

async function signIn(wallet: Wallet): Promise<string> {
  const challenge = await call("POST", "/v1/auth/challenge", { wallet: wallet.address });
  const verify = await call("POST", "/v1/auth/verify", {
    nonce: challenge.body.nonce, signature: await wallet.sign(challenge.body.message), wallet: wallet.address,
  });
  expect(verify.status).toBe(200);
  return verify.body.token as string;
}

function nextMessage(socket: WebSocket, expectedType: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expectedType}.`)), 2_000);
    const listener = (event: MessageEvent): void => {
      if (typeof event.data !== "string") return;
      const value = JSON.parse(event.data) as Record<string, unknown>;
      if (value.type === expectedType) {
        clearTimeout(timeout);
        socket.removeEventListener("message", listener);
        resolve(value);
      }
    };
    socket.addEventListener("message", listener);
  });
}

async function connect(websocketUrl: string): Promise<WebSocket> {
  const requestUrl = new URL(websocketUrl);
  requestUrl.protocol = "http:";
  const response = await exports.default.fetch(new Request(requestUrl, {
    headers: { Origin: GAME_ORIGIN, Upgrade: "websocket" },
  }));
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const welcome = nextMessage(socket, "welcome");
  socket.accept();
  await welcome;
  return socket;
}

/* a result and its matchmaker-side report, two guests on opposite teams */
function teamReport(matchId: string, keys: [string, string], scores: [number, number]): MatchStatsReport {
  return {
    matchId, playlist: "team", mapIndex: 0, modeIndex: 1, teams: true, teamScores: scores, stake: null,
    endedAt: 1_700_000_000_000,
    players: [
      { name: "Red", team: 0, score: scores[0], quit: false, kills: scores[0], deaths: scores[1], wallet: null, playerKey: keys[0] },
      { name: "Blue", team: 1, score: scores[1], quit: false, kills: scores[1], deaths: scores[0], wallet: null, playerKey: keys[1] },
    ],
  };
}

/* the stats land through waitUntil: wait for them */
async function playerSoon(id: string, tries = 40): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const result = await call("GET", `/v1/players/${encodeURIComponent(id)}`);
    if (result.status === 200) return result.body.player;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`No stats for ${id}.`);
}

describe("match outcomes", () => {
  const players = [
    { team: 0, score: 5, quit: false }, { team: 1, score: 3, quit: false }, { team: 1, score: 5, quit: true },
  ];
  it("gives a team match to the higher team score, equal scores a draw", () => {
    const team = { teams: true, teamScores: [10, 7] as [number, number], players };
    expect(outcomeOf(team, players[0]!)).toBe("win");
    expect(outcomeOf(team, players[1]!)).toBe("loss");
    expect(outcomeOf({ ...team, teamScores: [7, 7] }, players[0]!)).toBe("draw");
  });
  it("gives a free-for-all to the top score, shared top scores a draw, a quitter a loss", () => {
    const ffa = { teams: false, teamScores: [0, 0] as [number, number], players };
    expect(outcomeOf(ffa, players[0]!)).toBe("win");
    expect(outcomeOf(ffa, players[1]!)).toBe("loss");
    /* the quitter's five does not count against the winner, and is a loss for them */
    expect(outcomeOf(ffa, players[2]!)).toBe("loss");
    const tied = { ...ffa, players: [players[0]!, { team: 2, score: 5, quit: false }] };
    expect(outcomeOf(tied, players[0]!)).toBe("draw");
  });
});

describe("resolving a result's players", () => {
  const wallet = "7Vt8Rz4mQ2nK9sLx3pWcY5hJ6fBdA1eGuT2rN8kM4qZ";
  const tickets = [
    { identifier: "aaaaaaaaaaaa", wallet: null, playerKey: "guest-key-aaaaaaaaaaaaaa" },
    { identifier: "bbbbbbbbbbbb", wallet, playerKey: "guest-key-bbbbbbbbbbbbbb" },
    { identifier: "cccccccccccc", wallet: null, playerKey: null },
  ];
  const result = {
    teams: false, teamScores: [0, 0] as [number, number],
    players: [
      { name: "Alpha", team: 0, score: 4, quit: false },
      { name: walletPlayerName(wallet), team: 1, score: 2, quit: false },
      { name: "Nobody", team: 2, score: 1, quit: false },
      { name: "Twin", team: 3, score: 1, quit: false },
    ],
  };
  it("joins names to tickets through the room's seats, or by a wallet's name without them", () => {
    const roster = {
      seats: [
        { identifier: "AAAAAAAAAAAA", name: "Alpha", wallet: null },
        { identifier: "cccccccccccc", name: "Nobody", wallet: null },
        { identifier: "dddddddddddd", name: "Twin", wallet: null },
        { identifier: "eeeeeeeeeeee", name: "Twin", wallet: null },
      ],
      kills: [{ name: "Alpha", kills: 4, deaths: 3 }, { name: "Twin", kills: 1, deaths: 2 }],
    };
    const players = resolveMatchPlayers(result, tickets, roster);
    expect(players).toEqual([
      { name: "Alpha", team: 0, score: 4, quit: false, kills: 4, deaths: 3, wallet: null, playerKey: "guest-key-aaaaaaaaaaaaaa" },
      /* no seat (the wallet player's room profile never arrived) and no
         kills counted, so the score stands in for kills */
      { name: walletPlayerName(wallet), team: 1, score: 2, quit: false, kills: 2, deaths: 0, wallet, playerKey: "guest-key-bbbbbbbbbbbbbb" },
    ]);
    /* "Nobody" has a ticket with no identity; "Twin" was two players */
    expect(players.map((player) => player.name)).not.toContain("Nobody");
    expect(players.map((player) => player.name)).not.toContain("Twin");
  });
  it("takes a seat's wallet over the ticket's", () => {
    const roster = { seats: [{ identifier: "aaaaaaaaaaaa", name: "Alpha", wallet }], kills: [] };
    expect(resolveMatchPlayers(result, tickets, roster)[0]).toMatchObject({ name: "Alpha", wallet });
  });
});

describe("the stats store", () => {
  const stats = () => env.STATS.getByName(STATS_NAME);

  it("records a match once, whatever is reported again", async () => {
    const matchId = freshMatch();
    const keys: [string, string] = [freshKey("once-a"), freshKey("once-b")];
    const report = teamReport(matchId, keys, [50, 31]);
    expect(await stats().recordMatch(report)).toBe(true);
    expect(await stats().recordMatch(report)).toBe(false);
    expect(await stats().recordMatch({ ...report, teamScores: [0, 50] })).toBe(false);
    const red = await stats().player({ key: `guest:${await guestId(keys[0])}` });
    expect(red).toMatchObject({
      identity: "guest", verified: true, name: "Red", matches: 1, wins: 1, losses: 0, draws: 0, quits: 0,
      kills: 50, deaths: 31, score: 50, kd: 1.61, wagered: 0, wagerNet: 0,
    });
    expect(red!.id).toMatch(/^[0-9a-f]{16}$/u);
    expect(red!.recent).toEqual([expect.objectContaining({
      matchId, playlist: "team", teams: true, team: 0, score: 50, kills: 50, deaths: 31, outcome: "win", quit: false, wagerNet: null,
    })]);
    const blue = await stats().player({ key: `guest:${await guestId(keys[1])}` });
    expect(blue).toMatchObject({ matches: 1, wins: 0, losses: 1, kills: 31, deaths: 50 });
  });

  it("folds a guest's record into their wallet, and a wallet's into their username", async () => {
    const playerKey = freshKey("grow");
    const wallet = (await newWallet()).address;
    /* a guest match */
    await stats().recordMatch(teamReport(freshMatch(), [playerKey, freshKey("grow-other")], [50, 20]));
    const asGuest = await stats().player({ key: `guest:${await guestId(playerKey)}` });
    expect(asGuest).toMatchObject({ identity: "guest", matches: 1, kills: 50 });
    /* the same browser signs in: its record moves to the wallet */
    const second = teamReport(freshMatch(), [playerKey, freshKey("grow-other")], [10, 50]);
    second.players[0]!.wallet = wallet;
    second.players[0]!.name = walletPlayerName(wallet);
    await stats().recordMatch(second);
    expect(await stats().player({ key: `guest:${await guestId(playerKey)}` })).toBeNull();
    const asWallet = await stats().player({ key: `wallet:${wallet}` });
    expect(asWallet).toMatchObject({
      identity: "wallet", id: wallet, name: walletPlayerName(wallet), matches: 2, wins: 1, losses: 1, kills: 60, deaths: 70,
    });
    expect(asWallet!.recent).toHaveLength(2);
    /* the wallet claims a username: the record follows it, and is found by name */
    const username = `Grow${playerKey.slice(5, 11)}`.replace(/[^A-Za-z0-9]/gu, "x").slice(0, 11);
    const claimed = await env.PROFILES.getByName(PROFILES_NAME)
      .claimUsername(wallet, username, username.toLowerCase(), Date.now());
    expect("profile" in claimed).toBe(true);
    const third = teamReport(freshMatch(), [playerKey, freshKey("grow-other")], [50, 50]);
    third.players[0]!.wallet = wallet;
    await stats().recordMatch(third);
    expect(await stats().player({ key: `wallet:${wallet}` })).toBeNull();
    const named = await call("GET", `/v1/players/@${username}`);
    expect(named.status).toBe(200);
    expect(named.body.player).toMatchObject({
      identity: "username", id: username, name: username, matches: 3, wins: 1, losses: 1, draws: 1, kills: 110,
    });
    /* and by the wallet, which now stands for the profile */
    expect((await call("GET", `/v1/players/${wallet}`)).body.player.id).toBe(username);
    expect(named.body.player.ranks.kills).toBeGreaterThanOrEqual(1);
  });

  it("counts a wager's settlement once, before or after the match's report", async () => {
    const wallets = [(await newWallet()).address, (await newWallet()).address];
    const first = freshMatch();
    /* the settlement lands first */
    expect(await stats().recordWagerNet(first, [{ wallet: wallets[0]!, net: 900 }, { wallet: wallets[1]!, net: -1000 }])).toBe(true);
    expect(await stats().recordWagerNet(first, [{ wallet: wallets[0]!, net: 900 }, { wallet: wallets[1]!, net: -1000 }])).toBe(false);
    const report = teamReport(first, [freshKey("w"), freshKey("w")], [50, 10]);
    report.stake = 1000;
    report.players[0]!.wallet = wallets[0]!;
    report.players[1]!.wallet = wallets[1]!;
    await stats().recordMatch(report);
    const winner = await stats().player({ key: `wallet:${wallets[0]}` });
    expect(winner).toMatchObject({ matches: 1, wagered: 1, wagerNet: 900 });
    /* the line of a match recorded after its settlement has no net; one
       recorded before it gets the net */
    expect(winner!.recent[0]!.wagerNet).toBeNull();
    const second = freshMatch();
    const again = teamReport(second, [freshKey("w"), freshKey("w")], [10, 50]);
    again.players[0]!.wallet = wallets[0]!;
    again.players[1]!.wallet = wallets[1]!;
    await stats().recordMatch(again);
    await stats().recordWagerNet(second, [{ wallet: wallets[0]!, net: -1000 }, { wallet: wallets[1]!, net: 900 }]);
    const after = await stats().player({ key: `wallet:${wallets[0]}` });
    expect(after).toMatchObject({ matches: 2, wagered: 2, wagerNet: -100 });
    expect(after!.recent.find((line) => line.matchId === second)!.wagerNet).toBe(-1000);
  });

  it("sorts and pages the leaderboard, and refuses bad queries", async () => {
    const keys = [freshKey("lb-a"), freshKey("lb-b"), freshKey("lb-c")];
    await stats().recordMatch(teamReport(freshMatch(), [keys[0]!, keys[1]!], [50, 3]));
    await stats().recordMatch(teamReport(freshMatch(), [keys[2]!, keys[1]!], [50, 2]));
    const all = await call("GET", "/v1/leaderboard?sort=kills&limit=100");
    expect(all.status).toBe(200);
    expect(all.body.leaderboard).toMatchObject({ sort: "kills", order: "desc", limit: 100, offset: 0, source: "dedicated" });
    const ids = await Promise.all(keys.map(guestId));
    const entries = all.body.leaderboard.entries as Array<{ id: string; rank: number; kills: number }>;
    const ranks = ids.map((id) => entries.find((entry) => entry.id === id)!);
    expect(ranks.every(Boolean)).toBe(true);
    expect(ranks[0]!.kills).toBe(50);
    expect(ranks[1]!.kills).toBe(5);
    expect(ranks[0]!.rank).toBeLessThan(ranks[1]!.rank);
    entries.forEach((entry, index) => {
      expect(entry.rank).toBe(index + 1);
      if (index > 0) expect(entries[index - 1]!.kills).toBeGreaterThanOrEqual(entry.kills);
    });
    /* pages do not overlap, and carry their ranks */
    const page1 = (await call("GET", "/v1/leaderboard?sort=matches&limit=1&offset=0")).body.leaderboard;
    const page2 = (await call("GET", "/v1/leaderboard?sort=matches&limit=1&offset=1")).body.leaderboard;
    expect(page1.entries).toHaveLength(1);
    expect(page2.entries[0].rank).toBe(2);
    expect(page1.entries[0].id).not.toBe(page2.entries[0].id);
    expect(page1.total).toBe(page2.total);
    expect(page1.entries[0].matches).toBeGreaterThanOrEqual(page2.entries[0].matches);
    /* the wager column lists only players who wagered */
    const net = (await call("GET", "/v1/leaderboard?sort=net&limit=100")).body.leaderboard;
    expect(net.entries.every((entry: { wagered: number }) => entry.wagered > 0)).toBe(true);
    expect((await call("GET", "/v1/leaderboard?sort=luck")).status).toBe(400);
    expect((await call("GET", "/v1/leaderboard?limit=0")).status).toBe(400);
    expect((await call("GET", "/v1/leaderboard?limit=101")).status).toBe(400);
    expect((await call("GET", "/v1/leaderboard?order=sideways")).status).toBe(400);
    expect((await call("GET", "/v1/players/nobody-at-all-ever-played-here")).status).toBe(404);
    expect((await call("GET", "/v1/players/@nosuchname")).status).toBe(404);
    expect((await call("GET", "/v1/players/!!")).status).toBe(404);
    expect((await call("POST", "/v1/leaderboard", {})).status).toBe(404);
  });
});

describe("a dedicated server's match", () => {
  it("lands in its players' records: a wallet by its name, a guest through the room's seats and kills", async () => {
    const buildId = freshBuild();
    const registered = await call("POST", "/v1/pool/servers", { buildId }, SERVER);
    const serverId = registered.body.serverId as string;
    const wallet = await newWallet();
    const walletToken = await signIn(wallet);
    const walletName = walletPlayerName(wallet.address);
    const guestKey = freshKey("seat");
    const queuedWallet = await call("POST", "/v1/queue", {
      protocolVersion: 1, buildId, identifier: identifier(0xa01), playlist: "duel", walletToken, playerKey: freshKey("wk"),
    });
    expect(queuedWallet.status).toBe(201);
    const queuedGuest = await call("POST", "/v1/queue", {
      protocolVersion: 1, buildId, identifier: identifier(0xa02), playlist: "duel", playerKey: guestKey,
    });
    expect(queuedGuest.body.ticket.state).toBe("assigning");
    const beat = await call("POST", `/v1/pool/servers/${serverId}/heartbeat`, {}, SERVER);
    const matchId = beat.body.assignment.matchId as string;

    /* the server's room: the guest takes a seat under the name they play
       under, and the server reports the kills */
    const created = await call("POST", "/v1/rooms", {
      buildId, capacity: 4, dedicated: true, identifier: identifier(0xa00), protocolVersion: 1,
    }, SERVER);
    expect(created.status).toBe(201);
    const roomId = created.body.room.id as string;
    const host = await connect(created.body.host.session.websocketUrl as string);
    const guestTicket = (created.body.invite.code as string).split(".")[1]!;
    const session = await call("POST", `/v1/rooms/${roomId}/sessions`, {
      buildId, identifier: identifier(0xa02), protocolVersion: 1, ticket: guestTicket,
    });
    expect(session.status).toBe(201);
    const guest = await connect(session.body.session.websocketUrl as string);
    const seated = nextMessage(host, "roster");
    guest.send(JSON.stringify({ profile: { name: "BlueGuest", style: "blue" }, type: "profile", v: 1 }));
    await seated;
    for (const [killer, victim] of [[walletName, "BlueGuest"], [walletName, "BlueGuest"], ["BlueGuest", walletName]]) {
      host.send(JSON.stringify({ killer, type: "kill", v: 1, victim }));
    }
    /* the room handles its messages in order: a roster after the kills
       means they are counted */
    const counted = nextMessage(guest, "roster");
    host.send(JSON.stringify({ profile: { name: "Server", style: "sage" }, type: "profile", v: 1 }));
    await counted;
    expect(await env.ROOMS.getByName(roomId).matchRoster()).toEqual({
      seats: [{ identifier: identifier(0xa02), name: "BlueGuest", wallet: null }],
      kills: [{ name: "BlueGuest", kills: 1, deaths: 2 }, { name: walletName, kills: 2, deaths: 1 }].sort((a, b) => a.name < b.name ? -1 : 1),
    });

    const ready = await call("POST", `/v1/pool/servers/${serverId}/matches/${matchId}/ready`,
      { roomId, inviteCode: created.body.invite.code }, SERVER);
    expect(ready.status).toBe(200);
    const ended = await call("POST", `/v1/pool/servers/${serverId}/matches/${matchId}/end`, {
      reason: "finished",
      result: {
        teams: false, teamScores: [0, 0],
        players: [
          { name: walletName, team: 0, score: 2, quit: false },
          { name: "BlueGuest", team: 1, score: 1, quit: false },
        ],
      },
    }, SERVER);
    expect(ended.status).toBe(200);
    host.close();
    guest.close();

    const walletStats = await playerSoon(wallet.address);
    expect(walletStats).toMatchObject({
      id: wallet.address, name: walletName, identity: "wallet", verified: true,
      matches: 1, wins: 1, losses: 0, kills: 2, deaths: 1, score: 2,
    });
    expect(walletStats.recent[0]).toMatchObject({ matchId, playlist: "duel", teams: false, outcome: "win" });
    /* the guest, by the key only their browser knows; the answer never
       carries the key */
    const guestStats = await playerSoon(guestKey);
    expect(guestStats).toMatchObject({
      name: "BlueGuest", identity: "guest", matches: 1, wins: 0, losses: 1, kills: 1, deaths: 2, score: 1,
    });
    expect(guestStats.id).toBe(await guestId(guestKey));
    expect(JSON.stringify(guestStats)).not.toContain(guestKey);
    /* and by their public id */
    expect((await call("GET", `/v1/players/${guestStats.id}`)).body.player.id).toBe(guestStats.id);
    /* a second report of the same match is taken (the server may retry)
       and counts for nothing */
    const twice = await call("POST", `/v1/pool/servers/${serverId}/matches/${matchId}/end`, { reason: "finished" }, SERVER);
    expect(twice.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await playerSoon(wallet.address)).matches).toBe(1);
  });
});
