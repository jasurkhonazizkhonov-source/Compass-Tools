import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// The Admin Database Backup feature needs three things from the deployment that no unit test of the code can see: a PostgreSQL client of the SAME major
// version as the server inside the app image, a private writable place to stage the dump, and that place kept away from the database container. These
// are text checks (Docker is not available everywhere this runs); deploy/ci-smoke.sh proves the same things on real Docker in CI.
const ROOT = path.resolve(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf-8").replace(/\r\n/g, "\n");
const compose = read("compose.yaml");
const dockerfile = read("Dockerfile");
const smoke = read("deploy", "ci-smoke.sh");

const serverMajor = /image:\s*postgres:(\d+)\./.exec(compose)?.[1];

describe("Database Backup deployment", () => {
  it("the app image carries a PostgreSQL client of the same major version as the pinned server", () => {
    expect(serverMajor).toBeDefined();
    expect(dockerfile).toContain(`postgresql-client-${serverMajor}`);
  });

  it("the PostgreSQL apt repository key is checked against the VERIFIED fingerprint (postgresql.org / ACCC4CF8), and the build tools used to fetch it are removed again", () => {
    // B97B 0AFC AA1A 47F0 44F2 44A0 7FCC 7D46 ACCC 4CF8: printed by postgresql.org's Debian instructions, computed from the downloaded key and the signer of the live InRelease.
    expect(dockerfile).toContain('= "B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8"');
    expect(dockerfile).toContain("https://www.postgresql.org/media/keys/ACCC4CF8.asc");
    expect(dockerfile).toMatch(/signed-by=\/usr\/share\/keyrings\/pgdg\.gpg\] https:\/\/apt\.postgresql\.org\/pub\/repos\/apt bookworm-pgdg main/);
    expect(dockerfile).not.toMatch(/trusted=yes|--allow-unauthenticated|apt-key add/);
    expect(dockerfile).toMatch(/apt-get purge -y --auto-remove curl gnupg/);
    expect(dockerfile).toMatch(/pg_dump --version/);
  });

  it("the app runs the two real PostgreSQL binaries by path, so no Perl wrapper or extra package is involved", () => {
    expect(dockerfile).toContain(`ENV PG_DUMP_BIN=/usr/lib/postgresql/${serverMajor}/bin/pg_dump`);
    expect(dockerfile).toContain(`PG_RESTORE_BIN=/usr/lib/postgresql/${serverMajor}/bin/pg_restore`);
    expect(dockerfile).toContain(`/usr/lib/postgresql/${serverMajor}/bin/pg_dump --version`); // the build itself proves the binary runs
    expect(dockerfile).toContain("apt-get install -y --no-install-recommends postgresql-client-"); // never the server package, never recommends
    expect(dockerfile).not.toMatch(/apt-get install[^\n]*postgresql-\d+ /);
  });

  it("the staging directory is owned by the unprivileged user, mode 0700, and is a volume of the app only", () => {
    expect(dockerfile).toMatch(/install -d -o node -g node -m 0700 \/var\/lib\/compass-tools\/backups|chmod 0?700 \/var\/lib\/compass-tools\/backups/);
    expect(compose).toContain("BACKUP_STAGING_DIR: /var/lib/compass-tools/backups");
    const mounts = compose.match(/source: backup_staging\n\s+target: \/var\/lib\/compass-tools\/backups/g) ?? [];
    expect(mounts).toHaveLength(1); // exactly one service (the app) mounts it; the database container never does
  });

  it("the CI smoke test exercises the real pg_dump, the read-back and the closed download endpoint", () => {
    expect(smoke).toContain('"$PG_DUMP_BIN" --version');
    expect(smoke).toMatch(/for pkg in curl gnupg gcc make postgresql-17/); // build-only tools and the server are not in the runtime image
    expect(smoke).toContain("--list /var/lib/compass-tools/backups/smoke.dump"); // the read-back with pg_restore --list
    expect(smoke).toContain("\"$PG_RESTORE_BIN\"");
    // QUOTED: pg_dump folds an unquoted pattern to lower case ("paymentmethodcvv"), which matches no table, so the data would NOT be excluded and the dump's table of contents would
    // list "TABLE DATA public PaymentMethodCvv" (the GitHub CI run of 80c2e67 failed exactly there). The application's own command line and deploy/backup-db.sh use the quoted form.
    expect(smoke).toContain('--exclude-table-data="\\"PaymentMethodCvv\\""');
    expect(smoke).not.toMatch(/--exclude-table-data=PaymentMethodCvv/);
    expect(smoke).toContain("/api/admin/database-backup/");
  });

  it("the database helpers never read the caller's stdin, so the confirmation piped into restore-db.sh --replace reaches its `read` (the CI recovery rehearsal died silently on EOF)", () => {
    const common = read("deploy", "common.sh");
    const psqlIn = common.slice(common.indexOf("psql_in() {"), common.indexOf("app_db_name()"));
    expect(psqlIn).toMatch(/<\/dev\/null\n\}/);
    expect(common).toMatch(/app_db_name\(\) \{ db_exec sh -c 'printf %s "\$POSTGRES_DB"' <\/dev\/null; \}/);
    // the confirmation is read AFTER helpers have run, so any helper that kept stdin attached would swallow it
    const restore = read("deploy", "restore-db.sh");
    expect(restore.indexOf('LIVE_DB="$(app_db_name)"')).toBeLessThan(restore.indexOf("read -r typed"));
  });

  it("the CI smoke test gives restore-db.sh the .env it insists on (mode 600, before the call), never overwrites a real one, and removes its copy", () => {
    // restore-db.sh -> common.sh check_env_file needs ./.env; the smoke run's own settings live in $TMP/env. The first run of the recovery rehearsal in CI failed with ".env not found".
    const copy = smoke.indexOf('install -m 600 "$TMP/env" .env');
    const firstCall = smoke.indexOf("bash deploy/restore-db.sh");
    expect(copy).toBeGreaterThan(-1);
    expect(firstCall).toBeGreaterThan(-1);
    expect(copy).toBeLessThan(firstCall);
    expect(smoke).toContain("[ ! -e .env ]");
    expect(smoke).toMatch(/\[ "\$\{SMOKE_ENV_COPY:-\}" = "1" \] && rm -f \.env/);
  });

  it("the documentation states what the feature leaves out and that there is no in-app restore", () => {
    const doc = read("docs", "DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md");
    expect(doc).toMatch(/Not an in-app restore/);
    expect(doc).toMatch(/Rebuilding on a replacement VPS/);
    expect(doc).toMatch(/`PaymentMethodCvv`/);
  });
});
