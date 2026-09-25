// Writes src/lib/migration-manifest.json: the list of Prisma migration folder
// names this build EXPECTS to be applied. The running app compares it with the
// database's own _prisma_migrations table (see src/lib/health-check.ts) so a
// deploy that shipped code needing a migration the database does not have is
// detected immediately, instead of surfacing as scattered runtime errors.
//
//   npm run migrations:manifest
//
// src/lib/__tests__/migration-manifest.test.ts fails if this file is stale.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "prisma", "migrations");
const migrations = fs
  .readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
fs.writeFileSync(path.join(root, "src", "lib", "migration-manifest.json"), JSON.stringify({ migrations }, null, 2) + "\n");
console.log(`migration manifest written: ${migrations.length} migrations, latest ${migrations.at(-1)}`);
