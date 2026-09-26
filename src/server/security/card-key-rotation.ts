// Re-encryption of stored cards under the ring's CURRENT key — the mechanism
// behind key rotation and the one-time upgrade of legacy (unversioned) blobs to
// the versioned envelope. Runs from `npm run cards:rotate` against whatever
// DATABASE_URL the operator supplies; it is never reachable from a web request.
//
// Safety properties:
//   • Dry run by default — nothing is written unless `apply` is true.
//   • Each row is decrypted under its OWN key (by id), re-encrypted under the
//     current key, and the new value is decrypted again and compared before it
//     is written. A row that fails any step is left untouched and reported by
//     id + a fixed error code (never a value).
//   • The write is a compare-and-swap (`WHERE id = $1 AND "encryptedPan" = $old`),
//     so a concurrent edit by the application can never be overwritten.
//   • Purged (tombstone) rows are skipped; no plaintext is logged or returned.
//   • Old keys stay in the ring until you retire them (docs/CARD_VAULT_SECURITY.md).
import { CardVaultError, decryptPan, encryptPan, inspectReference } from "./card-encryption";
import { getKeyringStatus } from "./card-keyring";

/** The minimal database surface needed — satisfied by `pg.Client`. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export type RotationSummary = {
  apply: boolean;
  currentKeyId: string;
  total: number;
  alreadyCurrent: number;
  purged: number;
  /** Rows that were (apply) or would be (dry run) re-encrypted, by their current key id / "legacy". */
  toRotate: Record<string, number>;
  rotated: number;
  raced: number;
  failed: Array<{ id: string; code: string }>;
};

export async function rotateCardKeys(db: Queryable, options: { apply: boolean; batchSize?: number; /** Rotate only these payment-method ids (e.g. a canary batch). */ ids?: string[] }): Promise<RotationSummary> {
  const ring = getKeyringStatus();
  if (ring.state !== "configured" || !ring.currentKeyId) throw new CardVaultError("NOT_CONFIGURED");
  const summary: RotationSummary = {
    apply: options.apply,
    currentKeyId: ring.currentKeyId,
    total: 0,
    alreadyCurrent: 0,
    purged: 0,
    toRotate: {},
    rotated: 0,
    raced: 0,
    failed: [],
  };
  const batchSize = options.batchSize ?? 200;
  let after = "";

  for (;;) {
    const { rows } = options.ids
      ? await db.query(`SELECT "id", "encryptedPan" FROM "PaymentMethod" WHERE "id" > $1 AND "id" = ANY($3::text[]) ORDER BY "id" LIMIT $2`, [after, batchSize, options.ids])
      : await db.query(`SELECT "id", "encryptedPan" FROM "PaymentMethod" WHERE "id" > $1 ORDER BY "id" LIMIT $2`, [after, batchSize]);
    if (rows.length === 0) break;
    for (const row of rows) {
      const id = String(row.id);
      const oldRef = String(row.encryptedPan);
      after = id;
      summary.total++;
      const info = inspectReference(oldRef);
      if (!info) {
        summary.failed.push({ id, code: "MALFORMED" });
        continue;
      }
      if (info.format === "purged") {
        summary.purged++;
        continue;
      }
      if (info.format === "envelope" && info.keyId === ring.currentKeyId) {
        summary.alreadyCurrent++;
        continue;
      }
      const label = info.format === "legacy" ? "legacy" : info.keyId;
      summary.toRotate[label] = (summary.toRotate[label] ?? 0) + 1;
      if (!options.apply) continue;

      try {
        let plain = decryptPan(oldRef, id);
        const newRef = encryptPan(plain, id);
        if (decryptPan(newRef, id) !== plain) throw new CardVaultError("AUTH_FAILED");
        plain = "";
        const res = await db.query(`UPDATE "PaymentMethod" SET "encryptedPan" = $1, "updatedAt" = now() WHERE "id" = $2 AND "encryptedPan" = $3`, [newRef, id, oldRef]);
        if ((res.rowCount ?? 0) === 1) summary.rotated++;
        else summary.raced++;
      } catch (err) {
        summary.failed.push({ id, code: err instanceof CardVaultError ? err.code : "UNKNOWN" });
      }
    }
  }

  if (options.apply) {
    await db.query(
      `INSERT INTO "AuditLog" ("id","action","entityType","entityId","metadata","createdAt") VALUES ($1,'CARD_KEYS_ROTATED','CardVault','keyring',$2::jsonb,now())`,
      [crypto.randomUUID(), JSON.stringify({ currentKeyId: ring.currentKeyId, total: summary.total, rotated: summary.rotated, raced: summary.raced, failed: summary.failed.length, result: summary.failed.length === 0 ? "SUCCESS" : "PARTIAL" })]
    );
  }
  return summary;
}
