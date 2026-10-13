#!/usr/bin/env bash
# Restore a backup made by backup-uploads.sh.
#
#   bash deploy/restore-uploads.sh /var/backups/compass-tools/uploads-20261013T021500Z.tar.gz            # CHECK only (default, harmless)
#   bash deploy/restore-uploads.sh /var/backups/compass-tools/uploads-20261013T021500Z.tar.gz --replace  # put the files back
#
# CHECK (the default): proves the archive is intact and contains ONLY upload files (directories and <2 hex>/<64 hex> files - no absolute
# paths, no "..", no links, no executables, nothing else). It changes nothing.
#
# --replace: stops the website, MOVES the current upload files aside into a folder inside the upload directory (".before-restore-<time>" -
# nothing is deleted; remove it yourself once you are satisfied), unpacks the archive as the application user with private permissions,
# starts the website and runs the database-vs-disk comparison. It asks you to type RESTORE first.
#
# Restore the DATABASE from the same day first (deploy/restore-db.sh): the records say which files should exist, and the comparison at the end
# (scripts/attachments-reconcile.ts) tells you whether the two agree. Encrypted (.age) archives must be decrypted first.
# shellcheck source=./common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need_cmd docker; need_cmd gzip; need_cmd tar
FILE="${1:-}"
MODE="${2:---check}"
[ -n "$FILE" ] || die "Usage: bash deploy/restore-uploads.sh <uploads-*.tar.gz> [--check|--replace]"
[ -f "$FILE" ] || die "Archive not found: $FILE"
case "$FILE" in *.age) die "That archive is age-encrypted. Decrypt it first (age -d -i <your key file> '$FILE' > restored.tar.gz) and pass the .tar.gz." ;; esac
case "$MODE" in --check|--replace) ;; *) die "Unknown option '$MODE' (use --check or --replace)." ;; esac
check_env_file

step "Checking the archive"
gzip -t "$FILE" || die "The archive is damaged (gzip integrity check failed)."
bad="$(gzip -dc "$FILE" | tar -tvf - | grep -Ev '^d[rwx-]{9} |^-[rwx-]{9} ' | head -3 || true)"
[ -z "$bad" ] || die "The archive contains links or special files (first: $bad). Refusing it."
unexpected="$(gzip -dc "$FILE" | tar -tf - | grep -Ev '^\./$|^\./[0-9a-f]{2}/$|^\./[0-9a-f]{2}/[0-9a-f]{64}$' | head -3 || true)"
[ -z "$unexpected" ] || die "The archive contains entries that are not upload files (first: $unexpected). Refusing it."
files="$(gzip -dc "$FILE" | tar -tf - | grep -Ec '^\./[0-9a-f]{2}/[0-9a-f]{64}$' || true)"
green "Archive OK: $files upload files, nothing else."
[ "$MODE" = "--check" ] && exit 0

# ---- --replace --------------------------------------------------------------------------------------------------------------------
yellow "This puts $files files back into the live upload directory. The website will be offline while it runs."
yellow "The files that are there now are MOVED ASIDE (not deleted) into .before-restore-<time> inside the upload directory."
printf 'Type RESTORE to continue: '
read -r typed
[ "$typed" = "RESTORE" ] || die "Confirmation did not match. Nothing was changed."

step "Stopping the website"
dc stop cloudflared cvv-cleanup app

step "Moving the current files aside"
aside="$(in_uploads_container sh -c '
  set -e
  d=/var/lib/compass-tools/uploads
  stamp=.before-restore-$(date -u +%Y%m%dT%H%M%SZ)
  mkdir "$d/$stamp"
  for e in "$d"/* "$d"/.tmp; do
    [ -e "$e" ] || continue
    case "$e" in "$d/$stamp"|"$d"/.before-restore-*) continue ;; esac
    mv "$e" "$d/$stamp"/
  done
  echo "$stamp"
')"
echo "Previous files kept in: $aside (inside the upload directory)"

step "Unpacking as the application user, with private permissions"
gzip -dc "$FILE" | in_uploads_container sh -c '
  set -e
  d=/var/lib/compass-tools/uploads
  tar -xf - -C "$d" --no-same-owner --no-same-permissions --no-overwrite-dir
  find "$d" -path "$d/.before-restore-*" -prune -o -type d -exec chmod 700 {} +
  find "$d" -path "$d/.before-restore-*" -prune -o -type f -exec chmod 600 {} +
'
green "Files restored."

step "Starting the website"
dc up -d app cvv-cleanup cloudflared
wait_healthy app

step "Comparing the database records with the files"
dc run --rm tools npx tsx scripts/attachments-reconcile.ts || yellow "The comparison reported problems - read them above. Nothing was changed by it."
yellow "When you are satisfied, free the space the old files use:  docker compose run --rm --no-deps --entrypoint rm app -rf /var/lib/compass-tools/uploads/$aside"
