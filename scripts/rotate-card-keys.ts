// Re-encrypts every stored card under the CURRENT key of the key ring (and
// upgrades legacy unversioned blobs). See docs/CARD_VAULT_SECURITY.md for the
// full rotation procedure — run this only as part of it.
//
//   # dry run (default): counts rows per key id, changes nothing, needs no key
//   DATABASE_URL=... CARD_ENCRYPTION_KEYS=... CARD_ENCRYPTION_KEY_ID=... npm run cards:rotate
//   # perform the rotation (needs BOTH flags; optionally a canary batch first: --ids=<id>,<id>)
//   ... npm run cards:rotate -- --apply --confirm
//   # AFTER a rotation, BEFORE retiring any old key: read-only proof that every card decrypts under its own key and which
//   # ring keys no row depends on any more (only those may be retired)
//   ... npm run cards:rotate -- --verify
//
// It prints ids and counts only — never a card number, key or ciphertext.
import pg from "pg";
import { resolveDatabaseSsl } from "../src/lib/db-tls";
import { rotateCardKeys, verifyCardKeys } from "../src/server/security/card-key-rotation";
import { parseRotationArgs } from "../src/server/security/card-key-rotation-cli";

async function main() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const command = parseRotationArgs(process.argv.slice(2));
  if ("error" in command) {
    console.error(command.error);
    process.exit(1);
  }
  const apply = command.mode === "apply";
  const u = new URL(raw);
  u.searchParams.delete("sslmode");
  const client = new pg.Client({ connectionString: u.toString(), ssl: resolveDatabaseSsl() });
  await client.connect();
  try {
    if (command.mode === "verify") {
      const verified = await verifyCardKeys(client);
      console.log(JSON.stringify(verified, null, 2));
      console.log(
        verified.safeToRetireListedKeys
          ? verified.retirableKeyIds.length > 0
            ? `Verified. Keys no stored card depends on (retirable): ${verified.retirableKeyIds.join(", ")}. Keep every other key.`
            : "Verified. No old key is unused yet — do not retire any key."
          : "NOT verified: some cards failed to decrypt. Do NOT retire any key; investigate the listed ids."
      );
      if (!verified.safeToRetireListedKeys) process.exitCode = 2;
      return;
    }
    const summary = await rotateCardKeys(client, { apply, ids: command.ids });
    console.log(JSON.stringify(summary, null, 2));
    console.log(apply ? (summary.failed.length === 0 ? "Rotation complete." : "Rotation finished WITH FAILURES — investigate the listed ids before retiring any key.") : "Dry run only. To rotate, re-run with --apply --confirm.");
    if (summary.failed.length > 0) process.exitCode = 2;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`rotate-card-keys failed (${err instanceof Error ? err.name : "error"}${err && typeof err === "object" && "code" in err ? `: ${String((err as { code: unknown }).code)}` : ""})`);
  process.exit(1);
});
