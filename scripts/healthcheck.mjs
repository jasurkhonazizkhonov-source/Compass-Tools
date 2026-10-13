// Container health probe:  node scripts/healthcheck.mjs      (exit 0 = healthy, 1 = unhealthy)
//
// Asks the app's own /api/health (liveness + a real database round trip + schema status). Used by the Docker HEALTHCHECK and
// deploy/verify.sh. It prints nothing but a short verdict - /api/health's body is not echoed - and sends no credentials.
//
// The result is reported through process.exitCode and the process is left to end by itself: calling process.exit() while the HTTP
// client is still closing its socket aborts Node with a libuv assertion on some platforms (seen on Windows) and loses the exit code.
const port = process.env.PORT || "3000";
const url = `http://127.0.0.1:${port}/api/health`;

process.exitCode = 1;
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" } });
  const body = await res.json().catch(() => null);
  if (res.ok && body?.status === "ok") {
    console.log("healthy");
    process.exitCode = 0;
  } else {
    console.error(`unhealthy: HTTP ${res.status}${body?.database && body.database.ok === false ? ` (database: ${String(body.database.error ?? "down")})` : ""}`);
  }
} catch (err) {
  console.error(`unhealthy: ${err instanceof Error ? err.name : "error"}`);
}
