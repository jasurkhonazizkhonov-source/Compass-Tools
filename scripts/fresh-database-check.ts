// Repeatable, fully automated version of the manual "connect a genuinely
// empty PostgreSQL database and use the app normally" portability test
// (see prisma/seed-data/README.md's "How this was tested" section for the
// manual procedure this script replaces). Creates a real, disposable
// database on the SAME Postgres server DATABASE_URL already points at,
// migrates it from scratch, runs the checks in
// fresh-database-check-inner.ts against it in a separate process, then
// drops it — regardless of pass or fail. Never touches .env, never writes
// a connection string to any file, never touches the real dev database
// beyond using it to issue CREATE DATABASE / DROP DATABASE (which need an
// existing connection to run from).
//
// Usage:  npx tsx scripts/fresh-database-check.ts
//
// Deliberately NOT part of `npm run test` / `vitest run` — this creates
// and drops a real database and needs CREATEDB privilege, which a locked-
// down CI database user may not have. Run manually (or wire into a CI job
// that specifically has that privilege) when validating a change to the
// self-healing reference-data mechanism itself.
import "dotenv/config";
import { spawn } from "node:child_process";
import { Client } from "pg";

function connectionStringWithoutSslMode(url: string): string {
  const u = new URL(url);
  u.searchParams.delete("sslmode");
  return u.toString();
}

function runChild(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, shell: true, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

async function main() {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error("DATABASE_URL is not set in the current environment");

  const dbName = `compass_fresh_check_${Date.now()}`;
  const adminUrl = connectionStringWithoutSslMode(baseUrl);

  const freshUrlObj = new URL(adminUrl);
  freshUrlObj.pathname = `/${dbName}`;
  const freshUrl = freshUrlObj.toString();

  console.log(`Creating disposable database "${dbName}"...`);
  const adminClient = new Client({ connectionString: adminUrl, ssl: { rejectUnauthorized: false } });
  await adminClient.connect();
  try {
    await adminClient.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await adminClient.end();
  }

  let exitCode = 1;
  try {
    console.log("Running migrations against the fresh database...");
    const migrate = await runChild("npx", ["prisma", "migrate", "deploy"], { ...process.env, DATABASE_URL: freshUrl });
    if (migrate.code !== 0) throw new Error(`prisma migrate deploy failed with exit code ${migrate.code}`);

    console.log("Running portability checks against the fresh database (zero manually seeded reference data)...");
    const check = await runChild("npx", ["tsx", "scripts/fresh-database-check-inner.ts"], { ...process.env, DATABASE_URL: freshUrl });
    exitCode = check.code;

    if (exitCode === 0) {
      console.log("\nPASS — fresh-database portability check succeeded.");
    } else {
      console.error("\nFAIL — see output above for the failing assertion.");
    }
  } finally {
    console.log(`Dropping disposable database "${dbName}"...`);
    const cleanupClient = new Client({ connectionString: adminUrl, ssl: { rejectUnauthorized: false } });
    await cleanupClient.connect();
    try {
      // Terminate any lingering connections (Prisma's connection pool in
      // the child process) before dropping — Postgres refuses DROP
      // DATABASE while other sessions are still connected to it.
      await cleanupClient.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName]
      );
      await cleanupClient.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } finally {
      await cleanupClient.end();
    }
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
