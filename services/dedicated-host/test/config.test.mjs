import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig, parseRotation } from "../config.mjs";

const TOKEN = "test-only-host-service-token-32-bytes-min";

test("rotation accepts names, aliases and indices", () => {
  assert.deepEqual(parseRotation(""), [{ mapIndex: 9, modeIndex: 0 }]);
  assert.deepEqual(parseRotation("bloodgulch:slayer, hangemhigh:team_slayer,2:ctf, blood-gulch"), [
    { mapIndex: 9, modeIndex: 0 },
    { mapIndex: 5, modeIndex: 1 },
    { mapIndex: 2, modeIndex: 2 },
    { mapIndex: 9, modeIndex: 0 },
  ]);
  assert.throws(() => parseRotation("13:0"), /out of range/);
  assert.throws(() => parseRotation("bloodgulch:golf"), /Unknown mode/);
});

test("config requires the service token and validates numbers", () => {
  assert.throws(() => loadConfig({}), /HALO_HOST_SERVICE_TOKEN/);
  const config = loadConfig({
    HALO_HOST_SERVICE_TOKEN: TOKEN,
    HALO_LOBBY_ROTATION: "prisoner:oddball",
    HALO_LOBBY_MIN_PLAYERS: "2",
    HALO_LOBBIES: "3",
    HALO_HEADLESS: "false",
  });
  assert.equal(config.gameUrl, "https://mitchellhynes.com/halo");
  assert.deepEqual(config.rotation, [{ mapIndex: 4, modeIndex: 3 }]);
  assert.equal(config.minimumPlayers, 2);
  assert.equal(config.lobbies, 3);
  assert.equal(config.countdownSeconds, 20);
  assert.equal(config.postgameSeconds, 15);
  assert.equal(config.headless, false);
  assert.throws(() => loadConfig({ HALO_HOST_SERVICE_TOKEN: TOKEN, HALO_LOBBY_MIN_PLAYERS: "0" }), /HALO_LOBBY_MIN_PLAYERS/);
  assert.throws(() => loadConfig({ HALO_HOST_SERVICE_TOKEN: TOKEN, HALO_LOBBY_COUNTDOWN_SECONDS: "999" }), /COUNTDOWN/);
});
