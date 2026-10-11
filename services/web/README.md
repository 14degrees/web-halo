# Halo browser hosting

This package publishes the browser build with Cloudflare Workers Static Assets
and R2. Static Assets serves the application, `ui.map`, and the 13 stock
multiplayer maps without invoking the Worker. The ten larger campaign maps are
streamed from the `halo-web-campaign-maps` R2 bucket. The Worker accepts only
their exact stock names and supports `GET`, `HEAD`, and one HTTP byte range per
request, which lets WasmFS fetch 32 MiB chunks instead of downloading an entire
map before starting a mission.

The current deployment is
[halo-web.otherness-bugs.workers.dev](https://halo-web.otherness-bugs.workers.dev/).
Only deploy game data that you are entitled to host and distribute.

## Prepare a release build

A deployment needs two sets of files that are not in Git, because the
repository is public and the game data is proprietary:

| Files | Where they go | Where they come from |
| --- | --- | --- |
| `ui.map` and the 13 multiplayer maps (`beavercreek.map`, `bloodgulch.map`, …) | `assets/maps/` | An Xbox disc image of Halo: Combat Evolved: `python3 tools/xiso_extract.py Halo.iso --output assets/maps` |
| The menu art: `maps/*.png` (13 map cards), `modes/*.png` (6 mode icons), `spartan/*.png` (18 armor colors) and `shell/` (`halo-ce-ring-menu.jpg`, `hud-frame.png`, `xbox-duke-controller.png`, `kofi-support-dark.png`, `mitchell-jester-card.svg`, optionally `lobby-backdrop.png`) | `port/web/assets/ui/` | A copy of the original site's art. `tools/web_capture_art.mjs` can render the map cards and the lobby backdrop from the game itself; the other images have no generator. |

`tools/web_placeholder_assets.py` writes plain images under the same names
for local builds. Staging refuses them: `tools/web_stage_cloudflare.py` (and
so `npm run check` and `npm run deploy`) fails if any menu image is a
placeholder or missing, or if a map file lacks the game's cache file header.
After real art replaces placeholders, delete the placeholder files first: the
generator never overwrites, and the art copy must overwrite them.

Then build the release and validate it from the repository root. The Emscripten
SDK can live in the ignored `build/emsdk`:

```sh
python3 configure.py --release --pgo=off --lto=off
ninja web
cd services/web
npm ci
npm run check
```

Deploy with:

```sh
npm run deploy
```

`tools/web_stage_cloudflare.py` creates the ignored
`build/cloudflare-web/` directory and fails if a required asset is missing or
larger than Cloudflare's per-file limit. Campaign maps remain outside that
directory because every one exceeds the 25 MiB Static Assets limit. The
generated `_headers` file and the R2 response handler enable the cross-origin
isolation required by WebAssembly threads.

Create the campaign bucket once, from this directory:

```sh
npx wrangler r2 bucket create halo-web-campaign-maps
```

Then upload the ten maps extracted from the player's Halo disc. Object names
must remain exactly as shown because the Worker deliberately uses an allowlist:

```sh
for map in a10 a30 a50 b30 b40 c10 c20 c40 d20 d40; do
  npx wrangler r2 object put "halo-web-campaign-maps/$map.map" \
    --file "../../assets/maps/$map.map" \
    --content-type application/octet-stream \
    --cache-control "public, max-age=0, must-revalidate" \
    --remote
done
```

The campaign data totals about 1.46 GiB. `npm run check` validates the Worker
bundle but does not create the bucket or confirm that remote objects exist.
After the bucket is populated, `npm run deploy` publishes the Worker and static
assets together. Only upload game data that you are legally entitled to host
and distribute.
