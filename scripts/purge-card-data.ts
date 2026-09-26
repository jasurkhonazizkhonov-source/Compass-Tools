// Destroys stored (encrypted) card numbers per the retention policy in
// docs/CARD_VAULT_SECURITY.md. Dry run unless --apply is passed. It only ever
// removes data.
//
//   DATABASE_URL=... npm run cards:purge -- --archived
//   DATABASE_URL=... npm run cards:purge -- --older-than-days 180 --apply
//
// Prints counts only — never a card number or ciphertext.
import pg from "pg";
import { purgeCardData } from "../src/server/security/card-retention";

async function main() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const daysIdx = args.indexOf("--older-than-days");
  const olderThanDays = daysIdx >= 0 ? Number(args[daysIdx + 1]) : undefined;
  const archived = args.includes("--archived");
  const apply = args.includes("--apply");
  const u = new URL(raw);
  u.searchParams.delete("sslmode");
  const client = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const summary = await purgeCardData(client, { apply, archived, olderThanDays });
    console.log(JSON.stringify(summary, null, 2));
    if (!apply) console.log("Dry run only. Re-run with --apply to destroy these card numbers (irreversible).");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`purge-card-data failed: ${err instanceof Error ? err.message : "error"}`);
  process.exit(1);
});
