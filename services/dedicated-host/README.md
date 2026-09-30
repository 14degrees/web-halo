# Halo Web dedicated host

This directory runs the browser build as a **dedicated public-lobby host**:
a headless Chromium on a server you operate loads the deployed game page,
creates a public room with the signaling Worker's service credential, and
keeps it open around the clock. Players press **Join multiplayer** in their
browser and land in it. The game's own driver
(`port/web/src/web_online_ui.c`) starts a game when enough players are in,
ends a game everyone has left, and brings the lobby back after each game with
the next map of the rotation. This process only supervises: it restarts a page
whose room closed or whose runtime died, and reports status.

Nothing from the game is copied into the container. It loads the public page
exactly as a player does, so the deployment must carry a browser build that
includes the dedicated-host mode (this repository's `port/web` and
`port/web/src` at or after the commit that added
`platform_web_online_host_dedicated`).

## Requirements

- The signaling Worker deployed with `HOST_SERVICE_TOKEN` set
  (`services/signaling/README.md`). The same value goes in
  `HALO_HOST_SERVICE_TOKEN` here. It is a server-to-server secret: never put
  it in a page or share it with players.
- Per lobby: about 3 GB of memory (the game reserves 2.3 GB up front, plus
  Chromium), one CPU core, and outbound bandwidth that grows with the square
  of the player count, since the host sends every player's state to every
  guest. A public IP gives guests direct WebRTC paths, so TURN relay is rarely
  needed.
- Node.js 22 or newer and a Chromium Playwright can drive. The Dockerfile uses
  Microsoft's Playwright image, which ships both.

## Run

```sh
cd services/dedicated-host
npm ci
HALO_HOST_SERVICE_TOKEN=... HALO_LOBBY_ROTATION="bloodgulch:slayer,hangemhigh:team_slayer" npm start
```

Or in Docker:

```sh
docker build -t halo-dedicated-host services/dedicated-host
docker run -d --name halo-lobby --restart unless-stopped \
  --shm-size=1g --memory=4g \
  -e HALO_HOST_SERVICE_TOKEN=... \
  -e HALO_LOBBY_ROTATION="bloodgulch:slayer,hangemhigh:team_slayer,prisoner:ctf" \
  -p 127.0.0.1:8790:8790 \
  halo-dedicated-host
```

`--restart unless-stopped` matters: the process exits deliberately when the
browser dies so the container runtime brings it back.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `HALO_HOST_SERVICE_TOKEN` | required | The Worker's `HOST_SERVICE_TOKEN` secret |
| `HALO_GAME_URL` | `https://mitchellhynes.com/halo` | The deployed game page |
| `HALO_LOBBIES` | `1` | Lobbies (pages) this process runs; each is its own public room |
| `HALO_LOBBY_ROTATION` | `bloodgulch:slayer` | Comma-separated `map:mode` entries played in turn; a map alone plays slayer. Maps: `beavercreek`, `sidewinder`, `damnation`, `ratrace`, `prisoner`, `hangemhigh`, `chillout`, `carousel` (Derelict), `boardingaction`, `bloodgulch`, `wizard`, `putput` (Chiron TL-34), `longest`, or their index 0-12. Modes: `slayer`, `team_slayer`, `ctf`, `oddball`, `king`, `race`, or 0-5 |
| `HALO_LOBBY_MIN_PLAYERS` | `1` | Players besides the host needed before the countdown starts |
| `HALO_LOBBY_COUNTDOWN_SECONDS` | `20` | Seconds enough players must be in the lobby before the game starts |
| `HALO_LOBBY_POSTGAME_SECONDS` | `15` | Seconds the carnage report shows before the lobby returns |
| `HALO_HOST_NAME` | `Server` | The host player's name (11 characters); numbered when `HALO_LOBBIES` is above 1 |
| `HALO_HOST_STYLE` | `white` | The host player's armor color |
| `HALO_STATUS_PORT` | `0` (off) | Serves `GET /status` on 127.0.0.1 with each lobby's room, match state and player count |
| `HALO_HEADLESS` | `true` | `false` shows the browser window, for watching a lobby on a desktop |
| `HALO_STARTUP_TIMEOUT_SECONDS` | `600` | How long the game may take to start before the page is reloaded |
| `HALO_CHROMIUM_PATH` | unset | A Chromium executable, when not using the Playwright image |

## How a lobby runs

1. The page loads with `window.HALO_DEDICATED` set, so the game starts without
   a renderer (`HALO_NULL_RENDERER`): no GPU is needed.
2. Once Halo's runtime is ready, `HaloOnline.hostDedicated` creates the room
   (`POST /v1/rooms` with `dedicated: true` and the bearer credential) and
   hands Halo the first map, the minimum player count, and the timings.
3. Halo opens its lobby with the host's own player in it. The lobby directory
   ranks a dedicated room first, so quick join fills it before any
   player-hosted room.
4. When the players besides the host reach the minimum for the countdown
   time, the driver asks the server to start, as the host pressing Start
   does. While a game runs with nobody but the host left in it for 30
   seconds, the driver ends it.
5. When the carnage report comes up, the page moves the rotation on, tells
   Halo the next map, and republishes the lobby through the renew route. After
   the postgame pause the driver returns the server to the pregame and puts
   the lobby screen back with the next map on it.
6. The page renews the room every 50 minutes with the dedicated TTL, so it
   never expires while the host runs. Leaving (SIGTERM) closes the room.

## Known limits

- **The host is a player.** Xbox Halo has no server without a player on it:
  the game refuses to start unless every machine, the host's included, has
  one. The dedicated host therefore has an idle Spartan in every game, named
  `HALO_HOST_NAME`. It counts on the scoreboard and can be killed. Removing it
  needs engine work and is the next step.
- **One host, one game at a time.** A lobby is one Halo game of up to 127
  guests. For more concurrent games, raise `HALO_LOBBIES` or run more
  containers; each is its own room and the directory fills the fullest first.
- **No vote.** The rotation is fixed per process; change it and restart.
- **Untested against a live build in this repository's CI.** The browser
  build is produced and deployed outside Git; the driver's game-thread code
  follows `port/linux/game/network_test.c`, which hosts and starts games the
  same way, but it has not run here.

## Verify

```sh
npm test
node --check host.mjs
```

The tests cover the rotation and settings parsing. Driving a real browser is
exercised by running the host against a deployment.
