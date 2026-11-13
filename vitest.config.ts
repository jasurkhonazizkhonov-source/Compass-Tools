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
    // Fail-closed gate in front of every database-backed test (src/test/integration-database-guard.ts): when INTEGRATION_DATABASE_URL is set it must
    // be the approved local disposable database (loopback literal, exactly `compass_test`) and the live server must confirm it, or the whole run is
    // aborted before any file loads. With the variable unset it does nothing.
    globalSetup: ["./src/test/integration-database-guard.ts"],
    // Under full-suite parallel execution on this dev machine, a handful of
    // tests intermittently exceed vitest's 5s default (isolated re-runs of
    // the exact same tests consistently finish in well under 1s) — this is
    // resource contention between worker threads, not a real hang. Raised
    // rather than chased, since there's no actual slow operation to fix.
    testTimeout: 45_000,
    // Same contention story for setup hooks that import a large module graph
    // (the real-database integration suites).
    hookTimeout: 60_000,
    // The cause of the contention above, measured on this 8 GB / 12-thread machine: vitest starts one worker per logical CPU (12), each loading jsdom,
    // React and the generated Prisma client, so free memory falls below 1 GB and individual tests take 16-49 s where an isolated run takes under a
    // second - then a jsdom UI test misses a default asyncUtil timeout, or a worker is "torn down", and a different file fails each time (seen:
    // quote-builder-gds-tabs, leads, reassignment, deploy-image-version). Capping the workers fixed it with no test, assertion or timeout changed:
    // two full runs at 4 workers passed every test. Raise it on a machine with more memory (VITEST_MAX_WORKERS=8) - it is a cap, not a floor.
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS) > 0 ? Number(process.env.VITEST_MAX_WORKERS) : 4,
  },
});
