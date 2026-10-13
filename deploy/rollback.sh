#!/usr/bin/env bash
# Roll the APPLICATION back to a previously built image version. No rebuild, no migration, no data change.
#
#   docker images compass-tools --format '{{.Tag}}  {{.CreatedAt}}'      # list the versions still on this server
#   bash deploy/rollback.sh <version>                                    # e.g. a1b2c3d4e5f6
#
# It restarts only app + cvv-cleanup on the chosen image tag and runs deploy/verify.sh.
#
# IMPORTANT - what a rollback does NOT undo: database migrations. Migrations here are forward-only. If the version you are leaving
# applied a migration, the older code runs against the newer schema. That is fine when the migration only ADDED things (the usual
# case), but if verify.sh reports a problem, or the release notes say the migration changed or removed something, restore the
# pre-deploy backup instead (deploy/restore-db.sh ... --replace) - deploy.sh --migrate takes one automatically.
# shellcheck source=./common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need_cmd docker
VERSION="${1:-}"
[ -n "$VERSION" ] || die "Usage: bash deploy/rollback.sh <image version>   (list them: docker images compass-tools)"
case "$VERSION" in *[!A-Za-z0-9._-]*) die "Invalid version string." ;; esac
docker image inspect "compass-tools:$VERSION" >/dev/null 2>&1 || die "Image compass-tools:$VERSION is not on this server (old versions are pruned after the 5 most recent). Check out that commit and run deploy/deploy.sh --ref <sha> to rebuild it."
check_env_file

RUNNING="$(docker inspect --format '{{.Config.Image}}' "$(dc ps -q app 2>/dev/null | head -1)" 2>/dev/null || true)"
echo "Running now : ${RUNNING:-none}"
echo "Rolling back: compass-tools:$VERSION"
confirm "Restart the application on that image?" || die "Cancelled. Nothing was changed."

export APP_VERSION="$VERSION"
check_compose
dc up -d --no-build app cvv-cleanup
wait_healthy app 240
bash "$ROOT_DIR/deploy/verify.sh"
green "Application is running compass-tools:$VERSION."
yellow "The git checkout is unchanged. Before the next normal deploy, either 'git checkout main' or deploy a fixed commit - deploy.sh handles both."
