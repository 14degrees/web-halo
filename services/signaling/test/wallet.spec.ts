import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { BANK_NAME } from "../src/bank";
import type { CreateRoomResponse, QuickJoinResponse } from "../src/index";
import {
  base58Decode,
  base58Encode,
  transferMessage,
  walletPlayerName,
} from "../src/solana";

const API_ORIGIN = "http://signaling.test";
const GAME_ORIGIN = "http://127.0.0.1:8765";
const HOST_SERVICE_TOKEN = "test-only-host-service-token-32-bytes-min";
let nextAddress = 0;
let nextBuild = 0;

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  nextAddress += 1;
  return new Request(`${API_ORIGIN}${path}`, {
    body: JSON.stringify(body),
    headers: {
      "CF-Connecting-IP": `203.0.113.${nextAddress % 250}`,
      "Content-Type": "application/json",
      Origin: GAME_ORIGIN,
      ...headers,
    },
    method: "POST",
  });
}

/* A wallet: an Ed25519 key pair whose public key is the address. */
async function newWallet(): Promise<{ address: string; sign(message: string): Promise<string> }> {
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

async function signIn(wallet: { address: string; sign(message: string): Promise<string> }): Promise<string> {
  const challenge = await (await exports.default.fetch(
    jsonRequest("/v1/auth/challenge", { wallet: wallet.address }),
  )).json<{ message: string; nonce: string }>();
  const response = await exports.default.fetch(jsonRequest("/v1/auth/verify", {
    nonce: challenge.nonce,
    signature: await wallet.sign(challenge.message),
    wallet: wallet.address,
  }));
  expect(response.status).toBe(200);
  return (await response.json<{ token: string }>()).token;
}

async function connect(websocketUrl: string): Promise<WebSocket> {
  const requestUrl = new URL(websocketUrl);
  requestUrl.protocol = "http:";
  const response = await exports.default.fetch(
    new Request(requestUrl, { headers: { Origin: GAME_ORIGIN, Upgrade: "websocket" } }),
  );
  const socket = response.webSocket;
  if (socket === null) throw new Error("Upgrade did not return a WebSocket.");
  socket.accept();
  return socket;
}

function next(
  socket: WebSocket,
  type: string,
  accept: (value: Record<string, unknown>) => boolean = () => true,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`no ${type}`)), 3_000);
    socket.addEventListener("message", (event) => {
      const value = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (value.type === type && accept(value)) {
        clearTimeout(timeout);
        resolve(value);
      }
    });
  });
}

describe("Solana helpers", () => {
  it("round-trips base58 and builds a System Program transfer", () => {
    const address = "11111111111111111111111111111112";
    expect(base58Encode(base58Decode(address) ?? new Uint8Array())).toBe(address);
    expect(base58Decode("0OIl")).toBeNull();
    const from = base58Encode(new Uint8Array(32).fill(7));
    const to = base58Encode(new Uint8Array(32).fill(9));
    const blockhash = base58Encode(new Uint8Array(32).fill(3));
    const message = transferMessage(from, to, 100_000_000, blockhash);
    /* header, 3 accounts, blockhash, one instruction of 12 data bytes */
    expect(message.length).toBe(3 + 1 + 96 + 32 + 1 + 1 + 1 + 2 + 1 + 12);
    expect(Array.from(message.slice(0, 3))).toEqual([1, 0, 1]);
    expect(walletPlayerName("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")).toBe("7xKX..gAsU");
  });
});

describe("wallet accounts", () => {
  it("signs in with a wallet signature and refuses a forged one", async () => {
    const wallet = await newWallet();
    const token = await signIn(wallet);
    const summary = await (await exports.default.fetch(new Request(`${API_ORIGIN}/v1/wallet`, {
      headers: { Authorization: `Bearer ${token}`, Origin: GAME_ORIGIN },
    }))).json<Record<string, unknown>>();
    expect(summary).toMatchObject({ cluster: "devnet", lamports: 0, name: walletPlayerName(wallet.address), wallet: wallet.address });

    const other = await newWallet();
    const challenge = await (await exports.default.fetch(
      jsonRequest("/v1/auth/challenge", { wallet: wallet.address }),
    )).json<{ message: string; nonce: string }>();
    const forged = await exports.default.fetch(jsonRequest("/v1/auth/verify", {
      nonce: challenge.nonce,
      signature: await other.sign(challenge.message),
      wallet: wallet.address,
    }));
    expect(forged.status).toBe(401);
    /* The nonce is single use. */
    const replay = await exports.default.fetch(jsonRequest("/v1/auth/verify", {
      nonce: challenge.nonce,
      signature: await wallet.sign(challenge.message),
      wallet: wallet.address,
    }));
    expect(replay.status).toBe(401);
  });

  it("moves the wager from victim to killer on a dedicated host's kill report", async () => {
    nextBuild += 1;
    const buildId = `wallet-test-build-${nextBuild}`;
    const hostRoom = await (await exports.default.fetch(jsonRequest(
      "/v1/rooms",
      { buildId, dedicated: true, identifier: "6a6a6a6a6a6a", protocolVersion: 1 },
      { Authorization: `Bearer ${HOST_SERVICE_TOKEN}` },
    ))).json<CreateRoomResponse>();
    const host = await connect(hostRoom.host.session.websocketUrl);

    const killerWallet = await newWallet();
    const victimWallet = await newWallet();
    const bank = env.BANK.getByName(BANK_NAME);
    await bank.creditDeposit(victimWallet.address, `test-deposit-${victimWallet.address}`, 150_000_000, Date.now());

    const join = async (wallet: Awaited<ReturnType<typeof newWallet>>, identifier: string): Promise<WebSocket> => {
      const token = await signIn(wallet);
      const joined = await (await exports.default.fetch(jsonRequest("/v1/quickjoin", {
        buildId, identifier, protocolVersion: 1, walletToken: token,
      }))).json<QuickJoinResponse>();
      if (joined.role !== "guest") throw new Error("expected guest");
      const socket = await connect(joined.session.websocketUrl);
      /* Whatever name is asked for, a wallet plays under its own. */
      const named = (value: Record<string, unknown>): boolean =>
        (value.players as Array<{ profile: { name: string } | null }>)
          .some((player) => player.profile?.name === walletPlayerName(wallet.address));
      const roster = next(socket, "roster", named);
      socket.send(JSON.stringify({ profile: { name: "Impostor", style: "red" }, type: "profile", v: 1 }));
      const players = (await roster).players as Array<{ profile: { name: string } | null }>;
      expect(players.map((player) => player.profile?.name)).toContain(walletPlayerName(wallet.address));
      expect(players.map((player) => player.profile?.name)).not.toContain("Impostor");
      return socket;
    };
    const killerSocket = await join(killerWallet, "6b6b6b6b6b6b");
    const victimSocket = await join(victimWallet, "6c6c6c6c6c6c");

    const reward = next(victimSocket, "reward");
    host.send(JSON.stringify({
      killer: walletPlayerName(killerWallet.address),
      type: "kill",
      v: 1,
      victim: walletPlayerName(victimWallet.address),
    }));
    expect(await reward).toMatchObject({ killerLamports: 100_000_000, lamports: 100_000_000, victimLamports: 50_000_000 });

    /* The victim has 0.05 left: the next kill takes only that. */
    const second = next(killerSocket, "reward", (value) => value.victimLamports === 0);
    host.send(JSON.stringify({
      killer: walletPlayerName(killerWallet.address),
      type: "kill",
      v: 1,
      victim: walletPlayerName(victimWallet.address),
    }));
    expect(await second).toMatchObject({ killerLamports: 150_000_000, lamports: 50_000_000, victimLamports: 0 });

    /* A guest cannot report kills. */
    const refused = next(victimSocket, "error");
    victimSocket.send(JSON.stringify({ killer: "a", type: "kill", v: 1, victim: "b" }));
    expect(await refused).toMatchObject({ code: "KILL_FORBIDDEN" });

    killerSocket.close(1000, "done");
    victimSocket.close(1000, "done");
    host.close(1000, "done");
    /* Let the room finish what the closes set off (directory updates) before
       the test environment is torn down. */
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
});
