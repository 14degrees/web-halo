#!/usr/bin/env node

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "bea51ed443abd5b18e9e56723daa7a79";
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const SIGNALING_URL = process.env.HALO_SIGNALING_URL || "https://halo-web-signaling.otherness-bugs.workers.dev";
const ADMIN_TOKEN = process.env.HALO_ADMIN_TOKEN;

function required(value, name) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function cloudflare(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${required(API_TOKEN, "CLOUDFLARE_API_TOKEN")}`, ...(init.headers || {}) },
  });
  const value = await response.json();
  if (!response.ok || value.errors?.length) throw new Error(JSON.stringify(value.errors || value));
  return value;
}

async function performanceSummary(hours = 24) {
  const sql = `
    SELECT blob2 AS browser, blob3 AS platform, blob4 AS device,
      COUNT() AS summaries, SUM(double7) AS samples,
      ROUND(AVG(double1), 1) AS avg_fps,
      ROUND(MIN(double2), 1) AS worst_fps,
      ROUND(AVG(double3), 1) AS avg_p95_fps,
      ROUND(AVG(double4), 2) AS avg_cpu_ms,
      ROUND(AVG(double5), 2) AS avg_p95_cpu_ms,
      ROUND(AVG(double6) / 1048576, 1) AS avg_memory_mb
    FROM halo_web_performance
    WHERE timestamp > NOW() - INTERVAL '${Math.max(1, Math.min(720, hours))}' HOUR
    GROUP BY browser, platform, device
    ORDER BY samples DESC`;
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`,
    {
      body: sql,
      headers: {
        Authorization: `Bearer ${required(API_TOKEN, "CLOUDFLARE_API_TOKEN")}`,
        "Content-Type": "text/plain",
      },
      method: "POST",
    },
  );
  const value = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(value));
  console.table(value.data || value);
}

async function turnSummary(days = 7) {
  const to = new Date();
  const from = new Date(to.getTime() - Math.max(1, Math.min(90, days)) * 86_400_000);
  const query = `query TurnUsage($accountId: String!, $dateFrom: Date!, $dateTo: Date!) {
    viewer { accounts(filter: { accountTag: $accountId }) {
      callsTurnUsageAdaptiveGroups(
        filter: { date_geq: $dateFrom, date_leq: $dateTo }
        limit: 100
        orderBy: [sum_egressBytes_DESC, sum_ingressBytes_DESC]
      ) {
        dimensions { customIdentifier keyId }
        sum { egressBytes ingressBytes }
        avg { concurrentConnectionsFiveMinutes }
      }
    } }
  }`;
  const result = await cloudflare("/graphql", {
    body: JSON.stringify({
      query,
      variables: {
        accountId: ACCOUNT_ID,
        dateFrom: from.toISOString().slice(0, 10),
        dateTo: to.toISOString().slice(0, 10),
      },
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const rows = result.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups || [];
  console.table(rows.map((row) => ({
    actorId: row.dimensions.customIdentifier || "untagged",
    egressGB: (Number(row.sum.egressBytes || 0) / 1e9).toFixed(3),
    ingressGB: (Number(row.sum.ingressBytes || 0) / 1e9).toFixed(3),
    avgConnections: Number(row.avg.concurrentConnectionsFiveMinutes || 0).toFixed(1),
    keyId: row.dimensions.keyId,
  })));
}

async function signaling(path, init = {}) {
  const response = await fetch(`${SIGNALING_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${required(ADMIN_TOKEN, "HALO_ADMIN_TOKEN")}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (response.status === 204) return null;
  const value = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(value));
  return value;
}

const [command = "help", first, second] = process.argv.slice(2);
try {
  if (command === "fps") await performanceSummary(Number(first) || 24);
  else if (command === "turn") await turnSummary(Number(first) || 7);
  else if (command === "turn-live") console.dir(
    await signaling(`/v1/admin/turn?hours=${Math.max(1, Math.min(168, Number(first) || 24))}`),
    { depth: null },
  );
  else if (command === "turn-check") console.dir(
    await signaling("/v1/admin/turn/check", { method: "POST" }),
    { depth: null },
  );
  else if (command === "turn-disable") console.dir(
    await signaling("/v1/admin/turn/disable", { method: "POST" }),
    { depth: null },
  );
  else if (command === "turn-enable") {
    await signaling("/v1/admin/turn/disable", { method: "DELETE" });
    console.log("TURN credential issuance enabled.");
  }
  else if (command === "bans") console.dir(await signaling("/v1/admin/bans"), { depth: null });
  else if (command === "ban") {
    required(first, "actorId");
    console.dir(await signaling("/v1/admin/bans", {
      body: JSON.stringify({ actorId: first, reason: second || "Abusive TURN usage" }), method: "POST",
    }), { depth: null });
  } else if (command === "unban") {
    required(first, "actorId");
    await signaling(`/v1/admin/bans/${encodeURIComponent(first)}`, { method: "DELETE" });
    console.log(`Unbanned ${first}.`);
  } else {
    console.log("Usage: halo_telemetry.mjs fps [hours] | turn [days] | turn-live [hours] | turn-check | turn-disable | turn-enable | bans | ban ACTOR_ID [reason] | unban ACTOR_ID");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
