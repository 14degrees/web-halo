import { EMBED_PATH, gamePage } from "./embed.js";

const CAMPAIGN_MAP_NAMES = Object.freeze([
  "a10.map",
  "a30.map",
  "a50.map",
  "b30.map",
  "b40.map",
  "c10.map",
  "c20.map",
  "c40.map",
  "d20.map",
  "d40.map",
]);

const SECURITY_HEADERS = Object.freeze({
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});
const PERFORMANCE_ROUTE = "/v1/telemetry/performance";
const CAMPAIGN_ROUTE = "/v1/telemetry/campaign";
const RUNTIME_ROUTE = "/v1/telemetry/runtime";
const MAX_TELEMETRY_BODY_BYTES = 8_192;
const CAMPAIGN_OUTCOMES = new Set(["completed", "abandoned", "superseded"]);
const RUNTIME_EVENTS = new Set([
  "page_loaded", "renderer_ready", "runtime_initialized", "game_presented",
  "startup_slow", "startup_stalled", "controller_connected", "controller_unavailable",
  "webgl_context_lost", "runtime_abort", "runtime_error", "map_load_started",
  "map_load_slow", "map_load_stalled", "map_load_completed", "online_state",
  "transport_connected", "online_error", "audio_running", "audio_suspended",
  "audio_blocked",
]);
const RUNTIME_GPU_CLASSES = new Set([
  "unknown", "other", "software", "nvidia", "amd", "intel", "apple", "qualcomm", "arm",
]);
const RUNTIME_ROLES = new Set(["offline", "host", "guest", "unknown"]);
const RUNTIME_CONNECTIONS = new Set(["direct", "relay", "unknown"]);
const RUNTIME_ERROR_CATEGORIES = new Set([
  "none", "unknown", "wasm-memory", "threading", "gamepad", "graphics", "audio",
  "network", "permission", "wasm-runtime", "javascript-type",
]);
const RUNTIME_VISIBILITY = new Set(["visible", "hidden", "prerender", "unknown"]);
const RUNTIME_ISOLATION = new Set(["isolated", "not-isolated", "unknown"]);
const RUNTIME_AVAILABILITY = new Set(["available", "unavailable", "unknown"]);
const RUNTIME_WEBGL = new Set(["webgl2", "webgl", "unavailable", "unknown"]);

function secureHeaders(initial) {
  const headers = new Headers(initial);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return headers;
}

async function boundedJson(request, maximumBytes) {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new Error("body-too-large");
  }
  if (!request.body) {
    throw new Error("body-required");
  }
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel("body-too-large");
      throw new Error("body-too-large");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function finiteNumber(value, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function shortString(value, maximumLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function safeToken(value, maximumLength) {
  return shortString(value, maximumLength) && /^[A-Za-z0-9_$.:~-]+$/u.test(value);
}

function browserFamily(userAgent) {
  if (/Edg\//u.test(userAgent)) return "Edge";
  if (/Firefox\//u.test(userAgent)) return "Firefox";
  if (/Chrome\//u.test(userAgent)) return "Chrome";
  if (/Safari\//u.test(userAgent)) return "Safari";
  return "Other";
}

async function recordPerformance(request, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed.\n", { status: 405, headers: secureHeaders({ Allow: "POST" }) });
  }
  let body;
  try {
    body = await boundedJson(request, MAX_TELEMETRY_BODY_BYTES);
  } catch {
    return new Response("Invalid telemetry.\n", { status: 400, headers: secureHeaders() });
  }
  if (
    !body || typeof body !== "object" || Array.isArray(body) ||
    !shortString(body.sessionId, 64) || !shortString(body.buildId, 96) ||
    !finiteNumber(body.sampleCount, 1, 600) || !finiteNumber(body.durationMs, 0, 900_000) ||
    !finiteNumber(body.avgFps, 0, 10_000) || !finiteNumber(body.minFps, 0, 10_000) ||
    !finiteNumber(body.p95Fps, 0, 10_000) || !finiteNumber(body.avgCpuMs, 0, 10_000) ||
    !finiteNumber(body.p95CpuMs, 0, 10_000) || !finiteNumber(body.memoryBytes, 0, 8 * 1024 ** 3) ||
    !finiteNumber(body.viewportWidth, 1, 32_768) || !finiteNumber(body.viewportHeight, 1, 32_768) ||
    !finiteNumber(body.dpr, 0.25, 16)
  ) {
    return new Response("Invalid telemetry.\n", { status: 400, headers: secureHeaders() });
  }
  const cf = request.cf || {};
  const platform = shortString(body.platform, 48) ? body.platform : "unknown";
  const audioState = shortString(body.audioState, 24) ? body.audioState : "unknown";
  const audioCallbacks = finiteNumber(body.audioCallbacks, 0, 1e12) ? body.audioCallbacks : 0;
  const audioLateCallbacks = finiteNumber(body.audioLateCallbacks, 0, 1e12)
    ? body.audioLateCallbacks : 0;
  const audioMaximumGapMs = finiteNumber(body.audioMaximumGapMs, 0, 3_600_000)
    ? body.audioMaximumGapMs : 0;
  env.PERFORMANCE_TELEMETRY.writeDataPoint({
    blobs: [
      body.buildId,
      browserFamily(request.headers.get("User-Agent") || ""),
      platform,
      body.mobile ? "mobile" : "desktop",
      typeof cf.country === "string" ? cf.country : "unknown",
      typeof cf.colo === "string" ? cf.colo : "unknown",
      `${Math.round(body.viewportWidth)}x${Math.round(body.viewportHeight)}`,
      audioState,
    ],
    doubles: [
      body.avgFps, body.minFps, body.p95Fps, body.avgCpuMs, body.p95CpuMs,
      body.memoryBytes, body.sampleCount, body.durationMs, body.dpr,
      audioCallbacks, audioLateCallbacks, audioMaximumGapMs,
    ],
    indexes: [body.sessionId],
  });
  return new Response(null, { status: 204, headers: secureHeaders({ "Cache-Control": "no-store" }) });
}

async function recordRuntime(request, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed.\n", { status: 405, headers: secureHeaders({ Allow: "POST" }) });
  }
  let body;
  try {
    body = await boundedJson(request, MAX_TELEMETRY_BODY_BYTES);
  } catch {
    return new Response("Invalid telemetry.\n", { status: 400, headers: secureHeaders() });
  }
  const errorCategory = body && RUNTIME_ERROR_CATEGORIES.has(body.errorCategory)
    ? body.errorCategory : "none";
  const errorFingerprint = body && body.errorFingerprint === "none"
    ? "none" : (body && typeof body.errorFingerprint === "string" &&
      /^[0-9a-f]{16}$/u.test(body.errorFingerprint) ? body.errorFingerprint : "none");
  const errorTopFrame = body && safeToken(body.errorTopFrame, 64) ? body.errorTopFrame : "none";
  const visibility = body && RUNTIME_VISIBILITY.has(body.visibility) ? body.visibility : "unknown";
  const isolation = body && RUNTIME_ISOLATION.has(body.isolation) ? body.isolation : "unknown";
  const sharedMemory = body && RUNTIME_AVAILABILITY.has(body.sharedMemory)
    ? body.sharedMemory : "unknown";
  const webgl = body && RUNTIME_WEBGL.has(body.webgl) ? body.webgl : "unknown";
  const gamepadApi = body && RUNTIME_AVAILABILITY.has(body.gamepadApi)
    ? body.gamepadApi : "unknown";
  const hardwareConcurrency = body && finiteNumber(body.hardwareConcurrency, 0, 1024)
    ? body.hardwareConcurrency : 0;
  const deviceMemoryGb = body && finiteNumber(body.deviceMemoryGb, 0, 1024)
    ? body.deviceMemoryGb : 0;
  if (
    !body || typeof body !== "object" || Array.isArray(body) ||
    !shortString(body.sessionId, 64) || !shortString(body.buildId, 96) ||
    !RUNTIME_EVENTS.has(body.event) || !shortString(body.stage, 32) ||
    !RUNTIME_GPU_CLASSES.has(body.gpuClass) || !RUNTIME_ROLES.has(body.role) ||
    !RUNTIME_CONNECTIONS.has(body.connection) ||
    !finiteNumber(body.elapsedMs, 0, 604_800_000) ||
    !finiteNumber(body.loops, 0, 1e12) || !finiteNumber(body.swaps, 0, 1e12) ||
    !finiteNumber(body.memoryBytes, 0, 8 * 1024 ** 3) ||
    !finiteNumber(body.controllerCount, 0, 16) ||
    !finiteNumber(body.mapIndex, -1, 127) || !finiteNumber(body.clientState, -1, 16) ||
    !finiteNumber(body.onlineState, -1, 16) ||
    !finiteNumber(body.viewportWidth, 1, 32_768) || !finiteNumber(body.viewportHeight, 1, 32_768) ||
    !finiteNumber(body.dpr, 0.25, 16) ||
    (body.errorCategory !== undefined && !RUNTIME_ERROR_CATEGORIES.has(body.errorCategory)) ||
    (body.errorFingerprint !== undefined && body.errorFingerprint !== "none" &&
      !/^[0-9a-f]{16}$/u.test(body.errorFingerprint)) ||
    (body.errorTopFrame !== undefined && !safeToken(body.errorTopFrame, 64)) ||
    (body.visibility !== undefined && !RUNTIME_VISIBILITY.has(body.visibility)) ||
    (body.isolation !== undefined && !RUNTIME_ISOLATION.has(body.isolation)) ||
    (body.sharedMemory !== undefined && !RUNTIME_AVAILABILITY.has(body.sharedMemory)) ||
    (body.webgl !== undefined && !RUNTIME_WEBGL.has(body.webgl)) ||
    (body.gamepadApi !== undefined && !RUNTIME_AVAILABILITY.has(body.gamepadApi)) ||
    (body.hardwareConcurrency !== undefined && !finiteNumber(body.hardwareConcurrency, 0, 1024)) ||
    (body.deviceMemoryGb !== undefined && !finiteNumber(body.deviceMemoryGb, 0, 1024))
  ) {
    return new Response("Invalid telemetry.\n", { status: 400, headers: secureHeaders() });
  }
  const cf = request.cf || {};
  const platform = shortString(body.platform, 48) ? body.platform : "unknown";
  env.RUNTIME_TELEMETRY.writeDataPoint({
    blobs: [
      body.buildId,
      body.event,
      body.stage,
      browserFamily(request.headers.get("User-Agent") || ""),
      platform,
      body.mobile ? "mobile" : "desktop",
      body.gpuClass,
      body.role,
      body.connection,
      typeof cf.country === "string" ? cf.country : "unknown",
      typeof cf.colo === "string" ? cf.colo : "unknown",
      `${Math.round(body.viewportWidth)}x${Math.round(body.viewportHeight)}`,
      errorCategory,
      errorFingerprint,
      errorTopFrame,
      visibility,
      isolation,
      sharedMemory,
      webgl,
      gamepadApi,
    ],
    doubles: [
      body.elapsedMs, body.loops, body.swaps, body.memoryBytes, body.controllerCount,
      body.mapIndex, body.clientState, body.onlineState, body.dpr, 1,
      hardwareConcurrency, deviceMemoryGb,
    ],
    indexes: [body.sessionId],
  });
  return new Response(null, { status: 204, headers: secureHeaders({ "Cache-Control": "no-store" }) });
}

async function recordCampaignLoad(request, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed.\n", { status: 405, headers: secureHeaders({ Allow: "POST" }) });
  }
  let body;
  try {
    body = await boundedJson(request, MAX_TELEMETRY_BODY_BYTES);
  } catch {
    return new Response("Invalid telemetry.\n", { status: 400, headers: secureHeaders() });
  }
  if (
    !body || typeof body !== "object" || Array.isArray(body) ||
    !shortString(body.sessionId, 64) || !shortString(body.loadId, 64) ||
    !shortString(body.buildId, 96) ||
    !shortString(body.map, 3) || !CAMPAIGN_MAP_NAMES.includes(`${body.map}.map`) ||
    !CAMPAIGN_OUTCOMES.has(body.outcome) ||
    !finiteNumber(body.durationMs, 0, 3_600_000) ||
    !finiteNumber(body.downloadMs, 0, 3_600_000) ||
    !finiteNumber(body.prepareMs, 0, 3_600_000) ||
    !finiteNumber(body.maxProgress, 0, 1) ||
    !finiteNumber(body.sampleCount, 1, 100_000) ||
    !finiteNumber(body.longestStallMs, 0, 3_600_000) ||
    !finiteNumber(body.memoryBytes, 0, 8 * 1024 ** 3) ||
    !finiteNumber(body.viewportWidth, 1, 32_768) ||
    !finiteNumber(body.viewportHeight, 1, 32_768) ||
    !finiteNumber(body.dpr, 0.25, 16)
  ) {
    return new Response("Invalid telemetry.\n", { status: 400, headers: secureHeaders() });
  }
  const cf = request.cf || {};
  const platform = shortString(body.platform, 48) ? body.platform : "unknown";
  const connection = shortString(body.connection, 16) ? body.connection : "unknown";
  env.CAMPAIGN_TELEMETRY.writeDataPoint({
    blobs: [
      body.buildId,
      body.map,
      body.outcome,
      browserFamily(request.headers.get("User-Agent") || ""),
      platform,
      body.mobile ? "mobile" : "desktop",
      connection,
      typeof cf.country === "string" ? cf.country : "unknown",
      typeof cf.colo === "string" ? cf.colo : "unknown",
      `${Math.round(body.viewportWidth)}x${Math.round(body.viewportHeight)}`,
      body.loadId,
    ],
    doubles: [
      body.durationMs,
      body.downloadMs,
      body.prepareMs,
      body.maxProgress,
      body.sampleCount,
      body.longestStallMs,
      body.memoryBytes,
      body.dpr,
    ],
    indexes: [body.sessionId],
  });
  return new Response(null, { status: 204, headers: secureHeaders({ "Cache-Control": "no-store" }) });
}

function campaignMapName(pathname) {
  // WasmFS's Fetch backend can leave a doubled separator between its base URL
  // and a mounted file name. Treat that spelling exactly like the canonical
  // URL, but keep the final component on an explicit allowlist.
  const normalized = pathname.replace(/\/{2,}/g, "/");
  const match = /^\/assets\/maps\/([^/]+)$/.exec(normalized);
  if (!match || !CAMPAIGN_MAP_NAMES.includes(match[1])) {
    return null;
  }
  return match[1];
}

function unsignedInteger(text) {
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

function singleByteRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) {
    return null;
  }

  if (!match[1]) {
    const suffix = unsignedInteger(match[2]);
    if (suffix === null || suffix === 0) {
      return null;
    }
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }

  const offset = unsignedInteger(match[1]);
  if (offset === null || offset >= size) {
    return null;
  }

  if (!match[2]) {
    return { offset, length: size - offset };
  }

  const requestedEnd = unsignedInteger(match[2]);
  if (requestedEnd === null || requestedEnd < offset) {
    return null;
  }
  const end = Math.min(requestedEnd, size - 1);
  return { offset, length: end - offset + 1 };
}

function mapHeaders(object) {
  const headers = secureHeaders();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "application/octet-stream");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  headers.set("ETag", object.httpEtag);
  return headers;
}

function mapNotFound() {
  return new Response("Campaign map not found.\n", {
    status: 404,
    headers: secureHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
  });
}

function rangeNotSatisfiable(size, object) {
  const headers = mapHeaders(object);
  headers.set("Content-Range", `bytes */${size}`);
  headers.set("Content-Length", "0");
  return new Response(null, { status: 416, headers });
}

async function serveCampaignMap(request, bucket, name) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed.\n", {
      status: 405,
      headers: secureHeaders({
        Allow: "GET, HEAD",
        "Content-Type": "text/plain; charset=utf-8",
      }),
    });
  }

  if (request.method === "HEAD") {
    const object = await bucket.head(name);
    if (!object) {
      return mapNotFound();
    }
    const headers = mapHeaders(object);
    // FetchFS deliberately sends Range: bytes=0- on HEAD, then uses this full
    // length and Accept-Ranges to decide whether it can fetch the map in
    // chunks. Reporting the full object here avoids a whole-file download.
    headers.set("Content-Length", String(object.size));
    return new Response(null, { status: 200, headers });
  }

  const rangeValue = request.headers.get("Range");
  if (rangeValue !== null) {
    const metadata = await bucket.head(name);
    if (!metadata) {
      return mapNotFound();
    }
    const range = singleByteRange(rangeValue, metadata.size);
    if (!range) {
      return rangeNotSatisfiable(metadata.size, metadata);
    }

    const object = await bucket.get(name, { range });
    if (!object) {
      return mapNotFound();
    }
    const headers = mapHeaders(object);
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`,
    );
    headers.set("Content-Length", String(range.length));
    return new Response(object.body, { status: 206, headers });
  }

  const object = await bucket.get(name);
  if (!object) {
    return mapNotFound();
  }
  const headers = mapHeaders(object);
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

/* The game page, with the X Player Card tags (/) or as the card's player
   (/embed). wrangler.jsonc runs the Worker first for these paths. */
async function serveGamePage(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed.\n", { status: 405, headers: secureHeaders({ Allow: "GET, HEAD" }) });
  }
  const asset = await env.ASSETS.fetch(new URL("/", url));
  if (!asset.ok) {
    return asset;
  }
  const page = gamePage(await asset.text(), {
    url,
    twitterSite: env.TWITTER_SITE,
    extraFrameAncestors: env.EMBED_FRAME_ANCESTORS,
    embed: url.pathname === EMBED_PATH,
  });
  return new Response(request.method === "HEAD" ? null : page.html, {
    headers: secureHeaders(page.headers),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (pathname === "/" || pathname === EMBED_PATH) {
      return serveGamePage(request, env, url);
    }
    if (pathname === `${EMBED_PATH}/`) {
      /* the page's asset URLs are relative to / */
      return Response.redirect(new URL(EMBED_PATH + url.search, url), 301);
    }
    if (pathname === PERFORMANCE_ROUTE) {
      return recordPerformance(request, env);
    }
    if (pathname === CAMPAIGN_ROUTE) {
      return recordCampaignLoad(request, env);
    }
    if (pathname === RUNTIME_ROUTE) {
      return recordRuntime(request, env);
    }
    const name = campaignMapName(pathname);
    if (!name) {
      return env.ASSETS.fetch(request);
    }

    if (!env.CAMPAIGN_MAPS) {
      /* A multiplayer-only deployment has no campaign bucket bound. */
      return new Response("Campaign maps are not available on this deployment.\n", {
        status: 404,
        headers: secureHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
      });
    }
    try {
      return await serveCampaignMap(request, env.CAMPAIGN_MAPS, name);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "campaign map read failed",
          map: name,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return new Response("Campaign map is temporarily unavailable.\n", {
        status: 503,
        headers: secureHeaders({
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8",
        }),
      });
    }
  },
};
