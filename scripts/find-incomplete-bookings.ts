// READ-ONLY diagnostic: lists bookings left half-finished by the old,
// non-atomic "Finish Booking" (a Booking row was written first, and a later
// step — a payment method, or the Quote -> SIGNED / Lead -> BOOKED
// transition — failed or the function was killed by the platform). Newer
// code commits all of it in one transaction, so no NEW ones can appear;
// this finds any that already exist so someone can follow up with the
// customer.
//
//   DATABASE_URL=postgres://... npx tsx scripts/find-incomplete-bookings.ts
//
// It never writes, and prints only references/ids/statuses — no names,
// emails, phone numbers or card data.
import pg from "pg";

async function main() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const u = new URL(raw);
  u.searchParams.delete("sslmode");
  const client = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const { rows } = await client.query(`
      SELECT b."bookingReference", b."id" AS "bookingId", q."quoteNumber", q."status" AS "quoteStatus",
             b."createdAt", COUNT(pm."id")::int AS "paymentMethods", (s."id" IS NOT NULL) AS "hasSignature"
      FROM "Booking" b
      JOIN "Quote" q ON q."id" = b."quoteId"
      LEFT JOIN "PaymentMethod" pm ON pm."bookingId" = b."id"
      LEFT JOIN "Signature" s ON s."bookingId" = b."id"
      GROUP BY b."id", q."id", s."id"
      HAVING COUNT(pm."id") = 0 OR q."status" IN ('SENT', 'READ', 'VIEWED')
      ORDER BY b."createdAt" DESC
    `);
    if (rows.length === 0) {
      console.log("No incomplete bookings found.");
      return;
    }
    console.log(`${rows.length} booking(s) look incomplete (no payment method saved, or the quote was never marked SIGNED):\n`);
    console.table(rows.map((r) => ({ ...r, createdAt: new Date(r.createdAt).toISOString() })));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Failed:", err?.constructor?.name, err?.code ?? "");
  process.exit(1);
});
