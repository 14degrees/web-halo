# Playing for SOL

The browser game has wagered playlists, Bounty Duel and Bounty Rumble.
Players stake SOL, each kill moves a bounty from the victim to the killer,
and the match pays out on Solana when it ends. It runs on **Solana devnet**
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
   shows the player's running total and the pot. The Back (F1) scoreboard
   has a SOL column and the pot.
5. After the match the lobby shows the result ("+0.019 SOL", or "Stake
   returned") with a link to the transaction on Solana. The balance chip in
   the top right opens the vault: free balance, what is in play, the
   session, Load up and Withdraw.

## The rules

| | Bounty Duel | Bounty Rumble |
| --- | --- | --- |
| Players | 2 | 2 to 4, free-for-all |
| Buy-in | 0.05 SOL | 0.05 SOL |
| Bounty | 0.01 SOL a kill | 0.01 SOL a kill |

- Each kill moves the bounty, or what the victim has left if that is less,
  from the victim's match balance to the killer's. Suicides and betrayals
  move nothing. A player whose stake is spent plays on for nothing.
- At the end each player is paid their balance, less a 5% fee on what they
  won. Nobody pays a fee on their own stake, and a match nobody won anything
  in costs nothing.
- If a match does not finish (the server is lost, everyone leaves, it never
  starts), it is void and every stake goes back in full.
- If the game never settles a match, each player can take their stake back
  themselves after 24 hours (the program's `reclaim`).

The playlists are `bountyduel` and `bounty` in
`services/signaling/src/matchmaker.ts` (`PLAYLISTS`); the rules are
`killTransfer` and `bountyPayouts` in `services/signaling/src/wager.ts`.

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

- `/servers.html` (the dashboard) logs `stakes_locked` and `stakes_failed`
  beside each match.
- `GET /v1/wagers/:matchId` returns a match's wager: state, balances,
  payouts and transaction signatures.
- The settlement wallet's history on the Solana explorer (devnet) shows every
  create, settle, void and close.

## Known gaps

- A voided match still counts toward the session's 0.5 SOL daily limit (the
  program does not give it back). Approving a new session is one click.
- The old house ledger (`src/bank.ts` and the `/v1/wallet` deposit,
  faucet and withdraw routes) is unused and still in the code.
- Kills only: Bounty is Slayer. There is no team or objective wagering.
- Before real money: an audit of the program, hardware or multisig keys for
  the upgrade authority and operator, legal advice, and a mainnet deploy of
  the program (about 1.3 SOL of refundable rent).
