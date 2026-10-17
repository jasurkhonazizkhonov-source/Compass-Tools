#!/usr/bin/env bash
# Shared helpers for the deploy/*.sh scripts. Source it, do not run it.
#
# Conventions
#   * Secrets are never parsed or printed on the host: .env is read by `docker compose` itself, and anything that needs a database
#     user/name asks the CONTAINER (`sh -c '... "$POSTGRES_USER" ...'`), so there is no `source .env`.
#   * Every script runs from the repository root, whatever the caller's working directory.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
step()   { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die()    { red "ERROR: $*"; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed."; }

dc() { docker compose "$@"; }

# .env must exist and must not be readable by other users (it holds every production secret).
check_env_file() {
  [ -f .env ] || die ".env not found in $ROOT_DIR. Copy .env.example to .env, fill it in, and run: chmod 600 .env"
  local mode
  mode="$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env)"
  case "$mode" in
    600|400) ;;
    *) die ".env permissions are $mode; it holds production secrets. Run: chmod 600 .env" ;;
  esac
}

# The Compose project must be valid and every required variable present.
check_compose() { dc config -q || die "docker compose config failed - see the message above (a required .env value is probably missing)."; }

db_exec()  { dc exec -T db "$@"; }
# Run a SQL string against a database inside the db container. The database user comes from the container's own environment.
psql_in() { # $1 = database, $2 = sql
  db_exec sh -c 'psql -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1 -At -c "$2"' sh "$1" "$2"
}
app_db_name() { db_exec sh -c 'printf %s "$POSTGRES_DB"'; }

# Waits until a Compose service reports healthy (its container HEALTHCHECK), up to $2 seconds (default 240).
wait_healthy() {
  local service="$1" timeout="${2:-240}" waited=0 id status
  while [ "$waited" -lt "$timeout" ]; do
    id="$(dc ps -q "$service" 2>/dev/null || true)"
    if [ -n "$id" ]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo unknown)"
      case "$status" in
        healthy|running) [ "$status" = healthy ] && return 0 ;;
        exited|dead) die "$service stopped. Inspect it with: docker compose logs --tail=100 $service" ;;
      esac
    fi
    sleep 5
    waited=$((waited + 5))
  done
  die "$service did not become healthy within ${timeout}s. Inspect it with: docker compose logs --tail=100 $service"
}

# Where the uploaded Lead documents live inside the app container, and the HOST directory that is mounted there.
UPLOADS_CONTAINER_DIR="/var/lib/compass-tools/uploads"
uploads_host_dir() {
  local id src
  # A running app container is the authority on what is really mounted.
  id="$(dc ps -q app 2>/dev/null | head -1 || true)"
  if [ -n "$id" ]; then
    src="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "'"$UPLOADS_CONTAINER_DIR"'"}}{{.Source}}{{end}}{{end}}' "$id" 2>/dev/null || true)"
    [ -n "$src" ] && { printf '%s' "$src"; return 0; }
  fi
  # Otherwise ask Compose what it WOULD mount (it resolves UPLOADS_HOST_DIR from .env itself; the `source:` line precedes `target:`).
  src="$(dc config 2>/dev/null | awk -v t="target: $UPLOADS_CONTAINER_DIR" 'index($0, t) { print prev; exit } { prev = $0 }' | sed -E 's/^[[:space:]]*source:[[:space:]]*//')"
  printf '%s' "${src:-/srv/compass-tools/uploads}"
}

# Which image version to use. compose.yaml names the images  compass-tools:${APP_VERSION:-local}  and  compass-tools-tools:${APP_VERSION:-local}.
# deploy.sh and rollback.sh set APP_VERSION themselves. Every OTHER script (backups, restores, usage reports, a manual `docker compose run`)
# starts in a fresh shell where it is unset, and the "local" fallback names an image that does not exist: Compose would then try to BUILD
# it from the checkout (slow, memory-hungry, and a different tag from the running app) or, for `up`, start the application on that other
# image. So those scripts call this first: it takes the tag of the application that is installed (running or stopped) and refuses to
# continue - with a clear message - if that image is not on this server. It never builds and never guesses.
require_app_version() {
  local image
  if [ -z "${APP_VERSION:-}" ]; then
    image="$(docker inspect --format '{{.Config.Image}}' "$(dc ps -aq app 2>/dev/null | head -1)" 2>/dev/null || true)"
    case "$image" in compass-tools:?*) APP_VERSION="${image#compass-tools:}" ;; esac
  fi
  [ -n "${APP_VERSION:-}" ] || die "Cannot tell which application version is installed: there is no 'app' container to read it from and APP_VERSION is not set. Start the application with deploy/deploy.sh, or name the version yourself:  APP_VERSION=<tag> bash deploy/<script>   (the tags on this server: docker images compass-tools --format '{{.Tag}}')"
  case "$APP_VERSION" in *[!A-Za-z0-9._-]*) die "APP_VERSION contains characters that are not allowed in an image tag." ;; esac
  docker image inspect "compass-tools:$APP_VERSION" >/dev/null 2>&1 || die "The image compass-tools:$APP_VERSION is not on this server, so nothing was run (Docker Compose would otherwise try to build it). Tags available: docker images compass-tools --format '{{.Tag}}'. To (re)build a version: bash deploy/deploy.sh --ref <sha>."
  export APP_VERSION
}

# Whether a database check can be trusted. Prints "existing" when the application database already has tables, "empty" when it verifiably
# has none (a first deployment), and returns non-zero - printing nothing - when it could not be determined (container down, query failed,
# unexpected answer). Callers must treat a non-zero result as "unknown", never as "empty".
database_state() {
  local db count
  db="$(app_db_name)" || return 1
  [ -n "$db" ] || return 1
  count="$(psql_in "$db" "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'")" || return 1
  case "$count" in
    0) echo empty ;;
    [1-9]*) case "$count" in *[!0-9]*) return 1 ;; *) echo existing ;; esac ;;
    *) return 1 ;;
  esac
}

# Runs a command as the application user (uid 1000) in a throw-away container of the app image with the uploads mounted. No dependencies
# are started and nothing is published. This is how the scripts read and write the 0700, uid-1000 files without needing root.
in_uploads_container() { require_app_version; dc run --rm --no-deps -T --entrypoint "$1" app "${@:2}"; }

# Fails with copy-paste instructions unless the HOST upload directory exists and belongs to the application user (uid/gid 1000).
# Compose is configured NOT to create it (a root-owned one would be unwritable by the app and uploads would fail at runtime).
check_uploads_dir() {
  local dir owner mode
  dir="$(uploads_host_dir)"
  if [ ! -d "$dir" ]; then
    die "The upload directory $dir does not exist. Create it once (the application runs as uid/gid 1000):
  sudo install -d -o 1000 -g 1000 -m 0700 $dir
(see docs/LEAD_ATTACHMENTS.md; to use another location set UPLOADS_HOST_DIR in .env)"
  fi
  owner="$(stat -c '%u:%g' "$dir" 2>/dev/null || echo unknown)"
  mode="$(stat -c '%a' "$dir" 2>/dev/null || echo unknown)"
  [ "$owner" = "1000:1000" ] || die "The upload directory $dir is owned by $owner; the application (uid/gid 1000) could not write to it. Run:
  sudo chown 1000:1000 $dir && sudo chmod 0700 $dir"
  case "$mode" in
    700|750) ;;
    *) yellow "The upload directory $dir has mode $mode; it holds customers' documents. Recommended: sudo chmod 0700 $dir" ;;
  esac
  green "Upload directory OK: $dir (owner $owner, mode $mode)"
}

confirm() { # $1 = prompt; honours ASSUME_YES=1
  [ "${ASSUME_YES:-0}" = "1" ] && return 0
  local answer
  read -r -p "$1 [y/N] " answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ]
}
