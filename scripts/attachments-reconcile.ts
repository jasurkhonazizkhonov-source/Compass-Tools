// READ-ONLY check that the Lead-document records in PostgreSQL and the files on the VPS disk agree. Run it after a restore, after moving the
// server, and now and then:
//
//   docker compose run --rm tools npx tsx scripts/attachments-reconcile.ts
//
// What it reports (it never deletes, moves, writes or "fixes" anything - the tools container mounts the uploads READ-ONLY and this script
// only SELECTs):
//   MISSING   a READY attachment whose file is not on disk      -> the file is gone; restore it from a backup or tell the user
//   SIZE      a READY attachment whose file has a different size -> corrupted or truncated; restore it from a backup
//   ORPHAN    a file on disk that no record points to            -> harmless leftovers (a cancelled upload, a restore taken between a
//                                                                    delete and a backup); list is for the operator to review - nothing removes them
//   PENDING   uploads that were started and never completed       -> the daily cleanup removes the stale ones
//
// Exit code: 0 = consistent (orphans and pending are only reported), 2 = at least one MISSING or SIZE problem, 1 = the check itself failed.
// It prints counts, attachment ids (opaque UUIDs) and opaque storage keys - never a customer file name or a path outside the upload root.
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { resolveDatabaseSsl } from "../src/lib/db-tls";
import { resolveUploadRoot } from "../src/server/storage/local";

const KEY_DIR = /^[0-9a-f]{2}$/;
const KEY_FILE = /^[0-9a-f]{64}$/;
const LIST_LIMIT = 25;

type Row = { id: string; status: "PENDING" | "READY"; storageKey: string; fileSize: number | null; createdAt: Date };

async function main() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set.");
  const resolved = resolveUploadRoot();
  if ("problem" in resolved) throw new Error("UPLOAD_STORAGE_DIR is missing or invalid.");
  const root = resolved.root;
  await fs.access(root); // a missing mount must fail loudly here, not look like "no files"

  const u = new URL(raw);
  u.searchParams.delete("sslmode");
  const client = new pg.Client({ connectionString: u.toString(), ssl: resolveDatabaseSsl() });
  await client.connect();
  let rows: Row[];
  try {
    const res = await client.query<Row>(`SELECT "id", "status", "storageKey", "fileSize", "createdAt" FROM "Attachment" WHERE "storageKey" IS NOT NULL`);
    rows = res.rows;
  } finally {
    await client.end();
  }

  // Everything that looks like one of OUR files: <2 hex>/<64 hex>. Dot-directories (.tmp, .before-restore-*) and anything else are not ours.
  const onDisk = new Map<string, number>();
  let unrecognised = 0;
  for (const shard of await fs.readdir(root, { withFileTypes: true })) {
    if (shard.name.startsWith(".")) continue;
    if (!shard.isDirectory() || !KEY_DIR.test(shard.name)) {
      unrecognised++;
      continue;
    }
    for (const entry of await fs.readdir(path.join(root, shard.name), { withFileTypes: true })) {
      if (!entry.isFile() || !KEY_FILE.test(entry.name) || !entry.name.startsWith(shard.name)) {
        unrecognised++;
        continue;
      }
      onDisk.set(`${shard.name}/${entry.name}`, (await fs.stat(path.join(root, shard.name, entry.name))).size);
    }
  }

  const known = new Set(rows.map((r) => r.storageKey));
  const missing = rows.filter((r) => r.status === "READY" && !onDisk.has(r.storageKey));
  const wrongSize = rows.filter((r) => r.status === "READY" && onDisk.has(r.storageKey) && r.fileSize != null && onDisk.get(r.storageKey) !== r.fileSize);
  const pending = rows.filter((r) => r.status === "PENDING");
  const orphans = [...onDisk.entries()].filter(([key]) => !known.has(key));
  const totalBytes = [...onDisk.values()].reduce((a, b) => a + b, 0);
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  const show = (label: string, items: string[]) => {
    if (items.length === 0) return;
    console.log(`  ${label} (first ${Math.min(items.length, LIST_LIMIT)} of ${items.length}):`);
    for (const i of items.slice(0, LIST_LIMIT)) console.log(`    ${i}`);
  };

  console.log("Lead documents - database vs disk");
  console.log(`  database records (local) : ${rows.length}  (${rows.length - pending.length} ready, ${pending.length} pending)`);
  console.log(`  files on disk            : ${onDisk.size}  (${mb(totalBytes)})`);
  console.log(`  MISSING (ready, no file) : ${missing.length}`);
  console.log(`  SIZE mismatch            : ${wrongSize.length}`);
  console.log(`  ORPHAN files (no record) : ${orphans.length}  (${mb(orphans.reduce((a, [, n]) => a + n, 0))})`);
  console.log(`  PENDING uploads          : ${pending.length}`);
  if (unrecognised > 0) console.log(`  unrecognised entries     : ${unrecognised} (ignored - not files this application created)`);
  show("MISSING attachment ids", missing.map((r) => r.id));
  show("SIZE-mismatch attachment ids", wrongSize.map((r) => r.id));
  show("ORPHAN keys", orphans.map(([k, n]) => `${k}  ${mb(n)}`));

  if (missing.length > 0 || wrongSize.length > 0) {
    console.log("\nRESULT: PROBLEMS FOUND - some records point at files that are missing or damaged. Nothing was changed.");
    process.exitCode = 2;
  } else {
    console.log("\nRESULT: consistent. Nothing was changed.");
  }
}

main().catch((err) => {
  // Never print a connection string or a path: the error name and a short fixed message only.
  console.error(`attachments-reconcile failed: ${err instanceof Error ? err.message.replace(/postgres(ql)?:\/\/\S+/gi, "[url]") : "unknown error"}`);
  process.exitCode = 1;
});
