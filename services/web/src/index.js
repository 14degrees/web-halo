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
const MAX_TELEMETRY_BODY_BYTES = 8_192;

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
  env.PERFORMANCE_TELEMETRY.writeDataPoint({
    blobs: [
      body.buildId,
      browserFamily(request.headers.get("User-Agent") || ""),
      platform,
      body.mobile ? "mobile" : "desktop",
      typeof cf.country === "string" ? cf.country : "unknown",
      typeof cf.colo === "string" ? cf.colo : "unknown",
      `${Math.round(body.viewportWidth)}x${Math.round(body.viewportHeight)}`,
    ],
    doubles: [
      body.avgFps, body.minFps, body.p95Fps, body.avgCpuMs, body.p95CpuMs,
      body.memoryBytes, body.sampleCount, body.durationMs, body.dpr,
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

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === PERFORMANCE_ROUTE) {
      return recordPerformance(request, env);
    }
    const name = campaignMapName(pathname);
    if (!name) {
      return env.ASSETS.fetch(request);
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
