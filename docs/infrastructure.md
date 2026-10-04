# Infrastructure, and how to stand up your own

Everything the online browser game runs on, what each piece does, and how
to deploy a copy on your own Cloudflare and Fly.io accounts. No secrets
here: generate your own as the steps say.

## The pieces

```
 player's browser ──HTTPS──▶ Cloudflare Worker "halo"            the site: the game (WebAssembly) and its assets
        │                    (services/web)
        │ HTTPS + WebSocket
        ├──────────────────▶ Cloudflare Worker "halo-signaling"  rooms, lobbies, matchmaking, parties, wagers,
        │                    (services/signaling)                spectator broadcasts, autoscaling the servers
        │                       ├ Durable Objects  SignalingRoom, LobbyDirectory, Matchmaker, Wager, Party
        │                       ├ KV               HALO_ABUSE (rate-limit and ban state)
        │                       ├ R2               halo-broadcasts (spectator chunks, kept a day)
        │                       ├ Rate limiters    room create, session create, TURN issue
        │                       └ Analytics Engine halo_turn_events
        │ WebRTC (UDP)
        └──────────────────▶ Fly.io app (services/game-server)   dedicated game servers
                               ├ public-0   2 servers: the public games Click to play drops into
                               └ pool-0..2  3 servers each: matchmade matches (the Worker starts and stops them)
                             each server = Halo's Linux build (ninja server) + the Go gateway (WebRTC ⇄ game)

 optional: Solana escrow program (services/escrow) for playing for SOL, on devnet
```

| Piece | Where | Code |
| --- | --- | --- |
| Site Worker `halo` | Cloudflare, Static Assets | `services/web`, `tools/web_stage_cloudflare.py` |
| Signaling Worker `halo-signaling` | Cloudflare | `services/signaling` |
| Game servers | Fly.io app, one dedicated IPv4, UDP | `services/game-server` (Dockerfile, gateway, `fly/`) |
| Escrow program (optional) | Solana devnet | `services/escrow`, `docs/wagers.md` |

How a game reaches a player: the page asks the signaling Worker for a room
(quick join, matchmaking or an invite); the Worker hands back a session;
the page and the game server's gateway exchange WebRTC offers through the
room's Durable Object; then game traffic flows directly over UDP between
the browser and the Fly machine. Spectators don't connect to the server at
all: they download 2-second chunks of the match from R2 through the Worker
(`services/signaling/src/broadcast.ts`).

## What it costs to run (roughly)

- **Cloudflare:** Workers Paid ($5/month) for the Durable Objects and rate
  limiters. R2 for broadcasts stays inside the free tier at small scale.
- **Fly.io:** a dedicated IPv4 (about $2/month) and the machines: public-0
  runs all the time (shared-cpu-2x, 1 GB); the pool machines run only while
  matches need them.

## Before you start

You need:
- A Cloudflare account on **Workers Paid**, with **R2 enabled** (dashboard,
  R2 Object Storage, Enable).
- A Fly.io account with a payment method.
- Tools: Node 22+, `npx wrangler` (comes with each service's `npm install`),
  `flyctl` (`fly auth login`), Docker (with `linux/amd64` builds), Python
  3.12, Go 1.25 (tests only), and the Emscripten SDK for the web build
  (`tools/web_run.py` can install it at `build/emsdk`).
- **The game data.** Nothing here ships Halo's files. Extract the `maps/`
  folder from your own copy of Halo: Combat Evolved for Xbox (README.md,
  "Download"; `tools/web_run.py --iso <your.iso>` does it). Only host game
  data you're entitled to host.

Pick your names now; they appear below as placeholders:

| Placeholder | Example | Used for |
| --- | --- | --- |
| `<cf-subdomain>` | `yourname` | `*.<cf-subdomain>.workers.dev` |
| `<site>` | `https://halo.yourname.workers.dev` | the site Worker's URL |
| `<signaling>` | `https://halo-signaling.yourname.workers.dev` | the signaling Worker's URL |
| `<fly-app>` | `halo-game-yourname` | the Fly app |
| `<fly-ipv4>` | from `fly ips allocate-v4` | the servers' public address |

## 1. Secrets you generate

```sh
openssl rand -hex 32   # HOST_SERVICE_TOKEN: the game servers' credential (Worker and Fly both get it)
openssl rand -hex 32   # ROOM_ID_SECRET: signs room IDs
openssl rand -hex 32   # ABUSE_ID_SECRET: hashes abuse identifiers
openssl rand -hex 32   # ADMIN_TOKEN: the /v1/admin routes
```

Keep them in a private file (this repo's `build/` is gitignored; ours live
in `build/ops/`). Never commit them.

## 2. The signaling Worker (Cloudflare)

In `services/signaling/wrangler.jsonc`, change:
- `vars.FLY_APP_NAME` → `<fly-app>`
- `vars.ALLOWED_ORIGINS` → `<site>` (keep the localhost entries for local dev)
- `vars.PUBLIC_GAME_URL` → `<site>`
- `vars.CLOUDFLARE_ACCOUNT_ID` → your account ID (`npx wrangler whoami`)
- `kv_namespaces[0].id` → the ID from the next step

Then:

```sh
cd services/signaling && npm install
npx wrangler kv namespace create HALO_ABUSE          # put the id in wrangler.jsonc
npx wrangler r2 bucket create halo-broadcasts
npx wrangler r2 bucket lifecycle add halo-broadcasts expire-chunks --expire-days 1 --force

# secrets (each command prompts for the value)
npx wrangler secret put HOST_SERVICE_TOKEN
npx wrangler secret put ROOM_ID_SECRET
npx wrangler secret put ABUSE_ID_SECRET
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put FLY_API_TOKEN               # `fly tokens create deploy -a <fly-app>`: lets the
                                                    # matchmaker start and stop pool machines
npx wrangler deploy
```

Optional secrets:
- `TURN_KEY_ID`, `TURN_KEY_SECRET`: a Cloudflare Realtime TURN key, for
  players behind strict NATs (without it, STUN only).
- `TURNSTILE_SECRET` plus `vars.TURNSTILE_HOSTNAMES`: bot checks on joins
  (off when the hostname list is empty).
- Playing for SOL: `ESCROW_AUTHORITY_SECRET_KEY`, `ESCROW_SESSION_SECRET`,
  `SOLANA_RPC_PRIVATE_URL`, `ALERT_WEBHOOK_URL`, plus `vars.ESCROW_*` and
  `vars.SOLANA_*`. See `docs/wagers.md`. Without them, money playlists are
  off (and hidden in the page unless `?sol=1`).

Check: `curl <signaling>/v1/health` → `{"ok":true,"v":1}`.

## 3. The site Worker (Cloudflare)

Point the page at your signaling Worker: the build reads it from the
`halo-signaling-url` meta tag in `port/web/shell.html`. Change
`https://halo-signaling.lilchocobo2.workers.dev` there to `<signaling>`.

```sh
# the game, built to build/web (first time: python3 configure.py, see README.md)
EMSDK_PYTHON=$(brew --prefix python@3.12)/bin/python3.12 ninja web
# multiplayer maps from your game data into the repo's assets/maps/ (gitignored)
cd services/web && npm install && npm run deploy  # stages build/cloudflare-web, deploys "halo"
```

Open `<site>`. It should load the game; Click to play needs the servers
below.

## 4. The game servers (Fly.io)

```sh
fly apps create <fly-app>
fly ips allocate-v4 -a <fly-app>                    # a dedicated IPv4: UDP needs one. Note it: <fly-ipv4>
fly secrets set HALO_HOST_SERVICE_TOKEN=<same as the Worker's> -a <fly-app>
```

Change the hard-coded names:
- `services/game-server/fly/fly.toml`: `app`, `HALO_SIGNALING_URL`,
  `HALO_GAME_ORIGIN`, `HALO_PUBLIC_IP`
- `services/game-server/fly/pool.py`: `APP`, `PUBLIC_IP`, and the two URLs
  in `ENV`

Build the image. The game data goes in at build time (Fly has no volume at
machine start), so build a second image on top with your `maps/`:

```sh
docker build --platform linux/amd64 -f services/game-server/Dockerfile -t halo-game-server .
mkdir -p build/fly && cp services/game-server/fly/Dockerfile build/fly/ && cp -R <your maps/> build/fly/maps
docker build --platform linux/amd64 -t registry.fly.io/<fly-app>:v1 build/fly
fly auth docker && docker push registry.fly.io/<fly-app>:v1
```

**Matchmaking pool** (3 machines, 3 servers each on UDP 40100-40122; pool-0
stays up, the Worker starts the others when matches need them):

```sh
python3 services/game-server/fly/pool.py registry.fly.io/<fly-app>:v1
```

**Public servers** (Click to play: always-on games players join mid-round).
Write `public-0.json`:

```json
{
  "image": "registry.fly.io/<fly-app>:v1",
  "guest": { "cpu_kind": "shared", "cpus": 2, "memory_mb": 1024 },
  "env": {
    "HALO_SIGNALING_URL": "<signaling>",
    "HALO_GAME_ORIGIN": "<site>",
    "HALO_MODE": "open",
    "HALO_SERVERS": "2",
    "HALO_WEBRTC_UDP_HOST": "fly-global-services",
    "HALO_WEBRTC_UDP_PORT": "40200",
    "HALO_PUBLIC_IP": "<fly-ipv4>",
    "HALO_LOBBY_ROTATION": "hangemhigh:slayer,chillout:team_oddball,prisoner:slayer,beavercreek:ctf,carousel:slayer,damnation:team_slayer,ratrace:team_king,wizard:slayer,longest:slayer,putput:slayer",
    "HALO_LOBBY_MIN_PLAYERS": "1",
    "HALO_LOBBY_COUNTDOWN_SECONDS": "3",
    "HALO_LOBBY_POSTGAME_SECONDS": "10",
    "HALO_RESTART_FOR_WAITING": "false",
    "HALO_ROOM_CAPACITY": "17",
    "HALO_HOST_NAME": "Public"
  },
  "services": [
    { "protocol": "udp", "internal_port": 40200, "ports": [{ "port": 40200 }] },
    { "protocol": "udp", "internal_port": 40201, "ports": [{ "port": 40201 }] }
  ],
  "restart": { "policy": "always" }
}
```

```sh
fly machine run registry.fly.io/<fly-app>:v1 --machine-config public-0.json --name public-0 --region lax -a <fly-app>
```

Ports: every server needs its own UDP port across the whole app (Fly routes
a shared IP's UDP by port). Public uses 40200+, pool machine N uses
40100 + 10·N onward. Map and mode names for the rotation:
`services/game-server/gateway/main.go` (`mapNames`, `modeNames`).

Check: within a minute `curl -H "Origin: <site>" "<signaling>/v1/lobbies?buildId=web-multiplayer-v1"`
lists two dedicated rooms; `fly logs -a <fly-app>` shows each gateway
opening its room.

## 5. Updating

| What changed | Do |
| --- | --- |
| Page or engine (web) | `ninja web`, then `npm run deploy` in `services/web` |
| Signaling Worker | `npx wrangler deploy` in `services/signaling` |
| Game server or gateway | build both images with a new tag, push, then `fly machine update <public-0 id> --machine-config public-0.json --yes -a <fly-app>` and `python3 services/game-server/fly/pool.py <image>` |
| Public rotation or settings | edit `public-0.json`, `fly machine update …` (restarts the public games) |

Netcode changes usually need the site, the Worker and the servers updated
together. Restarting a server drops its players for about 15 seconds:
check `/v1/lobbies` and `/v1/matchmaker` first.

## 6. Running it all locally

Useful before touching anything live (we test netcode this way):

1. `services/signaling/.dev.vars` with `HOST_SERVICE_TOKEN`, `ROOM_ID_SECRET`,
   `ABUSE_ID_SECRET` (any long random values), then
   `npx wrangler dev --port 8787 --ip 0.0.0.0` (local Durable Objects, KV and R2).
2. The server image in Docker pointed at it:
   `-e HALO_SIGNALING_URL=http://host.docker.internal:8787 -e HALO_GAME_ORIGIN=http://localhost:8765
   -e HALO_PUBLIC_IP=127.0.0.1 -e HALO_WEBRTC_UDP_PORT=40300 -p 40300:40300/udp`, plus the
   public-server env above.
3. `npm run stage` in `services/web`, copy `build/cloudflare-web`
   somewhere, change the `halo-signaling-url` in its `index.html` to
   `http://localhost:8787`, and serve the folder on port 8765 with the
   headers `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp` (the game uses threads).

## Where things live in this deployment

For reference, ours: site `https://halo.lilchocobo2.workers.dev`,
signaling `https://halo-signaling.lilchocobo2.workers.dev`, Fly app
`halo-game-lilchocobo` in `lax` (IPv4 37.16.2.146), machines `public-0`
and `pool-0..2`, R2 bucket `halo-broadcasts`, escrow program
`3dPU7bDe3Bqfzx7z2g4hVr9cNQGeZqR1oHCkti5uD3bJ` on devnet. Secrets and
machine configs are kept outside git in `build/ops/` on the maintainer's
machine.
