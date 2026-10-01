#!/usr/bin/env node
/* Capture the lobby's art from the game itself.

   The original site's menu art is not in Git. This loads the browser build
   in headless Chrome, screenshots Halo's title screen for the lobby backdrop,
   then starts a solo game on each of the 13 multiplayer maps and screenshots
   the view, writing port/web/assets/ui/shell/lobby-backdrop.png and
   port/web/assets/ui/maps/<map>.png. Rebuild (ninja web) afterwards.

     node tools/web_capture_art.mjs [page-url]

   The page URL defaults to a local tools/web_serve.py on port 8766. Chrome is
   found at its macOS location unless CHROME_PATH says otherwise; the script
   uses services/dedicated-host's playwright-core (npm ci there first). */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(path.join(repository, "services/dedicated-host/node_modules/playwright-core/index.mjs"));

const MAP_SLUGS = [
  "battle-creek", "sidewinder", "damnation", "rat-race", "prisoner", "hang-em-high",
  "chill-out", "derelict", "boarding-action", "blood-gulch", "wizard", "chiron-tl-34", "longest",
];
const url = process.argv[2] || "http://127.0.0.1:8766/build/web/halo.html";
const output = path.join(repository, "port/web/assets/ui");
const chrome = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const token = process.env.HALO_HOST_SERVICE_TOKEN;
if (!token) throw new Error("Set HALO_HOST_SERVICE_TOKEN (the signaling Worker's HOST_SERVICE_TOKEN).");
/* A build ID of its own keeps real players out of the capture's room. */
const pageUrl = new URL(url);
pageUrl.searchParams.set("build", "art-capture");

const browser = await chromium.launch({
  headless: true,
  executablePath: chrome,
  args: ["--use-angle=metal", "--ignore-gpu-blocklist", "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
});

async function openGame(render) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  await page.addInitScript((headless) => { window.HALO_DEDICATED = { headless }; }, !render);
  await page.goto(pageUrl.href);
  /* The lobby covers the game; the capture wants the game. */
  await page.addStyleTag({
    content: "#lobby,#lobby-deploy,#loading,#player-sidebar,#duke-legend,#online-dialog{display:none!important}",
  });
  await page.waitForFunction(() => window.HaloOnline && window.HaloOnline.isRuntimeReady(), null, { timeout: 600_000 });
  return page;
}

await mkdir(path.join(output, "shell"), { recursive: true });
await mkdir(path.join(output, "maps"), { recursive: true });

/* The camera hosts and renders; a second, invisible player lets Halo start. */
const camera = await openGame(true);
await camera.waitForTimeout(6_000);
await camera.locator("#canvas").screenshot({ path: path.join(output, "shell/lobby-backdrop.png") });
console.log("captured the title screen");

await camera.evaluate((value) => window.HaloOnline.hostDedicated(value), {
  serviceToken: token,
  rotation: MAP_SLUGS.map((_slug, mapIndex) => ({ mapIndex, modeIndex: 0 })),
  minimumPlayers: 1,
  countdownSeconds: 0,
  postgameSeconds: 0,
  name: "Camera",
});
await camera.waitForFunction(() => document.getElementById("invite-link").value, null, { timeout: 60_000 });
const invite = await camera.evaluate(() => document.getElementById("invite-link").value);
const extra = await openGame(false);

const matchState = () => camera.evaluate(() => Module._platform_web_online_get_match_state());
for (let index = 0; index < MAP_SLUGS.length; index++) {
  await camera.waitForFunction(() => Module._platform_web_online_get_match_state() === 1, null, { timeout: 300_000 });
  await extra.evaluate((link) => window.HaloOnline.join(link), invite);
  await camera.waitForFunction(() => Module._platform_web_online_get_match_state() === 3, null, { timeout: 300_000 });
  await camera.waitForTimeout(7_000);
  await camera.locator("#canvas").screenshot({ path: path.join(output, `maps/${MAP_SLUGS[index]}.png`) });
  console.log(`captured ${MAP_SLUGS[index]}`);
  /* Leaving empties the match, which the host ends and rotates. */
  await extra.evaluate(() => window.HaloOnline.leave());
  while ((await matchState()) === 3) await camera.waitForTimeout(1_000);
}
await camera.evaluate(() => window.HaloOnline.leave());
await browser.close();
