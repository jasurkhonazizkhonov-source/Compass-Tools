import { describe, it, expect, vi, beforeEach } from "vitest";

// The staff-facing "Flexible dates" switch (updateLeadField) must never leave the Boolean and the customer's stored choice (0-3 days, or NULL = not stated) contradicting each
// other. In-memory fake Prisma, same convention as the other server-action tests; no database.

type StoredLead = { id: string; assignedAgentId: string | null; flexibleDates: boolean; dateFlexibilityDays: number | null };
let stored: StoredLead;
const updates: Array<Record<string, unknown>> = [];

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => ({ id: "admin-1", fullName: "Admin", email: "admin@example.test", status: "ACTIVE", companyId: "company-1", role: "ADMIN" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("@/server/reassignment-email", () => ({ sendReassignmentEmail: vi.fn(async () => undefined) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lead: {
      findFirst: vi.fn(async () => ({ id: stored.id, assignedAgentId: stored.assignedAgentId, dateFlexibilityDays: stored.dateFlexibilityDays })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        stored = { ...stored, ...(data as Partial<StoredLead>) };
        return { id: stored.id };
      }),
    },
  },
}));

beforeEach(() => {
  updates.length = 0;
  stored = { id: "lead-1", assignedAgentId: null, flexibleDates: false, dateFlexibilityDays: null };
});

async function setFlexible(value: boolean) {
  const { updateLeadField } = await import("../leads");
  await updateLeadField("lead-1", { flexibleDates: value });
}

describe("switching 'Flexible dates' keeps the customer's choice consistent", () => {
  it("OFF while the customer chose 2 days: the Boolean is cleared and the choice becomes exact dates (0)", async () => {
    stored = { ...stored, flexibleDates: true, dateFlexibilityDays: 2 };
    await setFlexible(false);
    expect(stored).toMatchObject({ flexibleDates: false, dateFlexibilityDays: 0 });
  });

  it("ON while the customer chose exact dates: flexible, and the number is no longer claimed (NULL)", async () => {
    stored = { ...stored, flexibleDates: false, dateFlexibilityDays: 0 };
    await setFlexible(true);
    expect(stored).toMatchObject({ flexibleDates: true, dateFlexibilityDays: null });
  });

  it("a lead with no stated choice is left with none: ON and OFF write only the Boolean", async () => {
    await setFlexible(true);
    await setFlexible(false);
    for (const data of updates) expect(data).not.toHaveProperty("dateFlexibilityDays");
    expect(stored.dateFlexibilityDays).toBeNull();
  });

  it("switching ON when the customer already chose 3 days changes nothing but the Boolean", async () => {
    stored = { ...stored, flexibleDates: true, dateFlexibilityDays: 3 };
    await setFlexible(true);
    expect(stored.dateFlexibilityDays).toBe(3);
  });

  it("the staff action cannot write the number directly (it is the customer's choice, not an editable field of this action)", async () => {
    const { updateLeadField } = await import("../leads");
    await updateLeadField("lead-1", { flexibleDates: true, dateFlexibilityDays: 3 } as never);
    for (const data of updates) expect(data).not.toHaveProperty("dateFlexibilityDays");
    expect(stored.dateFlexibilityDays).toBeNull();
  });
});
