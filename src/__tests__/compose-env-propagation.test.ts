import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

// A variable that compose.yaml does not name under a service's `environment:` NEVER reaches that container, whatever .env contains
// (there is no env_file). Before 2026-11-22 five documented settings were silently dropped this way - including WEBSITE_SIGNATURE_REQUIRED, so
// the documented "set it to true and restart" step for strict website signing could not take effect on the VPS. This test makes that class of
// defect impossible to reintroduce: every setting that .env.example documents AND the application code reads must be forwarded to the app
// container, or be listed below with the reason it deliberately is not.
const ROOT = path.resolve(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf-8").replace(/\r\n/g, "\n");
const compose = read("compose.yaml");
const envExample = read(".env.example");

function service(name: string): string {
  const servicesBlock = compose.slice(compose.indexOf("\nservices:\n"), compose.indexOf("\nnetworks:\n"));
  const parts = servicesBlock.split(/^ {2}([a-z][a-z0-9-]*):\n/m);
  const i = parts.indexOf(name);
  if (i < 0) throw new Error(`service ${name} not found`);
  return uncommented(parts[i + 1]);
}
const uncommented = (s: string) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const environmentNames = (svc: string) => new Set([...uncommented(svc).matchAll(/^ {6}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (/^(__tests__|__integration__|generated|node_modules)$/.test(entry)) continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry) && !/\.(test|spec)\./.test(entry)) out.push(full);
  }
  return out;
}

const readByCode = new Set<string>();
for (const dir of ["src", "scripts"]) {
  for (const file of walk(path.join(ROOT, dir))) {
    const text = readFileSync(file, "utf-8");
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) readByCode.add(m[1]);
    for (const m of text.matchAll(/process\.env\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g)) readByCode.add(m[1]);
    for (const m of text.matchAll(/(?:intEnv|envInt|envFlag|readEnv)\(\s*["']([A-Z][A-Z0-9_]+)["']/g)) readByCode.add(m[1]);
  }
}
const documented = new Set([...envExample.split("\n")].map((l) => /^#?\s*([A-Z][A-Z0-9_]{3,})\s*=/.exec(l)?.[1]).filter((n): n is string => !!n));

/** Settings that are documented and read by code but deliberately NOT forwarded to the app container, each with the reason. */
const NOT_FORWARDED: Record<string, string> = {
  DATABASE_SSL_CA: "remote-database TLS only; the compose database is on a private network and the config test forbids passing it next to DATABASE_SSL_MODE=disable",
  DATABASE_SSL_VERIFY: "remote-database TLS only (same reason as DATABASE_SSL_CA)",
  DATABASE_AUTO_INIT: "read only by scripts/vercel-build.mjs at build time on a hosted platform; the VPS applies migrations as an explicit separate step",
  APP_ENV: "only APP_ENV=production has any effect and the image already runs with NODE_ENV=production; forwarding it could only add a way to confuse the mode",
  CRON_TARGET_URL: "set directly on the cvv-cleanup scheduler service",
  CLEANUP_HEARTBEAT_URL: "belongs to the cvv-cleanup scheduler service, not the application",
  CF_PAGES: "platform marker set by Cloudflare Pages itself",
  WORKERS_CI: "platform marker set by Cloudflare Workers builds itself",
  VERCEL_PROJECT_PRODUCTION_URL: "platform value set by Vercel itself",
};

describe("compose.yaml forwards every documented setting the application reads", () => {
  const forwarded = environmentNames(service("app"));

  it("scans a meaningful amount of code and documentation (the scan itself is not broken)", () => {
    expect(readByCode.size).toBeGreaterThan(25);
    expect(documented.size).toBeGreaterThan(40);
    expect(forwarded.size).toBeGreaterThan(30);
  });

  it("every documented, code-read setting is named in the app service's environment, or is exempted below with a reason", () => {
    const missing = [...readByCode].filter((n) => documented.has(n) && !forwarded.has(n) && !(n in NOT_FORWARDED)).sort();
    expect(missing, `documented and read by the application, but never passed to the container by compose.yaml: ${missing.join(", ")}`).toEqual([]);
  });

  it("the exemption list cannot rot: nothing in it is actually forwarded to the app, and every reason is spelled out", () => {
    for (const [name, reason] of Object.entries(NOT_FORWARDED)) {
      expect(forwarded.has(name), `${name} is forwarded, so remove it from NOT_FORWARDED`).toBe(false);
      expect(reason.length, name).toBeGreaterThan(20);
    }
  });

  it("the security-relevant settings that were silently dropped before 2026-11-22 are forwarded", () => {
    for (const n of ["WEBSITE_SIGNATURE_REQUIRED", "LEAD_INGEST_SECRET_PREVIOUS", "CAMPAIGN_SENDS_PER_MINUTE", "CAMPAIGN_DAILY_LIMIT", "DISABLE_IN_PROCESS_POLLER", "GEOIP_DB_PATH"]) {
      expect(forwarded.has(n), n).toBe(true);
    }
  });

  it("the strict-signing switch is forwarded from .env and never forced on or off by this file (an empty value means the transitional default)", () => {
    expect(service("app")).toMatch(/WEBSITE_SIGNATURE_REQUIRED: \$\{WEBSITE_SIGNATURE_REQUIRED:-\}/);
    expect(service("app")).toMatch(/LEAD_INGEST_SECRET_PREVIOUS: \$\{LEAD_INGEST_SECRET_PREVIOUS:-\}/);
    expect(uncommented(compose)).not.toMatch(/WEBSITE_SIGNATURE_REQUIRED:\s*["']?(true|false)/i);
    expect(uncommented(envExample)).not.toMatch(/^\s*WEBSITE_SIGNATURE_REQUIRED\s*=\s*"?true/im); // documented, but never switched on by an example file
  });

  it("campaign budgets and the poller switch default to EMPTY here, so the code's own defaults (20/min, 400/day, poller on) apply unless the owner sets them", () => {
    for (const n of ["CAMPAIGN_SENDS_PER_MINUTE", "CAMPAIGN_DAILY_LIMIT", "DISABLE_IN_PROCESS_POLLER"]) {
      expect(service("app")).toMatch(new RegExp(`${n}: \\$\\{${n}:-\\}`));
    }
  });
});

describe("compose.yaml: the IP-geolocation database", () => {
  it("the app reads it from a named volume mounted READ-ONLY, and GEOIP_DB_PATH defaults to a file inside that mount", () => {
    const app = service("app");
    expect(app).toMatch(/GEOIP_DB_PATH: \$\{GEOIP_DB_PATH:-\/var\/lib\/compass-tools\/geoip\/city\.mmdb\}/);
    expect(app).toMatch(/type: volume\s*\n\s+source: geoip_data\s*\n\s+target: \/var\/lib\/compass-tools\/geoip\s*\n\s+read_only: true/);
    expect(uncommented(compose)).toMatch(/^volumes:\n(\s+.*\n)*\s+geoip_data: \{\}/m);
  });

  it("geoip-update is an on-demand tools-profile job: no database, no secrets, no uploads, its own egress network, licence flag typed by the operator", () => {
    const job = service("geoip-update");
    expect(job).toMatch(/profiles: \["tools"\]/);
    expect(job).toMatch(/restart: "no"/);
    expect(job).toMatch(/networks: \[egress\]/);
    expect(job).not.toMatch(/networks:s*[[^]]*(data|web|website_api)/); // never on the database, tunnel or website network
    expect(uncommented(job)).not.toMatch(/DATABASE_URL|SECRET|PASSWORD|TOKEN|KEY|uploads|UPLOADS/);
    expect(job).toMatch(/no-new-privileges|<<: \*hardening/);
    // the volume is writable here (this is the only writer) and mounted nowhere else writable
    expect(job).toMatch(/source: geoip_data\s*\n\s+target: \/var\/lib\/compass-tools\/geoip\s*\n(?!\s+read_only)/);
    for (const other of ["db", "cloudflared", "cvv-cleanup", "tools"]) expect(service(other), other).not.toMatch(/geoip_data/);
  });

  it("no long-running service is on the internet-capable egress network", () => {
    for (const name of ["db", "app", "cloudflared", "cvv-cleanup", "tools"]) expect(service(name), name).not.toMatch(/\begress\b/);
  });

  it("the image creates the mount point owned by the unprivileged user in both stages, so a new volume is writable by the job and readable by the app", () => {
    const dockerfile = read("Dockerfile");
    expect([...dockerfile.matchAll(/mkdir -p \/var\/lib\/compass-tools\/geoip && chown node:node \/var\/lib\/compass-tools\/geoip/g)]).toHaveLength(2);
  });
});
