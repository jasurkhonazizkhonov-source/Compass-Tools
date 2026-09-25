#!/usr/bin/env node
// Vercel's build step for this project (wired via package.json's
// "vercel-build" script — Vercel runs that script instead of "build"
// automatically, zero extra config needed; local/CI builds still use the
// plain "build": "next build" script unchanged, so this file never runs
// outside an actual Vercel deployment).
//
// WHY THIS EXISTS: docs/DEPLOYMENT.md has always documented
// `npx prisma migrate deploy` as a manual pre-deploy step — safe (see
// below) but easy to forget, which leaves a fresh/empty PostgreSQL
// database (Scenario A/D: a brand-new deployment target, a disaster-
// recovery restore, a fresh staging environment) permanently unable to
// serve any request that touches the database, with nothing to fix it
// short of someone remembering the manual command. This automates that
// exact command as part of the build itself, using Prisma's own
// idempotent, non-destructive production migration mechanism — never
// `db push`, never `migrate reset`, never a DROP of any kind.
//
// SAFETY MODEL — directly modeled on the equivalent, already-proven build
// step in this deployment's sibling application (the public Business
// Flights Travel website, Travel Agency Website/scripts/vercel-build.mjs),
// whose own history is the reason for the ambiguity gate below: an
// earlier, ungated version of that script ran `migrate deploy`
// unconditionally and, when that project's DATABASE_URL was once
// misconfigured to point at the wrong (empty) Postgres instance,
// correctly and faithfully initialized a full CRM-compatible schema
// there — creating a live, working, but completely ORPHANED database.
// The code wasn't buggy; an empty database is structurally
// indistinguishable from "intentionally fresh environment" using schema
// state alone, so this compass-tools deployment gets the identical gate:
//   - A read-only check first asks whether this database shows ANY sign
//     of prior CRM presence (a `public."Company"` table, or Prisma's own
//     `public."_prisma_migrations"` tracking table). If either exists,
//     `migrate deploy` proceeds unconditionally — on such a database it
//     can only ever be a safe no-op (Scenario B) or a safe catch-up of
//     specifically missing migrations (Scenario C), never a first-time
//     schema creation.
//   - If NEITHER exists, initialization only proceeds when
//     DATABASE_AUTO_INIT=true is explicitly set for this environment.
//     Without it, this step logs a clear message and does nothing
//     further — the app's existing runtime behavior (a safe, generic
//     customer-facing error; the specific category in Vercel's own logs
//     via src/lib/safe-error-log.ts) continues exactly as before. This is
//     what stops a misconfigured/stale DATABASE_URL from silently
//     becoming a working orphan database: initializing a database with no
//     prior compass-tools footprint requires a deliberate, separate,
//     reviewable configuration change, never just whatever DATABASE_URL
//     happens to be set to at build time.
//   - `prisma migrate deploy` never drops or resets anything — this is
//     the same command real CI/CD pipelines use to apply pending
//     migrations. An already-fully-migrated database (the normal,
//     expected case in production) is a pure no-op ("No pending
//     migrations to apply"). A partially-migrated database gets only the
//     specifically missing migrations, in order. On a genuine conflict
//     (checksum mismatch, or an unrelated table name collision) it fails
//     loudly rather than guessing — never destructive, with or without
//     the gate.
//   - This step is best-effort and NON-BLOCKING: if DATABASE_URL isn't
//     set, the database is unreachable, or migrate deploy fails for any
//     reason, this logs a safe (credential-free) summary and the build
//     CONTINUES to `next build` regardless. Failing the entire deployment
//     over a transient build-time database hiccup would be a bigger,
//     more disruptive risk than deploying with a clearly-logged warning —
//     the application's own runtime error handling remains the safety
//     net either way.
//   - Deliberately does NOT create a baseline Company row (unlike the
//     sibling script) — compass-tools already owns that logic:
//     bootstrapInitialAdminIfEligible (src/server/auth/initial-admin-
//     bootstrap.ts) creates the Company row itself, transactionally, the
//     first time INITIAL_ADMIN_EMAIL signs in against a zero-Account
//     database. Duplicating that here would be a second, competing
//     implementation of the same bootstrap decision.
//   - Nothing here ever logs DATABASE_URL, a username, or a password.
//     Subprocess output is captured (not inherited) specifically so it
//     can be redacted before being printed.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REDACT_PATTERN = /(postgres(?:ql)?:\/\/)[^@\s]+@/gi;
export function redact(text) {
  return String(text).replace(REDACT_PATTERN, "$1[redacted]@");
}

const AUTO_INIT_ENV_VAR = "DATABASE_AUTO_INIT";

// Deliberately NOT imported from src/lib/safe-error-log.ts's own
// describeDatabaseTarget(): that file (like most of src/) reaches other
// app modules through the "@/" tsconfig path alias, which plain Node ESM
// resolution knows nothing about — a real, reproduced-locally bug (Cannot
// find package '@/generated'), not merely a Windows quirk, since this
// script runs under plain `node`, not through Next.js's/Vitest's bundler
// that would otherwise resolve that alias. Vercel's Linux build would hit
// the exact same failure. Duplicated here as a tiny, dependency-free
// function instead, matching that function's own logic exactly.
function describeDatabaseTarget() {
  const url = process.env.DATABASE_URL;
  if (!url) return "DATABASE_URL is not set in this runtime";
  try {
    const u = new URL(url);
    const db = u.pathname.replace(/^\//, "") || "(no path)";
    return `${u.hostname}:${u.port || "(default)"}/${db}`;
  } catch {
    return "DATABASE_URL is set but is not a valid URL";
  }
}

// Read-only: true only when this database shows NO sign of ever having
// run compass-tools's own migrations. Deliberately conservative — a
// database with ANY trace of prior CRM presence is treated as non-empty
// so migrate deploy (always safe there) proceeds without needing the
// explicit flag. Takes any object with a pg-style `query(sql)` so tests
// can stub it.
export async function isDatabaseEmptyOfCrmPresence(client) {
  const { rows } = await client.query(
    `SELECT to_regclass('public."Company"') IS NOT NULL AS company_exists,
            to_regclass('public."_prisma_migrations"') IS NOT NULL AS migrations_table_exists`
  );
  const row = rows[0];
  return !row.company_exists && !row.migrations_table_exists;
}

// Uses the plain `pg` driver directly — NOT the generated Prisma client.
// This script runs under bare `node` (no bundler/TypeScript loader), and
// the generated client is TypeScript with extensionless relative imports
// (`./enums`), which Node's native type-stripping cannot resolve: the
// first live test against a reachable database failed with "Cannot find
// module .../generated/prisma/enums", meaning this gate had silently never
// worked on Vercel either (it always fell into "could not check database
// state" and skipped migrations). `pg` is plain CommonJS and already a
// declared dependency.
async function connectClient(databaseUrl) {
  const { default: pg } = await import("pg");
  const u = new URL(databaseUrl);
  u.searchParams.delete("sslmode");
  const client = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 });
  await client.connect();
  return client;
}

function runMigrateDeploy() {
  console.log("[vercel-build] Running `prisma migrate deploy` (idempotent — no-op on an already up-to-date database)...");
  // A single command string (not a file+args array) with shell:true avoids
  // Node's "args not escaped" deprecation warning — safe here since nothing
  // in this fixed string is ever built from external input. shell:true
  // itself is needed because plain execFileSync("npx", ...) resolves "npx"
  // as a literal executable, which is an ENOENT on Windows (npx is
  // npx.cmd) — reproduced while testing this script locally. Vercel's own
  // build runs on Linux, where this was always a no-op either way, so this
  // only fixes local/Windows testing.
  const output = execFileSync("npx prisma migrate deploy", {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    shell: true,
  });
  console.log(redact(output));
  console.log("[vercel-build] migrate deploy completed.");
}

export async function tryInitializeDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.log("[vercel-build] DATABASE_URL not set — skipping schema init, proceeding to build.");
    return;
  }

  console.log(`[vercel-build] DATABASE_URL target: ${describeDatabaseTarget()}`);

  let client;
  let looksEmpty;
  try {
    client = await connectClient(databaseUrl);
    looksEmpty = await isDatabaseEmptyOfCrmPresence(client);
  } catch (err) {
    // The error CLASS and SQLSTATE/system code only — never the message,
    // which can embed connection detail.
    const code = err && typeof err === "object" && "code" in err ? ` code=${String(err.code)}` : "";
    console.warn(`[vercel-build] Could not check database state — continuing build anyway. (${err?.constructor?.name || "Error"}${code})`);
    if (client) await client.end().catch(() => {});
    return;
  }

  if (looksEmpty) {
    const autoInitEnabled = process.env[AUTO_INIT_ENV_VAR] === "true";
    if (!autoInitEnabled) {
      console.warn(
        `[vercel-build] This database has no existing Company table or Prisma migrations history — it looks empty, or ` +
          `unrelated to Compass Tools / Business Flights Travel. Skipping automatic schema initialization because ` +
          `${AUTO_INIT_ENV_VAR} is not set to "true". If this is an intentional brand-new environment for this ` +
          `deployment, set ${AUTO_INIT_ENV_VAR}=true in this environment's variables and redeploy. If this is NOT ` +
          `intentional, DATABASE_URL is likely misconfigured for this deployment — verify it points at the correct ` +
          `database before setting ${AUTO_INIT_ENV_VAR}.`
      );
      await client.end().catch(() => {});
      return;
    }
    console.log(`[vercel-build] Database appears empty and ${AUTO_INIT_ENV_VAR}=true — proceeding with initialization.`);
  } else {
    console.log("[vercel-build] Existing Company table or migrations history found — proceeding (migrate deploy is safe/idempotent here regardless).");
  }

  await client.end().catch(() => {});

  try {
    runMigrateDeploy();
  } catch (err) {
    // Never fail the build over this — see file header. Log a safe,
    // redacted summary and move on; the app's existing runtime error
    // handling covers a database that's still unreachable/un-migrated.
    const stdout = err && typeof err.stdout === "string" ? err.stdout : "";
    const stderr = err && typeof err.stderr === "string" ? err.stderr : "";
    console.warn("[vercel-build] migrate deploy did not complete — continuing build anyway. Details:");
    if (stdout) console.warn(redact(stdout));
    if (stderr) console.warn(redact(stderr));
  }
}

async function main() {
  // Belt-and-suspenders: tryInitializeDatabase() already catches its own
  // known failure modes (unreachable DB, migrate deploy failure), but this
  // outer catch guarantees the promise this file's own safety guarantee —
  // "the build continues regardless" — even against a bug this script
  // itself doesn't yet anticipate. `next build` always still runs.
  try {
    await tryInitializeDatabase();
  } catch (err) {
    console.warn("[vercel-build] Unexpected error during database init step — continuing build anyway.", redact(String(err?.message || err)));
  }

  console.log("[vercel-build] Running `next build`...");
  execFileSync("npx next build", { stdio: "inherit", shell: true });
}

// Only auto-run when executed directly (`node scripts/vercel-build.mjs` /
// the "vercel-build" npm script) — not when imported by a test for its
// exported functions.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error("[vercel-build] Build failed:", err?.constructor?.name || err);
    process.exit(1);
  });
}
