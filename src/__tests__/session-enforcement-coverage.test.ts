import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// One session rule for the whole app (sign-in replaces the old device, 24 hours absolute, sign-out-all): it only holds if every
// authenticated path goes through the SAME checks. These source-level guards fail if a new CRM area, an API route, or a new
// reader of the session cookie bypasses them.

const SRC = path.join(process.cwd(), "src");
const read = (p: string) => fs.readFileSync(p, "utf8");
const norm = (p: string) => path.relative(process.cwd(), p).split(path.sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["__tests__", "__integration__", "generated", "node_modules"].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) out.push(p);
  }
  return out;
}

describe("every authenticated route is behind the session proxy", () => {
  const matcherSource = read(path.join(SRC, "proxy.ts"));
  const matcher = [...matcherSource.slice(matcherSource.indexOf("matcher: [")).matchAll(/"(\/[^"]+)"/g)].map((m) => m[1]);

  it("every top-level CRM page area appears in the proxy matcher", () => {
    const areas = fs
      .readdirSync(path.join(SRC, "app", "(crm)"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(areas.length).toBeGreaterThan(10);
    for (const area of areas) {
      expect(matcher.some((m) => m === `/${area}` || m.startsWith(`/${area}/`)), `/${area} is not in the proxy matcher`).toBe(true);
    }
  });

  it("the CRM layout re-checks the session itself (defence in depth if a route were ever missed)", () => {
    const layout = read(path.join(SRC, "app", "(crm)", "layout.tsx"));
    expect(layout).toContain("getCurrentAccount");
  });
});

describe("the sign-in IP / location stays Administrator-only", () => {
  it("only the writer, the global omit, the type that mirrors it and the one role-checked query mention the columns", () => {
    const files = walk(SRC)
      .filter((f) => /lastSignIn(Ip|City|Region|Country|CountryCode|TimeZone)/.test(read(f)))
      .map(norm)
      .sort();
    expect(files).toEqual(["src/lib/prisma.ts", "src/server/auth/establish-session.ts", "src/server/auth/google-authorization.ts", "src/server/queries/accounts.ts"]);
  });

  it("the one query that opts in checks the viewer's role before touching the database", () => {
    const q = read(path.join(SRC, "server", "queries", "accounts.ts"));
    const fn = q.slice(q.indexOf("export async function getAccountSignInDetails"));
    expect(fn.indexOf("canManageAccounts")).toBeGreaterThan(-1);
    expect(fn.indexOf("canManageAccounts")).toBeLessThan(fn.indexOf("prisma.account"));
  });

  it("the global Prisma omit lists every sign-in field and the session token", () => {
    const prismaSrc = read(path.join(SRC, "lib", "prisma.ts"));
    for (const f of ["activeSessionId", "lastSignInIp", "lastSignInCity", "lastSignInRegion", "lastSignInCountry", "lastSignInCountryCode", "lastSignInTimeZone"]) {
      expect(prismaSrc, f).toMatch(new RegExp(`${f}: true`));
    }
  });
});

describe("no second way to read or issue a session", () => {
  const ALLOWED_COOKIE_READERS = [
    "src/lib/dev-session.ts", // getCurrentAccount — the single check pages, server actions and API routes use
    "src/proxy.ts", // the route gate
    "src/server/actions/dev-session.ts", // sign out
    "src/server/actions/session-admin.ts", // sign out all (clears the Admin's own cookie)
    "src/server/auth/establish-session.ts", // the one place a session is issued
  ];

  it("only the known modules touch the session cookie", () => {
    const readers = walk(SRC)
      .filter((f) => /DEV_ACCOUNT_COOKIE|compass_dev_account/.test(read(f)))
      .map(norm)
      .sort();
    expect(readers).toEqual([...ALLOWED_COOKIE_READERS].sort());
  });

  it("session issuance is never exported from a 'use server' module (it would be network-callable)", () => {
    const issuer = read(path.join(SRC, "server", "auth", "establish-session.ts"));
    expect(issuer).not.toMatch(/^\s*["']use server["']/m);
    for (const f of walk(path.join(SRC, "server", "actions"))) {
      if (/^\s*["']use server["']/m.test(read(f))) expect(read(f), norm(f)).not.toMatch(/export\s+(async\s+)?function\s+establishSession/);
    }
  });

  it("the only API routes that authenticate a signed-in user do so through getCurrentAccount (so expiry and replacement apply)", () => {
    const apiRoutes = walk(path.join(SRC, "app", "api")).filter((f) => f.endsWith("route.ts"));
    expect(apiRoutes.length).toBeGreaterThan(5);
    const sessionAware = apiRoutes.filter((f) => /getCurrentAccount|requireSession|activeSessionId/.test(read(f))).map(norm);
    // gmail callback (connect Gmail) and the Lead-document open/download route — both authenticate via getCurrentAccount only.
    expect([...sessionAware].sort()).toEqual(["src/app/api/attachments/[id]/file/route.ts", "src/app/api/auth/gmail/callback/route.ts"]);
    for (const f of apiRoutes) expect(read(f), norm(f)).not.toMatch(/cookies\(\)\s*\)?\.?get\(["']compass/);
  });
});
