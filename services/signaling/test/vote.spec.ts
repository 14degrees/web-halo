import { describe, expect, it } from "vitest";

import { offeredVote } from "../src/matchmaker";
import { parseVote } from "../src/vote";

/* The post-match vote's pure parts (src/vote.ts): a pick is well formed,
   and a playlist only offers its rotation. (Apart from the HTTP tests in
   postmatch.spec.ts: a source import beside a WebSocket test leaves the
   worker's module resolution pending at teardown.) */

describe("the post-match vote's picks", () => {
  it("parses a pick, and only one the playlist offers", () => {
    expect(parseVote({ mapIndex: 4, modeIndex: 0 })).toEqual({ mapIndex: 4, modeIndex: 0 });
    expect(parseVote({ mapIndex: 13, modeIndex: 0 })).toBeNull();
    expect(parseVote({ mapIndex: "4", modeIndex: 0 })).toBeNull();
    expect(parseVote(undefined)).toBeNull();
    /* Head to Head plays Prisoner, Chill Out, Wizard, Chiron and Longest */
    expect(offeredVote("duel", { mapIndex: 6, modeIndex: 0 })).toEqual({ mapIndex: 6, modeIndex: 0 });
    expect(offeredVote("duel", { mapIndex: 9, modeIndex: 0 })).toBeNull();
    expect(offeredVote("duel", { mapIndex: 6, modeIndex: 1 })).toBeNull();
    expect(offeredVote("duel", null)).toBeNull();
  });

});
