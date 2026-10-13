#!/usr/bin/env bash
# Controlled deployment of a reviewed commit to this VPS. Nothing here runs by itself: pushing to GitHub does NOT deploy.
#
#   bash deploy/deploy.sh                       # deploy origin/main (it shows what will change and asks first)
#   bash deploy/deploy.sh --migrate             # ...and apply pending database migrations (a backup is taken first)
#   bash deploy/deploy.sh --ref <tag|sha>       # deploy a specific reviewed commit that is on origin/main
#   bash deploy/deploy.sh --yes                 # do not ask for confirmation
#
# Safety rules enforced here
#   * The checkout must be clean: uncommitted changes on the server are never overwritten or discarded - the script stops.
#   * Only fast-forward updates (no merge commits, no resets). A --ref must already be on origin/main.
#   * Database migrations are NEVER implicit. Pending ones stop the deploy unless --migrate is given; with --migrate a verified
#     backup is taken first and only 'prisma migrate deploy' runs (it applies pending migrations; it never resets or drops).
#   * The images are tagged with the commit id (APP_VERSION), so the previous version stays available for deploy/rollback.sh.
#   * It ends with deploy/verify.sh.
#
# Building the image needs about 3 GB of free memory: on a 4 GB server add swap first (see the guide) and build while traffic is low.
# shellcheck source=./common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need_cmd docker; need_cmd git
MIGRATE=0; REF="origin/main"
while [ $# -gt 0 ]; do
  case "$1" in
    --migrate) MIGRATE=1 ;;
    --yes) ASSUME_YES=1 ;;
    --ref) shift; REF="${1:-}"; [ -n "$REF" ] || die "--ref needs a value" ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

step "Pre-flight"
check_env_file
[ -z "$(git status --porcelain --untracked-files=no)" ] || { git status --short --untracked-files=no >&2; die "The checkout has uncommitted changes. They are not touched. Commit them in GitHub (preferred) or stash them deliberately, then re-run."; }
git fetch --tags --prune origin
TARGET="$(git rev-parse --verify --quiet "$REF^{commit}")" || die "Unknown ref: $REF"
git merge-base --is-ancestor "$TARGET" origin/main || die "$REF is not on origin/main. Only reviewed (merged) commits are deployed."
CURRENT="$(git rev-parse HEAD)"
PREVIOUS_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$(dc ps -q app 2>/dev/null | head -1)" 2>/dev/null || true)"
echo "Currently checked out : $(git log -1 --format='%h %s' "$CURRENT")"
echo "Deploying             : $(git log -1 --format='%h %s' "$TARGET")"
echo "Running image         : ${PREVIOUS_IMAGE:-none}"
if [ "$CURRENT" != "$TARGET" ]; then
  echo "Changes:"; git log --oneline --no-decorate "$CURRENT..$TARGET" 2>/dev/null | head -30 || true
  echo "Files changed in prisma/migrations (database changes):"
  git diff --name-only "$CURRENT" "$TARGET" -- prisma/migrations 2>/dev/null | sed 's/^/  /' || true
fi
confirm "Continue with the deployment?" || die "Cancelled. Nothing was changed."

step "Updating the checkout (fast-forward only)"
if [ "$REF" = "origin/main" ]; then
  git checkout --quiet main
  git merge --ff-only origin/main
else
  git checkout --quiet --detach "$TARGET"
  yellow "Checked out $TARGET (detached). The next normal deploy returns to main automatically."
fi
APP_VERSION="$(git rev-parse --short=12 HEAD)"
export APP_VERSION
echo "Image version: $APP_VERSION"
check_compose
check_uploads_dir

step "Building images (app + migration tools)"
dc build app tools

step "Database migration status"
if dc up -d db && wait_healthy db 120 && dc run --rm tools npx prisma migrate status; then
  green "Database schema is up to date."
else
  if [ "$MIGRATE" = "1" ]; then
    step "Backup before migrating"
    if [ "$(psql_in "$(app_db_name)" "SELECT to_regclass('public.\"Account\"') IS NOT NULL" 2>/dev/null || echo f)" = "t" ]; then
      bash "$ROOT_DIR/deploy/backup-db.sh"
    else
      yellow "The database has no tables yet (first deployment): there is nothing to back up."
    fi
    step "Applying pending migrations (prisma migrate deploy: forward-only, never resets)"
    dc run --rm tools npx prisma migrate deploy
  else
    die "Pending (or unreadable) migrations. Review them, then re-run with --migrate (a backup is taken first). Nothing was started or changed."
  fi
fi

step "Starting the new version"
dc up -d --remove-orphans db app cvv-cleanup cloudflared
wait_healthy app 240

step "Verification"
bash "$ROOT_DIR/deploy/verify.sh"

step "Tidying old images (keeping the 5 most recent versions for rollback)"
docker image prune -f >/dev/null 2>&1 || true
for repo in compass-tools compass-tools-tools; do
  docker images "$repo" --format '{{.CreatedAt}}|{{.Tag}}' 2>/dev/null | sort -r | cut -d'|' -f2 | grep -v '^<none>$' | tail -n +6 | while read -r tag; do
    docker rmi "$repo:$tag" >/dev/null 2>&1 || true
  done
done

green "Deployed $APP_VERSION."
if [ -n "$PREVIOUS_IMAGE" ]; then
  echo "To go back to the previous image:  bash deploy/rollback.sh ${PREVIOUS_IMAGE##*:}"
fi
