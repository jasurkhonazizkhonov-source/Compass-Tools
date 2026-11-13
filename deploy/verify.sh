#!/usr/bin/env bash
# Post-deployment verification. Read-only: it changes nothing and prints no secret.
#
#   bash deploy/verify.sh                 # internal checks + public checks against APP_BASE_URL
#   bash deploy/verify.sh --internal      # skip the checks that go out through Cloudflare
#
# Exit code 0 = every critical check passed. Warnings (yellow) need a human decision but do not fail the run.
# shellcheck source=./common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

need_cmd docker
INTERNAL_ONLY=0
[ "${1:-}" = "--internal" ] && INTERNAL_ONLY=1

failures=0
pass() { green "  PASS  $*"; }
fail() { red   "  FAIL  $*"; failures=$((failures + 1)); }
warn() { yellow "  WARN  $*"; }

check_env_file

step "1. Containers"
for service in db app cloudflared cvv-cleanup; do
  id="$(dc ps -q "$service" 2>/dev/null || true)"
  if [ -z "$id" ]; then fail "$service is not running"; continue; fi
  state="$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$id")"
  case "$state" in
    running/healthy|running/no-healthcheck) pass "$service: $state" ;;
    *) fail "$service: $state (docker compose logs --tail=80 $service)" ;;
  esac
done

step "2. Nothing is published on the VPS"
# A published port shows as "0.0.0.0:3000->3000/tcp"; an internal-only one shows as just "3000/tcp".
published="$(dc ps --format '{{.Name}} {{.Ports}}' | grep -E -- '->' || true)"
if [ -z "$published" ]; then pass "no container publishes a host port (db and app are reachable only inside Docker)"; else fail "a container publishes a host port: $published"; fi
if command -v ss >/dev/null 2>&1; then
  exposed="$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E '(^|:)(5432|3000)$' | grep -Ev '^(127[.]|[[]::1[]])' || true)"
  if [ -z "$exposed" ]; then pass "no process on the host listens on 5432 or 3000 beyond loopback"; else fail "the host is listening on a non-loopback address for 5432/3000: $exposed"; fi
fi

step "3. Application health (the app's own /api/health, which also queries the database)"
# Runs inside the app container (it has Node; the host may not) and prints one non-secret summary line.
summary="$(dc exec -T app node -e '
  fetch("http://127.0.0.1:" + (process.env.PORT || 3000) + "/api/health").then(r => r.json()).then(h => {
    const r = h.readiness || {};
    const ok = h.status === "ok" && h.database && h.database.ok;
    console.log([(ok ? "OK" : "BAD") + " status=" + h.status + " db=" + (h.database && h.database.ok),
      "schema=" + r.schema + (r.pendingMigrations ? " pending=" + r.pendingMigrations : ""),
      "databaseTls=" + r.databaseTls, "cardVault=" + r.cardVaultState + " enabled=" + r.cardVaultEnabled,
      "signerIpCapture=" + r.signerIpCapture, "uploadStorage=" + r.uploadStorage, "websiteApi=" + r.websiteApi].join(" | "));
  }).catch(() => { console.log("BAD the app did not answer /api/health"); });
' 2>/dev/null || echo 'BAD could not run the check')"
case "$summary" in OK*) pass "$summary" ;; *) fail "$summary" ;; esac
case "$summary" in *"schema=current"*) ;; *) fail "database schema is not current: run the migration step (deploy.sh --migrate, or: bash deploy/compose.sh run --rm tools npx prisma migrate deploy)" ;; esac
case "$summary" in *"databaseTls=disabled"*) pass "database TLS is explicitly disabled for the private Docker network (expected)" ;; *) warn "databaseTls is not 'disabled' - compose.yaml sets DATABASE_SSL_MODE=disable for the Docker database" ;; esac
case "$summary" in *"enabled=false"*) warn "the card vault is CLOSED (CARD_VAULT_MODE unset), so customers cannot finish a booking that needs card storage. That is the owner's explicit opt-in (docs/CARD_VAULT_SECURITY.md); nothing here enables it." ;; esac
case "$summary" in *"websiteApi=not_configured"*) warn "the website API (POST /api/v1/website/flight-inquiries) is not enabled: WEBSITE_API_KEY is unset or shorter than 32 characters (docs/WEBSITE_LEAD_API.md). Only needed once the website calls the CRM." ;; esac
case "$summary" in *"signerIpCapture=disabled"*) warn "signer IP capture is disabled - TRUSTED_PROXY is not in effect" ;; esac

step "3b. Lead document storage (VPS disk)"
case "$summary" in
  *"uploadStorage=ready"*) pass "upload storage is ready" ;;
  *"uploadStorage=low_space"*) warn "upload storage is nearly full: new uploads are refused until space is freed (bash deploy/uploads-usage.sh)" ;;
  *) fail "upload storage is unavailable: the upload directory is missing, not writable or not mounted (docs/LEAD_ATTACHMENTS.md, Troubleshooting)" ;;
esac
# Prove the mount is real and writable by the application user: write, read back and delete a probe file INSIDE the running app container.
# The probe name starts with a dot and has no 2-hex shard, so it can never be mistaken for (or collide with) an upload.
if probe="$(dc exec -T app sh -c 'd=/var/lib/compass-tools/uploads; f="$d/.verify-probe-$$"; printf ok > "$f" && [ "$(cat "$f")" = ok ] && rm -f "$f" && echo PROBE_OK' 2>/dev/null)" && [ "$probe" = "PROBE_OK" ]; then
  pass "the app can write, read and delete in its upload directory"
else
  fail "the app container cannot write to /var/lib/compass-tools/uploads (owner must be uid/gid 1000: sudo chown 1000:1000 <host dir>)"
fi
mount_src="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/compass-tools/uploads"}}{{.Type}} {{.Source}}{{end}}{{end}}' "$(dc ps -q app 2>/dev/null | head -1)" 2>/dev/null || true)"
case "$mount_src" in
  "bind "*) pass "uploads are a host bind mount (${mount_src#bind }), so they survive container recreation and image upgrades" ;;
  *) fail "the uploads directory is not a host bind mount ($mount_src); files would be lost when the container is recreated" ;;
esac
db_mounts="$(docker inspect --format '{{range .Mounts}}{{.Destination}} {{end}}' "$(dc ps -q db 2>/dev/null | head -1)" 2>/dev/null || true)"
case "$db_mounts" in *compass-tools/uploads*) fail "the uploads are mounted into the database container" ;; *) pass "the database container does not see the uploads" ;; esac
host_dir="$(uploads_host_dir)"
if [ -d "$host_dir" ]; then
  used_pct="$(df -P "$host_dir" | awk 'NR==2 {gsub("%","",$5); print $5}')"
  if [ -n "$used_pct" ]; then
    if [ "$used_pct" -ge 95 ]; then fail "the disk holding the uploads is ${used_pct}% full"
    elif [ "$used_pct" -ge 80 ]; then warn "the disk holding the uploads is ${used_pct}% full (bash deploy/uploads-usage.sh)"
    else pass "disk holding the uploads is ${used_pct}% full"; fi
  fi
fi

step "4. Scheduled CVV cleanup"
last="$(dc logs --no-log-prefix --tail=200 cvv-cleanup 2>/dev/null | grep '"status":"ok"' | tail -1 || true)"
if [ -n "$last" ]; then pass "last successful run: $(printf '%s' "$last" | sed -E 's/.*"time":"([^"]+)".*/\1/')"; else warn "no successful CVV cleanup run in the recent log yet (the first runs about 90 seconds after the container starts: docker compose logs cvv-cleanup)"; fi
if dc logs --no-log-prefix --tail=200 cvv-cleanup 2>/dev/null | grep -q '"status":"gave_up"'; then fail "the CVV cleanup gave up after retries - see: docker compose logs cvv-cleanup"; fi

if [ "$INTERNAL_ONLY" = "0" ]; then
  step "5. Public site through Cloudflare"
  need_cmd curl
  base="$(dc exec -T app printenv APP_BASE_URL | tr -d '\r\n')"
  case "$base" in https://*) pass "APP_BASE_URL is $base" ;; *) fail "APP_BASE_URL is not an https origin ($base)" ;; esac
  host="${base#https://}"
  code() { curl -sS -o /dev/null -m 20 -w '%{http_code}' "$@" 2>/dev/null || echo 000; }
  [ "$(code "$base/api/health")" = "200" ] && pass "GET $base/api/health -> 200" || fail "GET $base/api/health did not return 200"
  hsts="$(curl -sSI -m 20 "$base/login" 2>/dev/null | tr -d '\r' | grep -i '^strict-transport-security' || true)"
  [ -n "$hsts" ] && pass "HSTS header present" || warn "no Strict-Transport-Security header on $base/login"
  redirect="$(curl -sSI -m 20 -o /dev/null -w '%{http_code} %{redirect_url}' "http://$host/" 2>/dev/null || echo '000 ')"
  case "$redirect" in 301\ https://*|302\ https://*|307\ https://*|308\ https://*) pass "http://$host/ redirects to HTTPS ($redirect)" ;; *) fail "http://$host/ did not redirect to HTTPS (got: $redirect) - enable 'Always Use HTTPS' in Cloudflare" ;; esac
  # The unauthenticated cron gate must hold on the public side too. A POST without the secret only ever returns 401/403/404/503: it runs nothing.
  c="$(code -X POST "$base/api/cron/cvv-cleanup")"
  case "$c" in 401|403|404|503) pass "POST $base/api/cron/cvv-cleanup without the secret -> $c (not runnable from the internet)" ;; *) fail "POST /api/cron/cvv-cleanup without the secret returned $c (expected 401)" ;; esac
  apex="${host#www.}"
  if [ "$apex" != "$host" ]; then
    loc="$(curl -sSI -m 20 -o /dev/null -w '%{http_code} %{redirect_url}' "https://$apex/" 2>/dev/null || echo '000 ')"
    case "$loc" in 301\ https://"$host"*|308\ https://"$host"*) pass "https://$apex/ redirects to $host ($loc)" ;; *) warn "https://$apex/ -> '$loc' (expected a 301/308 to https://$host/; see the guide, 'Apex redirect')" ;; esac
  fi
fi

echo
if [ "$failures" -eq 0 ]; then green "All critical checks passed."; else red "$failures critical check(s) failed."; exit 1; fi
