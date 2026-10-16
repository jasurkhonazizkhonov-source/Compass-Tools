#!/usr/bin/env bash
# Read-only report on disk space and on what the uploaded Lead documents use. Changes nothing, deletes nothing.
#
#   bash deploy/uploads-usage.sh
#
# Shows: free space on the disks that matter (the VPS disk is shared by PostgreSQL, Docker images, logs and the uploads), how much the
# uploads take, the totals by storage backend, and the LARGEST uploads (attachment id, size, date, lead - never a file name) so you can ask the
# owner of a big one whether it is still needed. Deleting is always a deliberate, per-file decision in the CRM (Admin / Manager); nothing here,
# and nothing in the application, ever removes a valid document to make room.
# shellcheck source=./common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need_cmd docker
check_env_file
host_dir="$(uploads_host_dir)"

step "Disk space (df -h)"
df -h / "$host_dir" 2>/dev/null | awk 'NR==1 || !seen[$1 $6]++'
echo
echo "Free space left for NEW uploads is also reported by the app: /api/health -> readiness.uploadStorage (ready / low_space / unavailable)."

step "What the uploads take"
in_uploads_container du -sh "$UPLOADS_CONTAINER_DIR" 2>/dev/null | awk '{print "  uploads directory: " $1}'
in_uploads_container sh -c 'find /var/lib/compass-tools/uploads -path "*/.before-restore-*" -prune -o -type f -print | wc -l' | awk '{print "  files: " $1}'
leftover="$(in_uploads_container sh -c 'ls -d /var/lib/compass-tools/uploads/.before-restore-* 2>/dev/null | wc -l')"
[ "${leftover:-0}" -gt 0 ] && yellow "  $leftover '.before-restore-*' folder(s) from a past restore are still taking space (restore-uploads.sh explains how to remove them once you are satisfied)."

step "Records (database)"
db="$(app_db_name)"
psql_in "$db" "SELECT \"status\" || '  files=' || count(*) || '  size=' || pg_size_pretty(coalesce(sum(\"fileSize\"),0)::bigint) FROM \"Attachment\" WHERE \"storageKey\" IS NOT NULL GROUP BY \"status\" ORDER BY 1" | sed 's/^/  /'

step "The 15 largest uploads (id, size, date, lead id - no file names)"
psql_in "$db" "SELECT \"id\" || '  ' || pg_size_pretty(\"fileSize\"::bigint) || '  ' || \"createdAt\"::date || '  lead=' || coalesce(\"leadId\",'-') FROM \"Attachment\" WHERE \"fileSize\" IS NOT NULL AND \"storageKey\" IS NOT NULL ORDER BY \"fileSize\" DESC LIMIT 15" | sed 's/^/  /'

step "Docker's own disk use"
docker system df 2>/dev/null | sed 's/^/  /' || true

echo
echo "To compare the database with the files:   docker compose run --rm tools npx tsx scripts/attachments-reconcile.ts"
