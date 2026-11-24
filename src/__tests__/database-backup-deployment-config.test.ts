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

  it("the PostgreSQL apt repository key is checked against a pinned fingerprint, and the build tools used to fetch it are removed again", () => {
    expect(dockerfile).toMatch(/[A-F0-9]{40}/);
    expect(dockerfile).toMatch(/apt-get purge -y --auto-remove curl gnupg/);
    expect(dockerfile).toMatch(/pg_dump --version/);
  });

  it("the staging directory is owned by the unprivileged user, mode 0700, and is a volume of the app only", () => {
    expect(dockerfile).toMatch(/install -d -o node -g node -m 0700 \/var\/lib\/compass-tools\/backups|chmod 0?700 \/var\/lib\/compass-tools\/backups/);
    expect(compose).toContain("BACKUP_STAGING_DIR: /var/lib/compass-tools/backups");
    const mounts = compose.match(/source: backup_staging\n\s+target: \/var\/lib\/compass-tools\/backups/g) ?? [];
    expect(mounts).toHaveLength(1); // exactly one service (the app) mounts it; the database container never does
  });

  it("the CI smoke test exercises the real pg_dump, the read-back and the closed download endpoint", () => {
    expect(smoke).toContain("pg_dump --version");
    expect(smoke).toContain("pg_restore --list");
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
