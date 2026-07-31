import path from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const emptyAssets = path.join(path.dirname(fileURLToPath(import.meta.url)), "test", "fixtures", "empty-assets");

export default defineConfig({
  test: {
    // A full refresh is deliberately sequential and rate-limited (250ms between
    // sources, see evaluate.ts), so the refresh tests take roughly
    // sources × 250ms — already past vitest's 5s default, and growing with every
    // source added to satvis.core.yaml. Worth raising rather than parallelizing:
    // the spacing is what keeps the real worker from hammering CelesTrak, and a
    // test that skipped it would stop exercising the real path. A timed-out
    // refresh also keeps running and its fetches leak into the next test's spy,
    // so the failure lands far from its cause.
    testTimeout: 30_000,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Ephemeral in-memory KV for tests (do not touch remote/local data).
        kvNamespaces: ["GP_KV"],
        // Point the assets binding at an empty dir so the pool does not walk
        // the real ../dist build (which may contain large local-only model
        // assets exceeding the Workers asset size limit).
        assets: { directory: emptyAssets },
      },
    }),
  ],
});
