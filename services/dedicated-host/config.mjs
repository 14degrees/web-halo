/* The dedicated host's settings, from the environment. Exported apart from
   the supervisor so they can be tested without a browser. */

export const MAP_NAMES = Object.freeze([
  "beavercreek", "sidewinder", "damnation", "ratrace", "prisoner",
  "hangemhigh", "chillout", "carousel", "boardingaction", "bloodgulch",
  "wizard", "putput", "longest",
]);
export const MAP_ALIASES = Object.freeze({
  "battle-creek": 0, battlecreek: 0, "rat-race": 3, "hang-em-high": 5,
  "chill-out": 6, derelict: 7, "boarding-action": 8, "blood-gulch": 9,
  "chiron-tl-34": 11, chiron: 11,
});
export const MODE_NAMES = Object.freeze([
  "slayer", "team_slayer", "ctf", "oddball", "king", "race", "team_oddball", "team_king",
]);
export const MODE_ALIASES = Object.freeze({
  "team-slayer": 1, teamslayer: 1, "capture-the-flag": 2, "king-of-the-hill": 4, koth: 4,
});

function indexOf(value, names, aliases, kind) {
  const text = String(value).trim().toLowerCase();
  if (/^\d+$/u.test(text)) {
    const index = Number(text);
    if (index >= 0 && index < names.length) return index;
    throw new Error(`${kind} index ${text} is out of range (0-${names.length - 1}).`);
  }
  const byName = names.indexOf(text);
  if (byName >= 0) return byName;
  if (Object.prototype.hasOwnProperty.call(aliases, text)) return aliases[text];
  throw new Error(`Unknown ${kind} "${value}". Use one of: ${names.join(", ")}.`);
}

/* "bloodgulch:slayer,hangemhigh:team_slayer" or "9:0,5:1"; a map alone plays
   slayer. */
export function parseRotation(value) {
  const text = String(value ?? "").trim();
  if (!text) return [{ mapIndex: 9, modeIndex: 0 }];
  return text.split(",").map((entry) => {
    const [map, mode = "slayer"] = entry.split(":").map((part) => part.trim());
    return {
      mapIndex: indexOf(map, MAP_NAMES, MAP_ALIASES, "map"),
      modeIndex: indexOf(mode, MODE_NAMES, MODE_ALIASES, "mode"),
    };
  });
}

function integer(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

export function loadConfig(env = process.env) {
  const serviceToken = String(env.HALO_HOST_SERVICE_TOKEN ?? "").trim();
  if (serviceToken.length < 32) {
    throw new Error("HALO_HOST_SERVICE_TOKEN must hold the signaling Worker's HOST_SERVICE_TOKEN secret.");
  }
  const gameUrl = String(env.HALO_GAME_URL ?? "https://mitchellhynes.com/halo").trim();
  return {
    gameUrl,
    serviceToken,
    lobbies: integer(env.HALO_LOBBIES, 1, 1, 16, "HALO_LOBBIES"),
    rotation: parseRotation(env.HALO_LOBBY_ROTATION),
    minimumPlayers: integer(env.HALO_LOBBY_MIN_PLAYERS, 1, 1, 127, "HALO_LOBBY_MIN_PLAYERS"),
    countdownSeconds: integer(env.HALO_LOBBY_COUNTDOWN_SECONDS, 20, 0, 255, "HALO_LOBBY_COUNTDOWN_SECONDS"),
    postgameSeconds: integer(env.HALO_LOBBY_POSTGAME_SECONDS, 15, 0, 255, "HALO_LOBBY_POSTGAME_SECONDS"),
    hostName: String(env.HALO_HOST_NAME ?? "Server").slice(0, 11) || "Server",
    hostStyle: String(env.HALO_HOST_STYLE ?? "white"),
    /* Platforms such as Railway hand the service a PORT and probe it from
       outside the container, so the status endpoint follows it and listens
       on every interface there; locally it stays on the loopback. */
    statusPort: integer(env.HALO_STATUS_PORT ?? env.PORT, 0, 0, 65535, "HALO_STATUS_PORT"),
    statusHost: env.PORT !== undefined || String(env.HALO_STATUS_PUBLIC ?? "") === "true" ? "0.0.0.0" : "127.0.0.1",
    chromiumNoSandbox: String(env.HALO_CHROMIUM_NO_SANDBOX ?? "") === "true",
    startupTimeoutSeconds: integer(env.HALO_STARTUP_TIMEOUT_SECONDS, 600, 30, 3600, "HALO_STARTUP_TIMEOUT_SECONDS"),
    headless: String(env.HALO_HEADLESS ?? "true") !== "false",
    chromiumPath: String(env.HALO_CHROMIUM_PATH ?? "").trim() || null,
  };
}
