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
CLOUDFLARE_TUNNEL_TOKEN=smoke-test-not-a-real-token
GOOGLE_CLIENT_ID=smoke.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=smoke-not-a-real-secret
GMAIL_TOKEN_ENCRYPTION_KEY=$(rand_b64)
CARD_ENCRYPTION_KEY=$(rand_b64)
IP_ENCRYPTION_KEY=$(rand_b64)
IP_HASH_KEY=$(rand_b64)
CRON_SECRET=$(openssl rand -hex 24)
WEBSITE_API_KEY=$(openssl rand -hex 32)
UPLOADS_HOST_DIR=$UPLOADS
# Only to prove the variable REACHES the container (see the "Settings reach the container" step). With no LEAD_INGEST_SECRET it cannot make anything strict.
WEBSITE_SIGNATURE_REQUIRED=true
CAMPAIGN_DAILY_LIMIT=123
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
tls="$(docker compose exec -T app node -e 'fetch("http://127.0.0.1:3000/api/health",{headers:{authorization:"Bearer "+(process.env.CRON_SECRET||"")}}).then(r=>r.json()).then(h=>console.log(h.readiness.databaseTls+" "+h.readiness.schema+" vault="+h.readiness.cardVaultEnabled))')"
[ "$tls" = "disabled current vault=false" ] && ok "databaseTls=disabled, schema=current, card vault CLOSED (as required): $tls" || fail "unexpected readiness: $tls"

step "sharp's native libraries load on Linux (company-logo processing)"
docker compose exec -T app node -e 'const s=require("sharp");s({create:{width:4,height:4,channels:3,background:"#fff"}}).png().toBuffer().then(b=>{console.log("png bytes",b.length)}).catch(e=>{console.error(e.message);process.exit(1)})' && ok "sharp works"

step "Lead document storage: a writable, persistent, private bind mount"
up="$(docker compose exec -T app node -e 'fetch("http://127.0.0.1:3000/api/health",{headers:{authorization:"Bearer "+(process.env.CRON_SECRET||"")}}).then(r=>r.json()).then(h=>console.log(h.readiness.uploadStorage))')"
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

step "Settings reach the container (a variable compose.yaml does not name never arrives, whatever .env says)"
[ "$(docker compose exec -T app printenv WEBSITE_SIGNATURE_REQUIRED)" = "true" ] && ok "WEBSITE_SIGNATURE_REQUIRED from .env reaches the app" || fail "WEBSITE_SIGNATURE_REQUIRED did not reach the app container"
[ "$(docker compose exec -T app printenv CAMPAIGN_DAILY_LIMIT)" = "123" ] && ok "CAMPAIGN_DAILY_LIMIT from .env reaches the app" || fail "CAMPAIGN_DAILY_LIMIT did not reach the app container"

step "IP-geolocation volume: the job writes it, the app can only read it"
docker compose --profile tools run --rm --no-deps -T --entrypoint sh geoip-update -c 'printf geo > /var/lib/compass-tools/geoip/.probe' && ok "the geoip-update job can write the volume (mount owned by the unprivileged user)" || fail "geoip-update cannot write /var/lib/compass-tools/geoip"
docker compose exec -T app sh -c '[ "$(cat /var/lib/compass-tools/geoip/.probe)" = geo ]' && ok "the app reads what the job wrote" || fail "the app cannot read the geoip volume"
if docker compose exec -T app sh -c 'printf x > /var/lib/compass-tools/geoip/.app-write' 2>/dev/null; then fail "the app can WRITE to the geoip volume (it must be read-only)"; else ok "the app cannot write to the geoip volume"; fi
docker compose --profile tools run --rm --no-deps -T --entrypoint sh geoip-update -c 'rm -f /var/lib/compass-tools/geoip/.probe'
geo="$(docker compose exec -T app node -e 'fetch("http://127.0.0.1:3000/api/health",{headers:{authorization:"Bearer "+(process.env.CRON_SECRET||"")}}).then(r=>r.json()).then(h=>console.log(h.readiness.geoIpDatabase))')"
[ "$geo" = "missing" ] && ok "readiness.geoIpDatabase=missing (no database installed - optional, country-level locations)" || fail "readiness.geoIpDatabase is $geo (expected missing: nothing was downloaded)"
# The update command itself runs inside the tools image (tsx, the MMDB reader, the volume): "status" changes nothing and needs no network, so it can run here.
status_out="$(docker compose --profile tools run --rm --no-deps -T --entrypoint npx geoip-update tsx scripts/geoip-database.ts status 2>&1)" || fail "the geoip-update command failed to run: $status_out"
case "$status_out" in *"not usable"*"no record"*) ok "geoip-update status runs in the tools image (nothing installed, no update recorded)" ;; *) fail "unexpected geoip-update status output: $status_out" ;; esac
geo_net="$(docker compose --profile tools config --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).services;const on=n=>Object.keys(c[n].networks||{});console.log(on("geoip-update").join(",")+"|"+["app","db","tools","cloudflared","cvv-cleanup"].filter(n=>on(n).includes("egress")).join(","))})')"
[ "$geo_net" = "egress|" ] && ok "geoip-update is on the egress network only; no long-running service is" || fail "unexpected networks: $geo_net"

step "Admin Database Backup: the image has a matching pg_dump, a private staging volume, and the download endpoint is closed"
# The PostgreSQL client must be the same major version as the server (pg_dump refuses an older client than the server).
client_major="$(docker compose exec -T app sh -c '"$PG_DUMP_BIN" --version' | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
server_major="$(docker compose exec -T db sh -c 'postgres --version' | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
[ -n "$client_major" ] && [ "$client_major" -ge "$server_major" ] && ok "pg_dump $client_major in the app image, server $server_major" || fail "pg_dump major '$client_major' is older than the server '$server_major'"
docker compose exec -T app sh -c '"$PG_RESTORE_BIN" --version >/dev/null' && ok "pg_restore is installed" || fail "pg_restore is missing from the app image"
[ "$(docker compose exec -T app printenv PG_DUMP_BIN)" = "/usr/lib/postgresql/17/bin/pg_dump" ] && ok "the app runs the real pg_dump 17 binary by path (no wrapper)" || fail "PG_DUMP_BIN does not point at the PostgreSQL 17 binary"
# Nothing used only to BUILD the image (download tools, compilers) is left in the final runtime image, and no PostgreSQL SERVER came with the client.
for pkg in curl gnupg gcc make postgresql-17; do
  if docker compose exec -T app sh -c "dpkg -s $pkg >/dev/null 2>&1"; then fail "the runtime image contains $pkg"; fi
done
ok "no curl, gnupg, compiler or PostgreSQL server in the runtime image"
# The app user can execute both tools (it is the user that runs them from the Admin page).
[ "$(docker compose exec -T app id -u)" != "0" ] && docker compose exec -T app sh -c '"$PG_DUMP_BIN" --version >/dev/null && "$PG_RESTORE_BIN" --version >/dev/null' && ok "the unprivileged app user can run pg_dump and pg_restore" || fail "the app user cannot run the PostgreSQL tools"
sids="$(docker compose exec -T app sh -c 'stat -c %u:%g:%a /var/lib/compass-tools/backups')"
[ "$sids" = "1000:1000:700" ] && ok "backup staging volume owned 1000:1000, mode 700" || fail "backup staging owner:mode was '$sids'"
[ "$(docker compose exec -T app printenv BACKUP_STAGING_DIR)" = "/var/lib/compass-tools/backups" ] && ok "BACKUP_STAGING_DIR reaches the app" || fail "BACKUP_STAGING_DIR did not reach the app container"
# The same command line the app builds, against the real database, then the same read-back check; the file is removed at once.
docker compose exec -T app sh -c 'PGPASSWORD="$(node -e "console.log(decodeURIComponent(new URL(process.env.DATABASE_URL).password))")" "$PG_DUMP_BIN" --format=custom --compress=6 --no-owner --no-privileges --exclude-table-data=PaymentMethodCvv -h db -U "$(node -e "console.log(decodeURIComponent(new URL(process.env.DATABASE_URL).username))")" -d "$(node -e "console.log(new URL(process.env.DATABASE_URL).pathname.slice(1))")" --file=/var/lib/compass-tools/backups/smoke.dump' && ok "pg_dump of the migrated database ran as the app user" || fail "pg_dump failed inside the app image"
toc="$(docker compose exec -T app sh -c '"$PG_RESTORE_BIN" --list /var/lib/compass-tools/backups/smoke.dump')"
case "$toc" in *"TABLE public Account"*"_prisma_migrations"*|*"_prisma_migrations"*"TABLE public Account"*) ok "the dump lists the Account table and the migration history" ;; *) fail "the dump does not list the expected tables" ;; esac
case "$toc" in *"TABLE DATA public PaymentMethodCvv"*) fail "the dump contains PaymentMethodCvv data" ;; *) ok "no retained security-code data in the dump" ;; esac
# Keep the dump for the recovery rehearsal below, exactly as an operator would download it from the Admin page, then remove the staged copy.
docker compose exec -T app cat /var/lib/compass-tools/backups/smoke.dump > "$TMP/smoke.dump"
[ -s "$TMP/smoke.dump" ] && ok "the dump left the container as a file" || fail "could not copy the dump out of the app container"
docker compose exec -T app rm -f /var/lib/compass-tools/backups/smoke.dump
dbk="$(docker inspect --format '{{range .Mounts}}{{.Destination}} {{end}}' "$(docker compose ps -q db)")"
case "$dbk" in *compass-tools/backups*) fail "the backup staging volume is mounted into the database container" ;; *) ok "the database container does not see the backup staging volume" ;; esac
bk() { docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/admin/database-backup/compass-20260101T000000Z-00000000',{headers:$1}).then(r=>console.log(r.status))"; }
[ "$(bk '{}')" = "401" ] && ok "the backup download endpoint refuses a request with no session (401)" || fail "the backup download endpoint did not refuse an anonymous request"

step "Operator scripts pick the INSTALLED image version (APP_VERSION unset), never ':local'"
ver="$(env -u APP_VERSION bash -c 'source deploy/common.sh; require_app_version; echo "$APP_VERSION"')"
[ "$ver" = "smoke" ] && ok "require_app_version -> $ver (read from the running app container)" || fail "resolved '$ver', expected 'smoke'"
# The container the maintenance/backup scripts start (same helper): the app image's REAL user must own the mount, with mode 0700.
ids="$(env -u APP_VERSION bash deploy/compose.sh run --rm --no-deps -T --entrypoint sh app -c 'echo "$(id -u):$(id -g) $(stat -c %u:%g:%a /var/lib/compass-tools/uploads)"')"
[ "$ids" = "1000:1000 1000:1000:700" ] && ok "app user 1000:1000; mount owned 1000:1000, mode 700" || fail "uid:gid / mount owner:mode was '$ids'"
if docker image inspect compass-tools:local >/dev/null 2>&1; then fail "a stray compass-tools:local image exists (something built the wrong tag)"; else ok "no compass-tools:local image was built"; fi
if env -u APP_VERSION bash -c 'source deploy/common.sh; COMPOSE_PROJECT_NAME=nothing-installed require_app_version' >/dev/null 2>&1; then fail "require_app_version succeeded with no installed app"; else ok "with no installed app the helper refuses instead of guessing"; fi

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
api_ready="$(docker compose exec -T app node -e 'fetch("http://127.0.0.1:3000/api/health",{headers:{authorization:"Bearer "+(process.env.CRON_SECRET||"")}}).then(r=>r.json()).then(h=>console.log(h.readiness.websiteApi))')"
[ "$api_ready" = "configured" ] && ok "readiness.websiteApi=configured" || fail "readiness.websiteApi is $api_ready"
api_net="$(docker compose config --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);const n=c.networks.website_api;const app=Object.keys(c.services.app.networks||{});const others=["db","cloudflared"].filter((x)=>Object.keys(c.services[x].networks||{}).includes("website_api"));console.log((n&&n.internal?"internal":"open")+" app:"+app.includes("website_api")+" others:"+others.length)})')"
[ "$api_net" = "internal app:true others:0" ] && ok "website_api is an internal network that only the app joins" || fail "unexpected website_api network layout: $api_net"
# What a container on that network (the website's) can actually do, on real Docker: a throwaway container from the app image, attached ONLY to it.
probe() { docker run --rm --network compass-tools-website-api --entrypoint node "compass-tools:smoke" -e "$1" 2>&1; }
r="$(probe 'fetch("http://compass-crm:3000/api/v1/website/flight-inquiries",{method:"POST"}).then(r=>console.log(r.status)).catch(e=>console.log("ERR "+(e.cause&&e.cause.code)))')"
[ "$r" = "401" ] && ok "from the website network, compass-crm resolves and the API answers (401 without a key)" || fail "compass-crm was not reachable from the website network: $r"
r="$(probe 'require("dns").lookup("db",(e)=>console.log(e?e.code:"RESOLVED"))')"
case "$r" in RESOLVED) fail "the website network can resolve the database host 'db'" ;; *) ok "the website network cannot resolve 'db' ($r)" ;; esac
dbip="$(docker inspect -f '{{(index .NetworkSettings.Networks "compass-smoke_data").IPAddress}}' "$(docker compose ps -q db)")"
[ -n "$dbip" ] || fail "could not read the database container address"
r="$(probe 'const s=require("net").connect({host:"'"$dbip"'",port:5432,timeout:3000});s.on("connect",()=>{console.log("CONNECTED");s.destroy()});s.on("timeout",()=>{console.log("UNREACHABLE");s.destroy()});s.on("error",()=>console.log("UNREACHABLE"))')"
[ "$r" = "UNREACHABLE" ] && ok "the website network has no route to PostgreSQL ($dbip:5432)" || fail "a container on the website network reached PostgreSQL: $r"

step "The scheduled CVV-cleanup job runs once against the real endpoint"
docker compose run --rm cvv-cleanup node scripts/cvv-cleanup-scheduler.mjs --once | tee "$TMP/job.log"
grep -q '"status":"ok"' "$TMP/job.log" && ok "job reported ok" || fail "the cleanup job did not succeed"
grep -q "$CRON_SECRET" "$TMP/job.log" && fail "the job log contains the secret" || ok "the secret is not in the job log"

step "Recovery rehearsal: a dump made by the app restores with deploy/restore-db.sh - test restore, then onto a brand-new EMPTY database (the replacement-server case)"
# 1. The harmless test restore (into a throw-away database; the live one is untouched).
verify_out="$(bash deploy/restore-db.sh "$TMP/smoke.dump" 2>&1)" || { printf '%s\n' "$verify_out" >&2; fail "restore-db.sh --verify failed"; }
case "$verify_out" in *"Test restore OK"*) ok "restore-db.sh (test restore) read the app's dump and restored it into a temporary database" ;; *) printf '%s\n' "$verify_out" >&2; fail "restore-db.sh did not report a successful test restore" ;; esac
# 2. Make the database brand new, as on a replacement server: stop the app, drop and recreate the application database with no tables.
docker compose stop app cvv-cleanup >/dev/null
live_db="$(bash -c 'source deploy/common.sh; app_db_name')"
bash -c 'source deploy/common.sh; db="$(app_db_name)"; psql_in postgres "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '"'"'$db'"'"' AND pid <> pg_backend_pid()" >/dev/null; psql_in postgres "DROP DATABASE \"$db\""; psql_in postgres "CREATE DATABASE \"$db\""'
empty="$(bash -c 'source deploy/common.sh; psql_in "$(app_db_name)" "SELECT to_regclass('"'"'public.\"Account\"'"'"') IS NOT NULL"')"
[ "$empty" = "f" ] && ok "the application database is brand new and empty" || fail "could not empty the database for the rehearsal (Account exists: $empty)"
# 3. The destructive path, with the typed confirmation, on that empty database. It must NOT abort for lack of something to back up, and must say so.
replace_out="$(printf '%s\n' "$live_db" | RESTORE_RESTART_SERVICES="app cvv-cleanup" bash deploy/restore-db.sh "$TMP/smoke.dump" --replace 2>&1)" || { printf '%s\n' "$replace_out" >&2; fail "restore-db.sh --replace failed on an empty database"; }
case "$replace_out" in *"nothing to back up first"*) ok "--replace on a fresh database skipped the safety backup and said so" ;; *) printf '%s\n' "$replace_out" >&2; fail "--replace did not report skipping the safety backup on an empty database" ;; esac
case "$replace_out" in *"Restore completed"*) ok "--replace restored the dump into the empty database" ;; *) printf '%s\n' "$replace_out" >&2; fail "--replace did not complete" ;; esac
# 4. The restored database is the app's database again: the tables and the migration history are there, the schema is current and the app is healthy.
accounts="$(bash -c 'source deploy/common.sh; psql_in "$(app_db_name)" "SELECT to_regclass('"'"'public.\"Account\"'"'"') IS NOT NULL"')"
[ "$accounts" = "t" ] && ok "the Account table is back" || fail "the restored database has no Account table"
docker compose run --rm tools npx prisma migrate status >/dev/null && ok "prisma migrate status: the restored schema is up to date" || fail "the restored schema is not current"
for _ in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q app)")" = healthy ] && break; sleep 3; done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose ps -q app)")" = healthy ] && ok "the app is healthy again on the restored database" || fail "the app did not become healthy after the restore"

printf '\nAll smoke checks passed.\n'
