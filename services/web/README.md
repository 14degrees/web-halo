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

Build and validate from the repository root:

```sh
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
