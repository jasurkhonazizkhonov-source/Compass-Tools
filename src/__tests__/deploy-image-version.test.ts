import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import os from "os";
import path from "path";

// Behaviour of the deployment helpers that must never guess: which image version a script runs on (deploy/common.sh require_app_version,
// deploy/compose.sh) and whether a database check can be trusted before a migration (database_state). They run the REAL shell code against a
// stub `docker` that records every call, so the tests prove what is (and is not) invoked - in particular that nothing ever builds, and that
// a failed probe is never reported as "empty". They need `bash` (Git Bash on Windows, any Linux), like the deploy scripts themselves.
const ROOT = path.resolve(__dirname, "..", "..");
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;

let dir: string;
let log: string;
const STUB = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$1 $2" in
  "compose ps") echo "\${STUB_CONTAINER:-}" ;;
  "inspect --format") echo "\${STUB_IMAGE:-}" ;;
  "image inspect") for i in \${STUB_IMAGES:-}; do [ "$i" = "$3" ] && exit 0; done; exit 1 ;;
  "compose exec")
    case "$*" in
      *printf*) printf %s "\${STUB_DB-compass}" ;;
      *psql*) [ "\${STUB_FAIL:-}" = 1 ] && exit 1; printf '%s\\n' "\${STUB_COUNT-}" ;;
    esac ;;
  "compose up") echo "UP version=\${APP_VERSION:-unset} args=$*" ;;
  "compose run") echo "RUN version=\${APP_VERSION:-unset} args=$*" ;;
esac
exit 0
`;

function sh(script: string, env: Record<string, string> = {}) {
  const r = spawnSync("bash", ["-c", `source "${ROOT.replace(/\\/g, "/")}/deploy/common.sh"; ${script}`], {
    env: { ...process.env, PATH: `${dir.replace(/\\/g, "/")}${path.delimiter}${process.env.PATH}`, STUB_LOG: log.replace(/\\/g, "/"), APP_VERSION: "", ...env },
    encoding: "utf8",
  });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").replace(/\x1b\[[0-9;]*m/g, "").trim() };
}
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);

describe.skipIf(!hasBash)("deployment helpers (real shell code, stub docker)", () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ct-stub-"));
    log = path.join(dir, "calls.log");
    writeFileSync(path.join(dir, "docker"), STUB);
    chmodSync(path.join(dir, "docker"), 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const reset = () => rmSync(log, { force: true });

  describe("require_app_version", () => {
    it("takes the tag of the installed app (running OR stopped) when the image exists", () => {
      reset();
      const r = sh('require_app_version; echo "$APP_VERSION"', { STUB_CONTAINER: "abc123", STUB_IMAGE: "compass-tools:a1b2c3d4e5f6", STUB_IMAGES: "compass-tools:a1b2c3d4e5f6" });
      expect(r).toMatchObject({ code: 0, out: "a1b2c3d4e5f6" });
      expect(calls().some((c) => c.startsWith("compose ps") && c.includes("-aq"))).toBe(true); // -a: a stopped container counts
    });

    it("keeps an explicit APP_VERSION when that image exists", () => {
      expect(sh('require_app_version; echo "$APP_VERSION"', { APP_VERSION: "v9", STUB_IMAGES: "compass-tools:v9" })).toMatchObject({ code: 0, out: "v9" });
    });

    it("fails with a clear message - and runs nothing - when no installed version can be determined", () => {
      reset();
      const r = sh("require_app_version");
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/Cannot tell which application version is installed/);
      expect(r.err).toMatch(/APP_VERSION=<tag>/);
      expect(calls().filter((c) => /^compose (up|run|build)/.test(c))).toEqual([]);
    });

    it("never falls back to the non-existent ':local' tag, an untagged image or a foreign image", () => {
      for (const image of ["compass-tools:", "compass-tools", "postgres:17", "somebody/compass-tools:abc", ""]) {
        const r = sh('require_app_version; echo "$APP_VERSION"', { STUB_CONTAINER: "abc123", STUB_IMAGE: image, STUB_IMAGES: "compass-tools:local compass-tools:" });
        expect(r.code, image).not.toBe(0);
        expect(r.out, image).not.toContain("local");
      }
    });

    it("refuses when the image for that version is not on this server, instead of letting Compose build it", () => {
      reset();
      const r = sh("require_app_version", { STUB_CONTAINER: "abc123", STUB_IMAGE: "compass-tools:gone12345678", STUB_IMAGES: "compass-tools:other" });
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/image compass-tools:gone12345678 is not on this server/);
      expect(calls().filter((c) => /^compose (up|run|build)/.test(c))).toEqual([]);
    });

    it("rejects a version string that is not a valid image tag", () => {
      for (const v of ["a b", "x;rm -rf /", "../x", "a/b", "$(id)"]) expect(sh("require_app_version", { APP_VERSION: v, STUB_IMAGES: `compass-tools:${v}` }).code, v).not.toBe(0);
    });
  });

  describe("deploy/compose.sh", () => {
    const run = (args: string, env: Record<string, string>) => sh(`bash "${ROOT.replace(/\\/g, "/")}/deploy/compose.sh" ${args}`, env);
    const installed = { STUB_CONTAINER: "abc123", STUB_IMAGE: "compass-tools:v1abcdef0123", STUB_IMAGES: "compass-tools:v1abcdef0123 compass-tools-tools:v1abcdef0123" };

    it("runs `up` on the installed version and never builds", () => {
      reset();
      const r = run("up -d app", installed);
      expect(r.out).toContain("UP version=v1abcdef0123");
      expect(r.out).toContain("up --no-build -d app");
    });

    it("runs the maintenance image on the installed version", () => {
      reset();
      expect(run("run --rm tools npx prisma migrate status", installed).out).toContain("RUN version=v1abcdef0123");
    });

    it("refuses to start anything when the installed version is unknown or its image is missing", () => {
      reset();
      expect(run("up -d app", {}).code).not.toBe(0);
      expect(run("up -d app", { STUB_CONTAINER: "abc123", STUB_IMAGE: "compass-tools:v1abcdef0123", STUB_IMAGES: "" }).code).not.toBe(0);
      expect(run("run --rm tools x", { ...installed, STUB_IMAGES: "compass-tools:v1abcdef0123" }).code).not.toBe(0); // tools image missing
      expect(calls().filter((c) => /^compose (up|run)/.test(c))).toEqual([]);
    });
  });

  describe("database_state (the backup-before-migration decision)", () => {
    it("reports a database with tables as existing and a verifiably table-less one as empty", () => {
      expect(sh("database_state", { STUB_COUNT: "73" })).toMatchObject({ code: 0, out: "existing" });
      expect(sh("database_state", { STUB_COUNT: "1" })).toMatchObject({ code: 0, out: "existing" });
      expect(sh("database_state", { STUB_COUNT: "0" })).toMatchObject({ code: 0, out: "empty" });
    });

    it("a failed or unreadable check is UNKNOWN (non-zero, no answer) - never 'empty'", () => {
      for (const env of <Record<string, string>[]>[{ STUB_FAIL: "1", STUB_COUNT: "0" }, { STUB_COUNT: "" }, { STUB_COUNT: "t" }, { STUB_COUNT: "7x" }, { STUB_COUNT: "-1" }, { STUB_COUNT: "0 1" }, { STUB_DB: "", STUB_COUNT: "0" }]) {
        const r = sh("database_state", env);
        expect(r.code, JSON.stringify(env)).not.toBe(0);
        expect(r.out, JSON.stringify(env)).toBe("");
      }
    });
  });

  describe("deploy.sh wiring", () => {
    const deploy = readFileSync(path.join(ROOT, "deploy", "deploy.sh"), "utf8").replace(/\r\n/g, "\n");
    it("only a VERIFIED empty database skips the backup; an unknown state stops before migrating; the backup is required to exist", () => {
      expect(deploy).toContain('DB_STATE="$(database_state)" || die');
      expect(deploy).not.toMatch(/\|\|\s*echo f/); // the old "a failed probe means first deployment" shortcut
      const block = deploy.slice(deploy.indexOf('step "Backup before migrating"'), deploy.indexOf('step "Applying pending migrations'));
      expect(block.indexOf("database_state")).toBeLessThan(block.indexOf("backup-db.sh"));
      expect(block).toMatch(/backup-db\.sh"?\s*\|\|\s*die/);
      expect(block).toContain("-newer");
      expect(block).toMatch(/\[ "\$DB_STATE" = "existing" \]/);
      expect(deploy.indexOf('step "Applying pending migrations')).toBeGreaterThan(deploy.indexOf("database_state"));
    });

    it("prints the rollback command (using the existing script and version format) before starting the new version, and runs nothing automatically", () => {
      const start = deploy.slice(deploy.indexOf('step "Starting the new version"'));
      expect(start.indexOf("bash deploy/rollback.sh")).toBeGreaterThan(-1);
      expect(start.indexOf("bash deploy/rollback.sh")).toBeLessThan(start.indexOf("dc up -d"));
      expect(deploy).not.toMatch(/^\s*bash "\$ROOT_DIR\/deploy\/rollback\.sh"/m);
    });
  });

  describe("the scripts that need an image resolve the version first", () => {
    const text = (f: string) => readFileSync(path.join(ROOT, "deploy", f), "utf8").replace(/\r\n/g, "\n");
    it("restore scripts read the version BEFORE they stop the app", () => {
      for (const f of ["restore-db.sh", "restore-uploads.sh"]) {
        const t = text(f);
        expect(t.indexOf("require_app_version"), f).toBeGreaterThan(-1);
        expect(t.indexOf("require_app_version"), f).toBeLessThan(t.indexOf("dc stop"));
      }
    });
    it("every image-using helper goes through require_app_version", () => {
      expect(text("common.sh")).toMatch(/in_uploads_container\(\) \{ require_app_version;/);
    });
  });
});
