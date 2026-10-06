import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  CHAT_MAX_LENGTH,
  CHAT_MESSAGES_PER_WINDOW,
  CHAT_WINDOW_MS,
  allowChat,
  censorChatText,
  normaliseChatText,
} from "../src/chat";
import { parseClientMessage } from "../src/protocol";
import type { CreateRoomResponse, CreateSessionResponse } from "../src/index";

const API_ORIGIN = "http://signaling.test";
const GAME_ORIGIN = "http://127.0.0.1:8765";
const BUILD_ID = "halo-web-chat-test-1";

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`${API_ORIGIN}${path}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Origin: GAME_ORIGIN },
    method: "POST",
  });
}

async function createRoom(identifier: string, capacity = 3): Promise<CreateRoomResponse> {
  const response = await exports.default.fetch(
    jsonRequest("/v1/rooms", { buildId: BUILD_ID, capacity, identifier, protocolVersion: 1 }),
  );
  expect(response.status).toBe(201);
  return response.json<CreateRoomResponse>();
}

async function createGuestSession(room: CreateRoomResponse, identifier: string): Promise<CreateSessionResponse> {
  const guestTicket = room.invite.code.slice(room.invite.code.indexOf(".") + 1);
  const response = await exports.default.fetch(
    jsonRequest(`/v1/rooms/${room.room.id}/sessions`, {
      buildId: BUILD_ID, identifier, protocolVersion: 1, ticket: guestTicket,
    }),
  );
  expect(response.status).toBe(201);
  return response.json<CreateSessionResponse>();
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

/* every message of a type for a moment: what a flood lets through */
function collect(socket: WebSocket, expectedType: string, milliseconds: number): Promise<Record<string, unknown>[]> {
  const seen: Record<string, unknown>[] = [];
  const listener = (event: MessageEvent): void => {
    if (typeof event.data !== "string") return;
    const value = JSON.parse(event.data) as Record<string, unknown>;
    if (value.type === expectedType) seen.push(value);
  };
  socket.addEventListener("message", listener);
  return new Promise((resolve) => setTimeout(() => {
    socket.removeEventListener("message", listener);
    resolve(seen);
  }, milliseconds));
}

async function connectSession(websocketUrl: string): Promise<WebSocket> {
  const requestUrl = new URL(websocketUrl);
  requestUrl.protocol = requestUrl.protocol === "wss:" ? "https:" : "http:";
  const response = await exports.default.fetch(
    new Request(requestUrl, { headers: { Origin: GAME_ORIGIN, Upgrade: "websocket" } }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("Upgrade did not return a WebSocket.");
  const welcome = nextMessage(socket, "welcome");
  socket.accept();
  await welcome;
  return socket;
}

async function setProfile(socket: WebSocket, name: string, style: string): Promise<void> {
  const roster = nextMessage(socket, "roster");
  socket.send(JSON.stringify({ profile: { name, style }, type: "profile", v: 1 }));
  await roster;
}

describe("chat text", () => {
  it("is trimmed, single-spaced and free of control characters, or nothing", () => {
    expect(normaliseChatText("  gg   everyone \n")).toBe("gg everyone");
    expect(normaliseChatText("no\u0000con\u001ftrols​here !")).toBe("nocontrolshere!");
    expect(normaliseChatText("   ")).toBeNull();
    expect(normaliseChatText("")).toBeNull();
    expect(normaliseChatText(42)).toBeNull();
    expect(normaliseChatText(undefined)).toBeNull();
    expect(normaliseChatText("x".repeat(CHAT_MAX_LENGTH))).toHaveLength(CHAT_MAX_LENGTH);
    expect(normaliseChatText("x".repeat(CHAT_MAX_LENGTH + 1))).toBeNull();
    /* the room's envelope uses the same rule */
    expect(parseClientMessage({ text: " hi ", type: "chat", v: 1 })).toEqual({
      ok: true, value: { text: "hi", type: "chat", v: 1 },
    });
    expect(parseClientMessage({ text: "", type: "chat", v: 1 })).toMatchObject({ ok: false });
    expect(parseClientMessage({ type: "chat", v: 1 })).toMatchObject({ ok: false });
  });

  it("masks the words on the list, however they are spelled, and nothing else", () => {
    expect(censorChatText("what the fuck was that")).toBe("what the **** was that");
    expect(censorChatText("FUCK! Sh1t, $hit, fuuuuck, fucking, shits.")).toBe("****! ****, ****, *******, *******, *****.");
    expect(censorChatText("nice shot, good game")).toBe("nice shot, good game");
    /* whole words only: the list never bleeds into other words */
    expect(censorChatText("class assistant shitake scunthorpe")).toBe("class assistant shitake scunthorpe");
    expect(censorChatText("you n1gger")).toBe("you ******");
    expect(censorChatText("héllo wörld")).toBe("héllo wörld");
  });

  it("lets a player speak only so often", () => {
    const state = {};
    for (let index = 0; index < CHAT_MESSAGES_PER_WINDOW; index += 1) expect(allowChat(state, 1_000)).toBe(true);
    expect(allowChat(state, 1_000 + CHAT_WINDOW_MS - 1)).toBe(false);
    /* the flood keeps counting: the window is not reset by being refused */
    expect(allowChat(state, 1_000 + CHAT_WINDOW_MS - 1)).toBe(false);
    expect(allowChat(state, 1_000 + CHAT_WINDOW_MS)).toBe(true);
  });
});

describe("room chat", () => {
  it("passes a player's line to everyone in the room, filtered, and no one else's state", async () => {
    const room = await createRoom("c0a1b2c3d4e5");
    const host = await connectSession(room.host.session.websocketUrl);
    const guestSession = await createGuestSession(room, "c0a1b2c3d4e6");
    const guest = await connectSession(guestSession.session.websocketUrl);

    /* before saying who they are, a player cannot speak */
    const forbidden = nextMessage(guest, "error");
    guest.send(JSON.stringify({ text: "hello?", type: "chat", v: 1 }));
    expect(await forbidden).toMatchObject({ code: "CHAT_FORBIDDEN", type: "error" });

    await setProfile(host, "TestSpartan", "rose");
    await setProfile(guest, "Blue Guest", "blue");

    const hostHears = nextMessage(host, "chat");
    const guestHears = nextMessage(guest, "chat");
    guest.send(JSON.stringify({ text: "  gg   that was some shit ", type: "chat", v: 1 }));
    const [atHost, atGuest] = await Promise.all([hostHears, guestHears]);
    const expected = {
      from: guestSession.session.peerId,
      name: "Blue Guest",
      style: "blue",
      text: "gg that was some ****",
      type: "chat",
      v: 1,
    };
    expect(atHost).toMatchObject(expected);
    expect(atGuest).toMatchObject(expected);
    expect(typeof atHost.at).toBe("number");
    /* no account name: none is claimed */
    expect(atHost.username).toBeUndefined();

    /* an empty or oversized line is a malformed message, not a chat */
    const malformed = nextMessage(guest, "error");
    guest.send(JSON.stringify({ text: "x".repeat(CHAT_MAX_LENGTH + 1), type: "chat", v: 1 }));
    expect(await malformed).toMatchObject({ code: "INVALID_MESSAGE", type: "error" });

    guest.close(1000, "test complete");
    host.close(1000, "test complete");
  });

  it("holds a flood back without disconnecting the player", async () => {
    const room = await createRoom("c0a1b2c3d4f0");
    const host = await connectSession(room.host.session.websocketUrl);
    await setProfile(host, "Chatty", "sage");

    const heard = collect(host, "chat", 300);
    const refused = collect(host, "error", 300);
    for (let index = 0; index < CHAT_MESSAGES_PER_WINDOW + 2; index += 1) {
      host.send(JSON.stringify({ text: `line ${index}`, type: "chat", v: 1 }));
    }
    expect((await heard).map((message) => message.text)).toEqual(
      Array.from({ length: CHAT_MESSAGES_PER_WINDOW }, (_, index) => `line ${index}`),
    );
    expect(await refused).toHaveLength(2);
    expect((await refused)[0]).toMatchObject({ code: "CHAT_RATE_LIMITED" });

    /* still connected: a ping comes back */
    const pong = nextMessage(host, "pong");
    host.send(JSON.stringify({ nonce: "still-here", type: "ping", v: 1 }));
    expect(await pong).toMatchObject({ nonce: "still-here" });
    host.close(1000, "test complete");
  });
});

describe("party chat", () => {
  let nextMachine = 0x700;
  function player(name: string) {
    nextMachine += 1;
    return {
      playerKey: `chat-test-key-${name}-${nextMachine}`,
      identifier: nextMachine.toString(16).padStart(12, "0"),
      profile: { name, style: "sage" },
    };
  }
  async function call(path: string, body: unknown) {
    const response = await exports.default.fetch(jsonRequest(path, body));
    return { status: response.status, body: await response.json<Record<string, any>>() };
  }

  it("keeps the party's lines for its members' polls, after the one they saw", async () => {
    const leader = player("Leader");
    const friend = player("Friend");
    const created = await call("/v1/parties", { buildId: BUILD_ID, ...leader });
    expect(created.status).toBe(200);
    const code = created.body.party.code as string;
    expect(created.body.party.chat).toEqual([]);
    const joined = await call(`/v1/parties/${code}/join`, friend);
    const friendId = joined.body.party.self as string;

    const said = await call(`/v1/parties/${code}/chat`, { ...friend, text: "  ready when you are, shit heads " });
    expect(said.status).toBe(200);
    expect(said.body.party.chat).toEqual([
      expect.objectContaining({ seq: 1, from: friendId, name: "Friend", style: "sage", text: "ready when you are, **** heads" }),
    ]);

    const polled = await call(`/v1/parties/${code}/poll`, { ...leader, chatSince: 0 });
    expect(polled.body.party.chat.map((line: { seq: number; text: string }) => [line.seq, line.text]))
      .toEqual([[1, "ready when you are, **** heads"]]);
    const caughtUp = await call(`/v1/parties/${code}/poll`, { ...leader, chatSince: 1 });
    expect(caughtUp.body.party.chat).toEqual([]);

    expect((await call(`/v1/parties/${code}/chat`, { ...leader, text: "   " })).status).toBe(400);
    expect((await call(`/v1/parties/${code}/chat`, { ...player("Stranger"), text: "hi" })).status).toBe(403);
  });

  it("holds a member's flood back", async () => {
    const leader = player("Leader");
    const code = (await call("/v1/parties", { buildId: BUILD_ID, ...leader })).body.party.code as string;
    for (let index = 0; index < CHAT_MESSAGES_PER_WINDOW; index += 1) {
      expect((await call(`/v1/parties/${code}/chat`, { ...leader, text: `line ${index}` })).status).toBe(200);
    }
    const refused = await call(`/v1/parties/${code}/chat`, { ...leader, text: "one more" });
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe("CHAT_RATE_LIMITED");
  });
});
