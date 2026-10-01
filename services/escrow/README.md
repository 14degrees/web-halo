# Escrow program

`halo_escrow` is the Solana program that holds wagered SOL (Anchor 1.2).
Each player has a vault with a free balance (theirs to withdraw) and a
locked balance (staked in matches). The settlement authority can only move
locked SOL, and only by a match's rules; see the design document, "Halo Web:
Production Money System".

| Instruction | Signed by | Does |
| --- | --- | --- |
| `initialize`, `update_config` | operator | settlement authority, fee vault, fee (10% cap), maximum stake, reclaim delay |
| `set_paused`, `hold_withdrawals` | operator | stop new matches; hold one wallet's withdrawals for at most 72 hours |
| `open_vault`, `deposit`, `withdraw` | player | the player's SOL in and out; locked SOL stays |
| `open_session`, `close_session` | player | a browser key that joins matches up to a limit until it expires (at most a day) |
| `create_match`, `join_match` | authority (and the player's session key to join) | a match with its stake; joining locks the stake |
| `settle`, `void_match`, `close_match` | authority | pay the match out (the fee is what the payouts leave of the pot), or return every stake; close an ended match for its rent |
| `reclaim` | player | take a stake back from a match nobody settled within the reclaim delay |

## Build and test

```sh
anchor build
cargo test --manifest-path programs/halo_escrow/Cargo.toml
```

The tests (`programs/halo_escrow/tests/escrow.rs`) run the built program in
LiteSVM and check each rule: settling moves SOL without making or losing
any, a match settles once, joining needs the session key and the authority
within the session's limit, locked SOL cannot be withdrawn, voids and
reclaims return stakes, holds expire, and the fee is capped.

Program ID: `3dPU7bDe3Bqfzx7z2g4hVr9cNQGeZqR1oHCkti5uD3bJ`.

## Devnet

Deployed to devnet at exact size (upgrade authority: the deployer key). The
keys live outside git in `build/escrow-keys/` (`deployer`, `operator`,
`authority`); the operator's wallet is also the fee vault. To set up the
config on a fresh cluster and play one wagered match with two throwaway
players through the Worker's own client (`services/signaling/src/escrow.ts`):

```sh
cd services/signaling
npm run escrow:devnet -- <rpc-url> ../../build/escrow-keys
```
