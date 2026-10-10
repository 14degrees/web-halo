import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BadgeCache, badgesFromView } from "../src/badges";
import { PROFILES_NAME } from "../src/profiles";
import { base58Encode } from "../src/solana";
import type { CreateRoomResponse, CreateSessionResponse } from "../src/index";

/* Badges on rosters: the room and the party attach a player's account name
   and shown links from the Profiles store, by the wallet they signed in
   with. Every outside call (the fomo chain check after a sign-in) gets an
   empty answer. */

const API_ORIGIN = "http://signaling.test";
const GAME_ORIGIN = "http://127.0.0.1:8765";
const BUILD_ID = "halo-web-badges-test-1";
let nextName = 0;
let nextMachine = 0xb00;

function freshName(): string {
  nextName += 1;
  return `badge${nextName}`;
}

function identifier(): string {
  nextMachine += 1;
  return nextMachine.toString(16).padStart(12, "0");
}

interface Wallet { address: string; sign(message: string): Promise<string> }

async function newWallet(): Promise<Wallet> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return {
    address: base58Encode(raw),
    async sign(message: string): Promise<string> {
      const signed = await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(message));
      return base58Encode(new Uint8Array(signed));
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", async () => Response.json({ jsonrpc: "2.0", id: 1, result: [] }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await exports.default.fetch(new Request(`${API_ORIGIN}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: GAME_ORIGIN, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, body: await response.json<Record<string, any>>() };
}

function store() {
  return env.PROFILES.getByName(PROFILES_NAME);
}

/* a signed-in wallet with a username and a verified X link it shows */
async function linkedPlayer(handle: string) {
  const wallet = await newWallet();
  const challenge = await call("POST", "/v1/auth/challenge", { wallet: wallet.address });
  const verify = await call("POST", "/v1/auth/verify", {
    nonce: challenge.body.nonce, signature: await wallet.sign(challenge.body.message), wallet: wallet.address,
  });
  expect(verify.status).toBe(200);
  const token = verify.body.token as string;
  const auth = { Authorization: `Bearer ${token}` };
  const username = freshName();
  const claimed = await call("POST", "/v1/profile/username", { username }, auth);
  expect(claimed.status).toBe(200);
  const now = Date.now();
  expect(await store().startXChallenge(wallet.address, "BADGE234", now)).not.toHaveProperty("error");
  expect(await store().linkX(wallet.address, {
    profileId: claimed.body.profile.id, code: "BADGE234", handle, proofUrl: `https://x.com/${handle}/status/1`,
  }, now)).not.toHaveProperty("error");
  expect((await call("PATCH", "/v1/profile", { showX: true }, auth)).status).toBe(200);
  return { wallet, token, auth, username };
}

function nextMessage(socket: WebSocket, test: (value: Record<string, any>) => boolean): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for a message.")), 2_000);
    const listener = (event: MessageEvent): void => {
      if (typeof event.data !== "string") return;
      const value = JSON.parse(event.data) as Record<string, any>;
      if (test(value)) {
        clearTimeout(timeout);
        socket.removeEventListener("message", listener);
        resolve(value);
      }
    };
    socket.addEventListener("message", listener);
  });
}

async function connect(websocketUrl: string): Promise<WebSocket> {
  const url = new URL(websocketUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  const response = await exports.default.fetch(new Request(url, { headers: { Origin: GAME_ORIGIN, Upgrade: "websocket" } }));
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const welcome = nextMessage(socket, (value) => value.type === "welcome");
  socket.accept();
  await welcome;
  return socket;
}

describe("badges from a public profile", () => {
  it("carry the name and the shown links, and never a wallet", () => {
    expect(badgesFromView(undefined)).toEqual({});
    expect(badgesFromView({ id: "p", username: "Chief" })).toEqual({ username: "Chief" });
    expect(badgesFromView({
      id: "p", username: "Chief", wallets: ["W1"], fomo: { handle: null, wallet: "F1" }, x: { handle: "chief" },
    })).toEqual({ username: "Chief", links: { fomo: { handle: null }, x: { handle: "chief" } } });
  });

  it("are asked for once while they are fresh", async () => {
    let asked = 0;
    const cache = new BadgeCache({
      PROFILES: { getByName: () => ({ publicProfilesForWallets: async (wallets: string[]) => {
        asked += 1;
        return Object.fromEntries(wallets.map((wallet) => [wallet, { id: "p", username: `n${wallet}` }]));
      } }) } as unknown as Env["PROFILES"],
    });
    expect((await cache.lookUp(["a", "b"], 1_000)).get("a")).toEqual({ username: "na" });
    expect((await cache.lookUp(["a", "b"], 2_000)).get("b")).toEqual({ username: "nb" });
    expect(asked).toBe(1);
    await cache.lookUp(["a"], 1_000 + 5 * 60_000);
    expect(asked).toBe(2);
  });
});

describe("room badges", () => {
  it("puts a signed-in player's name and shown links on the roster and their chat, whatever they send", async () => {
    const player = await linkedPlayer("halo_badge");
    const created = await call("POST", "/v1/rooms", { buildId: BUILD_ID, capacity: 3, identifier: identifier(), protocolVersion: 1 });
    expect(created.status).toBe(201);
    const room = created.body as unknown as CreateRoomResponse;
    const host = await connect(room.host.session.websocketUrl);
    const ticket = room.invite.code.slice(room.invite.code.indexOf(".") + 1);
    const session = await call("POST", `/v1/rooms/${room.room.id}/sessions`, {
      buildId: BUILD_ID, identifier: identifier(), protocolVersion: 1, ticket, walletToken: player.token,
    });
    expect(session.status).toBe(201);
    const guestSession = session.body as unknown as CreateSessionResponse;
    const guest = await connect(guestSession.session.websocketUrl);

    const badged = nextMessage(host, (value) => value.type === "roster" &&
      value.players.some((entry: Record<string, any>) => entry.links !== undefined));
    /* a page can't name its own links: the room ignores them */
    guest.send(JSON.stringify({
      profile: { name: "Guest", style: "blue" }, links: { x: { handle: "elonmusk" } }, username: "admin", type: "profile", v: 1,
    }));
    const roster = await badged;
    const entry = roster.players.find((candidate: Record<string, any>) => candidate.peerId === guestSession.session.peerId);
    expect(entry.username).toBe(player.username);
    expect(entry.links).toEqual({ x: { handle: "halo_badge" } });

    const heard = nextMessage(host, (value) => value.type === "chat");
    guest.send(JSON.stringify({ text: "gg", type: "chat", v: 1 }));
    expect(await heard).toMatchObject({ username: player.username, links: { x: { handle: "halo_badge" } } });

    guest.close(1000, "test complete");
    host.close(1000, "test complete");
  });
});

describe("party badges", () => {
  it("shows a member's name and shown links to the party after their next poll", async () => {
    const player = await linkedPlayer("party_badge");
    const member = (name: string, walletToken?: string) => ({
      playerKey: `badge-test-key-${name}-${identifier()}`, identifier: identifier(), profile: { name, style: "sage" },
      ...(walletToken === undefined ? {} : { walletToken }),
    });
    const leader = member("Leader");
    const friend = member("Friend", player.token);
    const code = (await call("POST", "/v1/parties", { buildId: BUILD_ID, ...leader })).body.party.code as string;
    await call("POST", `/v1/parties/${code}/join`, friend);

    let seen: Record<string, any> | undefined;
    for (let attempt = 0; attempt < 20 && seen?.links === undefined; attempt += 1) {
      const polled = await call("POST", `/v1/parties/${code}/poll`, leader);
      seen = polled.body.party.members.find((entry: Record<string, any>) => entry.name === "Friend");
      if (seen?.links === undefined) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(seen).toMatchObject({ username: player.username, links: { x: { handle: "party_badge" } } });
    const leaderEntry = (await call("POST", `/v1/parties/${code}/poll`, leader)).body.party.members
      .find((entry: Record<string, any>) => entry.name === "Leader");
    expect(leaderEntry.username).toBeUndefined();
    expect(leaderEntry.links).toBeUndefined();

    const said = await call("POST", `/v1/parties/${code}/chat`, { ...friend, text: "ready" });
    expect(said.body.party.chat.at(-1)).toMatchObject({ username: player.username, links: { x: { handle: "party_badge" } } });
  });
});
