#!/usr/bin/env bash
# Logical backup of the Compass Tools PostgreSQL database (pg_dump custom format) to the VPS.
#
#   bash deploy/backup-db.sh
#   BACKUP_DIR=/var/backups/compass-tools KEEP_DAYS=14 bash deploy/backup-db.sh
#
# What it does
#   * dumps the application database from the running `db` container (no database port is ever published);
#   * EXCLUDES the data of the "PaymentMethodCvv" table. Retained security codes (CVV/CVC) are destroyed 24 hours after the signed
#     booking form; a backup that kept them would keep them for as long as the backup lives. Everything else - including the
#     ENCRYPTED card numbers - is in the backup, so a backup is as sensitive as the database: see "Backups" in
#     docs/DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md (permissions, off-box copies must be encrypted, the keys are NOT in the backup);
#   * writes the file with mode 600 in a 700 directory, verifies it can be read back and that the CVV data really is absent, then
#     deletes backups older than KEEP_DAYS (default 14);
#   * optional encryption: if BACKUP_AGE_RECIPIENT is set (an `age` public key) the dump is encrypted with age and the plaintext
#     file removed. If it is set but `age` is not installed the script FAILS rather than leave an unencrypted copy.
#
# It prints file names and sizes only - never data or credentials.
# shellcheck source=./common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need_cmd docker
BACKUP_DIR="${BACKUP_DIR:-/var/backups/compass-tools}"
KEEP_DAYS="${KEEP_DAYS:-14}"
case "$KEEP_DAYS" in ''|*[!0-9]*|0) die "KEEP_DAYS must be a whole number of days, at least 1." ;; esac

check_env_file
[ -n "$(dc ps -q db)" ] || die "The db container is not running (docker compose up -d db)."

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null 2>&1 || die "BACKUP_AGE_RECIPIENT is set but 'age' is not installed (sudo apt-get install age). Refusing to write an unencrypted backup."
fi

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$BACKUP_DIR/compass-$stamp.dump"
partial="$final.partial"
trap 'rm -f "$partial"' EXIT

step "Dumping the database (CVV data excluded)"
db_exec sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6 --no-owner --exclude-table-data="\"PaymentMethodCvv\""' > "$partial"

[ -s "$partial" ] || die "The dump is empty."
listing="$(db_exec pg_restore --list < "$partial")" || die "The dump cannot be read back (pg_restore --list failed); not keeping it."
grep -Eq ' TABLE public "?Account"? ' <<<"$listing" || die "The dump does not contain the Account table; not keeping it."
if grep -Eq ' TABLE DATA public "?PaymentMethodCvv"? ' <<<"$listing"; then
  die "The dump contains PaymentMethodCvv data. Refusing to keep it: retained security codes must not be backed up."
fi

mv "$partial" "$final"
trap - EXIT
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  age -r "$BACKUP_AGE_RECIPIENT" -o "$final.age" "$final"
  rm -f "$final"
  final="$final.age"
fi
chmod 600 "$final"
green "Backup written: $final ($(du -h "$final" | cut -f1))"

step "Pruning backups older than $KEEP_DAYS days"
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'compass-*.dump' -o -name 'compass-*.dump.age' \) -mtime "+$KEEP_DAYS" -print -delete || true
echo "Remaining backups: $(find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'compass-*.dump' -o -name 'compass-*.dump.age' \) | wc -l)"
yellow "Reminder: this file holds encrypted card numbers and personal data. Copy it OFF this server only in encrypted form, and keep the card/IP/Gmail encryption keys somewhere else - without them the backup cannot be used."
