import { describe, it, expect, vi, beforeEach } from "vitest";

// loadMoreActivities is a directly callable action: older timeline entries can quote a customer's address ("Primary email updated to ..."), so a viewer who may not
// see complete addresses must get them masked here too, exactly like the first page of the timeline.

let actor: { id: string; role: string; companyId: string };
let unlimited: boolean;
let revealed: boolean;
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => actor) }));
vi.mock("@/server/visibility", () => ({ leadVisibilityWhere: () => ({}), contactVisibilityWhere: () => ({}) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    account: { findUnique: vi.fn(async () => ({ unlimitedCustomerEmailAccess: unlimited })) },
    lead: { findFirst: vi.fn(async () => ({ id: "l1", contactId: "c1" })) },
    contact: { findFirst: vi.fn(async () => ({ id: "c1" })) },
    activity: { findMany: vi.fn(async () => [{ id: "a1", description: "Primary email updated to john.smith@gmail.com", actor: null }]) },
    customerEmailRevealEvent: { findMany: vi.fn(async () => (revealed ? [{ contactId: "c1" }] : [])) },
  },
}));

beforeEach(() => {
  actor = { id: "agent-1", role: "TRAVEL_AGENT", companyId: "co-1" };
  unlimited = false;
  revealed = false;
});

describe("loadMoreActivities - customer email privacy", () => {
  it("masks an address quoted in an activity for a restricted viewer (lead and contact timelines)", async () => {
    const { loadMoreActivities } = await import("../activity");
    for (const params of [{ leadId: "l1", cursor: "x" }, { contactId: "c1", cursor: "x" }]) {
      const r = await loadMoreActivities(params);
      expect(r.activities[0].description).toBe("Primary email updated to j********h@gmail.com");
      expect(JSON.stringify(r)).not.toContain("john.smith@gmail.com");
    }
  });
  it("shows it in full once that customer was revealed today, and always for an Administrator or a user with Unlimited access", async () => {
    const { loadMoreActivities } = await import("../activity");
    revealed = true;
    expect((await loadMoreActivities({ leadId: "l1", cursor: "x" })).activities[0].description).toContain("john.smith@gmail.com");
    revealed = false;
    unlimited = true;
    expect((await loadMoreActivities({ leadId: "l1", cursor: "x" })).activities[0].description).toContain("john.smith@gmail.com");
    unlimited = false;
    actor = { id: "admin", role: "ADMIN", companyId: "co-1" };
    expect((await loadMoreActivities({ contactId: "c1", cursor: "x" })).activities[0].description).toContain("john.smith@gmail.com");
  });
});
