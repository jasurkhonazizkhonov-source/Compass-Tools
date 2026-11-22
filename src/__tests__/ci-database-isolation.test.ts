import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Pins the properties of the CI "tests" job that make its PostgreSQL verifiably local, so the database safety guard (src/test/integration-database-guard.ts) can stay
// strict. This is a check of the WORKFLOW'S TEXT: it does not prove that the runner's network is isolated - that is established when the job runs (the step
// "The test database listens on loopback only" fails the job otherwise) - but it makes sure nobody quietly turns these properties back off.

const ROOT = path.resolve(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");
const workflow = read(".github", "workflows", "ci.yml");
const code = (text: string) => text.replace(/^[ \t]*#.*$/gm, "").replace(/\s+#.*$/gm, "");
const jobBlock = (name: string, next: string) => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  const end = workflow.indexOf(`\n  ${next}:\n`, start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
};
const tests = jobBlock("tests", "docker");
const testsCode = code(tests);

describe("the CI database is reachable on loopback itself, never through a forwarded or container address", () => {
  it("runs in the host network namespace, listens on 127.0.0.1 only, and publishes no port", () => {
    const run = testsCode.slice(testsCode.indexOf("docker run"));
    expect(run).toMatch(/docker run [^\n]*--network host\b/);
    expect(run).toContain("-c listen_addresses=127.0.0.1");
    expect(run).toContain("-c port=5432");
    expect(testsCode).not.toMatch(/docker run[^\n]*(\s-p\s|\s--publish\b|\s-P\b)/);
    expect(testsCode).not.toMatch(/listen_addresses=(\*|0\.0\.0\.0|'\*')/);
  });

  it("the image stays pinned by digest and the service is a throw-away container of this job", () => {
    expect(testsCode).toMatch(/postgres:17\.\d+-bookworm@sha256:[0-9a-f]{64}/);
    expect(testsCode).toContain("--name ci-pg");
  });

  it("a step asserts that nothing but loopback listens on the port, and it runs before anything uses the database", () => {
    const names = [...testsCode.matchAll(/^ {6}- (?:name: (.+)|(run: npm ci))$/gm)].map((m) => m[1] ?? "npm ci");
    const listen = names.indexOf("The test database listens on loopback only");
    expect(listen).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(names.indexOf("Start PostgreSQL 17 with TLS"));
    for (const later of ["Apply the migrations to the empty test database", "Prisma migrations match schema.prisma (no schema change without a migration)", "Tests (serial, like the reference run)"]) {
      expect(names.indexOf(later), later).toBeGreaterThan(listen);
    }
    expect(testsCode).toMatch(/ss -H -ltn 'sport = :5432'/);
    expect(testsCode).toMatch(/grep -qvE '\^\(127\\\.0\\\.0\\\.1\|\\\[::1\\\]\):5432\$'/);
  });

  it("every database URL of the job is a loopback literal on port 5432 with a database the guard approves", () => {
    const urls = [...testsCode.matchAll(/^ {6}(DATABASE_URL|INTEGRATION_DATABASE_URL|INTEGRATION_ADMIN_DATABASE_URL): (\S+)$/gm)];
    expect(urls.map((m) => m[1]).sort()).toEqual(["DATABASE_URL", "INTEGRATION_ADMIN_DATABASE_URL", "INTEGRATION_DATABASE_URL"]);
    for (const [, name, url] of urls) {
      expect(url, name).toMatch(/^postgresql:\/\/postgres:postgres@127\.0\.0\.1:5432\/(compass_test|postgres)\?sslmode=require$/);
    }
    expect(testsCode).toMatch(/INTEGRATION_ADMIN_DATABASE_URL: \S+\/postgres\?sslmode=require/);
    expect(testsCode).toMatch(/\n {6}INTEGRATION_DATABASE_URL: \S+\/compass_test\?sslmode=require/);
  });

  it("the job holds no secret and no credential of any real system", () => {
    expect(testsCode).not.toMatch(/\$\{\{\s*secrets\./);
    expect(testsCode).not.toMatch(/(AKIA|GOCSPX|ghp_|-----BEGIN)/);
  });
});

describe("TLS verification is not switched off for the job", () => {
  it("NODE_TLS_REJECT_UNAUTHORIZED is not set anywhere in the workflow", () => {
    expect(code(workflow)).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
  });

  it("the test database's certificate names 127.0.0.1 and is trusted for the test step ONLY (normal verification stays on for npm ci and everything else)", () => {
    expect(testsCode).toMatch(/-addext "subjectAltName=IP:127\.0\.0\.1,DNS:localhost"/);
    const trusted = [...testsCode.matchAll(/NODE_EXTRA_CA_CERTS/g)];
    expect(trusted).toHaveLength(1);
    const testStep = testsCode.slice(testsCode.indexOf("- name: Tests (serial, like the reference run)"));
    expect(testStep).toContain("NODE_EXTRA_CA_CERTS: ${{ runner.temp }}/pgtls/server.crt");
    expect(testStep).toContain("run: npx vitest run --no-file-parallelism");
    // not at job level, not on the install step
    const beforeSteps = testsCode.slice(0, testsCode.indexOf("    steps:"));
    expect(beforeSteps).not.toContain("NODE_EXTRA_CA_CERTS");
  });
});

describe("the guard itself is still wired in and not bypassable from the workflow", () => {
  it("vitest still runs the guard as its global setup, before any test file", () => {
    const config = read("vitest.config.ts");
    expect(code(config)).toContain('globalSetup: ["./src/test/integration-database-guard.ts"]');
  });

  it("the workflow sets no variable that could skip or relax the guard, and does not touch the guard or its allow-lists", () => {
    expect(testsCode).not.toMatch(/SKIP_|BYPASS|DISABLE_(DB|DATABASE)_GUARD|ALLOW_NON_LOOPBACK|--globalSetup|--no-global-setup/i);
    const guard = read("src", "test", "integration-database-guard.ts");
    expect(guard).toMatch(/const LOOPBACK_ANSWERS = new Set\(\["127\.0\.0\.1", "::1"\]\);/);
    const disposable = read("src", "test", "disposable-database.ts");
    expect(disposable).toMatch(/const ALLOWED_HOSTS = new Set\(\["127\.0\.0\.1", "\[::1\]"\]\);/);
    expect(disposable).toMatch(/const APPROVED_DATABASES = new Set\(\["compass_test"\]\);/);
  });

  it("the test command is exactly the one the job has always run (discovery is unchanged)", () => {
    expect(testsCode.match(/run: npx vitest run[^\n]*/g)).toEqual(["run: npx vitest run --no-file-parallelism"]);
  });
});
