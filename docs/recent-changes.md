# Recent changes (October 2026)

What changed in the browser game over the last stretch of work, and why.
Newest ideas first within each part. Commit hashes are on
`claude/confident-wozniak-950gpg`.

## The landing: click and you're in

- **A live game behind the menu.** When anyone is playing on a public
  server, the landing plays that game a few seconds behind, from the
  broadcast (below), with the chase camera cutting between players every
  20 s. With nobody playing it flies over the empty map instead. *Why:* the
  first thing a visitor sees is the game being played, not a menu.
  (`918d03a`, `032248b`)
- **It never shows Halo's own menu through it.** The landing is
  see-through only while a game is on the screen. (`032248b`)
- **Layout.** Quick Play · Matchmaking · Custom Games · Spectate along the
  bottom, your Spartan and Customize middle right. (`d9304d9`, `c59c6cf`)
- **Esc in a game** brings the landing up over the game, dimmed: click to
  resume, or go elsewhere (it leaves the match first). Halo's own pause
  menu no longer opens under it. (`eeea0e4`)

## Ping, before a match

- **Your ping on the landing and in the lobby**, in the scoreboard's colors
  (green under 80 ms, yellow under 150). Outside a room the page times a
  few small requests to the signaling Worker (`GET /v1/ping`), which lists
  where else to probe: one URL per game region (`PING_TARGETS`; the
  gateway's `GET /ping`, exposed over HTTPS by `fly/fly.toml`). The nearest
  region shows, the rest in the readout's tooltip. *Why:* a player should
  know what to expect before they queue, and the probe, by region id, is
  what region-aware matchmaking will need. In a room, a guest's ping is
  WebRTC's measure to the host or server.
- **Pings in player-hosted rooms too.** A browser host now measures each
  player over WebRTC every two seconds and tells the room, as a dedicated
  server's gateway does, so the lobby's player list, the friends sidebar
  and the scoreboard show them in every room. The lobby lists each
  player's ping next to their name.
- Code: `port/web/online_client.js` (`refreshPing`, `tickPeerPings`),
  `services/signaling/src/index.ts` (`pingTargets`),
  `services/game-server/gateway/main.go` (`statusMux`).

## Spectating

- **Through the CDN, a few seconds behind** (`618e097`). While anyone
  watches a match, its server records what a spectator receives in
  2-second chunks (each opened by a snapshot, so a viewer can start
  anywhere). The gateway gzips each chunk (about 3–4 KB) and puts it in R2
  through the Worker; viewers fetch the chunks from Cloudflare's edge and
  play them into their own game with no connection to the server.
  - *Why:* any number of viewers cost the server what one does, hosting is
    about $0 (R2 has no download fees; recording runs only while watched,
    chunks expire after a day), and the delay (about 3–5 s) means a
    spectator can't feed live positions to a player.
  - Code: `source/networking/network_server_message_handler.c` (recorder),
    `services/game-server/gateway/broadcast.go`,
    `services/signaling/src/broadcast.ts`,
    `port/linux/game/network_lobby.c` (playback),
    `source/networking/network_connection.c` (playback connection).
- **The chase camera** follows a player from behind along their aim,
  blends between ticks as the renderer does, and rises over a player
  backed against a wall. Click: next player; Tab: scores; Esc: leave.
- **Spectators are never players.** The direct spectating mode before the
  broadcast (`050558b`) gave a spectator's machine no player, refused by
  the server, so a spectator can't join, be put on a team or touch money.
  The broadcast replaces it in the page; the code stays.

## Netcode fixes (what everyone sees)

These came out of chasing "spectating looks janky", and most affected
regular players too (`e837a29`, `eeea0e4`):

- **A late joiner's inputs went to a departed player.** A machine number is
  reused after its machine leaves; the departed player stayed first in that
  machine's list, so the new player's aim and trigger drove the old slot
  and everyone saw the newcomer with frozen aim. Departed players now leave
  the list.
- **Machines that joined mid-game number players differently** from the
  server once anyone has left. Unit states and relayed inputs now name or
  translate each player, so the right body gets the right data (this was
  "Waiting for space to clear").
- **The spectator froze everyone's controls** (a switch reused from the
  landing's backdrop). Fixed.
- **No 16-join limit per map.** Players who left kept their slot until the
  map ended; now the longest-gone gives theirs up when the game is full.
- **A spectator's mark outlived the spectator**, so the next player at that
  address couldn't spawn. Every address is now told its role on arrival.
- **A player leaving during the countdown** could break the server's game
  for the next joiner. Fixed.

## In the game

- **Scoreboard, Halo 3's way** (`ccec6b4`, `c8d016f`): team totals with
  their players under them, emblems, K/D (or SOL in money matches), score,
  **ping** (from the server's WebRTC connection to each player), dimmed
  quitters, your row outlined, and how many are watching.
- **Keyboard** (`cb9df81`, `5ca5275`, `d3c6532`): Tab holds the scores, Q
  switches weapons (flashlight on T), F melee. Halo's prompts name the keys
  ("Hold E to swap", "Hold TAB for score"), and a controls panel shows for
  10 s the first time you drop in.

## Playlists and servers

- **Public servers** (Click to play): one Fly machine, two servers, a
  small-map rotation of every mode: Hang 'Em High, Chill Out (Team
  Oddball), Prisoner, Battle Creek (CTF), Derelict, Damnation (Team
  Slayer), Rat Race (Team King), Wizard, Longest, Chiron. Team rounds start
  with one player; others join the smaller team. (`5605031`; the rotation
  is the machine's `HALO_LOBBY_ROTATION`.)
- **Matchmaking** (`4576e20`): Big Team Battle, Capture the Flag, Team
  Objective (new Team Oddball / Team King modes), Oddball & King, and
  longer rotations everywhere. **Rumble Pit is the default.** (`02582cf`)
- **Lobby** (`02582cf`): "+ Invite to party" under the players (starts a
  party, shows its code and link), Leave Party and Customize Spartan in
  the menu. Edit Matchmaking Options went: it opened the Playlist picker.

## Money

- **Hidden by default** (`e055186`): the wallet, Play for SOL, the SOL
  playlists and the live money matches show only in a browser opened once
  with `?sol=1` (`?sol=0` hides them again). *Why:* the site should read as
  a game first.
- **Out of SOL, out** (`f6e4e4d`): in a bounty match a player whose stake is
  spent is removed; a duel ends at the first such kill and pays out
  normally. Rules in `docs/wagers.md`.
- **Pending:** the escrow fix that keeps voided matches from counting
  against a session's limit is built and tested but needs about 2 devnet
  SOL in the deployer to upgrade the program (uncommitted until then).

## Working on it

- **A local copy of everything:** `wrangler dev` for the Worker (with a
  local R2), the game server image in Docker pointed at it, and the staged
  site served with the cross-origin headers the game needs. Changes to the
  netcode were tested this way before going live.
- **Reading a crash:** the web build writes `build/web/halo.html.symbols`
  (not published); a stack's `wasm-function[N]` is line N.
- **Debug readouts** in the page: `Module._platform_web_debug_player_heading(i)`
  and `_platform_web_spectate_heading()` for measuring aim and camera
  turning in tests.
