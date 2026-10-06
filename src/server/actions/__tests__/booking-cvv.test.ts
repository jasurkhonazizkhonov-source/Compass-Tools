import { describe, it, expect, vi, beforeEach } from "vitest";

// The Admin-only reveal / destroy of a booking card's retained security code — authorization order and fail-closed behaviour
// against fakes (the same flows against a real database are in booking-cvv.integration.test.ts). SYNTHETIC code only.
const CODE = "482";

type Actor = { id: string; role: string; status: string; companyId: string; paymentPermissions: string[]; sessionCreatedAt: Date | null };
let actor: Actor | null;
const calls: string[] = [];

const prismaMock = {
  booking: { findFirst: vi.fn<(a: unknown) => Promise<{ id: string } | null>>(async () => { calls.push("booking"); return { id: "b1" }; }) },
  paymentMethod: { findFirst: vi.fn<(a: unknown) => Promise<{ id: string } | null>>(async () => { calls.push("card"); return { id: "pm1" }; }) },
  paymentMethodCvv: {
    findUnique: vi.fn<(a: unknown) => Promise<Record<string, unknown> | null>>(async () => { calls.push("record"); return { paymentMethodId: "pm1", encryptedCvv: "cv2.v1.ciphertextciphertextcipher", expiresAt: new Date(Date.now() + 3_600_000), destroyedAt: null }; }),
    deleteMany: vi.fn<(a: unknown) => Promise<{ count: number }>>(async () => ({ count: 1 })),
  },
};
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => actor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), isProductionEnvironment: () => true }));
const rate = vi.fn<(...a: unknown[]) => Promise<{ allowed: boolean; retryAfterSeconds?: number }>>(async () => { calls.push("rate"); return { allowed: true }; });
vi.mock("@/server/security/rate-limit", () => ({ checkAccountRateLimit: (...a: unknown[]) => rate(...a), RATE_LIMITS: { CVV_REVEAL: { windowMs: 600000, maxAttempts: 10 } } }));
const audit = vi.fn<(p: unknown) => Promise<void>>(async () => {});
vi.mock("@/server/security/card-audit", () => ({ auditCardEvent: (p: unknown) => audit(p) }));
const reveal = vi.fn<(...a: unknown[]) => Promise<string>>(async () => { calls.push("decrypt"); return CODE; });
vi.mock("@/server/security/payment-vault", () => ({ getCvvVault: () => ({ reveal: (...a: unknown[]) => reveal(...a), store: vi.fn() }) }));
const destroyCvv = vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true);
vi.mock("@/server/security/booking-cvv", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/security/booking-cvv")>()), destroyCvv: (...a: unknown[]) => destroyCvv(...a) }));

const admin = (over: Partial<Actor> = {}): Actor => ({ id: "admin-1", role: "ADMIN", status: "ACTIVE", companyId: "c1", paymentPermissions: ["payments.reveal"], sessionCreatedAt: new Date(Date.now() - 60_000), ...over });

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  actor = admin();
  prismaMock.booking.findFirst.mockImplementation(async () => { calls.push("booking"); return { id: "b1" }; });
  prismaMock.paymentMethod.findFirst.mockImplementation(async () => { calls.push("card"); return { id: "pm1" }; });
  prismaMock.paymentMethodCvv.findUnique.mockImplementation(async () => { calls.push("record"); return { paymentMethodId: "pm1", encryptedCvv: "cv2.v1.ciphertextciphertextcipher", expiresAt: new Date(Date.now() + 3_600_000), destroyedAt: null }; });
  rate.mockImplementation(async () => { calls.push("rate"); return { allowed: true }; });
  reveal.mockImplementation(async () => { calls.push("decrypt"); return CODE; });
});

const lastAuditReasons = () => audit.mock.calls.map((c) => (c[0] as { reason?: string }).reason);

describe("revealBookingCvv — who may reveal", () => {
  it("an Admin with the payments.reveal grant, a recent sign-in, an accessible booking and a live record receives the code, audited without it", async () => {
    const { revealBookingCvv } = await import("../booking-cvv");
    expect(await revealBookingCvv("b1", "pm1")).toEqual({ cvv: CODE });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "CVV_REVEALED", entityId: "pm1", success: true }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain(CODE);
    expect(JSON.stringify(audit.mock.calls)).not.toContain("cv2.");
  });

  it.each(["MANAGER", "TICKETING_AGENT", "TRAVEL_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"])("%s is refused even when holding the card-reveal grant — and nothing is decrypted or even looked up", async (role) => {
    actor = admin({ role });
    const { revealBookingCvv } = await import("../booking-cvv");
    await expect(revealBookingCvv("b1", "pm1")).rejects.toThrow("not authorized");
    expect(reveal).not.toHaveBeenCalled();
    expect(prismaMock.paymentMethodCvv.findUnique).not.toHaveBeenCalled();
    expect(rate).not.toHaveBeenCalled(); // an unauthorized role cannot even spend someone's rate budget
    expect(lastAuditReasons()).toContain("NOT_ADMIN");
  });

  it("an Admin without the explicit grant, with no session or inactive is refused", async () => {
    const { revealBookingCvv } = await import("../booking-cvv");
    actor = admin({ paymentPermissions: [] });
    await expect(revealBookingCvv("b1", "pm1")).rejects.toThrow("not authorized");
    actor = null;
    await expect(revealBookingCvv("b1", "pm1")).rejects.toThrow("not authorized");
    actor = admin({ status: "INACTIVE" });
    await expect(revealBookingCvv("b1", "pm1")).rejects.toThrow("not authorized");
    expect(reveal).not.toHaveBeenCalled();
    expect(lastAuditReasons()).toEqual(expect.arrayContaining(["MISSING_PERMISSION", "NO_ACTIVE_SESSION"]));
  });
});

describe("revealBookingCvv — order of the checks (everything is decided BEFORE any decryption)", () => {
  it("authorization → rate limit → booking scope → card on that booking → sign-in → record → decrypt", async () => {
    const { revealBookingCvv } = await import("../booking-cvv");
    await revealBookingCvv("b1", "pm1");
    expect(calls).toEqual(["rate", "booking", "card", "record", "decrypt"]);
  });

  it("the rate limit is keyed by the ACCOUNT (not the booking) in its own CVV_REVEAL bucket, and a limited attempt is audited and never decrypts", async () => {
    const { revealBookingCvv } = await import("../booking-cvv");
    await revealBookingCvv("b1", "pm1");
    expect(rate).toHaveBeenCalledWith("admin-1", "CVV_REVEAL", expect.objectContaining({ maxAttempts: 10 }));
    rate.mockImplementationOnce(async () => ({ allowed: false, retryAfterSeconds: 300 }));
    reveal.mockClear();
    const r = await revealBookingCvv("b2", "pm9");
    expect(r).toEqual({ error: expect.stringMatching(/Too many attempts/) });
    expect(reveal).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "CVV_REVEAL_RATE_LIMITED" }));
  });

  it("another company / an inaccessible booking, or a card that is not on THAT booking, is refused without touching the record", async () => {
    const { revealBookingCvv } = await import("../booking-cvv");
    prismaMock.booking.findFirst.mockImplementationOnce(async () => null);
    await expect(revealBookingCvv("other-company-booking", "pm1")).rejects.toThrow("not authorized");
    prismaMock.paymentMethod.findFirst.mockImplementationOnce(async () => null);
    await expect(revealBookingCvv("b1", "someone-elses-card")).rejects.toThrow("not authorized");
    expect(prismaMock.paymentMethodCvv.findUnique).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
    // the booking lookup carries the viewer's company, and the card lookup carries THIS booking's id
    const bookingWhere = (prismaMock.booking.findFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(JSON.stringify(bookingWhere)).toContain("c1");
    const cardWhere = (prismaMock.paymentMethod.findFirst.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(cardWhere).toEqual({ id: "someone-elses-card", bookingId: "b1" });
  });

  it("a sign-in older than 15 minutes is refused with a returned message — and nothing is decrypted", async () => {
    actor = admin({ sessionCreatedAt: new Date(Date.now() - 16 * 60_000) });
    const { revealBookingCvv } = await import("../booking-cvv");
    expect(await revealBookingCvv("b1", "pm1")).toEqual({ error: expect.stringMatching(/sign-in within the last 15 minutes/) });
    expect(reveal).not.toHaveBeenCalled();
  });
});

describe("revealBookingCvv — a record that is gone, destroyed or expired is never decrypted", () => {
  it("no record / destroyed record → 'no longer available'", async () => {
    const { revealBookingCvv } = await import("../booking-cvv");
    prismaMock.paymentMethodCvv.findUnique.mockImplementationOnce(async () => null);
    expect(await revealBookingCvv("b1", "pm1")).toEqual({ error: "CVV/CVC is no longer available." });
    prismaMock.paymentMethodCvv.findUnique.mockImplementationOnce(async () => ({ paymentMethodId: "pm1", encryptedCvv: null, expiresAt: new Date(Date.now() + 1000), destroyedAt: new Date() }));
    expect(await revealBookingCvv("b1", "pm1")).toEqual({ error: "CVV/CVC is no longer available." });
    expect(reveal).not.toHaveBeenCalled();
  });

  it("at or after expiresAt: refused with the retention message and the stale record is deleted on the spot", async () => {
    const { revealBookingCvv } = await import("../booking-cvv");
    for (const delta of [0, 1, 60_000, 30 * 3_600_000]) {
      prismaMock.paymentMethodCvv.deleteMany.mockClear();
      prismaMock.paymentMethodCvv.findUnique.mockImplementationOnce(async () => ({ paymentMethodId: "pm1", encryptedCvv: "cv2.v1.ciphertextciphertextcipher", expiresAt: new Date(Date.now() - delta), destroyedAt: null }));
      expect(await revealBookingCvv("b1", "pm1"), String(delta)).toEqual({ error: "CVV/CVC is no longer available because the 24-hour retention period has expired." });
      expect(prismaMock.paymentMethodCvv.deleteMany).toHaveBeenCalledTimes(1);
    }
    expect(reveal).not.toHaveBeenCalled();
  });

  it("revealing writes nothing to the record: no update of any kind, so the expiry cannot move", async () => {
    const { revealBookingCvv } = await import("../booking-cvv");
    await revealBookingCvv("b1", "pm1");
    expect(Object.keys(prismaMock.paymentMethodCvv)).toEqual(["findUnique", "deleteMany"]); // no update / updateMany / upsert exist on the fake, so any would have thrown
    expect(destroyCvv).not.toHaveBeenCalled(); // and revealing destroys nothing
  });

  it("a decrypt failure is a returned message with a fixed code in the audit trail — no ciphertext, no value", async () => {
    const { revealBookingCvv } = await import("../booking-cvv");
    const { CardVaultError } = await import("@/server/security/card-encryption");
    reveal.mockImplementationOnce(async () => { throw new CardVaultError("AUTH_FAILED"); });
    expect(await revealBookingCvv("b1", "pm1")).toEqual({ error: expect.stringMatching(/could not be decrypted/) });
    expect(lastAuditReasons()).toContain("DECRYPT_AUTH_FAILED");
    expect(JSON.stringify(audit.mock.calls)).not.toContain("cv2.");
  });
});

describe("destroyBookingCvv", () => {
  it("Admin only, same booking scope; destroys that card's record and nothing else", async () => {
    const { destroyBookingCvv } = await import("../booking-cvv");
    expect(await destroyBookingCvv("b1", "pm1")).toEqual({ destroyed: true });
    expect(destroyCvv).toHaveBeenCalledWith("pm1", "ADMIN_DESTROYED", "admin-1");
    for (const role of ["MANAGER", "TICKETING_AGENT", "TRAVEL_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"]) {
      actor = admin({ role });
      await expect(destroyBookingCvv("b1", "pm1"), role).rejects.toThrow("not authorized");
    }
    actor = null;
    await expect(destroyBookingCvv("b1", "pm1")).rejects.toThrow("not authorized");
    prismaMock.booking.findFirst.mockImplementationOnce(async () => null);
    actor = admin();
    await expect(destroyBookingCvv("other", "pm1")).rejects.toThrow("not authorized");
    expect(destroyCvv).toHaveBeenCalledTimes(1);
  });
});
