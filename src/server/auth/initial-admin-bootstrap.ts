// LAYER 0 — runs BEFORE the normal LAYER 2 authorization check
// (google-authorization.ts) on every Google sign-in attempt, but only ever
// has an effect on a brand-new, completely empty deployment. Solves the
// same circularity prisma/bootstrap-company.ts's own doc comment
// describes (creating an Account normally requires already being a
// signed-in Admin, which is impossible on a database with zero accounts) —
// this is the in-app alternative to running that CLI script by hand
// against production, which Vercel's serverless environment has no shell
// access to do.
//
// INITIAL_ADMIN_EMAIL is intentionally NOT a standing privilege-escalation
// mechanism: it is only ever consulted while prisma.account.count() === 0.
// The instant the first Account row exists (whether created by this
// bootstrap, by the CLI script, or by hand), this function permanently
// stops having any effect — normal authorizeGoogleUser() lookups take
// over for every subsequent sign-in, including the bootstrap email itself
// if it's ever used again.
import { Prisma } from "@/generated/prisma/client";
import type { Account } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/server/auth/google-authorization";

export type BootstrapOutcome =
  | { outcome: "created"; account: Account }
  | { outcome: "not_applicable" } // at least one Account already exists — bootstrap never applies again
  | { outcome: "not_initialized" } // zero accounts AND INITIAL_ADMIN_EMAIL is missing/blank
  | { outcome: "email_mismatch" }; // zero accounts, INITIAL_ADMIN_EMAIL is configured, this Google identity isn't it

class BootstrapRaceLostError extends Error {}

/**
 * Placeholder company row created for the very first admin — deliberately
 * minimal (this flow has no form to collect a real company name/website/
 * phone from), matching bootstrap-company.ts's own "configure the rest via
 * /company after first login" convention. The new admin edits this
 * immediately after signing in.
 */
function placeholderCompanyData() {
  return {
    name: "New Company",
    brandColor: "#1c3a5e",
    signatureTemplate: "Best regards,\n{{first_name}} {{last_name}}\n{{phone_number}}",
  };
}

/**
 * @param verifiedEmail A Google email ALREADY verified server-side by
 * verifyGoogleIdToken — never a client-supplied value trusted on its own.
 * @param verifiedName Google's own `name` claim from the same verified ID
 * token, if present — used only as the new Account's display name; never
 * trusted for anything security-relevant.
 */
export async function bootstrapInitialAdminIfEligible(verifiedEmail: string, verifiedName: string | undefined): Promise<BootstrapOutcome> {
  // Cheap short-circuit for the overwhelmingly common case (the CRM is
  // already initialized) — avoids opening a transaction on every ordinary
  // login. This is only an optimization; the real concurrency guard is the
  // re-check + unique constraint inside the transaction below.
  const existingCount = await prisma.account.count();
  if (existingCount > 0) return { outcome: "not_applicable" };

  const configured = process.env.INITIAL_ADMIN_EMAIL;
  const normalizedConfigured = configured ? normalizeEmail(configured) : "";
  // A missing OR whitespace-only value is treated identically to "not
  // configured" — never silently interpreted as a wildcard that would let
  // literally the first Google user in.
  if (!normalizedConfigured) return { outcome: "not_initialized" };

  if (normalizeEmail(verifiedEmail) !== normalizedConfigured) {
    return { outcome: "email_mismatch" };
  }

  // Real concurrency proof (Pass 37 — fresh throwaway-database test, see
  // the pass report) found two things:
  //   1. Plain READ COMMITTED isolation is NOT sufficient here: two
  //      transactions can both read account.count() === 0 before either
  //      commits, both create their OWN Company row, and only THEN
  //      collide on Account.email's unique constraint. Serializable
  //      isolation (the same isolation-level + P2034-retry idiom already
  //      established in this codebase for exactly this class of
  //      read-then-write race — see reassignLead's identical pattern in
  //      leads.ts) makes Postgres detect that conflict and abort the
  //      losing transaction.
  //   2. Even under Serializable, real testing observed a losing
  //      transaction's EARLIER statement (tx.company.create()) survive
  //      even though its LATER statement (tx.account.create()) correctly
  //      never commits, when the failure was a P2034 write conflict raised
  //      mid-transaction by this Prisma version's driver-adapter — i.e.
  //      the automatic whole-transaction rollback could not be trusted
  //      alone. Rather than depend on that, `pendingCompanyId` below
  //      tracks whatever Company row THIS attempt itself created, and a
  //      compensating cleanup step explicitly removes it if it's still
  //      unlinked to any Account after the attempt fails — regardless of
  //      whether the underlying rollback should have already done so. This
  //      is idempotent and safe to run even when rollback DID work (the
  //      row is simply already gone, and the targeted delete matches zero
  //      rows).
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let pendingCompanyId: string | undefined;
    try {
      const account = await prisma.$transaction(
        async (tx) => {
          const stillEmpty = await tx.account.count();
          if (stillEmpty > 0) throw new BootstrapRaceLostError();

          // Reuse an existing Company row if one is already present —
          // matches this app's established one-company-per-deployment
          // architecture (see the doc comment at the top of this file and
          // Company's own schema comment) rather than creating a second,
          // disconnected one. In practice every freshly-migrated database
          // already has exactly one (a historical migration seeds a
          // `default-company` placeholder row for pre-multi-tenancy
          // backfill compatibility — see
          // 20260819070000_company_multitenancy/migration.sql — which a
          // genuinely brand-new deployment still gets even though it has
          // nothing real to backfill). Only create a fresh Company when
          // literally none exists at all.
          const company = (await tx.company.findFirst({ orderBy: { createdAt: "asc" } })) ?? (await (async () => {
            const created = await tx.company.create({ data: placeholderCompanyData() });
            pendingCompanyId = created.id;
            return created;
          })());
          const created = await tx.account.create({
            data: {
              fullName: verifiedName?.trim() || verifiedEmail,
              email: normalizeEmail(verifiedEmail),
              role: "ADMIN",
              status: "ACTIVE",
              companyId: company.id,
            },
          });
          pendingCompanyId = undefined; // company+account committed together — nothing to compensate for
          return created;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
      return { outcome: "created", account };
    } catch (err) {
      if (pendingCompanyId) {
        await prisma.company.deleteMany({ where: { id: pendingCompanyId, accounts: { none: {} } } }).catch(() => undefined);
      }
      // This function's own re-check lost the race: someone else's
      // transaction already committed the first Account. Fall through to
      // "not_applicable" so the caller re-resolves via the now-existing
      // Account through the normal authorization path, rather than
      // denying the legitimate admin a session just because they lost an
      // internal race they have no way to know happened.
      if (err instanceof BootstrapRaceLostError) return { outcome: "not_applicable" };
      // Postgres detected the read/write conflict under Serializable
      // isolation and aborted this transaction — retry a couple of times
      // (the conflict is inherently transient), then fall back to a fresh
      // emptiness check rather than surfacing a raw serialization error to
      // a signing-in user.
      const isSerializationConflict = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034";
      if (isSerializationConflict && attempt < MAX_ATTEMPTS) continue;
      if (isSerializationConflict) {
        const finalCount = await prisma.account.count();
        if (finalCount > 0) return { outcome: "not_applicable" };
      }
      // Belt-and-suspenders: a duplicate-email unique-constraint violation
      // (P2002) reaching this far, under any isolation level, means the
      // same thing as losing the race above.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { outcome: "not_applicable" };
      throw err;
    }
  }
  return { outcome: "not_applicable" };
}
