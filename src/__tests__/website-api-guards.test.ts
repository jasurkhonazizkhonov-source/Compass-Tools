import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import path from "path";

// Source-level guards for the authenticated website API (POST /api/v1/website/flight-inquiries): the credential stays server-side and in one
// module, nothing browser-facing can reach it, the route keeps its order of checks, and the documented variables stay empty. These
// complement the real-database tests, which prove the behaviour.
const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf-8").replace(/\r\n/g, "\n");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*(\/\/|#)/.test(l)).join("\n");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (["__tests__", "__integration__", "generated", "node_modules"].includes(name)) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const APP_CODE = walk(SRC);
const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, "/");

describe("website API credential handling", () => {
  it("the key variables are read in exactly one module", () => {
    const readers = APP_CODE.filter((f) => /WEBSITE_API_KEY/.test(code(readFileSync(f, "utf-8")))).map(rel);
    expect(readers).toEqual(["src/server/security/website-api-auth.ts"]);
  });

  it("no setting of this API is a NEXT_PUBLIC_ variable, and no client component touches the API, its auth module or its secrets", () => {
    for (const f of APP_CODE) {
      const raw = readFileSync(f, "utf-8");
      expect(raw, rel(f)).not.toMatch(/NEXT_PUBLIC_[A-Z_]*WEBSITE_API/);
      if (/^\s*["']use client["']/.test(raw)) expect(raw, rel(f)).not.toMatch(/website-api|WEBSITE_API|flight-inquiries|server\/lead-intake/);
    }
    expect(read(".env.example")).not.toMatch(/NEXT_PUBLIC_[A-Z_]*WEBSITE_API/);
  });

  it("the comparison is constant-time and the module never logs or returns a key", () => {
    const auth = code(read("src", "server", "security", "website-api-auth.ts"));
    expect(auth).toContain("timingSafeEqual");
    expect(auth).not.toMatch(/console\.|JSON\.stringify|throw new Error\(/);
    expect(auth).not.toMatch(/===\s*(token|presented)|(token|presented)\s*===|\.includes\(token|startsWith\(token/); // never a plain string comparison with the presented key
  });
});

describe("website API route", () => {
  const route = code(read("src", "app", "api", "v1", "website", "flight-inquiries", "route.ts"));

  it("checks in the documented order: private network, credential, budget, headers, body, company, create", () => {
    const order = ["arrivedViaPublicEdge", "authenticateWebsiteApi", "RATE_LIMITS.WEBSITE_API_REQUESTS", 'req.headers.get("content-type")', 'req.headers.get("idempotency-key")', "await readLimited(", "apiSchema.safeParse", "prisma.company.findUnique", "createWebsiteFlightLead("].map((s) => route.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("is strict, never accepts a company or idempotency key from the body, and reuses the shared creation core", () => {
    expect(route).toContain(".strict()");
    expect(route).toContain(".omit({ submissionId: true })");
    expect(route).not.toMatch(/companyId:\s*(data|parsed|json|body)/);
    expect(route).toContain("websiteApiCompanyId()");
    expect(route).not.toMatch(/prisma\.(lead|contact)\.(create|update|upsert)/); // creation goes through src/server/lead-intake.ts only
  });

  it("never returns an exception, stack, request body or key, and never logs request data", () => {
    expect(route).not.toMatch(/\.stack|error\.message|err\.message|String\(err|JSON\.stringify\((json|data|raw|body)/);
    expect([...route.matchAll(/console\.\w+\(([^)]*)\)/g)].every((m) => /^"\[website-api\] [a-z ]+"$/.test(m[1].trim()))).toBe(true); // fixed tags only
  });

  it("stays outside the proxy matcher (no body buffering, no session logic) and is dynamic, node-runtime only", () => {
    const proxy = read("src", "proxy.ts");
    const matcher = proxy.slice(proxy.indexOf("matcher:"));
    expect(matcher).not.toMatch(/"\/api/); // an allow-list of page prefixes: no /api entry, so the route is never wrapped by the proxy
    const raw = read("src", "app", "api", "v1", "website", "flight-inquiries", "route.ts");
    expect(raw).toContain('export const runtime = "nodejs"');
    expect(raw).toContain('export const dynamic = "force-dynamic"');
    expect(existsSync(path.join(SRC, "app", "api", "v1", "website", "flight-inquiries", "route.ts"))).toBe(true);
  });
});

describe("shared lead creation", () => {
  it("both entry points create leads only through the shared core, so the business rules cannot drift", () => {
    for (const f of ["src/app/api/public/lead-capture/route.ts", "src/app/api/v1/website/flight-inquiries/route.ts"]) {
      const text = code(read(...f.split("/")));
      expect(text, f).toContain("createWebsiteFlightLead(");
      expect(text, f).not.toMatch(/prisma\.lead\.create|resolveContactForNewLead/);
    }
  });
});

describe("environment documentation", () => {
  const envExample = read(".env.example");

  it(".env.example documents the variables and leaves every one empty", () => {
    for (const v of ["WEBSITE_API_KEY", "WEBSITE_API_KEY_NEXT", "WEBSITE_API_COMPANY_ID", "WEBSITE_API_ALLOW_PUBLIC_ROUTE"]) {
      const m = envExample.match(new RegExp(`^#?\\s*${v}="([^"]*)"`, "m"));
      expect(m, v).not.toBeNull();
      if (v !== "WEBSITE_API_COMPANY_ID") expect(m![1], v).toBe("");
    }
  });
});
