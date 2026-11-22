import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Every async export of a "use server" file is a publicly callable Server
// Action. A helper that trusts its caller (no visibility / ownership check)
// therefore must not live in one — otherwise anyone, including a Manager
// reaching outside their own team, could call it with a record id.

const read = (...p: string[]) => readFileSync(path.join(process.cwd(), ...p), "utf-8");

describe("trusting helpers are not exposed as Server Actions", () => {
  it("applyLeadStatusChange (no visibility check by design) lives in a plain server module, not in a 'use server' file", () => {
    expect(read("src", "server", "actions", "leads.ts")).not.toMatch(/export\s+async\s+function\s+applyLeadStatusChange/);
    const mod = read("src", "server", "lead-status-change.ts");
    expect(mod).toMatch(/export\s+async\s+function\s+applyLeadStatusChange/);
    expect(mod).not.toMatch(/^["']use server["']/m);
  });

  it("the public updateLeadStatus action still checks the caller's row-level scope before using it", () => {
    const src = read("src", "server", "actions", "leads.ts");
    const body = src.slice(src.indexOf("export async function updateLeadStatus"), src.indexOf("const updatableLeadFields"));
    expect(body).toContain("leadVisibilityWhere");
  });

  it("sendQuote imports the helper from the plain module", () => {
    expect(read("src", "server", "actions", "quotes.ts")).toContain('from "@/server/lead-status-change"');
  });
});

describe("the lead distribution engine is not exposed as Server Actions", () => {
  const engine = () => read("src", "server", "actions", "lead-queue.ts");
  const actions = () => read("src", "server", "actions", "lead-queue-actions.ts");

  it("lead-queue.ts (which holds distributeNewWebsiteLead / distributePendingWebsiteLeads - no signed-in caller, trusts its caller) carries no 'use server' directive", () => {
    expect(engine()).not.toMatch(/^\s*["']use server["']/m);
    expect(engine()).toMatch(/export\s+async\s+function\s+distributeNewWebsiteLead/);
    expect(engine()).toMatch(/export\s+async\s+function\s+distributePendingWebsiteLeads/);
  });

  it("the only Server Actions of the queue are the five a signed-in person's browser may call, as thin delegates", () => {
    const src = actions();
    expect(src).toMatch(/^\s*["']use server["']/m);
    const exported = [...src.matchAll(/export\s+async\s+function\s+(\w+)/g)].map((m) => m[1]).sort();
    expect(exported).toEqual(["acceptLeadOffer", "getMyLeadOffer", "joinLeadQueue", "leaveLeadQueue", "skipLeadOffer"]);
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"); // the explanatory comment may name them; the code must not
    expect(code).not.toMatch(/distributeNewWebsiteLead|distributePendingWebsiteLeads/);
    expect(code).not.toMatch(/\bexport\s+(?!async\s+function)/); // nothing but async functions is exported from a "use server" file
  });

  it("no browser-side file imports the engine module: client components use the action wrappers", () => {
    for (const rel of ["components/layout/lead-acceptance-card.tsx", "components/layout/lead-offer-modal.tsx", "components/layout/lead-queue-toggle.tsx"]) {
      const src = read("src", ...rel.split("/"));
      expect(src, rel).toContain("@/server/actions/lead-queue-actions");
      expect(src, rel).not.toMatch(/from\s+["']@\/server\/actions\/lead-queue["']/);
    }
  });

  it("the server-side callers (cron route, lead intake, lead creation) still call the engine directly, so every internal path and every test mock of it is unchanged", () => {
    expect(read("src", "app", "api", "cron", "leads", "route.ts")).toMatch(/from\s+["']@\/server\/actions\/lead-queue["']/);
    expect(read("src", "server", "lead-intake.ts")).toMatch(/from\s+["']@\/server\/actions\/lead-queue["']/);
    expect(read("src", "server", "actions", "leads.ts")).toMatch(/from\s+["']@\/server\/actions\/lead-queue["']/);
  });

  it("the cron route that runs the engine without a user stays behind the cron secret", () => {
    expect(read("src", "app", "api", "cron", "leads", "route.ts")).toMatch(/rejectUnauthorizedCron/);
  });
});
