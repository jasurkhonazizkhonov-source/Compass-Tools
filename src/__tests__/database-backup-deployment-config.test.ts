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
    expect(smoke).toContain("--exclude-table-data=PaymentMethodCvv");
    expect(smoke).toContain("/api/admin/database-backup/");
  });

  it("the documentation states what the feature leaves out and that there is no in-app restore", () => {
    const doc = read("docs", "DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md");
    expect(doc).toMatch(/Not an in-app restore/);
    expect(doc).toMatch(/Rebuilding on a replacement VPS/);
    expect(doc).toMatch(/`PaymentMethodCvv`/);
  });
});
