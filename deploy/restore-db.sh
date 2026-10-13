#!/usr/bin/env bash
# Restore a backup made by backup-db.sh.
#
#   bash deploy/restore-db.sh /var/backups/compass-tools/compass-20261013T021500Z.dump            # TEST restore (default, harmless)
#   bash deploy/restore-db.sh /var/backups/compass-tools/compass-20261013T021500Z.dump --replace  # REPLACE the live database
#
# TEST restore (the default): restores into a throw-away database named compass_restore_check next to the live one, prints row
# counts for a few core tables so you can see the backup is real, then drops it. The live database and the running site are not
# touched. Do this routinely - a backup you have never restored is a hope, not a backup.
#
# --replace: DESTRUCTIVE. It stops the website, takes a fresh safety backup of the CURRENT database, drops the live database and
# restores the file in its place. It needs you to type the database name to confirm. The restored database has NO retained security
# codes (backups exclude them by design). Encrypted (.age) backups must be decrypted first:  age -d -i key.txt file.age > file.dump
# shellcheck source=./common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need_cmd docker
FILE="${1:-}"
MODE="${2:---verify}"
[ -n "$FILE" ] || die "Usage: bash deploy/restore-db.sh <backup .dump file> [--verify|--replace]"
[ -f "$FILE" ] || die "Backup file not found: $FILE"
case "$FILE" in *.age) die "That backup is age-encrypted. Decrypt it first (age -d -i <your key file> '$FILE' > restored.dump) and pass the .dump." ;; esac
case "$MODE" in --verify|--replace) ;; *) die "Unknown option '$MODE' (use --verify or --replace)." ;; esac

check_env_file
[ -n "$(dc ps -q db)" ] || die "The db container is not running (docker compose up -d db)."
db_exec pg_restore --list < "$FILE" >/dev/null || die "That file is not a readable PostgreSQL custom-format dump."

LIVE_DB="$(app_db_name)"
[ -n "$LIVE_DB" ] || die "Could not determine the database name."

restore_into() { # $1 = target database (must already exist)
  db_exec sh -c 'pg_restore -U "$POSTGRES_USER" -d "$1" --no-owner --exit-on-error' sh "$1" < "$FILE"
}

if [ "$MODE" = "--verify" ]; then
  step "Test restore into a temporary database (the live database is untouched)"
  scratch="compass_restore_check"
  psql_in postgres "DROP DATABASE IF EXISTS $scratch" >/dev/null
  psql_in postgres "CREATE DATABASE $scratch" >/dev/null
  trap 'psql_in postgres "DROP DATABASE IF EXISTS '"$scratch"'" >/dev/null 2>&1 || true' EXIT
  restore_into "$scratch"
  green "Restore completed. Row counts in the restored copy:"
  for table in Account Contact Lead Quote Booking Task; do
    printf '  %-10s %s\n' "$table" "$(psql_in "$scratch" "SELECT count(*) FROM \"$table\"" 2>/dev/null || echo 'n/a')"
  done
  printf '  %-10s %s\n' "migrations" "$(psql_in "$scratch" 'SELECT count(*) FROM "_prisma_migrations"' 2>/dev/null || echo 'n/a')"
  green "Test restore OK; temporary database removed."
  exit 0
fi

# ---- --replace ----------------------------------------------------------------------------------------------------------------
yellow "This will REPLACE the live database '$LIVE_DB' with the contents of: $FILE"
yellow "The website will be offline while it runs. Any data created since the backup was taken will be lost."
printf 'Type the database name (%s) to continue: ' "$LIVE_DB"
read -r typed
[ "$typed" = "$LIVE_DB" ] || die "Confirmation did not match. Nothing was changed."

step "Stopping the website (the database stays up)"
dc stop cloudflared cvv-cleanup app

step "Safety backup of the CURRENT database"
bash "$ROOT_DIR/deploy/backup-db.sh"

step "Replacing the database"
psql_in postgres "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$LIVE_DB' AND pid <> pg_backend_pid()" >/dev/null
psql_in postgres "DROP DATABASE \"$LIVE_DB\"" >/dev/null
psql_in postgres "CREATE DATABASE \"$LIVE_DB\"" >/dev/null
restore_into "$LIVE_DB"
green "Restore completed."

step "Starting the website"
dc up -d app cvv-cleanup cloudflared
wait_healthy app
bash "$ROOT_DIR/deploy/verify.sh" || yellow "verify.sh reported problems - read them above."
