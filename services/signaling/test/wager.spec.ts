import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { bountyPayouts, killTransfer, type WagerPlayer } from "../src/wager";

const STAKE = 50_000_000;
const PER_KILL = 10_000_000;

function players(count: number): WagerPlayer[] {
  return Array.from({ length: count }, (_, index) => ({
    wallet: `wallet${index}`, name: `p${index}`, balance: STAKE, kills: 0, deaths: 0,
  }));
}

function kill(table: WagerPlayer[], killer: number, victim: number): number {
  const moved = killTransfer(table, killer, victim, PER_KILL);
  table[victim]!.balance -= moved;
  table[killer]!.balance += moved;
  return moved;
}

describe("bounty rules", () => {
  it("moves the bounty from victim to killer, and never more than the victim has", () => {
    const table = players(2);
    for (let index = 0; index < 5; index += 1) expect(kill(table, 0, 1)).toBe(PER_KILL);
    expect(table[1]!.balance).toBe(0);
    /* spent: playing for nothing */
    expect(kill(table, 0, 1)).toBe(0);
    expect(table[0]!.balance).toBe(2 * STAKE);
  });

  it("moves nothing for a suicide or an unknown player", () => {
    const table = players(2);
    expect(killTransfer(table, 0, 0, PER_KILL)).toBe(0);
    expect(killTransfer(table, -1, 0, PER_KILL)).toBe(0);
    expect(killTransfer(table, 0, -1, PER_KILL)).toBe(0);
  });

  it("takes the fee only from winnings, within the program's cap, and pays out the whole pot", () => {
    const table = players(4);
    kill(table, 0, 1);
    kill(table, 0, 2);
    kill(table, 3, 0);
    kill(table, 3, 1);
    const balances = table.map((player) => player.balance);
    expect(balances.reduce((sum, balance) => sum + balance, 0)).toBe(4 * STAKE);
    const { payouts, fee } = bountyPayouts(STAKE, balances, 500);
    /* player 0 won 0.01 net, player 3 won 0.02: 5% of each */
    expect(payouts).toEqual([STAKE + PER_KILL - PER_KILL / 20, STAKE - 2 * PER_KILL, STAKE - PER_KILL, STAKE + 2 * PER_KILL - PER_KILL / 10]);
    expect(fee).toBe(PER_KILL / 20 + PER_KILL / 10);
    expect(payouts.reduce((sum, payout) => sum + payout, 0) + fee).toBe(4 * STAKE);
    expect(fee).toBeLessThanOrEqual(Math.floor((4 * STAKE * 500) / 10_000));
  });

  it("charges no fee on a match nobody won anything in", () => {
    expect(bountyPayouts(STAKE, [STAKE, STAKE], 500)).toEqual({ payouts: [STAKE, STAKE], fee: 0 });
  });
});

describe("wagered playlists", () => {
  it("need a wallet to queue", async () => {
    const response = await exports.default.fetch(new Request("http://signaling.test/v1/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:8765", "CF-Connecting-IP": "198.51.100.77" },
      body: JSON.stringify({ protocolVersion: 1, buildId: "wager-test-build", identifier: "0000000000aa", playlist: "bountyduel" }),
    }));
    expect(response.status).toBe(401);
  });

  it("withhold the invite until the stakes lock, and void the match when they cannot", async () => {
    const buildId = "wager-test-build-2";
    const matchmaker = env.MATCHMAKER.getByName("main");
    const now = Date.now();
    const serverId = await matchmaker.registerServer(buildId, null, null, now);
    const tickets = [];
    for (const [index, wallet] of ["WalletAAAAaaaa1111", "WalletBBBBbbbb2222"].entries()) {
      tickets.push(await matchmaker.enqueue({
        buildId, identifier: `00000000ab0${index}`, playerKey: null, playlist: "bountyduel", wallet, now,
      }));
    }
    const formed = tickets[1]!;
    expect(formed.state).toBe("assigning");
    expect(formed.match?.wager).toEqual({ stake: STAKE, perKill: PER_KILL, escrow: "locking" });
    expect(await matchmaker.matchReady(serverId, formed.match!.id, "room-for-wager-test", "INVITE1", now)).toBe(true);
    const ready = await matchmaker.poll(formed.id, now);
    expect(ready?.state).toBe("ready");
    /* the room is open, but not to anyone until the stakes are locked */
    if (ready?.match?.wager?.escrow !== "locked") expect(ready?.match?.inviteCode).toBeNull();

    /* this test Worker has no escrow keys: the wager reports it cannot lock */
    let ended = ready;
    for (let attempt = 0; attempt < 50 && ended?.state !== "ended"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      ended = await matchmaker.poll(formed.id, Date.now());
    }
    expect(ended?.state).toBe("ended");
    expect(ended?.match?.endReason).toMatch(/^void: .*not set up/u);
    expect(ended?.match?.inviteCode).toBeNull();
  });
});
