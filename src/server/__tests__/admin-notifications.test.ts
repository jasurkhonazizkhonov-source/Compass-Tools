import { describe, it, expect, vi, beforeEach } from "vitest";

// Pass 27 explicitly flagged this module as only "spot-checked" — no test
// file existed for it at all. Pass 28 §37: fully verify.
//
// notifyNewInquiry / notifyNewSubscriber both notify every ACTIVE account
// in the company whose ROLE has the matching permission
// (canViewGetInTouch/canViewSubscriptions) — never filtered by
// Account.accountsVisible (a directory-display preference, unrelated to
// who counts as an eligible internal-notification recipient), and never
// leaking across companies.

type FakeAccount = { id: string; companyId: string; role: string; status: string; accountsVisible?: boolean };

let accounts: FakeAccount[];
let notificationsCreated: Array<Record<string, unknown>>;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    account: {
      findMany: vi.fn(async ({ where }: { where: { companyId: string; status: string } }) =>
        accounts.filter((a) => a.companyId === where.companyId && a.status === where.status)
      ),
    },
    notification: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        notificationsCreated.push(...data);
        return { count: data.length };
      }),
    },
  },
}));

beforeEach(() => {
  notificationsCreated = [];
  accounts = [
    { id: "admin-1", companyId: "company-1", role: "ADMIN", status: "ACTIVE" },
    { id: "manager-1", companyId: "company-1", role: "MANAGER", status: "ACTIVE" },
    { id: "agent-1", companyId: "company-1", role: "TRAVEL_AGENT", status: "ACTIVE" },
    { id: "marketing-1", companyId: "company-1", role: "MARKETING_AGENT", status: "ACTIVE" },
    { id: "admin-inactive", companyId: "company-1", role: "ADMIN", status: "INACTIVE" },
    { id: "admin-other-company", companyId: "company-2", role: "ADMIN", status: "ACTIVE" },
    // Directory-visibility toggled off — must NOT exclude this account
    // from an internal notification; accountsVisible is a display-only
    // preference for the /accounts page, never an eligibility filter.
    { id: "admin-hidden-from-directory", companyId: "company-1", role: "ADMIN", status: "ACTIVE", accountsVisible: false },
  ];
  vi.clearAllMocks();
});

describe("notifyNewInquiry — Get in Touch admin notification", () => {
  it("notifies every ACTIVE Admin in the company (canViewGetInTouch is Admin-only)", async () => {
    const { notifyNewInquiry } = await import("../admin-notifications");
    await notifyNewInquiry("company-1", "inquiry-1", "Jane Traveler");

    const recipientIds = notificationsCreated.map((n) => n.accountId).sort();
    expect(recipientIds).toEqual(["admin-1", "admin-hidden-from-directory"].sort());
  });

  it("never notifies a Manager, Travel Agent, or Marketing Agent — Get in Touch is Admin-only", async () => {
    const { notifyNewInquiry } = await import("../admin-notifications");
    await notifyNewInquiry("company-1", "inquiry-1", "Jane Traveler");

    const recipientIds = notificationsCreated.map((n) => n.accountId);
    expect(recipientIds).not.toContain("manager-1");
    expect(recipientIds).not.toContain("agent-1");
    expect(recipientIds).not.toContain("marketing-1");
  });

  it("never notifies an INACTIVE account", async () => {
    const { notifyNewInquiry } = await import("../admin-notifications");
    await notifyNewInquiry("company-1", "inquiry-1", "Jane Traveler");
    expect(notificationsCreated.map((n) => n.accountId)).not.toContain("admin-inactive");
  });

  it("never notifies an Admin in a DIFFERENT company — no cross-company leakage", async () => {
    const { notifyNewInquiry } = await import("../admin-notifications");
    await notifyNewInquiry("company-1", "inquiry-1", "Jane Traveler");
    expect(notificationsCreated.map((n) => n.accountId)).not.toContain("admin-other-company");
  });

  it("accountsVisible=false does NOT exclude an otherwise-eligible account from this internal notification", async () => {
    const { notifyNewInquiry } = await import("../admin-notifications");
    await notifyNewInquiry("company-1", "inquiry-1", "Jane Traveler");
    expect(notificationsCreated.map((n) => n.accountId)).toContain("admin-hidden-from-directory");
  });

  it("sets the correct notification type and deep-links to the specific inquiry", async () => {
    const { notifyNewInquiry } = await import("../admin-notifications");
    await notifyNewInquiry("company-1", "inquiry-42", "Jane Traveler");
    expect(notificationsCreated.every((n) => n.type === "NEW_INQUIRY")).toBe(true);
    expect(notificationsCreated.every((n) => n.contactInquiryId === "inquiry-42")).toBe(true);
    expect(notificationsCreated[0].body).toContain("Jane Traveler");
  });

  it("is a silent no-op (never throws) when there are no eligible recipients", async () => {
    accounts = accounts.filter((a) => a.role !== "ADMIN");
    const { notifyNewInquiry } = await import("../admin-notifications");
    await expect(notifyNewInquiry("company-1", "inquiry-1", "Jane Traveler")).resolves.toBeUndefined();
    expect(notificationsCreated).toHaveLength(0);
  });
});

describe("notifyNewSubscriber — Subscriptions admin notification", () => {
  it("notifies every ACTIVE Admin AND Marketing Agent (canViewSubscriptions)", async () => {
    const { notifyNewSubscriber } = await import("../admin-notifications");
    await notifyNewSubscriber("company-1", "customer@example.com");

    const recipientIds = notificationsCreated.map((n) => n.accountId).sort();
    expect(recipientIds).toEqual(["admin-1", "admin-hidden-from-directory", "marketing-1"].sort());
  });

  it("never notifies a Manager or Travel Agent — they have no Subscriptions access", async () => {
    const { notifyNewSubscriber } = await import("../admin-notifications");
    await notifyNewSubscriber("company-1", "customer@example.com");

    const recipientIds = notificationsCreated.map((n) => n.accountId);
    expect(recipientIds).not.toContain("manager-1");
    expect(recipientIds).not.toContain("agent-1");
  });

  it("never notifies across companies or inactive accounts", async () => {
    const { notifyNewSubscriber } = await import("../admin-notifications");
    await notifyNewSubscriber("company-1", "customer@example.com");

    const recipientIds = notificationsCreated.map((n) => n.accountId);
    expect(recipientIds).not.toContain("admin-other-company");
    expect(recipientIds).not.toContain("admin-inactive");
  });

  it("sets the correct notification type and includes the subscriber's email in the body", async () => {
    const { notifyNewSubscriber } = await import("../admin-notifications");
    await notifyNewSubscriber("company-1", "customer@example.com");
    expect(notificationsCreated.every((n) => n.type === "NEW_SUBSCRIBER")).toBe(true);
    expect(notificationsCreated[0].body).toContain("customer@example.com");
    // No per-subscriber detail page exists — never a dangling/incorrect deep-link id.
    expect(notificationsCreated[0].contactInquiryId).toBeUndefined();
  });
});
