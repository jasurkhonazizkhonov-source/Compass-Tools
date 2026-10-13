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

confirm() { # $1 = prompt; honours ASSUME_YES=1
  [ "${ASSUME_YES:-0}" = "1" ] && return 0
  local answer
  read -r -p "$1 [y/N] " answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ]
}
