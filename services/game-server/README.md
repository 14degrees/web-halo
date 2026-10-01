# Game server

One container runs one native Halo dedicated server for browser players:

| Part | What it does |
| --- | --- |
| `halo-server` | The game, built with `ninja server` (`port/server/README.md`). |
| `halo-gateway` | Go, with Pion WebRTC. Opens the server's public room on the signaling Worker, accepts each browser's two DataChannels, carries their frames to the game, runs the lobby (countdown, map rotation), and reports kills to the room. |

The container is about 150 MB. A server idles at about 100 MB of memory.
This replaces `services/dedicated-host`, which ran the browser build in
headless Chrome.

## Build

From the repository root:

```sh
docker build --platform linux/amd64 -f services/game-server/Dockerfile -t halo-game-server .
```

## Run

The game data is not in the image. Mount a folder that holds `maps/` (at
least `ui.map` and the multiplayer maps) at `/data/maps`. `/data` must be
writable (the game writes `debug.txt` there).

```sh
docker run -d --name halo-server --env-file game-server.env \
  --tmpfs /data -v halo-maps:/data/maps:ro \
  -p 8790:8790 -p 40100:40100/udp halo-game-server
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `HALO_SIGNALING_URL` | (required) | The signaling Worker, for example `https://halo-signaling.example.workers.dev`. |
| `HALO_GAME_ORIGIN` | (required) | The game site. It must be in the Worker's `ALLOWED_ORIGINS`. |
| `HALO_HOST_SERVICE_TOKEN` | (required) | The Worker's `HOST_SERVICE_TOKEN` secret. |
| `HALO_WEBRTC_UDP_PORT` | `0` (any) | The one UDP port for all players' WebRTC traffic. Publish it. |
| `HALO_WEBRTC_UDP_HOST` | (all) | The address to receive WebRTC on, where the platform needs one: `fly-global-services` on Fly.io. |
| `HALO_PUBLIC_IP` | (none) | The address players reach the server at. Set it behind a 1:1 NAT (a cloud VM, a container). |
| `HALO_BUILD_ID` | `web-multiplayer-v1` | Must equal the page's `halo-build-id`. Players only join rooms with their build. |
| `HALO_LOBBY_ROTATION` | `bloodgulch:slayer` | Maps and modes in turn, for example `hangemhigh:slayer,prisoner`. |
| `HALO_LOBBY_MIN_PLAYERS` | `1` | Players needed to start the countdown. |
| `HALO_LOBBY_COUNTDOWN_SECONDS` | `20` | The countdown. |
| `HALO_LOBBY_POSTGAME_SECONDS` | `15` | How long the scores show. |
| `HALO_RESTART_FOR_WAITING` | `true` | End a match that has run a minute when a player is waiting to join. Turn it off for wagered play. |
| `PORT`, `HALO_STATUS_ADDRESS` | `:8790` | The status page: JSON with the match state, players and room. |

The server needs a public IP address with inbound UDP. Platforms that only
forward HTTP (Railway, Render) cannot host it. A VM (Hetzner, DigitalOcean,
EC2) or Fly.io can.

## Lease

The gateway pings its room every 15 seconds. The lobby directory stops
offering a dedicated room whose host has not pinged for 60 seconds
(`DEDICATED_HOST_LEASE_MS` in `services/signaling/src/lobby.ts`), so a
crashed server drops out of quick join on its own. Stop a server with
`docker stop`, which closes its room at once.

If the game exits, the gateway exits. If the room link fails eight times in
a row, the gateway stops the game and exits. Run the container with a
restart policy.

## Fly.io

`fly/fly.toml` runs one server in Los Angeles on a shared CPU with 512 MB,
with a dedicated IPv4 address (Fly carries UDP only to dedicated
addresses). Fly answers UDP only from `fly-global-services`, on the same
port outside and in, so the gateway binds there.

Fly mounts no folder at start, so the deployed image includes the maps. It
lives only in the app's private registry. From the repository root:

```sh
docker build --platform linux/amd64 -f services/game-server/Dockerfile -t halo-game-server .
mkdir -p build/fly/maps && cp services/game-server/fly/Dockerfile build/fly/
cp assets/maps/{ui,bloodgulch,hangemhigh,beavercreek,sidewinder,damnation,ratrace,prisoner,chillout,carousel,boardingaction,wizard,putput,longest}.map build/fly/maps/
docker build --platform linux/amd64 -t registry.fly.io/halo-game-lilchocobo:<tag> build/fly
fly auth docker && docker push registry.fly.io/halo-game-lilchocobo:<tag>
fly deploy -c services/game-server/fly/fly.toml --image registry.fly.io/halo-game-lilchocobo:<tag> --ha=false
```

The service credential is a Fly secret: `fly secrets set
HALO_HOST_SERVICE_TOKEN=... -a halo-game-lilchocobo`.
