import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEAM_SHARE_BPS,
  bountyPayouts,
  killTransfer,
  type MatchResult,
  type StakesConfig,
  stakesConfigProblem,
  stakesOutcome,
  stakesProjected,
  stakesProjection,
  type WagerPlayer,
} from "../src/wager";

const STAKE = 50_000_000;
const PER_KILL = 10_000_000;
const FEE_BPS = 500;
const CONFIG: StakesConfig = { stake: STAKE, killTarget: 50, teamShareBps: DEFAULT_TEAM_SHARE_BPS, groups: 2 };

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
    const { payouts, fee } = bountyPayouts(STAKE, balances, FEE_BPS);
    /* player 0 won 0.01 net, player 3 won 0.02: 5% of each */
    expect(payouts).toEqual([STAKE + PER_KILL - PER_KILL / 20, STAKE - 2 * PER_KILL, STAKE - PER_KILL, STAKE + 2 * PER_KILL - PER_KILL / 10]);
    expect(fee).toBe(PER_KILL / 20 + PER_KILL / 10);
    expect(payouts.reduce((sum, payout) => sum + payout, 0) + fee).toBe(4 * STAKE);
    expect(fee).toBeLessThanOrEqual(Math.floor((4 * STAKE * FEE_BPS) / 10_000));
  });

  it("charges no fee on a match nobody won anything in", () => {
    expect(bountyPayouts(STAKE, [STAKE, STAKE], FEE_BPS)).toEqual({ payouts: [STAKE, STAKE], fee: 0 });
  });
});

/* ---------- Team Stakes (the spec's worked examples, in lamports) */

interface Row { name: string; team: number; kills: number; quit?: boolean; score?: number }

/* a roster in join order, and the server's result for it */
function match(rows: Row[], teamScores: [number, number], teams = true): {
  players: Array<{ name: string; kills: number }>; result: MatchResult;
} {
  return {
    players: rows.map(({ name, kills }) => ({ name, kills })),
    result: {
      teams,
      teamScores,
      players: rows.map(({ name, team, quit, score, kills }) => ({ name, team, score: score ?? kills, quit: quit ?? false })),
    },
  };
}

function settled(outcome: ReturnType<typeof stakesOutcome>) {
  if (outcome.kind === "settle") return outcome;
  if (outcome.kind === "hold") return outcome.proposed;
  throw new Error(`void: ${outcome.reason}`);
}

function pot(playerCount: number, stake = STAKE): number {
  return stake * playerCount;
}

describe("team stakes", () => {
  it("A: pays a 4v4 by kills, a quarter of the prize evenly, and sums to the pot exactly", () => {
    const { players: roster, result } = match([
      { name: "r1", team: 0, kills: 17 }, { name: "b1", team: 1, kills: 15 },
      { name: "r2", team: 0, kills: 14 }, { name: "b2", team: 1, kills: 13 },
      { name: "r3", team: 0, kills: 11 }, { name: "b3", team: 1, kills: 10 },
      { name: "r4", team: 0, kills: 8 }, { name: "b4", team: 1, kills: 8 },
    ], [50, 46]);
    const outcome = stakesOutcome(CONFIG, roster, result, FEE_BPS);
    expect(outcome.kind).toBe("settle");
    const paid = settled(outcome);
    expect(paid.winningGroups).toEqual([0]);
    expect(paid.fee).toBe(10_000_000);
    expect(paid.perKill).toBe(2_850_000);
    expect(paid.payouts).toEqual([110_325_000, 0, 101_775_000, 0, 93_225_000, 0, 84_675_000, 0]);
    expect(paid.killShares).toEqual([48_450_000, 0, 39_900_000, 0, 31_350_000, 0, 22_800_000, 0]);
    expect(paid.evenShares).toEqual([11_875_000, 0, 11_875_000, 0, 11_875_000, 0, 11_875_000, 0]);
    expect(paid.payouts.reduce((sum, payout) => sum + payout, 0) + paid.fee).toBe(pot(8));
  });

  it("B: a staked no-show forfeits to their team-mates, and the dust goes to the top killers", () => {
    const { players: roster, result } = match([
      { name: "r1", team: 0, kills: 13 }, { name: "b1", team: 1, kills: 24 },
      { name: "r2", team: 0, kills: 12 }, { name: "b2", team: 1, kills: 16 },
      { name: "r3", team: 0, kills: 9 }, { name: "b3", team: 1, kills: 10 },
      { name: "r4", team: 0, kills: 7 }, { name: "b4", team: 1, kills: 0, quit: true },
    ], [41, 50]);
    /* b4 never loaded: the result has no row for them */
    result.players = result.players.filter((player) => player.name !== "b4");
    const paid = settled(stakesOutcome(CONFIG, roster, result, FEE_BPS));
    expect(paid.fee).toBe(12_500_000);
    expect(paid.perKill).toBe(3_562_500);
    expect(paid.payouts).toEqual([0, 155_291_667, 0, 126_791_667, 0, 105_416_666, 0, 0]);
    expect(paid.payouts.reduce((sum, payout) => sum + payout, 0) + paid.fee).toBe(pot(8));
  });

  it("C: a 0-kill winner still takes the team share; the carry takes the kill pool", () => {
    const { players: roster, result } = match([
      { name: "r1", team: 0, kills: 50 }, { name: "b1", team: 1, kills: 2 },
      { name: "r2", team: 0, kills: 0 }, { name: "b2", team: 1, kills: 1 },
    ], [50, 3]);
    const paid = settled(stakesOutcome(CONFIG, roster, result, FEE_BPS));
    expect(paid.perKill).toBe(1_425_000);
    expect(paid.payouts).toEqual([133_125_000, 0, 61_875_000, 0]);
    expect(paid.payouts.reduce((sum, payout) => sum + payout, 0) + paid.fee).toBe(pot(4));
  });

  it("D: a time-limit ending splits the unearned kill money evenly; a kill is still worth the same", () => {
    const { players: roster, result } = match([
      { name: "r1", team: 0, kills: 14 }, { name: "b1", team: 1, kills: 11 },
      { name: "r2", team: 0, kills: 9 }, { name: "b2", team: 1, kills: 8 },
    ], [23, 19]);
    const paid = settled(stakesOutcome(CONFIG, roster, result, FEE_BPS));
    expect(paid.perKill).toBe(1_425_000);
    expect(paid.killShares).toEqual([19_950_000, 0, 12_825_000, 0]);
    expect(paid.evenShares).toEqual([31_112_500, 0, 31_112_500, 0]);
    expect(paid.payouts).toEqual([101_062_500, 0, 93_937_500, 0]);
  });

  it("E: a whole team that dropped out holds the match, with the forfeit as the proposed settlement", () => {
    const { players: roster, result } = match([
      { name: "r1", team: 0, kills: 18, quit: true }, { name: "b1", team: 1, kills: 7 },
      { name: "r2", team: 0, kills: 12, quit: true }, { name: "b2", team: 1, kills: 5 },
    ], [30, 12]);
    const outcome = stakesOutcome(CONFIG, roster, result, FEE_BPS);
    expect(outcome.kind).toBe("hold");
    if (outcome.kind !== "hold") return;
    expect(outcome.dropped).toEqual([0]);
    expect(outcome.proposed.winningGroups).toEqual([1]);
    expect(outcome.proposed.payouts).toEqual([0, 98_925_000, 0, 96_075_000]);
    expect(outcome.proposed.payouts.reduce((sum, payout) => sum + payout, 0) + outcome.proposed.fee).toBe(pot(4));
  });

  it("F: a winner with no kills gets the whole prize as the even part", () => {
    const { players: roster, result } = match([
      { name: "r1", team: 0, kills: 0 }, { name: "b1", team: 1, kills: 0 },
      { name: "r2", team: 0, kills: 0 }, { name: "b2", team: 1, kills: 0 },
    ], [-1, 0]);
    const paid = settled(stakesOutcome(CONFIG, roster, result, FEE_BPS));
    expect(paid.payouts).toEqual([0, 97_500_000, 0, 97_500_000]);
  });

  it("G: a tie, no result, and nobody left are void", () => {
    const tie = match([
      { name: "r1", team: 0, kills: 13 }, { name: "b1", team: 1, kills: 12 },
      { name: "r2", team: 0, kills: 12 }, { name: "b2", team: 1, kills: 13 },
    ], [25, 25]);
    expect(stakesOutcome(CONFIG, tie.players, tie.result, FEE_BPS).kind).toBe("void");
    expect(stakesOutcome(CONFIG, tie.players, null, FEE_BPS).kind).toBe("void");
    const gone = match([
      { name: "r1", team: 0, kills: 3, quit: true }, { name: "b1", team: 1, kills: 2, quit: true },
    ], [3, 2]);
    expect(stakesOutcome(CONFIG, gone.players, gone.result, FEE_BPS).kind).toBe("void");
  });

  it("H: the brief's numbers: 1 SOL at 10 kills to win", () => {
    const { players: roster, result } = match([
      { name: "r1", team: 0, kills: 7 }, { name: "b1", team: 1, kills: 3 },
      { name: "r2", team: 0, kills: 3 }, { name: "b2", team: 1, kills: 1 },
    ], [10, 4]);
    const paid = settled(stakesOutcome({ ...CONFIG, stake: 1_000_000_000, killTarget: 10 }, roster, result, FEE_BPS));
    expect(paid.perKill).toBe(142_500_000);
    expect(paid.payouts).toEqual([2_235_000_000, 0, 1_665_000_000, 0]);
    /* no fee and no team share: exactly stake / kill target per losing stake */
    const literal = settled(stakesOutcome({ ...CONFIG, stake: 1_000_000_000, killTarget: 10, teamShareBps: 0 }, roster, result, 0));
    expect(literal.perKill).toBe(200_000_000);
  });

  it("I: kills past the target (betrayals cost the score, not the count) share the pool pro rata", () => {
    const { players: roster, result } = match([
      { name: "r1", team: 0, kills: 20 }, { name: "b1", team: 1, kills: 14 },
      { name: "r2", team: 0, kills: 15 }, { name: "b2", team: 1, kills: 12 },
      { name: "r3", team: 0, kills: 10 }, { name: "b3", team: 1, kills: 10 },
      { name: "r4", team: 0, kills: 7 }, { name: "b4", team: 1, kills: 8 },
    ], [50, 44]);
    const paid = settled(stakesOutcome(CONFIG, roster, result, FEE_BPS));
    expect(paid.perKill).toBe(2_740_384);
    expect(paid.payouts).toEqual([116_682_693, 0, 102_980_769, 0, 89_278_846, 0, 81_057_692, 0]);
    expect(paid.payouts.reduce((sum, payout) => sum + payout, 0) + paid.fee).toBe(pot(8));
  });

  it("J and K: a free-for-all pays the winner the prize, and co-winners on a tie for first", () => {
    const ffa: StakesConfig = { ...CONFIG, killTarget: 25, groups: 0 };
    const won = match([
      { name: "p0", team: 0, kills: 25 }, { name: "p1", team: 0, kills: 19 },
      { name: "p2", team: 0, kills: 12 }, { name: "p3", team: 0, kills: 7 },
    ], [0, 0], false);
    const paid = settled(stakesOutcome(ffa, won.players, won.result, FEE_BPS));
    expect(paid.winningGroups).toEqual([0]);
    expect(paid.payouts).toEqual([192_500_000, 0, 0, 0]);
    const tied = match([
      { name: "p0", team: 0, kills: 18 }, { name: "p1", team: 0, kills: 18 },
      { name: "p2", team: 0, kills: 9 }, { name: "p3", team: 0, kills: 4 },
    ], [0, 0], false);
    const shared = settled(stakesOutcome(ffa, tied.players, tied.result, FEE_BPS));
    expect(shared.winningGroups).toEqual([0, 1]);
    expect(shared.payouts).toEqual([97_500_000, 97_500_000, 0, 0]);
  });

  it("M: a custom configuration: 0.25 SOL, 30 kills, a 40% team share", () => {
    const { players: roster, result } = match([
      { name: "r1", team: 0, kills: 12 }, { name: "b1", team: 1, kills: 9 },
      { name: "r2", team: 0, kills: 9 }, { name: "b2", team: 1, kills: 8 },
      { name: "r3", team: 0, kills: 6 }, { name: "b3", team: 1, kills: 7 },
      { name: "r4", team: 0, kills: 3 }, { name: "b4", team: 1, kills: 4 },
    ], [30, 28]);
    const paid = settled(stakesOutcome({ stake: 250_000_000, killTarget: 30, teamShareBps: 4_000, groups: 2 }, roster, result, FEE_BPS));
    expect(paid.perKill).toBe(19_000_000);
    expect(paid.payouts).toEqual([573_000_000, 0, 516_000_000, 0, 459_000_000, 0, 402_000_000, 0]);
  });

  it("keeps its invariants on random rosters", () => {
    let seed = 7;
    const random = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
    let settledCount = 0, heldCount = 0, voidCount = 0;
    for (let trial = 0; trial < 4_000; trial += 1) {
      const count = 2 + random(7);
      const teams = random(4) !== 0;
      const groupCount = teams ? 2 : count;
      const rows: Row[] = Array.from({ length: count }, (_, index) => ({
        name: `p${index}`, team: teams ? random(groupCount) : 0, kills: random(60), quit: random(6) === 0,
      }));
      const scores: [number, number] = [random(60) - 3, random(60) - 3];
      const config: StakesConfig = {
        stake: 1 + random(1_000_000_000), killTarget: 1 + random(60), teamShareBps: random(10_001), groups: teams ? 2 : 0,
      };
      const feeBps = random(1_001);
      const { players: roster, result } = match(rows, scores, teams);
      const outcome = stakesOutcome(config, roster, result, feeBps);
      if (outcome.kind === "void") {
        voidCount += 1;
        continue;
      }
      const paid = outcome.kind === "hold" ? (heldCount += 1, outcome.proposed) : (settledCount += 1, outcome);
      const total = pot(count, config.stake);
      expect(paid.payouts.reduce((sum, payout) => sum + payout, 0) + paid.fee).toBe(total);
      expect(paid.fee).toBeLessThanOrEqual(Math.floor((total * feeBps) / 10_000));
      const group = (index: number) => (teams ? rows[index]!.team : index);
      rows.forEach((row, index) => {
        const winner = paid.winningGroups.includes(group(index)) && !row.quit;
        if (winner) expect(paid.payouts[index]!).toBeGreaterThan(config.stake);
        else expect(paid.payouts[index]).toBe(0);
        rows.forEach((other, otherIndex) => {
          const otherWinner = paid.winningGroups.includes(group(otherIndex)) && !other.quit;
          if (winner && otherWinner && row.kills > other.kills) expect(paid.payouts[index]!).toBeGreaterThanOrEqual(paid.payouts[otherIndex]!);
        });
      });
      if (outcome.kind === "hold") expect(outcome.dropped.length).toBeGreaterThan(0);
    }
    expect(settledCount).toBeGreaterThan(0);
    expect(heldCount).toBeGreaterThan(0);
    expect(voidCount).toBeGreaterThan(0);
  });

  it("projects a kill's value and a winner's floor as if the teams were even", () => {
    const projection = stakesProjection(CONFIG, 4, FEE_BPS);
    expect(projection).toEqual({ perKill: 1_425_000, floor: 11_875_000, prize: 95_000_000, winners: 2 });
    expect(stakesProjected(CONFIG, 4, FEE_BPS, 0)).toBe(STAKE + 11_875_000);
    expect(stakesProjected(CONFIG, 4, FEE_BPS, 20)).toBe(STAKE + 11_875_000 + 20 * 1_425_000);
    /* never more than the whole prize */
    expect(stakesProjected(CONFIG, 4, FEE_BPS, 90)).toBe(STAKE + 95_000_000);
    expect(stakesProjection({ ...CONFIG, groups: 0 }, 4, FEE_BPS).winners).toBe(1);
  });

  it("rejects a configuration the program or the rules cannot run", () => {
    expect(stakesConfigProblem(CONFIG)).toBeNull();
    expect(stakesConfigProblem({ ...CONFIG, stake: 0 })).toMatch(/stake/u);
    expect(stakesConfigProblem({ ...CONFIG, killTarget: 0 })).toMatch(/kill target/u);
    expect(stakesConfigProblem({ ...CONFIG, teamShareBps: 10_001 })).toMatch(/team share/u);
    expect(stakesConfigProblem({ ...CONFIG, groups: -1 })).toMatch(/groups/u);
  });
});

describe("held wagers", () => {
  it("are indexed by the wager's reports until they resolve", async () => {
    const matchmaker = env.MATCHMAKER.getByName("main");
    await matchmaker.wagerReport("held-test-match-1", "held", { reason: "group 0 dropped out", deadline: 1_700_000_000_000, limit: null });
    let held = await matchmaker.heldWagers();
    expect(held.find((row) => row.matchId === "held-test-match-1")?.deadline).toBe(1_700_000_000_000);
    await matchmaker.wagerReport("held-test-match-1", "hold_extended", { deadline: 1_700_000_360_000 });
    held = await matchmaker.heldWagers();
    expect(held.find((row) => row.matchId === "held-test-match-1")?.deadline).toBe(1_700_000_360_000);
    await matchmaker.wagerReport("held-test-match-1", "hold_decided", { action: "forfeit" });
    expect((await matchmaker.heldWagers()).some((row) => row.matchId === "held-test-match-1")).toBe(true);
    await matchmaker.wagerReport("held-test-match-1", "settled", {});
    expect((await matchmaker.heldWagers()).some((row) => row.matchId === "held-test-match-1")).toBe(false);
  });

  it("have admin routes behind the admin token", async () => {
    const headers = { Authorization: "Bearer test-only-admin-token-32-bytes-minimum", "Content-Type": "application/json" };
    const unauthorized = await exports.default.fetch(new Request("http://signaling.test/v1/admin/wagers/held"));
    expect(unauthorized.status).toBe(401);
    const list = await exports.default.fetch(new Request("http://signaling.test/v1/admin/wagers/held", { headers }));
    expect(list.status).toBe(200);
    expect(Array.isArray(((await list.json()) as { held: unknown[] }).held)).toBe(true);
    const missing = await exports.default.fetch(new Request("http://signaling.test/v1/admin/wagers/no-such-match-1", { headers }));
    expect(missing.status).toBe(404);
    const notHeld = await exports.default.fetch(new Request("http://signaling.test/v1/admin/wagers/no-such-match-1/decide", {
      method: "POST", headers, body: JSON.stringify({ action: "forfeit", note: "test" }),
    }));
    expect(notHeld.status).toBe(409);
    const invalid = await exports.default.fetch(new Request("http://signaling.test/v1/admin/wagers/no-such-match-1/hold", {
      method: "POST", headers, body: JSON.stringify({ hours: 0, note: "" }),
    }));
    expect(invalid.status).toBe(400);
  });

  it("answer the dashboard's preflight and CORS, and curl without an Origin", async () => {
    const origin = "http://127.0.0.1:8765";
    const preflight = await exports.default.fetch(new Request("http://signaling.test/v1/admin/wagers/held", {
      method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" },
    }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    const headers = { Authorization: "Bearer test-only-admin-token-32-bytes-minimum", Origin: origin };
    const list = await exports.default.fetch(new Request("http://signaling.test/v1/admin/wagers/held", { headers }));
    expect(list.status).toBe(200);
    expect(list.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    const rejected = await exports.default.fetch(new Request("http://signaling.test/v1/admin/wagers/held", {
      headers: { Authorization: "Bearer wrong", Origin: origin },
    }));
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    const forbidden = await exports.default.fetch(new Request("http://signaling.test/v1/admin/wagers/held", {
      headers: { ...headers, Origin: "https://evil.example" },
    }));
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const curl = await exports.default.fetch(new Request("http://signaling.test/v1/admin/wagers/held", {
      headers: { Authorization: headers.Authorization },
    }));
    expect(curl.status).toBe(200);
    expect(curl.headers.get("Access-Control-Allow-Origin")).toBeNull();
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
    expect(formed.match?.wager).toEqual({ stake: STAKE, perKill: PER_KILL, mode: "bounty", stakes: null, escrow: "locking" });
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

  it("carry Team Stakes' rules with the match", async () => {
    const buildId = "wager-test-build-3";
    const matchmaker = env.MATCHMAKER.getByName("main");
    const now = Date.now();
    await matchmaker.registerServer(buildId, null, null, now);
    let formed = null;
    for (const [index, wallet] of ["WalletCCCCcccc3333", "WalletDDDDdddd4444", "WalletEEEEeeee5555", "WalletFFFFffff6666"].entries()) {
      formed = await matchmaker.enqueue({
        buildId, identifier: `00000000ac0${index}`, playerKey: null, playlist: "teamstakes", wallet, now,
      });
    }
    expect(formed?.state).toBe("assigning");
    expect(formed?.match?.wager).toEqual({
      stake: STAKE, perKill: 0, mode: "team", escrow: "locking",
      stakes: { stake: STAKE, killTarget: 50, teamShareBps: DEFAULT_TEAM_SHARE_BPS, groups: 2 },
    });
  });
});
