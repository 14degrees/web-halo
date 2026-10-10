# Halo Web signaling service

This directory is an isolated Cloudflare Worker that coordinates invite-link
WebRTC connections. Each room is one SQLite-backed, hibernating Durable Object.
Only room membership and SDP/ICE signaling pass through Cloudflare; Halo game
packets travel over browser-to-browser WebRTC data channels (or Cloudflare TURN
when a direct path is impossible).

The service deliberately has no account system or database. A random invite is
the guest capability, and a separate random capability is retained by the host.

Rooms are private by default. A **public** room is additionally listed in the
lobby directory (one singleton Durable Object) so that **quick join** can seat a
player in it without an invite. A public room's guests need no ticket; the room
object mints a ticket-less guest session only for a public room. The directory
holds ranking data, never a capability, so a stale listing costs a failed
attempt, never an unauthorised join.

## Local development

Use Node.js 22 or 24+.

```sh
cd services/signaling
npm ci
npm run types
npm test
npm run dev
```

The deployed configuration permits these exact browser origins:

- `https://halo-web.otherness-bugs.workers.dev`
- `http://127.0.0.1:8765`
- `http://localhost:8765`

Requests without an `Origin` header are rejected by the safe-by-default
production configuration. The `*` origin is honored only when
`ENVIRONMENT=development`; use it only for isolated development. If the game
moves to another hostname, update both `ALLOWED_ORIGINS` and `PUBLIC_GAME_URL`
before deploying the signaling service.

## Configuration

Non-secret settings live in `wrangler.jsonc`:

| Setting | Meaning |
| --- | --- |
| `ALLOWED_ORIGINS` | Comma-separated, exact browser origins accepted by HTTP and WebSocket routes |
| `PUBLIC_GAME_URL` | URL used to construct the copyable `#join=...` invite |
| `ROOM_TTL_SECONDS` | Absolute room lifetime; default six hours, maximum one day |
| `SESSION_TTL_SECONDS` | Lifetime of a single-use WebSocket credential; default 30 seconds |
| `TURN_TTL_SECONDS` | TURN credential lifetime; default one hour, maximum two hours here |
| `DEFAULT_ROOM_CAPACITY` | Capacity including the host; default 128 |
| `MAX_ROOM_CAPACITY` | Hard capacity ceiling; 128 machines |
| `DEDICATED_ROOM_TTL_SECONDS` | Room lifetime for a dedicated host between renewals; default one day |
| `PUBLIC_LOBBY_MAP_INDEX`, `PUBLIC_LOBBY_MODE_INDEX` | The lobby quick join opens when no public room exists; default Blood Gulch (9) Slayer (0), in the order of `port/web/src/web_online_ui.h` |
| `FOMO_FEE_PAYER` | The mainnet wallet fomo.family pays its users' fees from; a wallet it paid for is a fomo wallet (`src/fomo.ts`) |
| `FOMO_REFERRAL_CODE` | The referral code in the landing's fomo.family link (`https://fomo.family/r/<code>`, `src/site.ts`); default `ARCH` |
| `X_PROFILE_URL` | The game's X profile, shown on the landing once set; empty (no account chosen) hides the link |

`wrangler types` generates `worker-configuration.d.ts` from this file. The only
manual environment augmentation is the required room-signing secret and the two
optional secret-backed TURN values; all normal bindings and variables use the
generated `Env` type.

Create the signing secret once before the first production deploy. Signed room
IDs let the Worker reject forged/nonexistent rooms before allocating a Durable
Object:

```sh
openssl rand -hex 32 | npx wrangler secret put ROOM_ID_SECRET
```

A dedicated host (a server-run copy of the browser build that keeps a public
lobby open; `services/dedicated-host/README.md`) authenticates with a
separate bearer secret instead of Turnstile. It is optional; without it,
public rooms are only ever hosted by players' browsers:

```sh
openssl rand -hex 32 | npx wrangler secret put HOST_SERVICE_TOKEN
```

Bounty playlists (playing for SOL through the escrow program) need two more
secrets, `ESCROW_AUTHORITY_SECRET_KEY` and `ESCROW_SESSION_SECRET`; without
them those playlists are off. Refer to [docs/wagers.md](../../docs/wagers.md).

fomo.family detection (`src/fomo.ts`) reads Solana **mainnet**, while the
game stays on `SOLANA_CLUSTER`, through one more secret: a mainnet RPC URL
with its key in it (Helius or similar). Without it, detection is off and
`GET /v1/site` says so (`fomoDetection: false`):

```sh
npx wrangler secret put FOMO_RPC_URL
```

A signed-in wallet is looked up once a day at most (a wallet once seen on
fomo is never looked up again), through at most 51 RPC calls per look-up,
so a free plan is enough. `wrangler types` folds any secret it finds in
`.dev.vars` into `worker-configuration.d.ts`; run it (and `npm run check`)
without that file, or the committed types will not match elsewhere.

The configured rate-limit bindings cap room creation at 20 per minute and
session creation at 512 per minute for one connecting address in one Cloudflare
location. They are an abuse backstop, not billing or quota accounting.

### Optional TURN

The service always returns Cloudflare STUN. It becomes TURN-enabled only when
both of these values exist:

```sh
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_SECRET
```

For local development, put the required room-signing secret and any optional
TURN values in an ignored `.dev.vars` file instead:

```dotenv
ROOM_ID_SECRET=replace-with-at-least-32-random-characters
TURN_KEY_ID=your-turn-key-id
TURN_KEY_SECRET=your-turn-api-token
FOMO_RPC_URL=https://mainnet.helius-rpc.com/?api-key=your-key
```

Deploy the signaling service before the static browser build:

```sh
npm run deploy
```

The Worker creates a different short-lived credential after each successful
room/session authorization. It calls Cloudflare's current
`credentials/generate-ice-servers` endpoint, validates the response, and
removes port 53 URLs because browsers block them. If TURN is unconfigured or
temporarily fails, the response safely falls back to STUN only.

The browser should use:

```js
const peer = new RTCPeerConnection({
  iceServers: response.iceServers,
  iceTransportPolicy: "all",
});
```

`iceTransportPolicy: "all"` is important: it attempts a free direct connection
before TURN relay traffic. `iceServersExpiresAt` is `null` for STUN-only
responses and an epoch-millisecond timestamp when TURN credentials are present.

## HTTP API

All response bodies are JSON, all mutable responses use `Cache-Control:
no-store`, and protocol version 1 is represented as `v: 1`. Browser requests
must carry an allowed `Origin`. Request bodies are limited to 4096 bytes.

### Health

```http
GET /v1/health
```

```json
{ "ok": true, "v": 1 }
```

### Ping

```http
GET /v1/ping
```

The page's ping before a match (`port/web/online_client.js`, `refreshPing`):
the browser times a few of these to this Worker, and the response lists
where else to probe, one URL per game region (`PING_TARGETS`, a JSON list;
each is a game server gateway's `GET /ping`, which answers 204 from any
origin). The page shows the nearest region's round trip on the landing and
in the lobby, with the scoreboard's colors (under 80 ms green, under 150 ms
yellow). Region-aware matchmaking can later take the page's measurements
by these ids.

```json
{
  "ok": true,
  "targets": [
    { "id": "lax", "label": "Los Angeles", "url": "https://halo-game-lilchocobo.fly.dev/ping" }
  ],
  "v": 1
}
```

### Create a room

```http
POST /v1/rooms
Content-Type: application/json
Origin: https://play.example.com
```

```json
{
  "protocolVersion": 1,
  "buildId": "streamhash-2026-09-28",
  "identifier": "001122334455",
  "capacity": 128
}
```

`identifier` is the lowercase 12-hex identifier used by the web transport's
XNADDR mapping. Capacity includes the host.

Optional fields:

| Field | Meaning |
| --- | --- |
| `visibility` | `"private"` (default) or `"public"`. A public room is listed for quick join. |
| `lobby` | `{ "mapIndex": 0-12, "modeIndex": 0-5 }`, shown to joiners and used by the host's game. A public room without one gets the configured default. |
| `dedicated` | `true` only with `Authorization: Bearer <HOST_SERVICE_TOKEN>`. Skips Turnstile, defaults to public, uses `DEDICATED_ROOM_TTL_SECONDS`, and ranks first in quick join. Without the credential the request fails with `403 DEDICATED_HOST_UNAUTHORIZED`. |

The response is:

```json
{
  "v": 1,
  "room": {
    "id": "7VQS-D96P-8WHA-Q3TC",
    "buildId": "streamhash-2026-09-28",
    "protocolVersion": 1,
    "capacity": 128,
    "expiresAt": 1790630000000,
    "visibility": "private",
    "dedicated": false,
    "lobby": null
  },
  "host": {
    "ticket": "host-capability-kept-by-the-host",
    "session": {
      "peerId": "h_NjczMDAzNjQxYjAw",
      "identifier": "001122334455",
      "role": "host",
      "token": "single-use-websocket-token",
      "websocketUrl": "wss://signal.example/v1/rooms/7VQS-D96P-8WHA-Q3TC/ws?peer=...&token=..."
    }
  },
  "invite": {
    "code": "7VQS-D96P-8WHA-Q3TC.guest-capability",
    "url": "https://play.example.com/halo.html#join=7VQS-D96P-8WHA-Q3TC.guest-capability"
  },
  "iceServers": [{ "urls": ["stun:stun.cloudflare.com:3478"] }],
  "iceServersExpiresAt": null
}
```

The UI should show one primary action: **Copy invite link**. The same guest link
can be shared with up to 127 friends. Keep `host.ticket` only in memory and never
put it in the shared URL. The invite is in the URL
fragment, so browsers do not send it in the initial HTTP request or the
`Referer` header.

### Exchange a room capability for a WebSocket session

```http
POST /v1/rooms/:roomId/sessions
Content-Type: application/json
Origin: https://play.example.com
```

```json
{
  "protocolVersion": 1,
  "buildId": "streamhash-2026-09-28",
  "identifier": "66778899aabb",
  "ticket": "guest-capability-from-the-fragment"
}
```

Each friend splits `invite.code` at the first period, using the first part as
`:roomId` and the second as `ticket`. A host can use the same endpoint with its
private host ticket to reconnect after its prior socket has closed. For a
public room, `ticket` may be omitted: the room seats the caller as a guest.
A ticket-less request against a private room shares the 404 of a bad ticket.

Success returns:

```json
{
  "v": 1,
  "room": {
    "id": "7VQS-D96P-8WHA-Q3TC",
    "buildId": "streamhash-2026-09-28",
    "protocolVersion": 1,
    "capacity": 128,
    "expiresAt": 1790630000000
  },
  "session": {
    "peerId": "g_NjY3Nzg4OTlhYWJi",
    "identifier": "66778899aabb",
    "role": "guest",
    "token": "single-use-websocket-token",
    "websocketUrl": "wss://signal.example/v1/rooms/7VQS-D96P-8WHA-Q3TC/ws?peer=...&token=..."
  },
  "iceServers": [{ "urls": ["stun:stun.cloudflare.com:3478"] }],
  "iceServersExpiresAt": null
}
```

The WebSocket token expires after 30 seconds and is deleted atomically during
the first successful upgrade. Invalid room IDs and invalid tickets intentionally
share a 404 response. Important 409 codes are `BUILD_MISMATCH`,
`PROTOCOL_MISMATCH`, `IDENTIFIER_IN_USE`, `ROOM_FULL`, and
`HOST_ALREADY_CONNECTED`.

### Quick join

```http
POST /v1/quickjoin
Content-Type: application/json
Origin: https://play.example.com
```

```json
{
  "protocolVersion": 1,
  "buildId": "streamhash-2026-09-28",
  "identifier": "66778899aabb",
  "turnstileToken": "optional, the join_room action"
}
```

The Worker asks the lobby directory for open public rooms on the same build
(a dedicated host first, then the fullest, then the oldest) and mints a guest
session in the first that accepts. The response is a session response with
`"role": "guest"`. When no room accepts, the Worker creates a public room for
the caller with the configured default lobby and returns a room response with
`"role": "host"`: the caller hosts, and later callers land with it. One
Turnstile token for the `join_room` action covers either outcome.

`409 IDENTIFIER_IN_USE` means this identifier is already in the room it would
have joined (a refresh still in flight); the caller is not sent elsewhere.

### Renew a room

```http
POST /v1/rooms/:roomId/renew
Content-Type: application/json
```

```json
{ "ticket": "host-capability-kept-by-the-host" }
```

Extends the room to one room TTL from now (the dedicated TTL when the request
also carries the service credential) and returns `{ "v": 1, "room": {...} }`.
An optional `lobby` (`{ "mapIndex", "modeIndex" }`) replaces the settings the
room advertises, which is how a dedicated host publishes its map rotation.
The browser host calls this every 50 minutes; a dedicated host relies on it to
keep its lobby open indefinitely.

### Open the signaling socket

Open the returned URL directly with the browser's `WebSocket` constructor:

```http
GET /v1/rooms/:roomId/ws?peer=:peerId&token=:singleUseToken
Upgrade: websocket
Origin: https://play.example.com
```

The Worker validates the origin before forwarding the upgrade to the room
Durable Object. The query credential is deliberately short-lived and
single-use. Application logs record only the URL path, never its query string.

### Profiles

A player's account: one unique username and one or more wallets, kept by the
`Profiles` Durable Object (`src/profiles.ts`, routes in `src/profile.ts`).
The caller is the signed-in wallet (`Authorization: Bearer` from
`POST /v1/auth/verify`); its profile is the one the wallet is linked to.

| Route | Does |
| --- | --- |
| `GET /v1/profile` | the caller's profile, or `{ "profile": null }` |
| `POST /v1/profile/username` `{ "username" }` | claims the name; a wallet with no profile gets one, linked to it. Renames are capped at three a day and the old name is held for its owner for a week |
| `PATCH /v1/profile` `{ "showWallets"?, "showFomo"?, "showX"? }` | what other players may see; everything starts private |
| `POST /v1/profile/wallets/challenge` `{ "wallet" }` | the message the new wallet must sign (profile, wallet, domain, network, nonce, expiry; five minutes) |
| `POST /v1/profile/wallets` `{ "wallet", "nonce", "signature" }` | links it; a wallet belongs to one profile |
| `DELETE /v1/profile/wallets/:wallet` | unlinks it; the last wallet stays |
| `GET /v1/profiles/:username` | another player's view: the name, and only the links the owner shows that are verified (no auth) |
| `GET /v1/profiles?wallets=a,b,c` | the same for up to 16 wallets of a roster, by wallet (no auth) |
| `GET /v1/admin/profiles?wallet=\|username=\|id=` | support lookup with the name history and the last events (admin token) |
| `PUT /v1/profile/fomo/handle` `{ "handle" }` | claims a fomo.family handle (`@name` or a pasted profile link works); stored unverified and private. fomo's public profile card is asked once whether the handle exists (cached a day, capped per hour; `FOMO_HANDLE_CHECK=off` stops it): unknown is refused, unanswered is kept. Ten claims an hour per wallet |
| `DELETE /v1/profile/fomo/handle` | drops it |
| `POST /v1/profile/fomo/transfer` | the transfer that proves a fomo wallet: a random USDC amount (0.10 to 0.99) to send from fomo to the signed-in wallet, valid 30 minutes |
| `POST /v1/profile/fomo/transfer/check` | looks for it (once a minute): a transfer of exactly that amount, its fee paid by fomo's fee payer; the sender becomes the profile's fomo wallet (`method: "transfer"`) |
| `GET /v1/admin/profiles/fomo-handles` | claimed handles on profiles with a proven fomo wallet, waiting for an admin (admin token) |
| `POST /v1/admin/profiles/fomo-handle` `{ "profileId", "handle", "verified", "note"? }` | an admin confirms (or takes back) a handle after checking it belongs to the proven fomo wallet, e.g. by the masked address fomo shows on the handle's page (admin token) |

Usernames are 3 to 11 characters of letters, digits and underscores (so one
fits Halo's player-name field), unique without regard to case, with a short
reserved list. A profile's id never changes, and the `usernames` registry
records every owner a name has had, so names can later move between
profiles.

fomo (`src/fomo.ts`, `src/fomo_handle.ts`): a profile's fomo *wallet* is
proven automatically (a linked wallet fomo paid fees for, `fee_payer`) or by
the transfer above (`transfer`). Nothing public ties a fomo *handle* to a
wallet, so a claimed handle is verified only when an admin confirms it
against the proven wallet; the confirmation goes when the proven wallet
changes. A verified handle is unique: confirming it clears other profiles'
claims of it, and nobody else can claim it. Other players see the handle
only once verified, and only with `showFomo` on.

## WebSocket protocol

Messages are UTF-8 JSON text. Binary frames and text frames above 65,536
characters are closed. The topology is a star: guests can signal only the host,
and the host can signal any guest. Halo gameplay data must use WebRTC data
channels, not these WebSockets. Guest welcome and membership messages expose
only the host; the host receives membership updates for every guest.

### Server to client

Immediately after connection:

```json
{
  "v": 1,
  "type": "welcome",
  "self": {
    "peerId": "g_...",
    "role": "guest",
    "identifier": "66778899aabb"
  },
  "room": {
    "id": "7VQS-D96P-8WHA-Q3TC",
    "buildId": "streamhash-2026-09-28",
    "protocolVersion": 1,
    "capacity": 128,
    "expiresAt": 1790630000000
  },
  "peers": [
    {
      "peerId": "h_...",
      "role": "host",
      "identifier": "001122334455"
    }
  ]
}
```

Membership events:

```json
{
  "v": 1,
  "type": "peer-joined",
  "peer": {
    "peerId": "g_...",
    "role": "guest",
    "identifier": "66778899aabb"
  }
}
```

```json
{
  "v": 1,
  "type": "peer-left",
  "peerId": "g_...",
  "identifier": "66778899aabb",
  "reason": "disconnected"
}
```

Relayed SDP/ICE messages add the authenticated sender:

```json
{
  "v": 1,
  "type": "signal",
  "from": "h_...",
  "signal": {
    "kind": "description",
    "description": { "type": "offer", "sdp": "v=0..." }
  }
}
```

Other server messages are `{ "v":1, "type":"pong", "nonce":"..." }` and
`{ "v":1, "type":"error", "code":"...", "message":"..." }`.

Every two seconds the host measures each player's round trip over WebRTC
(a dedicated server's gateway, or a browser host) and the room passes the
measurements on to the guests by the name each plays under, for the
scoreboard and the lobby:

```json
{ "v": 1, "type": "pings", "pings": { "Spartan 117": 42 } }
```

The room also broadcasts a presentation-only roster to every connected player.
It is independent of the host/guest WebRTC star topology:

```json
{
  "v": 1,
  "type": "roster",
  "players": [
    {
      "peerId": "g_...",
      "role": "guest",
      "profile": { "name": "Spartan 117", "style": "sage" }
    }
  ]
}
```

### Client to server

Optional application heartbeat:

```json
{ "v": 1, "type": "ping", "nonce": "optional-opaque-value" }
```

Each client sends its display profile after opening or reopening the socket.
Names are limited to Halo's 11-character ASCII profile field, and `style` is
one of the 18 stock armor colors validated by the service:

```json
{
  "v": 1,
  "type": "profile",
  "profile": { "name": "Spartan 117", "style": "sage" }
}
```

Session descriptions:

```json
{
  "v": 1,
  "type": "signal",
  "to": "g_...",
  "signal": {
    "kind": "description",
    "description": { "type": "offer", "sdp": "v=0..." }
  }
}
```

Trickle ICE candidates (send `candidate: null` for end-of-candidates):

```json
{
  "v": 1,
  "type": "signal",
  "to": "h_...",
  "signal": {
    "kind": "candidate",
    "candidate": {
      "candidate": "candidate:...",
      "sdpMid": "0",
      "sdpMLineIndex": 0,
      "usernameFragment": "optional"
    }
  }
}
```

A player's line of text chat goes to everyone in the room (spectators
included), under the name they play as and, when their wallet has a profile
(`src/profiles.ts`), their account name. The text is as the room shows it:
trimmed, single-spaced, and with the words on the profanity list
(`src/chat.ts`) masked. The room keeps no chat:

```json
{ "v": 1, "type": "chat", "from": "g_...", "name": "Spartan 117", "username": "Chief", "style": "sage", "text": "gg", "at": 1700000000000 }
```

The transport must process `welcome.peers` and `peer-joined.peer` first, pass
each peer's 12-hex `identifier` to `addPeer`, and only then apply SDP or ICE
signals for that `peerId`.

Only the host sends the players' pings, by signaling peer ID, in whole
milliseconds (at most 64 entries; the room rejects them from a guest with
`PINGS_FORBIDDEN`):

```json
{ "v": 1, "type": "pings", "pings": { "g_...": 42 } }
```

A line of text chat, at most 200 characters once trimmed (`src/chat.ts`,
`CHAT_MAX_LENGTH`). A player who has not sent a profile, or a spectator, is
refused with `CHAT_FORBIDDEN`; more than 5 lines in 10 seconds are dropped
with `CHAT_RATE_LIMITED` (the socket stays open):

```json
{ "v": 1, "type": "chat", "text": "gg" }
```

Parties chat the same way over HTTP: `POST /v1/parties/:code/chat` with the
member's body and `text`; `join`, `poll` and `chat` take `chatSince`, the
`seq` of the last line the member saw, and answer with the party's lines
after it (`party.chat`, the last 50 at most).

## Lifecycle and security properties

- Room IDs contain 80 random bits; host, invite, and session capabilities each
  contain 256 random bits. Only SHA-256 hashes are stored in SQLite.
- Guest capabilities are reusable until room expiry. Session tokens are
  30-second, single-use credentials suitable for a browser WebSocket URL.
- One alarm deletes the room at its absolute TTL and closes connected sockets
  with code 4001. A host may push the TTL back with the renew route.
- A public room publishes its player count and settings to the lobby
  directory on every membership change and withdraws itself when it closes or
  expires. The directory also drops entries whose rooms have expired or gone
  quiet, and a listing that no longer accepts sessions is removed on the next
  quick join that tries it.
- WebSocket attachments store peer ID, role, identifier, join time, and the
  small validated display profile, so membership and the roster survive
  Durable Object hibernation.
- Capacity includes connected sockets and unexpired pending sessions, preventing
  click races from overbooking a room.
- A 12-hex network identifier can appear only once among active or pending peers.
- The signaling object validates and relays SDP/ICE only; it cannot relay game
  traffic or arbitrary guest-to-guest messages.
- Cloudflare Rate Limiting bindings cap room creation and session exchange
  before a request reaches a room Durable Object. Capability entropy prevents
  guessing but does not by itself prevent an attacker from creating many empty
  rooms.

## Verification

```sh
npm run check
```

This checks generated bindings, runs strict TypeScript compilation, executes
the Worker/Durable Object/WebSocket tests, mocks the Cloudflare TURN credential
request, and performs a Wrangler dry-run bundle. It does not deploy.

Useful individual commands:

```sh
npm run types:check
npm test
npm run deploy:dry
```

The tests cover room creation, origin rejection, build and identifier matching,
capacity, single-use WebSocket credentials, peer membership, room revocation,
signed-room rejection, SDP relay, STUN fallback, TURN TTL clipping, browser
port-53 filtering, and the public lobby: quick join hosting and joining,
private rooms staying unlisted, full rooms being skipped, closed rooms leaving
the directory, the dedicated-host credential, and room renewal.
