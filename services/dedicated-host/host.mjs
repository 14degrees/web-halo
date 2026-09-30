/* A dedicated public-lobby host for the Halo browser build.

   Each lobby is one headless Chromium page running the deployed game with
   window.HALO_DEDICATED set before it loads. The page creates a public room
   with the service credential (HaloOnline.hostDedicated), and the game's own
   driver (port/web/src/web_online_ui.c) starts games when players are in,
   ends games everyone has left, and brings the lobby back after each. This
   process only watches: it restarts a page whose room closed or whose
   runtime died, and reports status. */

import http from "node:http";

import { chromium } from "playwright-core";

import { loadConfig } from "./config.mjs";

const POLL_MILLISECONDS = 5_000;
/* A page whose room is gone this long is reloaded. */
const INACTIVE_RESTART_MILLISECONDS = 30_000;
const RESTART_BACKOFF_MILLISECONDS = [5_000, 15_000, 60_000];

const CHROMIUM_ARGUMENTS = [
  "--autoplay-policy=no-user-gesture-required",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  /* Wasm threads need cross-origin isolation, which the deployment's headers
     grant; nothing here weakens it. */
];

function log(lobby, message, extra) {
  const line = { at: new Date().toISOString(), lobby, message, ...(extra ?? {}) };
  console.log(JSON.stringify(line));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class Lobby {
  constructor(index, config, browser) {
    this.index = index;
    this.config = config;
    this.browser = browser;
    this.page = null;
    this.status = null;
    this.inactiveSince = null;
    this.restarts = 0;
    this.stopping = false;
  }

  async start() {
    const context = await this.browser.newContext({
      viewport: { width: 640, height: 480 },
      ignoreHTTPSErrors: false,
    });
    await context.addInitScript((dedicated) => {
      window.HALO_DEDICATED = dedicated;
    }, { headless: this.config.headless, lobby: this.index });
    this.page = await context.newPage();
    this.page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        log(this.index, "page console", { level: message.type(), text: message.text().slice(0, 400) });
      }
    });
    this.page.on("crash", () => log(this.index, "page crashed"));
    this.page.on("pageerror", (error) => log(this.index, "page error", { error: String(error).slice(0, 400) }));
    await this.page.goto(this.config.gameUrl, { waitUntil: "domcontentloaded" });
    log(this.index, "page loaded", { url: this.config.gameUrl });

    const deadline = Date.now() + this.config.startupTimeoutSeconds * 1_000;
    while (Date.now() < deadline) {
      const ready = await this.page.evaluate(() =>
        !!(window.HaloOnline && typeof window.HaloOnline.isRuntimeReady === "function" &&
          window.HaloOnline.isRuntimeReady())).catch(() => false);
      if (ready) break;
      await sleep(1_000);
    }
    const ready = await this.page.evaluate(() =>
      !!(window.HaloOnline && window.HaloOnline.isRuntimeReady())).catch(() => false);
    if (!ready) throw new Error("Halo did not start in time.");
    log(this.index, "runtime ready");

    const settings = {
      serviceToken: this.config.serviceToken,
      rotation: this.config.rotation,
      minimumPlayers: this.config.minimumPlayers,
      countdownSeconds: this.config.countdownSeconds,
      postgameSeconds: this.config.postgameSeconds,
      name: this.config.lobbies > 1 ? `${this.config.hostName} ${this.index + 1}`.slice(0, 11) : this.config.hostName,
      style: this.config.hostStyle,
    };
    await this.page.evaluate((value) => window.HaloOnline.hostDedicated(value), settings);
    this.inactiveSince = null;
    log(this.index, "hosting", { rotation: this.config.rotation });
  }

  async poll() {
    if (!this.page || this.page.isClosed()) throw new Error("page closed");
    const status = await this.page.evaluate(() => window.HaloOnline.dedicatedStatus());
    const previous = this.status;
    this.status = status;
    if (!previous || previous.matchState !== status.matchState ||
        previous.players !== status.players || previous.roomId !== status.roomId) {
      log(this.index, "status", status);
    }
    if (status.active && status.dedicated) {
      this.inactiveSince = null;
      return;
    }
    this.inactiveSince ??= Date.now();
    if (Date.now() - this.inactiveSince >= INACTIVE_RESTART_MILLISECONDS) {
      throw new Error("the room is no longer active");
    }
  }

  async close() {
    this.stopping = true;
    if (this.page && !this.page.isClosed()) {
      try {
        await this.page.evaluate(() => window.HaloOnline.leave()).catch(() => {});
        await this.page.context().close();
      } catch {
        /* Closing a dead page is fine. */
      }
    }
    this.page = null;
  }

  /* Runs until stopped, restarting the page on any failure with backoff. */
  async run() {
    while (!this.stopping) {
      try {
        await this.start();
        this.restarts = 0;
        while (!this.stopping) {
          await sleep(POLL_MILLISECONDS);
          await this.poll();
        }
      } catch (error) {
        if (this.stopping) break;
        const delay = RESTART_BACKOFF_MILLISECONDS[Math.min(this.restarts, RESTART_BACKOFF_MILLISECONDS.length - 1)];
        this.restarts += 1;
        log(this.index, "restarting", { error: String(error && error.message || error).slice(0, 400), delayMs: delay });
        await this.close().catch(() => {});
        this.stopping = false;
        await sleep(delay);
      }
    }
  }
}

function startStatusServer(port, lobbies) {
  if (!port) return null;
  const server = http.createServer((request, response) => {
    if (request.url !== "/status") {
      response.writeHead(404).end();
      return;
    }
    const body = lobbies.map((lobby) => ({ lobby: lobby.index, restarts: lobby.restarts, status: lobby.status }));
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ lobbies: body }));
  });
  server.listen(port, "127.0.0.1", () => log(null, "status server", { port }));
  return server;
}

async function main() {
  const config = loadConfig();
  log(null, "starting", {
    gameUrl: config.gameUrl,
    lobbies: config.lobbies,
    rotation: config.rotation,
    minimumPlayers: config.minimumPlayers,
    countdownSeconds: config.countdownSeconds,
    postgameSeconds: config.postgameSeconds,
    headless: config.headless,
  });
  const browser = await chromium.launch({
    headless: config.headless,
    args: CHROMIUM_ARGUMENTS,
    ...(config.chromiumPath ? { executablePath: config.chromiumPath } : {}),
  });
  const lobbies = Array.from({ length: config.lobbies }, (_, index) => new Lobby(index, config, browser));
  const statusServer = startStatusServer(config.statusPort, lobbies);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(null, "stopping", { signal });
    await Promise.all(lobbies.map((lobby) => lobby.close()));
    statusServer?.close();
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => { shutdown("SIGINT"); });
  process.on("SIGTERM", () => { shutdown("SIGTERM"); });
  browser.on("disconnected", () => {
    if (!shuttingDown) {
      log(null, "browser exited; the supervisor should restart this process");
      process.exit(1);
    }
  });

  /* Lobbies start staggered so one server's Wasm downloads and map loads do
     not all land at once. */
  await Promise.all(lobbies.map(async (lobby, index) => {
    await sleep(index * 10_000);
    await lobby.run();
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
