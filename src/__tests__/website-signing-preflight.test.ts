import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import path from "path";
import { websiteSigningProblems } from "../../scripts/website-signing-preflight.mjs";

// The deployment gate for website request signing: deploy/deploy.sh runs scripts/website-signing-preflight.mjs inside the new image and stops, before any
// migration or restart, unless the configuration requires signatures AND can verify them.
const ROOT = path.resolve(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf-8").replace(/\r\n/g, "\n");
const problems = websiteSigningProblems as (env: Record<string, string | undefined>) => string[];

// Throwaway values.
const SECRET = "unit-test-signing-secret-0123456789-abcdefghij";
const OTHER = "unit-test-previous-secret-9876543210-zyxwvutsrq";
const GOOD = { LEAD_INGEST_SECRET: SECRET, WEBSITE_SIGNATURE_REQUIRED: "true" };

describe("website signing pre-flight: the configuration rules", () => {
  it("accepts a configured secret with WEBSITE_SIGNATURE_REQUIRED=true (any case), with or without a different rotation secret", () => {
    expect(problems(GOOD)).toEqual([]);
    expect(problems({ ...GOOD, WEBSITE_SIGNATURE_REQUIRED: " TRUE " })).toEqual([]);
    expect(problems({ ...GOOD, LEAD_INGEST_SECRET_PREVIOUS: OTHER, WEBSITE_API_KEY: "w".repeat(64), CRON_SECRET: "c".repeat(48) })).toEqual([]);
  });

  it.each([
    ["nothing at all", {}, /LEAD_INGEST_SECRET is not set/],
    ["no secret", { WEBSITE_SIGNATURE_REQUIRED: "true" }, /LEAD_INGEST_SECRET is not set/],
    ["no switch", { LEAD_INGEST_SECRET: SECRET }, /WEBSITE_SIGNATURE_REQUIRED is not set/],
    ["an empty switch", { ...GOOD, WEBSITE_SIGNATURE_REQUIRED: "" }, /WEBSITE_SIGNATURE_REQUIRED is not set/],
    ["the requirement disabled", { ...GOOD, WEBSITE_SIGNATURE_REQUIRED: "false" }, /must be exactly "true"/],
    ["a switch that is not 'true'", { ...GOOD, WEBSITE_SIGNATURE_REQUIRED: "yes" }, /must be exactly "true"/],
    ["a short secret", { ...GOOD, LEAD_INGEST_SECRET: "Ab1Cd2Ef3Gh4" }, /shorter than 32 characters/],
    ["a repeated-character placeholder", { ...GOOD, LEAD_INGEST_SECRET: "x".repeat(44) }, /placeholder/],
    ["a worded placeholder", { ...GOOD, LEAD_INGEST_SECRET: "change-me-to-a-long-random-secret-value-123" }, /placeholder/],
    ["a secret with whitespace", { ...GOOD, LEAD_INGEST_SECRET: `${SECRET} ` }, /spaces or line breaks/],
    ["a short previous secret", { ...GOOD, LEAD_INGEST_SECRET_PREVIOUS: "old" }, /LEAD_INGEST_SECRET_PREVIOUS is shorter/],
    ["a previous secret equal to the current one", { ...GOOD, LEAD_INGEST_SECRET_PREVIOUS: SECRET }, /equals LEAD_INGEST_SECRET/],
    ["the API key reused", { ...GOOD, WEBSITE_API_KEY: SECRET }, /same value as WEBSITE_API_KEY/],
    ["the cron secret reused", { ...GOOD, CRON_SECRET: SECRET }, /same value as CRON_SECRET/],
    ["an encryption key reused as the previous secret", { ...GOOD, LEAD_INGEST_SECRET_PREVIOUS: OTHER, CARD_ENCRYPTION_KEY: OTHER }, /LEAD_INGEST_SECRET_PREVIOUS is the same value as CARD_ENCRYPTION_KEY/],
  ])("refuses %s", (_label, env, expected) => {
    expect(problems(env).join("\n")).toMatch(expected);
  });

  it("never puts a value in a message", () => {
    const messages = problems({ LEAD_INGEST_SECRET: "short-sentinel", LEAD_INGEST_SECRET_PREVIOUS: "other-sentinel", WEBSITE_SIGNATURE_REQUIRED: "flag-sentinel", CRON_SECRET: "short-sentinel" }).join("\n");
    expect(messages).not.toMatch(/sentinel/);
  });
});

describe("website signing pre-flight: run as the deployment runs it", () => {
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, [path.join(ROOT, "scripts", "website-signing-preflight.mjs")], { env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf-8" });

  it("exits 0 for a safe configuration and prints no value", () => {
    const r = run(GOOD);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("website signing preflight: OK");
    expect(r.stdout + r.stderr).not.toContain(SECRET);
  });

  it("exits 1 and says it refused for an unsafe one", () => {
    const r = run({ LEAD_INGEST_SECRET: SECRET, WEBSITE_SIGNATURE_REQUIRED: "false" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("website signing preflight: refused");
    expect(r.stdout + r.stderr).not.toContain(SECRET);
  });
});

describe("website signing pre-flight: wired into the deployment", () => {
  it("the runtime image contains the script", () => {
    const runner = read("Dockerfile").split("AS runner")[1];
    expect(runner).toMatch(/COPY --from=builder[^\n]*\/app\/scripts\/website-signing-preflight\.mjs[^\n]*\.\/scripts\//);
  });

  it("deploy.sh runs it after the build and before any database or restart step, and stops on failure", () => {
    const deploy = read("deploy", "deploy.sh");
    const at = (needle: string) => {
      const i = deploy.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const check = at("node scripts/website-signing-preflight.mjs");
    expect(check).toBeGreaterThan(at("dc build app tools"));
    expect(check).toBeLessThan(at("dc up -d db"));
    expect(check).toBeLessThan(at("npx prisma migrate deploy"));
    expect(check).toBeLessThan(at("dc up -d --remove-orphans"));
    expect(deploy.slice(check, check + 200)).toMatch(/\|\| die /);
  });

  it("verify.sh fails when the running app does not require signatures", () => {
    const verify = read("deploy", "verify.sh");
    expect(verify).toContain('"websiteSignature=" + r.websiteSignature');
    expect(verify).toMatch(/websiteSignature=optional"\*\) fail /);
    expect(verify).toMatch(/websiteSignature=not_configured"\*\) fail /);
  });
});
