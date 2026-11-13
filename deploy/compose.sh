#!/usr/bin/env bash
# `docker compose` for this project, on the application version that is INSTALLED.
#
#   bash deploy/compose.sh up -d app                                   # apply a changed .env value to the running app
#   bash deploy/compose.sh run --rm tools npx tsx scripts/attachments-reconcile.ts
#
# Why: compose.yaml names its images  compass-tools:${APP_VERSION:-local}.  In a fresh shell APP_VERSION is unset, so a bare
# `docker compose up -d app` or `docker compose run ... tools` would look for an image called ":local" that does not exist, build it from
# the checkout (slow, memory-hungry) and run THAT instead of the version that is deployed. This wrapper reads the installed version from
# the existing app container (see require_app_version in common.sh), stops with a clear message if that image is missing, and for `up`
# never builds. Everything else is passed to `docker compose` unchanged. It is not needed after deploy.sh/rollback.sh, which set the version.
# shellcheck source=./common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need_cmd docker
[ $# -gt 0 ] || die "Usage: bash deploy/compose.sh <docker compose arguments>   e.g.  up -d app"
require_app_version

case " $* " in
  *" tools "*) docker image inspect "compass-tools-tools:$APP_VERSION" >/dev/null 2>&1 || die "The maintenance image compass-tools-tools:$APP_VERSION is not on this server (Docker Compose would build it). Build it with: bash deploy/deploy.sh --ref <sha>." ;;
esac

if [ "$1" = "up" ]; then
  shift
  exec docker compose up --no-build "$@"
fi
exec docker compose "$@"
