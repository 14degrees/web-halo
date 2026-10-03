import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { pingTargets } from "../src/index";

const API_ORIGIN = "https://signaling.example";
const GAME_ORIGIN = "https://halo.lilchocobo2.workers.dev";

describe("GET /v1/ping", () => {
  it("answers the page's probe with where else to probe", async () => {
    const response = await exports.default.fetch(new Request(`${API_ORIGIN}/v1/ping`, {
      headers: { Origin: GAME_ORIGIN },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(GAME_ORIGIN);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json<{ ok: boolean; targets: unknown; v: number }>();
    expect(body.ok).toBe(true);
    expect(body.v).toBe(1);
    /* wrangler.jsonc's PING_TARGETS: the one Fly region */
    expect(body.targets).toEqual([
      { id: "lax", label: "Los Angeles", url: "https://halo-game-lilchocobo.fly.dev/ping" },
    ]);
  });

  it("refuses an origin that is not the game's", async () => {
    const response = await exports.default.fetch(new Request(`${API_ORIGIN}/v1/ping`, {
      headers: { Origin: "https://elsewhere.example" },
    }));
    expect(response.status).toBe(403);
  });
});

describe("pingTargets", () => {
  it("lists nothing without the setting, or with a broken one", () => {
    expect(pingTargets(undefined)).toEqual([]);
    expect(pingTargets("")).toEqual([]);
    expect(pingTargets("not json")).toEqual([]);
    expect(pingTargets("{\"id\":\"lax\"}")).toEqual([]);
  });

  it("keeps only well-formed, distinct https targets", () => {
    const targets = pingTargets(JSON.stringify([
      { id: "lax", label: "Los Angeles", url: "https://game.example/ping" },
      { id: "lax", label: "Twice", url: "https://other.example/ping" },
      { id: "Bad Id", label: "Space", url: "https://game.example/ping" },
      { id: "ftp", label: "Scheme", url: "ftp://game.example/ping" },
      { id: "nolabel", label: "", url: "https://game.example/ping" },
      { id: "nourl", label: "No URL" },
      { id: "broken", label: "Broken", url: "::not a url::" },
      "text",
      { id: "fra", label: "Frankfurt", url: "https://fra.example/ping?x=1" },
    ]));
    expect(targets).toEqual([
      { id: "lax", label: "Los Angeles", url: "https://game.example/ping" },
      { id: "fra", label: "Frankfurt", url: "https://fra.example/ping?x=1" },
    ]);
  });
});
