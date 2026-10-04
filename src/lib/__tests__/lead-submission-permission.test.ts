import { describe, it, expect } from "vitest";
import { canViewLeadSubmissionInfo, canViewLeads } from "../permissions";

describe("canViewLeadSubmissionInfo", () => {
  it("is exactly the Leads area: every role that can open Leads, and no role that cannot", () => {
    const roles = ["ADMIN", "MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"] as const;
    for (const role of roles) expect(canViewLeadSubmissionInfo(role), role).toBe(canViewLeads(role));
    expect(canViewLeadSubmissionInfo(undefined)).toBe(false);
    expect(canViewLeadSubmissionInfo("MARKETING_AGENT")).toBe(false); // no Leads area → no IP data
  });

  it("is only the role gate — whose lead it is stays the lead-visibility filter's job", () => {
    expect(canViewLeadSubmissionInfo("TRAVEL_AGENT")).toBe(true); // still limited to their own leads by leadVisibilityWhere
  });
});
