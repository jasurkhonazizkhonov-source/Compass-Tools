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
