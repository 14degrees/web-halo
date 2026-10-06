# Playing for SOL

The browser game has wagered playlists: Bounty Duel and Bounty Rumble, where
each kill moves a bounty from the victim to the killer, and Team Stakes,
where the winners get their stake back and split the losers' stakes by
kills. The match pays out on Solana when it ends. It runs on **Solana devnet**
(test SOL) for now; nothing here moves real money until the program is
deployed to mainnet.

The design and its reasoning are in the design document, "Halo Web:
Production Money System". This page describes what is built.

## How a player sees it

1. They pick a bounty playlist and press Start matchmaking.
2. If their vault can't stake yet, the Load Up window opens. They connect a
   wallet (Phantom), pick 0.05, 0.1 or 0.25 SOL, and approve **once**. That
   one transaction opens their vault, deposits, and approves a play session:
   the game may stake up to 0.5 SOL of the vault in matches for 24 hours,
   with no more prompts. Then it searches.
3. When a match forms, everyone's stake is locked on chain (about three
   seconds). Nobody gets the server's invite until the stakes are locked.
4. In the match, each kill pops its bounty ("+0.010") over the body. The HUD
   shows the player's running total and the pot (in Team Stakes, what they
   take home if their team wins now, and what a kill is worth). The Back
   (F1) scoreboard has a SOL column and the pot.
5. After the match the lobby shows the result ("+0.019 SOL", or "Stake
   returned") with a link to the transaction on Solana. The balance chip in
   the top right opens the vault: free balance, what is in play, the
   session, Load up and Withdraw.

## The rules

| | Bounty Duel | Bounty Rumble | Team Stakes |
| --- | --- | --- | --- |
| Players | 2 | 2 to 4, free-for-all | exactly 4, two on two Team Slayer |
| Buy-in | 0.05 SOL | 0.05 SOL | 0.05 SOL |
| Pays | 0.01 SOL a kill | 0.01 SOL a kill | the winners get their stake back and split the losers' stakes: a quarter evenly, the rest by kills |

**Bounty** (Bounty Duel, Bounty Rumble):

- Each kill moves the bounty, or what the victim has left if that is less,
  from the victim's match balance to the killer's. Suicides and betrayals
  move nothing.
- A player whose stake is spent is out. When only one player has SOL left
  the match ends there and pays out (a duel ends at the first such kill);
  otherwise the broke player is removed from the match, can't rejoin it,
  and the others play on. The kill limit and time limit still end a match
  as usual. (`outOfSol` in `services/signaling/src/room.ts`; the gateway's
  `wager_out` in `services/game-server/gateway/room.go`.)
- At the end each player is paid their balance, less a 5% fee on what they
  won. Nobody pays a fee on their own stake, and a match nobody won anything
  in costs nothing.

**Team Stakes** (`stakesOutcome` in `services/signaling/src/wager.ts`):

The rule is written once for any match shape: teams of any size, even or
not, more than two teams, or a free-for-all where every player is their own
team. Its numbers (the stake, the kill target, the team share) travel with
the match as its stakes configuration, from the playlist today and from a
custom game's settings later.

- Halo's own scoring decides the winner: the dedicated server reports the
  team scores, each player's team and score, and who quit, when the match
  ends. Everyone who **stayed** on a **top-scoring team** is a winner; equal
  top scores all win.
- Each winner gets their own stake back. Every other stake (the losers',
  and the stake of anyone who quit, even on the winning team) is forfeited
  and, less the 5% fee, is the **prize**.
- A quarter of the prize (the **team share**) is split evenly among the
  winners, so a winner with no kills still gets paid. The rest (the **kill
  pool**) pays each winner's kills at exactly `kill pool / kill target`:
  the kill target is the variant's score to win (50 for Team Slayer), so
  the team's kills use the pool up exactly as the team reaches it. Kills are
  enemy kills; suicides and betrayals earn nothing (and cost Halo's score).
  Should the winners' kills exceed the target, the pool is shared by kills
  so it never overpays.
- Kill money nobody earned (the match ended on the time limit, or short of
  the target) is split evenly too. Everything is whole lamports: the
  payouts plus the fee equal the pot exactly, and the odd lamports go one
  each to the winners with the most kills.
- In a 2v2 at 0.05 SOL a kill is worth 0.001425 SOL and a winner's team
  share is 0.011875 SOL. A 50-0 carry nets +0.083 SOL and their 0-kill
  teammate +0.012; a 17/14/11/8 winning 4v4 team nets +0.060/+0.052/+0.043/
  +0.035.
- A staked player who never connects counts as having quit. A tie among
  everyone who stayed is void, and so is a match without a result.
- **A whole team that drops out** does not void or refund the match (that
  could be abused): the match is **held**. Its stakes stay locked in
  escrow, the admin is alerted, and unless an admin decides otherwise the
  dropped team forfeits when the hold's deadline passes (12 hours, and
  always at least an hour before the players could reclaim their stakes
  themselves). See "Held matches" below.
- During the match the HUD and the F1 column show each player's projected
  take if their team wins now (as if the teams were even), and what a kill
  is worth. The projection only becomes exact with the result.

**Every playlist:**

- If a match does not finish (the server is lost, everyone leaves, it never
  starts), it is void and every stake goes back in full.
- If the game never settles a match, each player can take their stake back
  themselves after 24 hours (the program's `reclaim`).

The playlists are `bountyduel`, `bounty` and `teamstakes` in
`services/signaling/src/matchmaker.ts` (`PLAYLISTS`); the rules are
`killTransfer`, `bountyPayouts` and `stakesOutcome` in
`services/signaling/src/wager.ts`.

### Held matches

A Team Stakes match whose whole team dropped out is held in state `held`.
Nothing moves on chain; the wager's record keeps the server's result, the
settlement a forfeit would pay, and a history of every action. The hold's
ceiling comes from the program: a player may `reclaim` their stake once the
match's `reclaim_delay` (24 hours on devnet) has passed, and a settle after
that fails, so a hold always ends an hour before that, and no extension can
pass it. To give admins more room, raise the program's configured
`reclaim_delay` (the operator's `update_config`, up to a week); it applies
to matches created after the change.

The admin routes, with the `ADMIN_TOKEN` bearer credential:

```sh
curl -H "Authorization: Bearer $ADMIN_TOKEN" $WORKER/v1/admin/wagers/held
curl -H "Authorization: Bearer $ADMIN_TOKEN" $WORKER/v1/admin/wagers/<matchId>
curl -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"forfeit","note":"red quit while behind"}' $WORKER/v1/admin/wagers/<matchId>/decide
curl -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"void","note":"server outage confirmed"}' $WORKER/v1/admin/wagers/<matchId>/decide
curl -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"hours":6,"note":"waiting on the players"}' $WORKER/v1/admin/wagers/<matchId>/hold
```

`forfeit` pays the settlement proposed when the match was held; `void`
returns every stake with no fee; `hold` extends the deadline (clamped at the
ceiling, which the response reports). A decision on a match that is not
held answers 409. The players' `GET /v1/wagers/:matchId` shows `held` with
the deadline, and their result card says the match is under review.

The dashboard (`/servers.html`, its "Held wagers" section from
`port/web/servers_wagers.js`) offers the same over these routes: the
operator pastes the admin token, which the page keeps only in that tab's
`sessionStorage` until they sign out or the Worker answers 401, and each
held match shows its reason, dropped teams, stakes, deadline, ceiling and
history with Forfeit, Void and Extend buttons that ask for a note (and
hours) and a confirmation. The page never contains the token (the repo is
public). The Worker answers the browser's CORS preflight on `/v1/admin/`
and adds CORS headers for an allowed `Origin`; curl without one works as
before.

### The match result

When a dedicated server's match enters postgame, the game captures its
result (`network_lobby_capture_result`, `port/linux/game/network_lobby.c`):
each player's name, team, score and whether they quit, and the two team
scores Halo itself compares for the winner. The server link sends it to the
gateway as its `'E'` message (`port/server/src/server_link.c`), and the
gateway sends it to the Worker with the match's end report
(`services/game-server/gateway/pool.go`).

## How it fits together

```
 browser (online_client.js)          Cloudflare Worker (services/signaling)          Solana
 ─────────────────────────           ──────────────────────────────────────          ──────
 Load up / Withdraw ──── builds tx ── vault.ts ── /v1/escrow/load, /withdraw
   wallet signs ──────── sends tx ─── vault.ts ── /v1/escrow/submit ───────────────▶ escrow program
 queue (bounty playlist) ──────────── matchmaker.ts: checks the vault can stake        (services/escrow)
                                      match forms ─▶ wager.ts (one per match):
                                        lock stakes ─────────────────────────────────▶ create + join
 kill on the game server ──▶ room.ts ─▶ wager.ts: move the bounty, tell the room
 HUD, pops, F1 column  ◀── "wager" messages
                                      match ends ─▶ wager.ts: settle or void ────────▶ settle / void
                                                      then close the match account ─▶ close
 result card  ◀────────────────────── GET /v1/wagers/:matchId
```

- **The escrow program** (`services/escrow`, Anchor) holds the SOL. Each
  player has a vault with a free balance (theirs to withdraw) and a locked
  balance (staked in matches). The settlement authority can only move locked
  SOL, and only by a match's rules: payouts must add up to the pot less a fee
  no higher than the configured rate (5%, hard cap 10%), a match settles
  once, and players can reclaim an unsettled match without us. Details and
  tests: `services/escrow/README.md`.
- **Vault routes** (`src/vault.ts`) build the transactions a player's wallet
  signs. The wallet only signs; `/v1/escrow/submit` sends the signed
  transaction to the game's cluster, so it works whatever network the wallet
  itself is set to. It sends only transactions the signed-in wallet pays for.
- **The matchmaker** (`src/matchmaker.ts`) admits a wallet to a bounty
  playlist only if its vault holds the buy-in free and its session is active
  with the buy-in left in its limit. When a bounty match forms it starts the
  match's wager. It hands out the invite only once the stakes are locked, and
  voids the match if they can't be.
- **The wager** (`src/wager.ts`, a Durable Object per match) locks the
  stakes (one transaction: create the match and join every player), keeps
  the match balances as kills arrive, and settles or voids at the end, then
  closes the match account to recover its rent. Every chain step first reads
  the match's account, so a retry after an unknown outcome never does
  anything twice. Its alarm retries until the chain confirms.
- **The room** (`src/room.ts`) passes the dedicated server's kill reports
  (by in-game name) to the match's wager and broadcasts the new balances.
  Wallet players always play under their wallet's short name (`22u5..g9tn`),
  so a kill can't be pinned on someone else.
- **The page** (`port/web/online_client.js`, `port/web/shell.html`) has the
  balance chip, Load Up window, playlist labels, kill pops, HUD total and
  result card. The F1 column is drawn by the engine
  (`source/game/game_engine.c`, under `HALO_WEB`) from a small table the
  page writes (`port/web/src/web_online_ui.c`, `platform_web_wager_*`).

### Session keys

A player approves a session key with a spending limit and an expiry; the
game joins matches with it, so play needs no wallet prompts. The key is
derived per wallet from `ESCROW_SESSION_SECRET` (`sessionKeypair` in
`wager.ts`) and never stored. Every join also needs the settlement
authority's signature.

This differs from the design document, which put the session key in the
browser. Holding it on the server removes a signing round trip from every
match, and adds little risk, because the server already decides results.
The limit and expiry bound what either key can do.

## Running it

### Keys and wallets (devnet)

Kept outside git in `build/escrow-keys/`:

| Key | Address | Role |
| --- | --- | --- |
| `deployer.json` | `7fwLtt1JouLbXrZ58HLPkNH7jzV6k41yopRc586pW84s` | The program's upgrade authority |
| `operator.json` | `8fLfv5vkEkUDvDuwHx6PpZPiF7A5ALNB7AhFxRtA6aAM` | Settings, pause, withdrawal holds; also the fee vault |
| `authority.json` | `58PxG6BsZEKtQpQmBLAyXdhGwhdqA4dVYmAMx7KxdFzf` | Settlement: creates, settles, voids and closes matches |
| `test-wallets.txt` | | Two saved test wallets (hex seed, address) for scripted tests |

The program is `3dPU7bDe3Bqfzx7z2g4hVr9cNQGeZqR1oHCkti5uD3bJ`.

The settlement wallet pays about 0.000025 SOL in fees per match, and holds
about 0.0033 SOL of rent per match while it runs (refunded at close). Keep
a few tenths of a SOL in it.

### Worker configuration

In `services/signaling/wrangler.jsonc`: `SOLANA_CLUSTER`, `SOLANA_RPC_URL`,
`ESCROW_FEE_VAULT` (the operator's address) and `ESCROW_FEE_BPS` (500). Two
secrets turn bounty playlists on:

```sh
tr -d ' \n' < build/escrow-keys/authority.json | npx wrangler secret put ESCROW_AUTHORITY_SECRET_KEY
openssl rand -base64 48 | tr -d '\n' | npx wrangler secret put ESCROW_SESSION_SECRET
```

Changing `ESCROW_SESSION_SECRET` changes every player's session key; they
approve a new session with one click.

### Tests

```sh
cd services/escrow && anchor build && cargo test --manifest-path programs/halo_escrow/Cargo.toml
cd services/signaling && npm test    # includes test/wager.spec.ts
```

`npm run escrow:devnet -- <rpc-url> ../../build/escrow-keys` (in
`services/signaling`) sets up the program's config on a fresh cluster and
plays one wagered match with two throwaway players.

For any test that sends SOL to a new key, save the key first and sweep the
SOL back afterwards; reuse `test-wallets.txt` instead of minting new
wallets.

### Watching it

- Money problems raise an alert: a settlement the network kept refusing
  (the stakes stay locked until it's retried or the players reclaim them),
  stakes that wouldn't lock, a Team Stakes match held for an admin, and the
  settlement wallet under 0.05 SOL (checked every five minutes). Alerts go
  to the Worker's logs, and to a Discord or Slack incoming webhook if one is
  set (`npx wrangler secret put ALERT_WEBHOOK_URL`), at most once an hour
  each.
- The dashboard's event log shows how each wagered match's money ended
  (`wager_settled`, `wager_void`, `wager_settle_gave_up`) and each hold's
  life (`wager_held`, `wager_hold_extended`, `wager_hold_decided`,
  `wager_hold_expired`). `GET /v1/admin/wagers/held` lists the matches held
  now.
- `/servers.html` (the dashboard) logs `stakes_locked` and `stakes_failed`
  beside each match.
- `GET /v1/wagers/:matchId` returns a match's wager: state, balances,
  payouts and transaction signatures.
- The settlement wallet's history on the Solana explorer (devnet) shows every
  create, settle, void and close.

## Known gaps

- Team Stakes is Team Slayer only; there is no objective (CTF) wagering.
  The payout rule already handles any team sizes and free-for-alls; a
  playlist or custom game only has to pass its stakes configuration. The
  dedicated server reports two team scores, so games with more than two
  teams would need the result to carry one per team.
- The escrow program holds at most 8 players in a match (`MAXIMUM_PLAYERS`,
  with one reclaim bit per player). Larger matches need the program's cap
  raised and redeployed, and the settle transaction checked for size.
- A held match's deadline cannot pass the program's reclaim delay.
- Before real money: an audit of the program, hardware or multisig keys for
  the upgrade authority and operator, legal advice, and a mainnet deploy of
  the program (about 1.3 SOL of refundable rent).
