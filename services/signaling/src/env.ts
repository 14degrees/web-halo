/**
 * Non-secret bindings are generated into Env by `wrangler types`.
 *
 * Wrangler secrets intentionally do not appear in wrangler.jsonc. These two
 * optional properties document the secret-backed TURN integration without
 * replacing or duplicating the generated binding types.
 */
export type RuntimeEnv = Omit<Env, "ALLOW_NO_ORIGIN" | "ENVIRONMENT"> & {
  ABUSE_ID_SECRET: string;
  ADMIN_TOKEN: string;
  CLOUDFLARE_ANALYTICS_TOKEN?: string;
  ALLOW_NO_ORIGIN: string;
  ENVIRONMENT: string;
  /* Optional: the bearer credential a dedicated (server-run) host presents to
     create public rooms without Turnstile and with the longer room TTL. */
  HOST_SERVICE_TOKEN?: string;
  /* Optional: an RPC endpoint with an API key (Helius, ...), tried before the
     public SOLANA_RPC_URL list. */
  SOLANA_RPC_PRIVATE_URL?: string;
  /* The escrow program's settlement authority (a 64-byte Solana secret key)
     and the secret the game's per-wallet session keys derive from. Without
     them, wagered playlists are off. */
  ESCROW_AUTHORITY_SECRET_KEY?: string;
  ESCROW_SESSION_SECRET?: string;
  /* Optional: a Discord or Slack incoming webhook for money alerts
     (src/alerts.ts). */
  ALERT_WEBHOOK_URL?: string;
  ROOM_ID_SECRET: string;
  /* the broadcasts' chunks (src/broadcast.ts) */
  BROADCASTS?: R2Bucket;
  TURN_KEY_ID?: string;
  TURN_KEY_SECRET?: string;
  TURNSTILE_SECRET: string;
  TURNSTILE_TEST_BYPASS?: string;
};
