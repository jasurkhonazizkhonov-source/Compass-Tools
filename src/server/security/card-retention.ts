// Retention purge for stored card numbers. Destroys the ENCRYPTED PAN (replaces
// it with the "cv2.purged" tombstone and stamps panPurgedAt) while keeping the
// row, last4/brand/expiry and its payment history. Runs from
// `npm run cards:purge`, never from a web request, and is a DRY RUN unless
// `apply` is true. It only ever removes data; it cannot read or reveal a card.
//
// Which cards: `archived` (every removed card that still has ciphertext — e.g.
// removed before purge-on-remove existed) and/or `olderThanDays` (cards created
// more than N days ago). At least one selector is required; there is no
// "purge everything" default. Copies of purged ciphertext in database backups
// survive until those backups expire — see docs/CARD_VAULT_SECURITY.md.
import { PURGED_REFERENCE } from "./card-encryption";
import type { Queryable } from "./card-key-rotation";

export type PurgeSummary = { apply: boolean; matched: number; purged: number };

export async function purgeCardData(db: Queryable, options: { apply: boolean; archived?: boolean; olderThanDays?: number; /** Restrict the purge to these payment-method ids. */ ids?: string[] }): Promise<PurgeSummary> {
  const clauses: string[] = [];
  const params: unknown[] = [PURGED_REFERENCE];
  if (options.archived) clauses.push(`"status" = 'ARCHIVED'`);
  if (options.olderThanDays !== undefined) {
    if (!Number.isInteger(options.olderThanDays) || options.olderThanDays < 1) throw new Error("olderThanDays must be a positive whole number");
    params.push(options.olderThanDays);
    clauses.push(`"createdAt" < now() - make_interval(days => $${params.length}::int)`);
  }
  if (clauses.length === 0) throw new Error("Choose at least one selector: archived and/or olderThanDays");

  let where = `"encryptedPan" <> $1 AND (${clauses.join(" OR ")})`;
  if (options.ids) {
    params.push(options.ids);
    where += ` AND "id" = ANY($${params.length}::text[])`;
  }
  const { rows } = await db.query(`SELECT "id", "last4" FROM "PaymentMethod" WHERE ${where}`, params);
  const summary: PurgeSummary = { apply: options.apply, matched: rows.length, purged: 0 };
  if (!options.apply) return summary;

  for (const row of rows) {
    const id = String(row.id);
    const res = await db.query(`UPDATE "PaymentMethod" SET "encryptedPan" = $1, "panPurgedAt" = now(), "status" = 'ARCHIVED', "updatedAt" = now() WHERE "id" = $2 AND "encryptedPan" <> $1`, [PURGED_REFERENCE, id]);
    if ((res.rowCount ?? 0) !== 1) continue;
    summary.purged++;
    await db.query(
      `INSERT INTO "AuditLog" ("id","action","entityType","entityId","metadata","createdAt") VALUES ($1,'PAYMENT_METHOD_PURGED','PaymentMethod',$2,$3::jsonb,now())`,
      [crypto.randomUUID(), id, JSON.stringify({ last4: row.last4 ?? null, result: "SUCCESS", reason: "RETENTION_PURGE" })]
    );
  }
  return summary;
}
