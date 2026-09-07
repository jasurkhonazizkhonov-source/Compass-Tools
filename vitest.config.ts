import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    // Under full-suite parallel execution on this dev machine, a handful of
    // tests intermittently exceed vitest's 5s default (isolated re-runs of
    // the exact same tests consistently finish in well under 1s) — this is
    // resource contention between worker threads, not a real hang. Raised
    // rather than chased, since there's no actual slow operation to fix.
    testTimeout: 20_000,
  },
});
