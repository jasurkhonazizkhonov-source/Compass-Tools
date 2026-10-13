#!/usr/bin/env bash
# Backup of the uploaded Lead documents (the files; the database records are backed up by backup-db.sh).
#
#   bash deploy/backup-uploads.sh
#   BACKUP_DIR=/var/backups/compass-tools KEEP_DAYS=7 bash deploy/backup-uploads.sh
#
# Why a separate backup: the database holds only METADATA (name, size, owner, which lead). The documents themselves are plain files on the
# VPS disk, so a database restore alone brings back records that point at nothing. Restore BOTH, from the same day (docs/LEAD_ATTACHMENTS.md,
# "Backup and restore").
#
# What it does
#   * archives the whole upload directory as a gzip'd tar, reading it INSIDE a throw-away container as the application user (uid 1000), so
#     this script never needs root and never opens the 0700 files itself;
#   * leaves out in-flight uploads (.tmp) and any earlier "before-restore" folder;
#   * verifies the archive (gzip integrity AND that every entry is exactly a directory or a <2 hex>/<64 hex> file - nothing else);
#   * refuses to start if the backup disk does not have room for it (the VPS disk is shared with PostgreSQL, Docker and logs);
#   * writes it with mode 600 in a 700 directory, optionally encrypts it (BACKUP_AGE_RECIPIENT, as backup-db.sh does) and prunes archives older
#     than KEEP_DAYS (default 7).
# Run it AFTER backup-db.sh (the systemd unit does): files are only ever added or deleted, so a file uploaded after the database dump is merely
# an unreferenced extra, while the opposite order could leave a record whose file is missing from the archive.
#
# It prints names, counts and sizes only. Documents may be personal data (passport copies): treat the archive like the database.
# shellcheck source=./common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need_cmd docker; need_cmd gzip; need_cmd tar
BACKUP_DIR="${BACKUP_DIR:-/var/backups/compass-tools}"
KEEP_DAYS="${KEEP_DAYS:-7}"
case "$KEEP_DAYS" in ''|*[!0-9]*|0) die "KEEP_DAYS must be a whole number of days, at least 1." ;; esac
check_env_file

if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null 2>&1 || die "BACKUP_AGE_RECIPIENT is set but 'age' is not installed (sudo apt-get install age). Refusing to write an unencrypted backup."
fi

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

step "Measuring the uploads and the free space"
used="$(in_uploads_container du "-sb" "$UPLOADS_CONTAINER_DIR" | awk '{print $1}')"
[ -n "$used" ] || die "Could not measure the upload directory (is the uploads mount present? docker compose config)."
avail="$(df -P -B1 "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
need=$(( used + used / 20 + 209715200 ))   # the data + 5% + 200 MB
echo "uploads: $(( used / 1048576 )) MB   free in $BACKUP_DIR: $(( avail / 1048576 )) MB   needed (worst case, before compression): $(( need / 1048576 )) MB"
[ "$avail" -ge "$need" ] || die "Not enough free space in $BACKUP_DIR for this backup. Free some space, back up to a bigger disk (BACKUP_DIR=...), or copy the files off the server with rsync/restic instead (see docs/LEAD_ATTACHMENTS.md)."

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$BACKUP_DIR/uploads-$stamp.tar.gz"
partial="$final.partial"
trap 'rm -f "$partial"' EXIT

step "Archiving"
in_uploads_container tar -C "$UPLOADS_CONTAINER_DIR" --exclude=./.tmp --exclude='./.before-restore-*' -cf - . | gzip -3 > "$partial"

[ -s "$partial" ] || die "The archive is empty."
gzip -t "$partial" || die "The archive failed its integrity check; not keeping it."
bad="$(gzip -dc "$partial" | tar -tf - | grep -Ev '^\./$|^\./[0-9a-f]{2}/$|^\./[0-9a-f]{2}/[0-9a-f]{64}$' | head -3 || true)"
[ -z "$bad" ] || die "The archive contains entries that are not upload files (first: $bad). Not keeping it."
files="$(gzip -dc "$partial" | tar -tf - | grep -Ec '^\./[0-9a-f]{2}/[0-9a-f]{64}$' || true)"

mv "$partial" "$final"
trap - EXIT
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  age -r "$BACKUP_AGE_RECIPIENT" -o "$final.age" "$final"
  rm -f "$final"
  final="$final.age"
fi
chmod 600 "$final"
green "Uploads backup written: $final ($files files, $(du -h "$final" | cut -f1))"

step "Pruning backups older than $KEEP_DAYS days"
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'uploads-*.tar.gz' -o -name 'uploads-*.tar.gz.age' \) -mtime "+$KEEP_DAYS" -print -delete || true
echo "Remaining uploads backups: $(find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'uploads-*.tar.gz' -o -name 'uploads-*.tar.gz.age' \) | wc -l)"
yellow "Reminder: a copy that exists only on this server is lost with the server. Copy the archive off the VPS (encrypted) - see docs/LEAD_ATTACHMENTS.md."
