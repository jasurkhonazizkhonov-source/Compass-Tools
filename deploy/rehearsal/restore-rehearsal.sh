#!/usr/bin/env bash
# REHEARSAL of deploy/restore-db.sh (and deploy/backup-db.sh) WITHOUT Docker, against a REAL PostgreSQL.
#
#   PG_BIN=/path/to/postgresql-17/bin PGHOST=127.0.0.1 PGPORT=54329 PGPASSWORD=... PGUSER=postgres PGSSLMODE=require \
#     bash deploy/rehearsal/restore-rehearsal.sh /path/to/a-real-backup.dump
#
# WHAT THIS IS: the real scripts (copied unchanged into a temp directory) run with a tiny stand-in for `docker` (deploy/rehearsal/docker) that turns
# `docker compose exec -T db <cmd>` into <cmd> run locally against the PostgreSQL named by PG*; `compose stop/up` are only logged. So it exercises the SCRIPT LOGIC for real - the
# confirmation prompt, the safety-backup decision (skipped for a brand-new empty database, taken for one with data), the drop/create/restore, the read-back, the row counts -
# against a real PostgreSQL. WHAT IT IS NOT: a Docker run. It proves nothing about the image, Compose, the container's postgres user, networking or cloudflared; verify.sh is replaced
# by a stub; run `bash deploy/ci-smoke.sh` (real Docker) for those. Everything it creates is a throw-away database whose name starts with `rehearsal_`; it never touches any other.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DUMP="${1:?usage: restore-rehearsal.sh <a real .dump file made by backup-db.sh or the Admin Database Backup page>}"
[ -f "$DUMP" ] || { echo "no such file: $DUMP" >&2; exit 2; }
: "${PG_BIN:?set PG_BIN to the directory holding psql, pg_dump, pg_restore (PostgreSQL 17)}"
: "${PGHOST:?}" "${PGPORT:?}" "${PGUSER:?}" "${PGPASSWORD:?}"
export PGHOST PGPORT PGUSER PGPASSWORD
export PATH="$PG_BIN:$PATH"
psql_admin() { psql -X -q -At -d postgres -v ON_ERROR_STOP=1 "$@"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; for d in rehearsal_empty rehearsal_data rehearsal_check rehearsal_source; do psql_admin -c "DROP DATABASE IF EXISTS $d" >/dev/null 2>&1 || true; done' EXIT
mkdir -p "$TMP/deploy" "$TMP/bin" "$TMP/backups"
cp "$REPO"/deploy/*.sh "$TMP/deploy/"
cp "$HERE/docker" "$TMP/bin/docker" && chmod +x "$TMP/bin/docker"
# verify.sh needs a running stack; the rehearsal stands in a stub that records it was called.
printf '#!/usr/bin/env bash\necho "[stub] verify.sh called"\n' > "$TMP/deploy/verify.sh"
# restore-db.sh refuses an .env that other users could read; on a file system without Unix modes (Windows) `stat` cannot say 600, so the stand-in answers for it.
printf '#!/usr/bin/env bash\nif [ "${*: -1}" = ".env" ]; then echo 600; else exec "$REAL_STAT" "$@"; fi\n' > "$TMP/bin/stat" && chmod +x "$TMP/bin/stat"
export REAL_STAT="$(command -v stat)"
printf 'POSTGRES_USER=%s\n' "$PGUSER" > "$TMP/.env"
export PATH="$TMP/bin:$PATH" SHIM_LOG="$TMP/shim.log" APP_VERSION=rehearsal BACKUP_DIR="$TMP/backups" RESTORE_RESTART_SERVICES="app"
export POSTGRES_USER="$PGUSER"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  PASS  %s\n' "$*"; }
bad() { fail=$((fail + 1)); printf '  FAIL  %s\n' "$*"; }
expect() { # $1 = description, $2 = grep pattern, $3 = text
  if grep -Eq -- "$2" <<<"$3"; then ok "$1"; else bad "$1 (wanted /$2/)"; printf '%s\n' "$3" | tail -15 | sed 's/^/        | /'; fi
}
count() { psql -X -q -At -d "$1" -c "SELECT count(*) FROM \"$2\"" 2>/dev/null || echo n/a; }
run() { (cd "$TMP" && "$@") 2>&1 || true; } # the scripts exit non-zero on a refusal: the output is what is asserted

echo "== Source: the dump under test"
psql_admin -c "DROP DATABASE IF EXISTS rehearsal_source" -c "CREATE DATABASE rehearsal_source" >/dev/null
pg_restore --exit-on-error --no-owner -d rehearsal_source "$DUMP"
SRC_ACCOUNTS="$(count rehearsal_source Account)"
SRC_MIGRATIONS="$(count rehearsal_source _prisma_migrations)"
echo "   source: $SRC_ACCOUNTS accounts, $SRC_MIGRATIONS migrations"
[ "$SRC_ACCOUNTS" != "n/a" ] && [ "$SRC_ACCOUNTS" -gt 0 ] || { echo "the dump has no accounts: not a CRM backup" >&2; exit 2; }

echo "== 1. --verify (default): restores into a temporary database, shows counts, drops it, leaves the live database alone"
psql_admin -c "DROP DATABASE IF EXISTS rehearsal_data" -c "CREATE DATABASE rehearsal_data" >/dev/null
export POSTGRES_DB=rehearsal_data
out="$(run bash deploy/restore-db.sh "$DUMP")"
expect "prints the restored Account count" "Account +$SRC_ACCOUNTS" "$out"
expect "reports the migration count" "migrations +$SRC_MIGRATIONS" "$out"
expect "says the test restore is OK" "Test restore OK" "$out"
[ "$(psql_admin -c "SELECT count(*) FROM pg_database WHERE datname='compass_restore_check'")" = "0" ] && ok "the temporary database was removed" || bad "the temporary database is still there"
[ "$(count rehearsal_data Account)" = "n/a" ] && ok "the live database was not touched (still empty)" || bad "the live database changed"

echo "== 2. --replace with a WRONG confirmation changes nothing"
out="$(printf 'not-the-name\n' | run bash deploy/restore-db.sh "$DUMP" --replace)"
expect "refuses" "Confirmation did not match. Nothing was changed" "$out"
[ "$(count rehearsal_data Account)" = "n/a" ] && ok "the database is untouched" || bad "the database changed"
grep -q "compose stop" "$SHIM_LOG" 2>/dev/null && bad "the application was stopped although the confirmation failed" || ok "the application was not stopped"

echo "== 3. --replace on a BRAND-NEW EMPTY database (a replacement server): no safety backup is attempted, and the restore completes"
psql_admin -c "DROP DATABASE IF EXISTS rehearsal_empty" -c "CREATE DATABASE rehearsal_empty" >/dev/null
export POSTGRES_DB=rehearsal_empty
: > "$SHIM_LOG"
out="$(printf 'rehearsal_empty\n' | run bash deploy/restore-db.sh "$DUMP" --replace)"
expect "says there is nothing to back up first" "no CRM tables .* nothing to back up first" "$out"
expect "completes the restore" "Restore completed" "$out"
[ "$(ls "$TMP/backups" | wc -l)" = "0" ] && ok "no safety backup was written" || bad "a safety backup was written for an empty database"
[ "$(count rehearsal_empty Account)" = "$SRC_ACCOUNTS" ] && ok "Account rows match the source ($SRC_ACCOUNTS)" || bad "Account rows differ: $(count rehearsal_empty Account) vs $SRC_ACCOUNTS"
[ "$(count rehearsal_empty _prisma_migrations)" = "$SRC_MIGRATIONS" ] && ok "migration history matches ($SRC_MIGRATIONS)" || bad "migration history differs"
grep -q "compose stop" "$SHIM_LOG" && ok "the application was stopped before the replace" || bad "the application was not stopped"
grep -q "compose up -d app" "$SHIM_LOG" && ok "the application was started again afterwards" || bad "the application was not restarted"
expect "runs verify.sh at the end" "verify.sh called" "$out"

echo "== 4. --replace on a database that HAS data: a verified safety backup of the current state is taken first, then it is replaced"
psql -X -q -d rehearsal_empty -c "INSERT INTO \"Company\"(id,name,\"signatureTemplate\",\"updatedAt\") VALUES ('rehearsal-marker','Marker','x',now())" >/dev/null
export POSTGRES_DB=rehearsal_empty
out="$(printf 'rehearsal_empty\n' | run bash deploy/restore-db.sh "$DUMP" --replace)"
expect "takes the safety backup" "Safety backup of the CURRENT database" "$out"
n="$(ls "$TMP/backups"/compass-*.dump 2>/dev/null | wc -l)"
[ "$n" = "1" ] && ok "exactly one safety backup file exists" || bad "expected 1 safety backup, found $n"
sb="$(ls "$TMP/backups"/compass-*.dump | head -1)"
pg_restore --list "$sb" >/dev/null 2>&1 && ok "the safety backup is a readable dump" || bad "the safety backup is not readable"
if pg_restore --list "$sb" | grep -Eq ' TABLE DATA public "?PaymentMethodCvv"? '; then bad "the safety backup contains CVV data"; else ok "the safety backup has no CVV data"; fi
[ "$(psql -X -q -At -d rehearsal_empty -c "SELECT count(*) FROM \"Company\" WHERE id='rehearsal-marker'")" = "0" ] && ok "the database really was replaced (the marker added after the backup is gone)" || bad "the marker survived: the database was not replaced"
[ "$(count rehearsal_empty Account)" = "$SRC_ACCOUNTS" ] && ok "Account rows match the source again" || bad "Account rows differ"

echo "== 5. a file that is not a PostgreSQL dump is refused before anything is stopped"
printf 'not a dump' > "$TMP/garbage.dump"
: > "$SHIM_LOG"
out="$(printf 'rehearsal_empty\n' | run bash deploy/restore-db.sh "$TMP/garbage.dump" --replace)"
expect "refuses a non-dump" "not a readable PostgreSQL custom-format dump" "$out"
grep -q "compose stop" "$SHIM_LOG" && bad "the application was stopped for a bad file" || ok "nothing was stopped"

echo "== 6. rollback.sh refuses while a contact-only sequence enrollment is open (the previous release would stop ALL sequence sending), and proceeds once it is ended"
export POSTGRES_DB=rehearsal_empty
# the dump under test may itself hold contact-only enrollments: end them so this scenario starts from none
psql -X -q -d rehearsal_empty -c "UPDATE \"SequenceEnrollment\" SET status='UNSUBSCRIBED' WHERE \"leadId\" IS NULL" >/dev/null
psql -X -q -d rehearsal_empty -c "INSERT INTO \"Company\"(id,name,\"signatureTemplate\",\"updatedAt\") VALUES ('rb-co','C','x',now()) ON CONFLICT DO NOTHING" -c "INSERT INTO \"Account\"(id,\"fullName\",email,role,status,\"companyId\",\"updatedAt\") VALUES ('rb-a','A','rb@example.test','TRAVEL_AGENT','ACTIVE','rb-co',now())" -c "INSERT INTO \"Contact\"(id,\"firstName\",\"lastName\",\"companyId\",\"updatedAt\") VALUES ('rb-c','C','O','rb-co',now())" -c "INSERT INTO \"Sequence\"(id,name,\"createdById\",\"updatedAt\") VALUES ('rb-s','S','rb-a',now())" -c "INSERT INTO \"SequenceEnrollment\"(id,\"sequenceId\",\"contactId\",\"leadId\",status) VALUES ('rb-e','rb-s','rb-c',NULL,'ACTIVE')" >/dev/null
: > "$SHIM_LOG"
out="$(ASSUME_YES=1 run bash deploy/rollback.sh rehearsal)"
expect "refuses with the count and the instructions" "1 contact-only sequence enrollment.* Nothing was changed" "$out"
grep -q "compose up" "$SHIM_LOG" && bad "the application was restarted despite the refusal" || ok "nothing was restarted"
[ "$(psql -X -q -At -d rehearsal_empty -c "SELECT count(*) FROM \"SequenceEnrollment\" WHERE id='rb-e'")" = "1" ] && ok "the enrollment was left exactly as it was (never deleted by the script)" || bad "the enrollment was touched"
psql -X -q -d rehearsal_empty -c "UPDATE \"SequenceEnrollment\" SET status='UNSUBSCRIBED' WHERE id='rb-e'" >/dev/null
out="$(ASSUME_YES=1 run bash deploy/rollback.sh rehearsal)"
expect "proceeds once it has been ended" "Application is running compass-tools:rehearsal" "$out"
grep -q "compose up" "$SHIM_LOG" && ok "the application was restarted on the chosen image" || bad "no restart"

echo
echo "restore rehearsal: $pass passed, $fail failed"
[ "$fail" = "0" ]
