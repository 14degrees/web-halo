# Playing inside a post on X

Post `https://halois.fun` on X and the post shows a Player Card: the card
image with a play button, and on click the game itself, inside the post.

## How it works

- `/` is the game page with the card's tags added by the site Worker
  (`services/web/src/embed.js`): `twitter:card` `player`, the image, and
  `twitter:player` naming `/embed` at 640 × 360.
- `/embed` is the same page, marked `<body data-embed>`, which X loads in
  an iframe. Only X, twitter.com and the site itself may frame it
  (`frame-ancestors`).
- The image is `/assets/ui/shell/x-card.jpg`. It is Halo art, so like the
  rest of the UI it lives in the gitignored `port/web/assets/` and is staged
  from there. It is a 1200 × 675 capture of the landing's live map with the
  title, and nothing in the middle, where X draws its play button.

## What X's iframe allows, and what the page does about it

X renders the card as:

```html
<iframe sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
        allow="autoplay; fullscreen; web-share" allowfullscreen>
```

**Threads.** The game is threaded WebAssembly and needs `crossOriginIsolated`.
COOP and COEP isolate only a top-level page, and x.com is not isolated, so
`/embed` also sends `Document-Isolation-Policy: isolate-and-require-corp`,
which isolates the frame by itself whatever embeds it. Chrome and Edge on
desktop (137 and later) support it. Safari, Firefox, Chrome on Android and
X's apps do not yet; there the card shows "Play in a new tab" instead of
the game. The isolation service worker (`coi-serviceworker.js`) skips
frames, since it cannot isolate one.

**The mouse.** No `allow-pointer-lock`: the mouse cannot be captured in a
post. So inside the card the page aims (`embedAim` in `shell.html`,
`platform_web_page_aim` in `sdl_platform.c`): a click into the game takes
the mouse, moving it over the game turns the view, and resting the pointer
in the outer sixth of the frame keeps turning, faster the closer it is to
the edge. Esc, or leaving the frame, gives the mouse back and opens the
menu, as with a capture. A controller works as usual.

**Everything else.** Popups escape the sandbox, so "Full game ↗" (on the
landing and next to the game's controls) opens the site in a normal tab
with real mouse capture. Fullscreen is allowed. There is no `allow-forms`;
the page submits no forms in the card's path. The landing shows only Click
to play; the other modes, the Spartan, and Play for SOL stay in the full
game (X's card rules forbid money in a card, so the wallet is off in
`/embed` whatever `?sol` says).

## Test it locally

```sh
cd services/web
npx wrangler dev --port 8797 --var EMBED_FRAME_ANCESTORS:http://localhost:8790
```

Serve a page on `http://localhost:8790` with an iframe of
`http://127.0.0.1:8797/embed` and the sandbox above (localhost and
127.0.0.1 are different sites, so the frame is cross-site as on X). In
Chrome, `crossOriginIsolated` is true inside it and the game runs; with
`--disable-features=DocumentIsolationPolicy` it shows the new-tab
fallback. Online play from a local origin needs that origin in the
signaling Worker's `ALLOWED_ORIGINS`.

X decides whether a posted link renders as a playable card; check a real
post after deploying.
