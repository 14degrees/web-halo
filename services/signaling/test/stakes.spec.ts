import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  STAKE_TIERS,
  chosenStake,
  customStakesProblem,
  customWager,
  playlistTiers,
  playlistWager,
} from "../src/matchmaker";

/* Stakes the player picks (src/matchmaker.ts, STAKE_TIERS): a wagered
   playlist's tiers, a ticket matching only tickets at its stake, and a
   party's custom game for SOL on terms every member accepted. */

const API = "http://signaling.test";
const ORIGIN = "http://127.0.0.1:8765";
const SOL = 1_000_000_000;
let address = 0;
let nextMachine = 0x900;

async function call(method: string, path: string, body?: unknown) {
  address += 1;
  const response = await exports.default.fetch(new Request(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": `198.51.100.${address % 250}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, body: await response.json<Record<string, any>>() };
}

function player(name: string) {
  nextMachine += 1;
  return {
    playerKey: `stakes-test-key-${name}-${nextMachine}`,
    identifier: nextMachine.toString(16).padStart(12, "0"),
    profile: { name, style: "sage" },
  };
}

describe("stake tiers", () => {
  it("scale a playlist's terms with the stake picked", () => {
    expect(playlistTiers("bountyduel")).toEqual(STAKE_TIERS);
    expect(playlistTiers("duel")).toEqual([]);
    /* the bounty stays a fifth of the stake */
    expect(playlistWager("bountyduel", SOL / 100)).toMatchObject({ stake: SOL / 100, perKill: SOL / 500 });
    expect(playlistWager("bountyduel", SOL / 10)).toMatchObject({ stake: SOL / 10, perKill: SOL / 50 });
    expect(playlistWager("bountyduel")).toMatchObject({ stake: SOL / 20, perKill: SOL / 100 });
    expect(playlistWager("teamstakes", SOL / 10)?.stakes).toEqual({ stake: SOL / 10, killTarget: 50, teamShareBps: 2_500, groups: 2 });
    /* a ticket names a tier, or gets the default; anything else is refused */
    expect(chosenStake("teamstakes", undefined)).toBe(SOL / 20);
    expect(chosenStake("teamstakes", SOL / 100)).toBe(SOL / 100);
    expect(chosenStake("teamstakes", SOL / 3)).toBeNull();
    expect(chosenStake("teamstakes", "0.05")).toBeNull();
    expect(chosenStake("duel", SOL / 100)).toBeNull();
  });

  it("keep every tier within the escrow's devnet maximum stake and a session's limit", () => {
    for (const tier of STAKE_TIERS) {
      expect(tier).toBeGreaterThan(0);
      expect(tier).toBeLessThanOrEqual(SOL / 10);
    }
  });

  it("match a ticket only with tickets at its stake", async () => {
    const buildId = "stakes-test-build-1";
    const matchmaker = env.MATCHMAKER.getByName("main");
    const now = Date.now();
    await matchmaker.registerServer(buildId, null, null, now);
    const queue = (index: number, stake: number) => matchmaker.enqueue({
      buildId, identifier: `0000000d0a0${index}`, playerKey: null, playlist: "bountyduel",
      wallet: `StakesWallet${index}AAAA`, stake, now,
    });
    const low = await queue(1, SOL / 100);
    const high = await queue(2, SOL / 10);
    /* two players for a duel, but at different stakes: no match */
    expect(low.state).toBe("queued");
    expect(high.state).toBe("queued");
    expect(high.stake).toBe(SOL / 10);
    expect(high.queued).toBe(1);
    const lists = await matchmaker.playlists(now);
    const duel = lists.find((entry) => entry.id === "bountyduel")!;
    expect(duel.tiers.map((tier) => [tier.stake, tier.perKill])).toEqual(STAKE_TIERS.map((stake) => [stake, stake / 5]));
    expect(duel.tiers.find((tier) => tier.stake === SOL / 100)!.searching).toBeGreaterThanOrEqual(1);
    /* a second player at the low stake: a match, at that stake */
    const formed = await queue(3, SOL / 100);
    expect(formed.state).toBe("assigning");
    expect(formed.match?.wager).toMatchObject({ stake: SOL / 100, perKill: SOL / 500, mode: "bounty", escrow: "locking" });
    expect((await matchmaker.poll(high.id, now))?.state).toBe("queued");
  });

  it("refuse a stake that is not one of the playlist's tiers", async () => {
    const result = await call("POST", "/v1/queue", {
      protocolVersion: 1, buildId: "stakes-test-build-2", identifier: "0000000d0b01", playlist: "teamstakes", stake: SOL / 3,
    });
    expect(result.status).toBe(400);
  });

  it("list the tiers and what a custom game can be set to", async () => {
    const result = await call("GET", "/v1/playlists");
    expect(result.body.stakes).toMatchObject({ tiers: [...STAKE_TIERS], killTarget: { minimum: 5, maximum: 100 } });
    expect(typeof result.body.stakes.feeBps).toBe("number");
    expect(result.body.playlists.find((entry: { id: string }) => entry.id === "teamstakes").tiers).toHaveLength(STAKE_TIERS.length);
  });
});

describe("a custom game for SOL", () => {
  it("checks its terms and plays by Team Stakes rules, in teams or each alone", () => {
    const terms = { stake: SOL / 100, killTarget: 25, teamShareBps: 5_000 };
    expect(customStakesProblem(terms)).toBeNull();
    expect(customStakesProblem({ ...terms, stake: SOL / 7 })).toMatch(/tiers/u);
    expect(customStakesProblem({ ...terms, killTarget: 2 })).toMatch(/kill target/u);
    expect(customStakesProblem({ ...terms, killTarget: 25.5 })).toMatch(/kill target/u);
    expect(customStakesProblem({ ...terms, teamShareBps: 10_001 })).toMatch(/team share/u);
    expect(customWager(terms, 1).stakes).toEqual({ ...terms, groups: 2 });
    expect(customWager(terms, 0)).toEqual({ stake: SOL / 100, perKill: 0, mode: "team", stakes: { ...terms, groups: 0 } });
  });

  it("starts only once every member accepted the terms they were shown", async () => {
    const buildId = "stakes-test-build-3";
    const leader = player("Leader");
    const friend = player("Friend");
    const created = await call("POST", "/v1/parties", { buildId, ...leader, lobby: "custom", mapIndex: 6, modeIndex: 0 });
    const code = created.body.party.code as string;
    expect(created.body.party).toMatchObject({ stake: null, customStakes: null });
    await call("POST", `/v1/parties/${code}/join`, friend);
    const terms = { stake: SOL / 20, killTarget: 25, teamShareBps: 5_000 };
    expect((await call("POST", `/v1/parties/${code}/settings`, { ...leader, customStakes: { ...terms, killTarget: 1 } })).status).toBe(400);
    expect((await call("POST", `/v1/parties/${code}/settings`, { ...friend, customStakes: terms })).status).toBe(403);
    const set = await call("POST", `/v1/parties/${code}/settings`, { ...leader, customStakes: terms });
    expect(set.body.party.customStakes).toEqual(terms);
    const shown = (await call("POST", `/v1/parties/${code}/poll`, friend)).body.party;
    expect(shown.customStakes).toEqual(terms);
    expect(shown.members.map((member: { accepted: boolean }) => member.accepted)).toEqual([true, false]);

    const refused = await call("POST", `/v1/parties/${code}/start`, leader);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("STAKES_NOT_ACCEPTED");
    expect(refused.body.error.message).toContain("Friend");

    /* the leader changes the terms after the friend saw them: the old ones
       can't be accepted */
    await call("POST", `/v1/parties/${code}/settings`, { ...leader, customStakes: { ...terms, killTarget: 50 } });
    const stale = await call("POST", `/v1/parties/${code}/accept`, { ...friend, terms: shown.terms });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("TERMS_CHANGED");
    const current = (await call("POST", `/v1/parties/${code}/poll`, friend)).body.party;
    expect(current.terms).toBeGreaterThan(shown.terms);
    const accepted = await call("POST", `/v1/parties/${code}/accept`, { ...friend, terms: current.terms });
    expect(accepted.status).toBe(200);
    expect(accepted.body.party.members.every((member: { accepted: boolean }) => member.accepted)).toBe(true);

    /* accepted, but nobody here has a wallet to stake from */
    const unready = await call("POST", `/v1/parties/${code}/start`, leader);
    expect(unready.body.error.code).toBe("STAKE_NOT_READY");

    /* a new game type changes what the terms mean: accept again */
    const moved = await call("POST", `/v1/parties/${code}/settings`, { ...leader, modeIndex: 1 });
    expect(moved.body.party.members.map((member: { accepted: boolean }) => member.accepted)).toEqual([true, false]);
    /* the map doesn't */
    await call("POST", `/v1/parties/${code}/accept`, { ...friend, terms: moved.body.party.terms });
    const mapped = await call("POST", `/v1/parties/${code}/settings`, { ...leader, mapIndex: 3 });
    expect(mapped.body.party.members.every((member: { accepted: boolean }) => member.accepted)).toBe(true);

    /* back to a free game: it starts without anyone's stake */
    await call("POST", `/v1/parties/${code}/settings`, { ...leader, customStakes: null });
    expect((await call("POST", `/v1/parties/${code}/start`, leader)).body.error.code).toBe("NO_SERVER_FREE");
  });

  it("stakes the members' wallets with the match when it starts", async () => {
    const buildId = "stakes-test-build-4";
    const matchmaker = env.MATCHMAKER.getByName("main");
    const now = Date.now();
    await matchmaker.registerServer(buildId, null, null, now);
    const terms = { stake: SOL / 100, killTarget: 10, teamShareBps: 0 };
    const started = await matchmaker.startCustom({
      partyId: "STAKE1", buildId, mapIndex: 4, modeIndex: 0, now, stakes: terms,
      members: [
        { key: "stakes-custom-a", identifier: "0000000d0c01", wallet: "StakesCustomWalletA" },
        { key: "stakes-custom-b", identifier: "0000000d0c02", wallet: "StakesCustomWalletB" },
      ],
    });
    expect("tickets" in started).toBe(true);
    if (!("tickets" in started)) return;
    const view = await matchmaker.poll(started.tickets["stakes-custom-a"]!, now);
    expect(view?.stake).toBe(SOL / 100);
    expect(view?.match?.wager).toEqual({
      stake: SOL / 100, perKill: 0, mode: "team", escrow: "locking", stakes: { ...terms, groups: 0 },
    });
  });
});
