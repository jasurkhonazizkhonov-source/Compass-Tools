import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@/generated/prisma/client";

// Real race condition found and fixed (see booking.ts's own comment on
// isVanishedRecordError): trackViewDealClicked and trackBookingFormStarted
// already treated "no quote for this token" as an expected, silent no-op —
// but only at their OWN leading lookup. A Quote is genuinely deletable (an
// Admin deleting its parent Lead/Contact cascades to it too, per
// schema.prisma's onDelete: Cascade), so if that delete lands in the
// narrow window between the leading lookup and the WRITE further down the
// call chain (transitionQuoteStatus, or logActivity's quoteId/leadId/
// contactId foreign keys), the write used to throw a real, uncaught Prisma
// error straight through these customer-facing pages' render — even though
// "the quote is gone" is exactly the same condition the leading check
// already handles, just observed a moment later. These tests prove that
// specific class of failure is now a safe no-op, while a genuinely
// different/unrelated error is still NOT swallowed.

const findUnique = vi.fn();
const activityFindFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    quote: { findUnique: (...args: unknown[]) => findUnique(...args) },
    activity: { findFirst: (...args: unknown[]) => activityFindFirst(...args) },
  },
}));

const transitionQuoteStatus = vi.fn();
vi.mock("@/server/quote-status", () => ({
  transitionQuoteStatus: (...args: unknown[]) => transitionQuoteStatus(...args),
  notifyQuoteActivity: vi.fn(async () => {}),
}));

const logActivity = vi.fn();
vi.mock("@/server/activity-log", () => ({
  logActivity: (...args: unknown[]) => logActivity(...args),
}));

// booking.ts also imports several payment/security modules unrelated to
// either function under test here (submitBooking's own dependencies) —
// stubbed out the same way booking-retry.test.ts already does, so this
// file only pays the import cost of what it actually exercises.
vi.mock("@/server/security/payment-vault", () => ({
  getPaymentVault: vi.fn(() => ({
    store: vi.fn(async (pan: string) => `ENC:${pan}`),
    reveal: vi.fn(async (ref: string) => ref.replace(/^ENC:/, "")),
  })),
}));
vi.mock("@/server/security/cvv-cache", () => ({
  cacheCvv: vi.fn(),
}));
vi.mock("@/server/security/ip-capture", () => ({
  recordIpCapture: vi.fn(async () => {}),
}));
vi.mock("@/server/booking-notification", () => ({
  sendBookingSignedNotification: vi.fn(async () => {}),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Map()),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

function vanishedRecordError(code: "P2025" | "P2003") {
  return new Prisma.PrismaClientKnownRequestError("Record required but not found", { code, clientVersion: "test" });
}

beforeEach(() => {
  vi.clearAllMocks();
  activityFindFirst.mockResolvedValue(null);
});

describe("trackViewDealClicked — quote deleted between the lookup and the status write", () => {
  it("quote exists and is SENT: transitions to VIEWED normally", async () => {
    findUnique.mockResolvedValue({ id: "quote-1", status: "SENT" });
    transitionQuoteStatus.mockResolvedValue(undefined);
    const { trackViewDealClicked } = await import("../booking");

    await expect(trackViewDealClicked("tok-1")).resolves.toBeUndefined();
    expect(transitionQuoteStatus).toHaveBeenCalledWith("quote-1", "VIEWED", expect.any(Object));
  });

  it("quote vanishes (deleted) between the lookup and the write: resolves silently instead of throwing", async () => {
    findUnique.mockResolvedValue({ id: "quote-1", status: "SENT" });
    transitionQuoteStatus.mockRejectedValue(vanishedRecordError("P2025"));
    const { trackViewDealClicked } = await import("../booking");

    await expect(trackViewDealClicked("tok-1")).resolves.toBeUndefined();
  });

  it("a genuinely different error is NOT swallowed", async () => {
    findUnique.mockResolvedValue({ id: "quote-1", status: "SENT" });
    transitionQuoteStatus.mockRejectedValue(new Error("connection terminated"));
    const { trackViewDealClicked } = await import("../booking");

    await expect(trackViewDealClicked("tok-1")).rejects.toThrow("connection terminated");
  });

  it("no quote at all for this token: still a silent no-op (unchanged pre-existing behavior)", async () => {
    findUnique.mockResolvedValue(null);
    const { trackViewDealClicked } = await import("../booking");

    await expect(trackViewDealClicked("tok-1")).resolves.toBeUndefined();
    expect(transitionQuoteStatus).not.toHaveBeenCalled();
  });
});

describe("trackBookingFormStarted — quote vanishes between the lookup and the activity write", () => {
  it("quote exists: logs the activity normally", async () => {
    findUnique.mockResolvedValue({ id: "quote-1", leadId: "lead-1", contactId: "contact-1" });
    logActivity.mockResolvedValue(undefined);
    const { trackBookingFormStarted } = await import("../booking");

    await expect(trackBookingFormStarted("tok-1")).resolves.toBeUndefined();
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ quoteId: "quote-1" }));
  });

  it("quote's lead/contact vanish before the activity write (foreign key violation): resolves silently instead of throwing", async () => {
    findUnique.mockResolvedValue({ id: "quote-1", leadId: "lead-1", contactId: "contact-1" });
    logActivity.mockRejectedValue(vanishedRecordError("P2003"));
    const { trackBookingFormStarted } = await import("../booking");

    await expect(trackBookingFormStarted("tok-1")).resolves.toBeUndefined();
  });

  it("a genuinely different error is NOT swallowed", async () => {
    findUnique.mockResolvedValue({ id: "quote-1", leadId: "lead-1", contactId: "contact-1" });
    logActivity.mockRejectedValue(new Error("connection terminated"));
    const { trackBookingFormStarted } = await import("../booking");

    await expect(trackBookingFormStarted("tok-1")).rejects.toThrow("connection terminated");
  });

  it("already logged once: still a no-op that never calls logActivity again (unchanged pre-existing behavior)", async () => {
    findUnique.mockResolvedValue({ id: "quote-1", leadId: "lead-1", contactId: "contact-1" });
    activityFindFirst.mockResolvedValue({ id: "activity-1" });
    const { trackBookingFormStarted } = await import("../booking");

    await expect(trackBookingFormStarted("tok-1")).resolves.toBeUndefined();
    expect(logActivity).not.toHaveBeenCalled();
  });
});
