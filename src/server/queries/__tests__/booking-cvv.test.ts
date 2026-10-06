import { describe, it, expect, vi, beforeEach } from "vitest";

// getBookingCvvStates feeds the Admin-only control on the Booking page: existence and expiry only, never the code or ciphertext.
const findFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { booking: { findFirst: (...a: unknown[]) => findFirst(...a) } } }));

const base = { id: "u1", companyId: "c1", status: "ACTIVE", paymentPermissions: ["payments.reveal"] };
const future = new Date(Date.now() + 3_600_000);
const past = new Date(Date.now() - 1000);

beforeEach(() => {
  findFirst.mockReset();
  findFirst.mockResolvedValue({
    paymentMethods: [
      { id: "pm-live", retainedSecurityCode: { expiresAt: future, destroyedAt: null } },
      { id: "pm-destroyed", retainedSecurityCode: { expiresAt: future, destroyedAt: new Date() } },
      { id: "pm-expired", retainedSecurityCode: { expiresAt: past, destroyedAt: null } },
      { id: "pm-none", retainedSecurityCode: null },
    ],
  });
});

describe("getBookingCvvStates", () => {
  it("an Admin with the grant gets existence/expiry per card — and nothing that could be the code", async () => {
    const { getBookingCvvStates } = await import("../booking-cvv");
    const states = await getBookingCvvStates({ ...base, role: "ADMIN" } as never, "b1");
    expect(states).toEqual({
      "pm-live": { available: true, expiresAt: future.toISOString() },
      "pm-destroyed": { available: false },
      "pm-expired": { available: false },
      "pm-none": { available: false },
    });
    expect(JSON.stringify(states)).not.toMatch(/cv2\.|encryptedCvv/);
    // the query selects no ciphertext
    expect(JSON.stringify(findFirst.mock.calls[0][0])).not.toContain("encryptedCvv");
  });

  it.each(["MANAGER", "TICKETING_AGENT", "TRAVEL_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"])("%s gets nothing at all — the database is not even queried", async (role) => {
    const { getBookingCvvStates } = await import("../booking-cvv");
    expect(await getBookingCvvStates({ ...base, role } as never, "b1")).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("an Admin without the grant, a missing viewer or an inactive Admin gets nothing", async () => {
    const { getBookingCvvStates } = await import("../booking-cvv");
    expect(await getBookingCvvStates({ ...base, role: "ADMIN", paymentPermissions: [] } as never, "b1")).toBeNull();
    expect(await getBookingCvvStates(null, "b1")).toBeNull();
    expect(await getBookingCvvStates({ ...base, role: "ADMIN", status: "INACTIVE" } as never, "b1")).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("a booking outside the viewer's company or visibility yields nothing, and the lookup is company-scoped", async () => {
    const { getBookingCvvStates } = await import("../booking-cvv");
    findFirst.mockResolvedValueOnce(null);
    expect(await getBookingCvvStates({ ...base, role: "ADMIN" } as never, "other")).toBeNull();
    expect(JSON.stringify(findFirst.mock.calls[0][0].where)).toContain("c1");
  });
});
