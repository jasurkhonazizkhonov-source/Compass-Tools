// Re-encrypts every stored card under the CURRENT key of the key ring (and
// upgrades legacy unversioned blobs). See docs/CARD_VAULT_SECURITY.md for the
// full rotation procedure — run this only as part of it.
//
//   # dry run (default): counts rows per key id, changes nothing, needs no key
//   DATABASE_URL=... CARD_ENCRYPTION_KEYS=... CARD_ENCRYPTION_KEY_ID=... npm run cards:rotate
//   # perform the rotation
//   ... npm run cards:rotate -- --apply
//
// It prints ids and counts only — never a card number, key or ciphertext.
import pg from "pg";
import { rotateCardKeys } from "../src/server/security/card-key-rotation";

async function main() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const apply = process.argv.includes("--apply");
  const u = new URL(raw);
  u.searchParams.delete("sslmode");
  const client = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const summary = await rotateCardKeys(client, { apply });
    console.log(JSON.stringify(summary, null, 2));
    console.log(apply ? (summary.failed.length === 0 ? "Rotation complete." : "Rotation finished WITH FAILURES — investigate the listed ids before retiring any key.") : "Dry run only. Re-run with --apply to rotate.");
    if (summary.failed.length > 0) process.exitCode = 2;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`rotate-card-keys failed (${err instanceof Error ? err.name : "error"}${err && typeof err === "object" && "code" in err ? `: ${String((err as { code: unknown }).code)}` : ""})`);
  process.exit(1);
});
