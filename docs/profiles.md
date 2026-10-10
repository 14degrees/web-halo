# Profiles and linked accounts

A player who signs in with a Solana wallet can claim a username and put
more than one wallet under it, prove a fomo.family wallet and claim their
fomo handle, and link an X account. Every link is private until the player
turns on showing it, and other players only ever see links that are
verified. The design and its reasoning are in the linking plan
(library/t-0003/fomo-x-linking-plan.md); this page describes what is built.

## How a player sees it

The Spartan dialog has a **Profile & linked accounts** button (with the
username beside it, or "claim a username"); the lobby's wallet panel has a
**Profile** link. Both open one dialog. Without a signed-in wallet it only
offers Connect wallet.

1. **Username.** 3 to 11 letters, digits or underscores, at least one
   letter, no underscore at either end. Some names are reserved (admin,
   halo, spartan, support and others). A profile may rename 3 times a day;
   a name it gives up is held for it for 7 days. The page checks the shape
   before asking; the Worker's refusals (taken, reserved, renames used up)
   are shown in words. The first claim makes the profile; everything below
   needs one.
2. **Wallets.** The signed-in wallet is listed first. To add another the
   player switches their wallet app to it and presses Link: the Worker
   gives a message naming the profile, the wallet, the game's domain and a
   nonce, the wallet signs it (nothing is sent or spent), and the Worker
   checks the signature. Any wallet but the last can be unlinked.
3. **fomo.** The Worker looks for the profile's wallets on fomo after each
   sign-in (a mainnet transaction fomo's fee payer paid for); the dialog
   shows "fomo wallet proven ✓" or "Not seen on fomo (checked …)" with
   Check again (ten minutes apart). A player whose fomo wallet isn't one of
   their linked wallets can prove it by a transfer: the dialog shows an
   amount of USDC (10 to 99 cents), the signed-in wallet's address to send
   it to from fomo, and when the request expires (30 minutes); "I've sent
   it: check" looks for it. The player keeps the money.
4. **fomo handle.** Claimed by typing it (a profile link or `@` is fine).
   fomo's public profile card says whether the handle exists; an unknown
   handle is refused. The handle then reads **claimed** (prove a fomo
   wallet), **awaiting an admin** (the wallet is proven; an admin compares
   it with the masked address fomo shows on the handle's page), or
   **verified**. It is private until verified.
5. **X.** Link X gives a code, the text to post (`Linking my Halo
   Spartan: <code>`), a Post on X link that fills it in, and when the code
   expires (15 minutes). The player posts, pastes the post's link and
   presses Verify; the Worker reads the post through X's public embed
   endpoint. Once linked the dialog says the post can be deleted. An X
   account is linked to one profile at a time: while another profile holds
   it, a proof for it is refused (`409 X_HANDLE_TAKEN`) and the code stays
   for another try. Unlinking it frees it; relinking a different account
   replaces a profile's own.
6. **Shown to other players.** Three switches, all off at first: wallets,
   fomo (the proven wallet and, once verified, the handle), and X.

The username shows where the in-game name did: the landing plate, the
lobby's player list (the room looks up each wallet's username; a hover
gives the in-game name), the wallet panel, and chat. The in-game name
itself stays the wallet's short name. The Spartan dialog's record shows the
**Username** badge as soon as one is claimed; an older wallet or guest
record folds into it with the next matchmade game.

## Where it lives

- `port/web/profile_panel.js`: the dialog (`HaloProfile`), a `--pre-js`
  module before `post_match.js`. `online_client.js` hands it the Worker
  fetch helper, the wallet session, and the pick-and-sign helpers for
  linking a wallet, and hears from it when the username changes.
- `services/signaling/src/profile.ts` (usernames, wallets, visibility,
  public lookups, admin routes), `fomo.ts` (detection), `fomo_handle.ts`
  (the handle and the transfer proof), `x.ts` (the post proof), and the
  store, `profiles.ts`.

Routes the page uses, all with the wallet's bearer token:

| Route | Does |
| --- | --- |
| `GET /v1/profile` | the caller's profile, or null |
| `POST /v1/profile/username` | `{ username }`: claim or rename |
| `PATCH /v1/profile` | `{ showWallets?, showFomo?, showX? }` |
| `POST /v1/profile/wallets/challenge`, `POST /v1/profile/wallets` | link a wallet by signed message |
| `DELETE /v1/profile/wallets/:wallet` | unlink one |
| `POST /v1/profile/fomo/check` | look for the wallets on fomo now |
| `PUT`, `DELETE /v1/profile/fomo/handle` | claim or drop the handle |
| `POST /v1/profile/fomo/transfer`, `.../transfer/check` | the transfer proof |
| `POST /v1/profile/x/challenge`, `/x/verify`; `DELETE /v1/profile/x` | link and unlink X |

Admins confirm fomo handles with `GET /v1/admin/profiles/fomo-handles` and
`POST /v1/admin/profiles/fomo-handle` (no page for it yet).

## Errors

Every error code these routes return has its own words in
`profile_panel.js` (`MESSAGES`); `tests/profile_panel_test.js` reads the
codes out of the Worker's sources and fails if one is missing. Where the
Worker's message carries the detail (an invalid username's rule, the code
a post is missing) the page shows the Worker's words.
