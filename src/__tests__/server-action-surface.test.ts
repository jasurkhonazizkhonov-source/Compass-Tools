import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The Server Action SURFACE. Every async export of a file that starts with "use server" is a callable endpoint (Next registers it, whoever imports it), so each one must either
// authorize its caller, or be listed below as PUBLIC BY DESIGN with the reason. A sweep of all of them on 2026-11-22 found two functions that received their `companyId` from the caller
// and answered without authenticating (listLeadEligibleAgents / listTaskEligibleAgents) and, earlier, the lead distribution engine; this guard makes the next one fail the REQUIRED
// unit job instead of waiting for a review. Source-level (reads the files); the production-build half at the bottom runs when a build exists and says so when it does not.

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (["__tests__", "__integration__", "generated", "node_modules"].includes(e.name)) continue;
      walk(rel, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) out.push(rel);
  }
  return out;
}

const useServerFiles = walk("src").filter((f) => /^\s*["']use server["']/.test(read(f).slice(0, 300)));

type Fn = { file: string; name: string; params: string; body: string; key: string };
function exportedFunctions(file: string): Fn[] {
  const text = read(file);
  return text
    .split(/\n(?=export async function )/)
    .slice(1)
    .map((p) => {
      const m = /^export async function (\w+)\s*\(([^)]*)\)/.exec(p)!;
      return { file, name: m[1], params: m[2].replace(/\s+/g, " "), body: p, key: `${file.replace("src/server/", "")}: ${m[1]}` };
    });
}
const all = useServerFiles.flatMap(exportedFunctions);

// What counts as an authorization step: the signed-in account is read and checked, a role / permission / visibility helper is applied, or an unguessable per-record token is required.
const AUTH = /getCurrentAccount|assert[A-Z]\w*\(|authorize[A-Z]\w*\(|require[A-Z]\w*\(|currentAccount|canView\w*\(|can[A-Z]\w*\(|checkPublicRateLimit|getEmailViewer|stepUp|verifyGoogle|establishSession/;
function hasAuthMarker(fn: Fn): boolean {
  if (AUTH.test(fn.body)) return true;
  const text = read(fn.file);
  for (const callee of new Set([...fn.body.matchAll(/\b([A-Za-z_]\w*)\(/g)].map((m) => m[1]))) {
    const body = new RegExp(`(?:async )?function ${callee}\\b[\\s\\S]*?\\n}\\n`).exec(text)?.[0];
    if (body && AUTH.test(body)) return true;
  }
  return false;
}

/** PUBLIC BY DESIGN: callable without a CRM sign-in, each with the reason it is acceptable. Adding a line here is a security decision: say why. */
const PUBLIC_BY_DESIGN: Record<string, string> = {
  "actions/dev-session.ts: signOut": "acts only on the caller's OWN session cookie (clears it and revokes that one session)",
  "actions/booking.ts: trackQuoteView": "the customer's secure quote page: the unguessable per-quote token IS the credential; it only advances that quote's own status",
  "actions/booking.ts: trackViewDealClicked": "same: token-gated, only that quote's own status",
  "actions/booking.ts: trackBookingFormStarted": "same: token-gated, one activity row on that quote",
  "queries/reference-data.ts: searchAirports": "PUBLIC reference data (the customer booking form uses it); results capped at 20, search text capped",
  "queries/reference-data.ts: searchAirlines": "public airport / airline / aircraft reference data, bounded exactly like searchAirports / resolveAirportCodes",
  "queries/reference-data.ts: searchAircraft": "public airport / airline / aircraft reference data, bounded exactly like searchAirports / resolveAirportCodes",
  "queries/reference-data.ts: resolveAirportCodes": "same (code list capped at 500)",
  "queries/reference-data.ts: resolveAirlineCodes": "public airport / airline / aircraft reference data, bounded exactly like searchAirports / resolveAirportCodes",
  "queries/reference-data.ts: resolveAircraftCodes": "public airport / airline / aircraft reference data, bounded exactly like searchAirports / resolveAirportCodes",
  "actions/lead-queue-actions.ts: joinLeadQueue": "thin delegate; the implementation in lead-queue.ts reads and checks the signed-in account (asserted below)",
  "actions/lead-queue-actions.ts: leaveLeadQueue": "thin delegate; the implementation in lead-queue.ts checks the signed-in account (asserted below)",
  "actions/lead-queue-actions.ts: getMyLeadOffer": "thin delegate; the implementation in lead-queue.ts checks the signed-in account (asserted below)",
  "actions/lead-queue-actions.ts: acceptLeadOffer": "thin delegate; the implementation in lead-queue.ts checks the signed-in account (asserted below)",
  "actions/lead-queue-actions.ts: skipLeadOffer": "thin delegate; the implementation in lead-queue.ts checks the signed-in account (asserted below)",
  // The two staff lists receive a companyId from the caller, but enforce the session themselves (asserted below), so they are not trusting helpers.
  "queries/reference-data.ts: listLeadEligibleAgents": "enforces the signed-in account and the caller's own company inside (asserted below)",
  "queries/reference-data.ts: listTaskEligibleAgents": "enforces the signed-in account and the caller's own company inside (asserted below)",
};

describe("the surface is what we expect", () => {
  it("finds the \"use server\" files (a vacuous test would pass on an empty list)", () => {
    expect(useServerFiles.length).toBeGreaterThan(30);
    expect(all.length).toBeGreaterThan(150);
  });

  it("every exported function of every \"use server\" file authorizes its caller, or is listed as public by design", () => {
    const unexplained = all.filter((f) => !hasAuthMarker(f) && !(f.key in PUBLIC_BY_DESIGN)).map((f) => f.key);
    expect(unexplained, `Unauthenticated Server Actions: add an authorization step, or list them in PUBLIC_BY_DESIGN with the reason:\n${unexplained.join("\n")}`).toEqual([]);
  });

  it("the allow-list has no stale entries (every listed function still exists), so it cannot silently grow into a hiding place", () => {
    const keys = new Set(all.map((f) => f.key));
    expect(Object.keys(PUBLIC_BY_DESIGN).filter((k) => !keys.has(k))).toEqual([]);
    for (const reason of Object.values(PUBLIC_BY_DESIGN)) expect(reason.length).toBeGreaterThan(8);
  });
});

describe("no action trusts a tenant or identity the CALLER supplies", () => {
  const trusting = all.filter((f) => /\b(companyId|userId|actorId)\b/.test(f.params));

  it("only the two staff lists take a companyId, and they bind it to the signed-in account inside", () => {
    expect(trusting.map((f) => f.key).sort()).toEqual(["queries/reference-data.ts: listLeadEligibleAgents", "queries/reference-data.ts: listTaskEligibleAgents"]);
    const text = read("src/server/queries/reference-data.ts");
    const scope = /async function staffListScope[\s\S]*?\n}\n/.exec(text)![0];
    expect(scope).toContain("getCurrentAccount");
    expect(scope).toMatch(/actor\.companyId !== companyId/); // another company's id is refused
    expect(scope).toMatch(/actor\.role === "ADMIN"/); // hidden accounts: Administrator only
    for (const name of ["listLeadEligibleAgents", "listTaskEligibleAgents"]) {
      const body = all.find((f) => f.key === `queries/reference-data.ts: ${name}`)!.body;
      expect(body, name).toContain("staffListScope(companyId, opts)");
      expect(body.indexOf("staffListScope"), name).toBeLessThan(body.indexOf("prisma.account.findMany")); // the check comes BEFORE any read
    }
  });

  it("every action that takes an accountId (the Users page controls) is Administrator-only AND checks that the target is in the caller's company", () => {
    const withAccountId = all.filter((f) => /\baccountId\b/.test(f.params));
    expect(withAccountId.length).toBeGreaterThanOrEqual(7);
    for (const f of withAccountId) {
      expect(f.body, `${f.key} must call assertAdmin`).toMatch(/assertAdmin\(\)/);
      expect(f.body, `${f.key} must check the target's company`).toMatch(/assertSameCompany|companyId !== current|\.companyId !== /);
    }
  });
});

describe("the lead queue wrappers delegate to implementations that check the signed-in account", () => {
  it("each of the five implementations reads the current account first", () => {
    const text = read("src/server/actions/lead-queue.ts");
    for (const name of ["joinLeadQueue", "leaveLeadQueue", "getMyLeadOffer", "acceptLeadOffer", "skipLeadOffer"]) {
      const body = new RegExp(`export async function ${name}\\b[\\s\\S]*?\\n}\\n`).exec(text)![0];
      expect(body.slice(0, 600), name).toContain("getCurrentAccount");
    }
  });
});

describe("the public reference lookups are bounded", () => {
  it("search text and code lists are capped, and results are limited", () => {
    const text = read("src/server/queries/reference-data.ts");
    expect(text).toMatch(/const MAX_QUERY_LENGTH = 100/);
    expect(text).toMatch(/const MAX_CODES_PER_CALL = 500/);
    expect((text.match(/query\.trim\(\)\.slice\(0, MAX_QUERY_LENGTH\)/g) ?? []).length).toBe(3);
    expect((text.match(/\.slice\(0, MAX_CODES_PER_CALL\)/g) ?? []).length).toBe(3);
  });
});

// ── the REAL registration, from the last production build ──
// Reads .next/server/server-reference-manifest.json (written by `next build`). It exists locally after a build and not in the unit job; when it is missing the three tests below are
// SKIPPED and reported as skipped - they are never counted as a pass.
const manifestPath = path.join(root, ".next", "server", "server-reference-manifest.json");
const hasManifest = fs.existsSync(manifestPath);
const registered = hasManifest ? Object.values((JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { node?: Record<string, unknown> }).node ?? {}).map((v) => JSON.stringify(v)) : [];
const isRegistered = (name: string) => registered.some((s) => s.includes(`"${name}"`) || s.includes(name));

describe.skipIf(!hasManifest)("registered Server Actions in the last production build", () => {
  it("the internal lead distribution engine is NOT registered (it was, until 2026-11-22)", () => {
    expect(isRegistered("distributeNewWebsiteLead")).toBe(false);
    expect(isRegistered("distributePendingWebsiteLeads")).toBe(false);
  });

  it("the five signed-in-user queue actions are still registered", () => {
    for (const name of ["joinLeadQueue", "leaveLeadQueue", "getMyLeadOffer", "acceptLeadOffer", "skipLeadOffer"]) expect(isRegistered(name), name).toBe(true);
  });

  it("every function that is registered is one this guard reviews (nothing callable appeared that the rules above did not see)", () => {
    const declared = new Set(all.map((f) => f.name));
    const registeredNames = [...new Set(registered.flatMap((s) => [...s.matchAll(/"exportedName":"(\w+)"/g)].map((m) => m[1])))];
    if (registeredNames.length === 0) return; // this Next version records no export names: the name-level checks above are what protect us
    expect(registeredNames.filter((n) => !declared.has(n))).toEqual([]);
  });
});
