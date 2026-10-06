import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          ABUSE_ID_SECRET: "test-only-abuse-id-secret-32-bytes-minimum",
          ADMIN_TOKEN: "test-only-admin-token-32-bytes-minimum",
          ENVIRONMENT: "test",
          /* fomo detection on, against a host the tests stub (never the
             real endpoint a developer may have in .dev.vars) */
          FOMO_RPC_URL: "http://fomo-rpc.test/rpc",
          HOST_SERVICE_TOKEN: "test-only-host-service-token-32-bytes-min",
          ROOM_ID_SECRET: "test-only-room-id-secret-32-bytes-minimum",
          TURNSTILE_TEST_BYPASS: "true",
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});
