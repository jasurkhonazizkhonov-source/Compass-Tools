// Daily CVV/CVC cleanup for a self-hosted (Docker Compose) deployment.
//
//   node scripts/cvv-cleanup-scheduler.mjs          run as a service: a catch-up run shortly after start, then once a day
//   node scripts/cvv-cleanup-scheduler.mjs --once   run once and exit (0 = done, 1 = failed) - for a manual run or a test
//
// It does exactly one thing: it calls the app's authenticated POST /api/cron/cvv-cleanup, which destroys every retained security
// code whose 24-hour window has ended. It does NOT touch /api/cron/tasks (so no task notifications are triggered, no card-number
// retention purge, no other maintenance) and it never reads or writes the database itself.
//
// Safety properties
//  - Authenticated: sends CRON_SECRET as a bearer token (the same gate as every /api/cron/* route). The secret is read from the
//    environment, never written to a log, a URL or an error message.
//  - Idempotent and retry-safe: the endpoint only deletes rows that are already past expiresAt, so running it twice, late, or
//    after a failed attempt cannot remove a still-valid code or extend a lifetime. A failed attempt is retried (1, 5, 15 minutes).
//  - Catch-up: if the host or container was down at the scheduled time, the run shortly after start repairs it. (An expired code
//    cannot be revealed even before cleanup - the reveal path refuses and destroys it - so a late run is hygiene, not exposure.)
//  - Observable: one JSON line per attempt on stdout/stderr (`docker compose logs cvv-cleanup`); an optional heartbeat URL
//    (CLEANUP_HEARTBEAT_URL, e.g. a Healthchecks.io check) is pinged after each success so a dead scheduler is noticed.
//
// The time of day is a fixed 03:30 UTC. It is not a retention setting: the 24-hour lifetime is enforced by the application and the
// database, and nothing here can change it.
const SECRET = process.env.CRON_SECRET?.trim();
const BASE = (process.env.CRON_TARGET_URL?.trim() || "http://app:3000").replace(/\/+$/, "");
const HEARTBEAT = process.env.CLEANUP_HEARTBEAT_URL?.trim();
const ONCE = process.argv.includes("--once");

const RUN_AT_UTC = { hour: 3, minute: 30 };
const STARTUP_DELAY_MS = 90_000; // let the app finish starting before the catch-up run
const RETRY_DELAYS_MS = [0, 60_000, 300_000, 900_000];

function log(level, fields) {
  const line = JSON.stringify({ time: new Date().toISOString(), job: "cvv-cleanup", ...fields });
  (level === "error" ? console.error : console.log)(line);
}

if (!SECRET) {
  log("error", { status: "misconfigured", detail: "CRON_SECRET is not set; the endpoint would refuse the request" });
  process.exit(1);
}
if (!/^https?:\/\/[^/\s]+$/i.test(BASE)) {
  log("error", { status: "misconfigured", detail: "CRON_TARGET_URL must be a bare origin such as http://app:3000" });
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt(n) {
  try {
    const res = await fetch(`${BASE}/api/cron/cvv-cleanup`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      log("info", { status: "ok", attempt: n, destroyed: typeof body.cvvRecordsDestroyed === "number" ? body.cvvRecordsDestroyed : null });
      return true;
    }
    // Only the status code is reported: the response is not echoed.
    log("error", { status: "failed", attempt: n, httpStatus: res.status, hint: res.status === 401 ? "CRON_SECRET does not match the app's" : res.status === 503 ? "the app has no CRON_SECRET set" : undefined });
  } catch (err) {
    log("error", { status: "failed", attempt: n, error: err instanceof Error ? err.name : "error" });
  }
  return false;
}

async function runWithRetries() {
  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    if (RETRY_DELAYS_MS[i] > 0) await sleep(RETRY_DELAYS_MS[i]);
    if (await attempt(i + 1)) {
      if (HEARTBEAT) await fetch(HEARTBEAT, { signal: AbortSignal.timeout(10_000) }).catch(() => log("error", { status: "heartbeat_failed" }));
      return true;
    }
  }
  log("error", { status: "gave_up", detail: "all attempts failed; the next scheduled run will try again" });
  return false;
}

function msUntilNextRun(now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), RUN_AT_UTC.hour, RUN_AT_UTC.minute, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

if (ONCE) {
  // exitCode, not process.exit(): forcing an exit while the HTTP client is closing can abort Node on some platforms and lose the code.
  process.exitCode = (await runWithRetries()) ? 0 : 1;
} else {
  log("info", { status: "started", target: new URL(BASE).host, nextScheduledRunInMinutes: Math.round(msUntilNextRun() / 60_000) });
  await sleep(STARTUP_DELAY_MS);
  await runWithRetries(); // catch-up
  for (;;) {
    await sleep(msUntilNextRun());
    await runWithRetries();
  }
}
