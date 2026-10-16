#!/usr/bin/env bash
# End-to-end smoke test of the Docker stack with THROW-AWAY values. Run by CI (.github/workflows/ci.yml) and runnable by hand on any
# Linux machine with Docker:   bash deploy/ci-smoke.sh
#
# It builds the images, starts db + app + the CVV scheduler (NOT cloudflared), applies the migrations to the empty database and
# proves the pieces that unit tests cannot: the image builds from the lockfile, no .env is inside it, the app boots against a
# PLAINTEXT private PostgreSQL (DATABASE_SSL_MODE=disable), the schema is current, sharp's native libraries load on Linux, the
# cron endpoint refuses unauthenticated calls, the daily-cleanup job runs against the real endpoint, and nothing is published
# on the host. Every secret is random and exists only for this run; the stack and its volume are removed at the end.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

export COMPOSE_PROJECT_NAME=compass-smoke
export APP_VERSION=smoke
TMP="$(mktemp -d)"
export COMPOSE_ENV_FILES="$TMP/env"
# The uploads bind mount: a host directory owned by the image user (uid/gid 1000), exactly as the VPS guide prescribes.
# (Mode 0700 and owned by 1000, so the runner user needs sudo to look inside it.)
UPLOADS="$TMP/uploads"
install -d -m 0700 "$UPLOADS"
if [ "$(id -u)" != "1000" ]; then sudo chown 1000:1000 "$UPLOADS"; fi
cleanup() {
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  # Files in the mount are owned by uid 1000, which may not be us.
  rm -rf "$UPLOADS" 2>/dev/null || sudo rm -rf "$UPLOADS" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

rand_b64() { openssl rand -base64 32; }
cat > "$TMP/env" <<EOF
APP_BASE_URL=https://www.compass-tools.com
POSTGRES_PASSWORD=$(openssl rand -hex 24)
TUNNEL_TOKEN=smoke-test-not-a-real-token
GOOGLE_CLIENT_ID=smoke.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=smoke-not-a-real-secret
GMAIL_TOKEN_ENCRYPTION_KEY=$(rand_b64)
CARD_ENCRYPTION_KEY=$(rand_b64)
IP_ENCRYPTION_KEY=$(rand_b64)
IP_HASH_KEY=$(rand_b64)
CRON_SECRET=$(openssl rand -hex 24)
WEBSITE_API_KEY=$(openssl rand -hex 32)
UPLOADS_HOST_DIR=$UPLOADS
EOF
chmod 600 "$TMP/env"
CRON_SECRET="$(grep '^CRON_SECRET=' "$TMP/env" | cut -d= -f2-)"
WEBSITE_API_KEY="$(grep '^WEBSITE_API_KEY=' "$TMP/env" | cut -d= -f2-)"

ok()   { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*" >&2; docker compose logs --tail=60 >&2 || true; exit 1; }
step() { printf '\n== %s\n' "$*"; }

step "Compose file is valid"
docker compose config -q && ok "docker compose config"

step "Build (app + tools) from the lockfile"
docker compose build app tools
ok "images built"

step "No .env or key material inside the image"
leftovers="$(docker run --rm --entrypoint sh "compass-tools:smoke" -c 'find /app -maxdepth 3 \( -name ".env" -o -name ".env.*" -o -name "*.pem" -o -name "*.key" \) -not -path "*/node_modules/*" 2>/dev/null')"
[ -z "$leftovers" ] && ok "none found" || fail "unexpected files in the image: $leftovers"

step "Database + migrations (forward-only, empty database)"
docker compose up -d db
for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q db)")" = healthy ] && break; sleep 2; done
docker compose run --rm tools npx prisma migrate deploy
docker compose run --rm tools npx prisma migrate status
ok "migrations applied, schema up to date"

step "App starts against the plaintext private database"
docker compose up -d app
for _ in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q app)")" = healthy ] && break; sleep 3; done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q app)")" = healthy ] || fail "the app did not become healthy"
docker compose exec -T app node scripts/healthcheck.mjs && ok "app healthy (database reachable, schema current)"
tls="$(docker compose exec -T app node -e 'fetch("http://127.0.0.1:3000/api/health").then(r=>r.json()).then(h=>console.log(h.readiness.databaseTls+" "+h.readiness.schema+" vault="+h.readiness.cardVaultEnabled))')"
[ "$tls" = "disabled current vault=false" ] && ok "databaseTls=disabled, schema=current, card vault CLOSED (as required): $tls" || fail "unexpected readiness: $tls"

step "sharp's native libraries load on Linux (company-logo processing)"
docker compose exec -T app node -e 'const s=require("sharp");s({create:{width:4,height:4,channels:3,background:"#fff"}}).png().toBuffer().then(b=>{console.log("png bytes",b.length)}).catch(e=>{console.error(e.message);process.exit(1)})' && ok "sharp works"

step "Lead document storage: a writable, persistent, private bind mount"
up="$(docker compose exec -T app node -e 'fetch("http://127.0.0.1:3000/api/health").then(r=>r.json()).then(h=>console.log(h.readiness.uploadStorage))')"
[ "$up" = "ready" ] && ok "readiness.uploadStorage=ready" || fail "uploadStorage is $up (expected ready)"
docker compose exec -T app sh -c 'printf smoke > /var/lib/compass-tools/uploads/.probe && [ "$(cat /var/lib/compass-tools/uploads/.probe)" = smoke ]' && ok "the app user can write and read in the mount" || fail "cannot write in the uploads mount"
{ [ -f "$UPLOADS/.probe" ] || sudo test -f "$UPLOADS/.probe"; } && ok "the file appears in the HOST directory (a real bind mount)" || fail "the file did not reach the host directory"
docker compose up -d --force-recreate --no-deps app
for _ in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q app)")" = healthy ] && break; sleep 3; done
docker compose exec -T app sh -c '[ "$(cat /var/lib/compass-tools/uploads/.probe)" = smoke ]' && ok "the file survives recreation of the container" || fail "the file was lost when the container was recreated"
docker compose exec -T app rm -f /var/lib/compass-tools/uploads/.probe
db_mounts="$(docker inspect --format '{{range .Mounts}}{{.Destination}} {{end}}' "$(docker compose ps -q db)")"
case "$db_mounts" in *compass-tools/uploads*) fail "the uploads are mounted into the database container" ;; *) ok "the database container does not see the uploads" ;; esac
tools_rw="$(docker compose --profile tools config --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).services.tools.volumes||[];console.log(v.length>0&&v.every(x=>x.read_only)?"ro":"rw")})')"
[ "$tools_rw" = "ro" ] && ok "the maintenance container sees the uploads read-only" || fail "the tools container can write to the uploads"

step "Runs as a non-root user"
uid="$(docker compose exec -T app id -u)"
[ "$uid" != "0" ] && ok "uid $uid" || fail "the app runs as root"

step "Nothing is published on the host"
published="$(docker compose ps --format '{{.Name}} {{.Ports}}' | grep -- '->' || true)"
[ -z "$published" ] && ok "no published ports" || fail "published: $published"

step "Cron endpoint: closed to the unauthenticated, open to the secret, POST only"
code() { docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/cron/cvv-cleanup',{method:'$1',headers:$2}).then(r=>console.log(r.status))"; }
[ "$(code POST '{}')" = "401" ] && ok "POST without the secret -> 401" || fail "unauthenticated POST was not refused"
[ "$(code GET '{}')" = "405" ] && ok "GET -> 405" || fail "GET was not refused"
[ "$(code POST "{authorization:'Bearer wrong'}")" = "401" ] && ok "POST with a wrong secret -> 401" || fail "wrong secret was not refused"

step "Website API: enabled, authenticated, and private-network only"
# The container reads the key from its own environment; the host-side value is used only to prove a WRONG key and a RIGHT key behave differently.
api() { docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/v1/website/flight-inquiries',{method:'POST',headers:$1,body:'{}'}).then(r=>console.log(r.status))"; }
[ "$(api '{}')" = "401" ] && ok "no credential -> 401" || fail "the website API did not refuse a request without a credential"
[ "$(api "{authorization:'Bearer wrong-wrong-wrong-wrong-wrong-wrong-wrong'}")" = "401" ] && ok "wrong key -> 401" || fail "the website API accepted a wrong key"
[ "$(api "{authorization:'Bearer $WEBSITE_API_KEY','content-type':'application/json'}")" = "400" ] && ok "right key passes authentication (400: no Idempotency-Key yet)" || fail "the right key was not accepted"
[ "$(api "{authorization:'Bearer $WEBSITE_API_KEY','cf-ray':'smoke-FRA'}")" = "404" ] && ok "a request that came through the public Cloudflare edge -> 404" || fail "the website API answered a public-edge request"
api_ready="$(docker compose exec -T app node -e 'fetch("http://127.0.0.1:3000/api/health").then(r=>r.json()).then(h=>console.log(h.readiness.websiteApi))')"
[ "$api_ready" = "configured" ] && ok "readiness.websiteApi=configured" || fail "readiness.websiteApi is $api_ready"
api_net="$(docker compose config --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);const n=c.networks.website_api;const app=Object.keys(c.services.app.networks||{});const others=["db","cloudflared"].filter((x)=>Object.keys(c.services[x].networks||{}).includes("website_api"));console.log((n&&n.internal?"internal":"open")+" app:"+app.includes("website_api")+" others:"+others.length)})')"
[ "$api_net" = "internal app:true others:0" ] && ok "website_api is an internal network that only the app joins" || fail "unexpected website_api network layout: $api_net"

step "The scheduled CVV-cleanup job runs once against the real endpoint"
docker compose run --rm cvv-cleanup node scripts/cvv-cleanup-scheduler.mjs --once | tee "$TMP/job.log"
grep -q '"status":"ok"' "$TMP/job.log" && ok "job reported ok" || fail "the cleanup job did not succeed"
grep -q "$CRON_SECRET" "$TMP/job.log" && fail "the job log contains the secret" || ok "the secret is not in the job log"

printf '\nAll smoke checks passed.\n'
