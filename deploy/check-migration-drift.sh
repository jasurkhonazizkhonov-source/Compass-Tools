#!/usr/bin/env bash
# Fails if the database produced by applying prisma/migrations differs from prisma/schema.prisma - i.e. someone changed the schema
# without writing a migration (or the other way round), which would break a fresh deployment or the next `migrate deploy`.
#
#   DATABASE_URL=postgresql://... bash deploy/check-migration-drift.sh        # against a database that has JUST been migrated
#
# One difference is KNOWN and tolerated: PaymentChargeStatus still carries the labels REFUNDED / PARTIALLY_REFUNDED in the database
# although schema.prisma no longer lists them. PostgreSQL cannot drop an enum value, so migration 20260926000300_remove_stripe_
# payment_artifacts leaves them in place on purpose (see the comment in that migration). Anything else is reported and fails.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

[ -n "${DATABASE_URL:-}" ] || { echo "DATABASE_URL must point at a migrated, disposable database." >&2; exit 2; }

summary="$(npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma 2>&1)" || {
  status=$?
  # A failure to run the diff at all (not "there are differences") is an error, not a pass.
  [ "$status" -ne 2 ] && { printf '%s\n' "$summary" >&2; echo "prisma migrate diff failed to run." >&2; exit 1; }
}

unexpected="$(printf '%s\n' "$summary" | sed -e 's/\x1b\[[0-9;]*m//g' | grep -vE '^[[:space:]]*$|^Loaded Prisma config|^No difference detected|^\[\*\] Changed the `PaymentChargeStatus` enum$|^[[:space:]]*\[-\] Removed variant `(REFUNDED|PARTIALLY_REFUNDED)`$' || true)"

if [ -n "$unexpected" ]; then
  echo "schema.prisma and prisma/migrations disagree:" >&2
  printf '%s\n' "$unexpected" >&2
  echo "Write a migration for the change (npx prisma migrate dev --name <what>) and commit it." >&2
  exit 1
fi
echo "Migrations and schema.prisma agree (apart from the documented PaymentChargeStatus leftover)."
