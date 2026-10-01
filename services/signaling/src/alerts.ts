import type { RuntimeEnv } from "./env";
import { escrowRpc, escrowSetup } from "./wager";

/* Alerts about money: a match whose settlement was given up on, stakes
   that would not lock, the settlement wallet running low. Each is logged,
   and posted to ALERT_WEBHOOK_URL when that secret is set (a Discord or
   Slack incoming webhook: both fields are sent). The same alert is posted
   at most once an hour. */

const REPEAT_SECONDS = 60 * 60;
/* below this the settlement wallet cannot hold many matches' rent */
const LOW_BALANCE_LAMPORTS = 50_000_000;

export async function alert(env: RuntimeEnv, key: string, text: string): Promise<void> {
  console.error(JSON.stringify({ message: "alert", key, text }));
  if (!env.ALERT_WEBHOOK_URL) return;
  const seen = `alert:${key}`;
  if (await env.HALO_ABUSE.get(seen)) return;
  await env.HALO_ABUSE.put(seen, "1", { expirationTtl: REPEAT_SECONDS });
  try {
    await fetch(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `Halo money: ${text}`, text: `Halo money: ${text}` }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error(JSON.stringify({ message: "alert not posted", key, error: error instanceof Error ? error.message : String(error) }));
  }
}

/* The cron's check: the settlement wallet holds enough. */
export async function checkSettlementWallet(env: RuntimeEnv): Promise<void> {
  const setup = await escrowSetup(env);
  if (!setup) return;
  let lamports: number;
  try {
    lamports = await escrowRpc(env).balance(setup.authority.address);
  } catch (error) {
    await alert(env, "rpc-down", `can't read the settlement wallet's balance: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (lamports < LOW_BALANCE_LAMPORTS) {
    await alert(env, "low-balance",
      `the settlement wallet ${setup.authority.address} is down to ${(lamports / 1e9).toFixed(4)} SOL (${setup.cluster}); top it up`);
  }
}
