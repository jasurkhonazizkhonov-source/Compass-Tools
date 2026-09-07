import { describe, it, expect, vi, beforeEach } from "vitest";

// quote-status.ts's DB surface is narrow enough to fake in-memory rather
// than hitting a real database — this exercises the actual guard logic
// (rank checks, the direct Booking.status -> Quote.status mapping) against
// controlled state, including the regression scenario the CHARGED-status
// work was meant to close: a later unrelated booking edit must never
// silently downgrade an already-CHARGED quote back to BOOKED.

type FakeQuote = {
  id: string;
  status: string;
  leadId: string;
  contactId: string;
  agentId: string | null;
  quoteNumber: string;
  contact: { firstName: string; lastName: string };
};
type FakeBooking = {
  id: string;
  quoteId: string;
  status: string;
};

let quotes: Map<string, FakeQuote>;
let bookings: Map<string, FakeBooking>;
let quoteStatusHistory: Record<string, unknown>[];

vi.mock("@/lib/dev-session", () => ({
  getCurrentAccount: vi.fn(async () => ({ id: "actor-1", fullName: "Test Actor", role: "ADMIN" })),
}));

vi.mock("@/server/activity-log", () => ({
  logActivity: vi.fn(async () => undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeClient: any = {
  quote: {
    findUniqueOrThrow: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
      const q = quotes.get(id);
      if (!q) throw new Error(`quote ${id} not found`);
      // A snapshot, not the live Map entry — a real DB read wouldn't
      // retroactively change when the row is updated later in the same
      // call.
      return { ...q };
    }),
    update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const q = quotes.get(id)!;
      if (typeof data.status === "string") q.status = data.status;
      return q;
    }),
  },
  booking: {
    findUnique: vi.fn(async ({ where: { id } }: { where: { id: string } }) => {
      const b = bookings.get(id);
      return b ? { ...b } : null;
    }),
  },
  quoteStatusHistory: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      quoteStatusHistory.push(data);
      return data;
    }),
  },
  notification: {
    create: vi.fn(async () => ({})),
  },
};
// Interactive-transaction form: runs the callback against the same fake
// client (there's nothing to actually roll back in-memory, but this is
// enough to exercise transitionQuoteStatus's "write inside whichever db
// handle it's given" logic identically to a real Prisma transaction).
fakeClient.$transaction = vi.fn(async (fn: (tx: typeof fakeClient) => unknown) => fn(fakeClient));

vi.mock("@/lib/prisma", () => ({ prisma: fakeClient }));

function seedQuote(overrides: Partial<FakeQuote>): FakeQuote {
  const q: FakeQuote = {
    id: "quote-1",
    status: "SIGNED",
    leadId: "lead-1",
    contactId: "contact-1",
    agentId: null,
    quoteNumber: "Q-0001",
    contact: { firstName: "Dark", lastName: "Master" },
    ...overrides,
  };
  quotes.set(q.id, q);
  return q;
}

function seedBooking(overrides: Partial<FakeBooking>): FakeBooking {
  const b: FakeBooking = {
    id: "booking-1",
    quoteId: "quote-1",
    status: "PENDING_TICKETING",
    ...overrides,
  };
  bookings.set(b.id, b);
  return b;
}

beforeEach(() => {
  quotes = new Map();
  bookings = new Map();
  quoteStatusHistory = [];
  vi.clearAllMocks();
});

describe("reconcileQuoteStatus — direct Booking.status -> Quote.status mapping", () => {
  it("TICKETED drives the Quote to BOOKED", async () => {
    const { reconcileQuoteStatus } = await import("../quote-status");
    seedQuote({ status: "SIGNED" });
    seedBooking({ status: "TICKETED" });

    await reconcileQuoteStatus("booking-1");

    expect(quotes.get("quote-1")!.status).toBe("BOOKED");
    expect(quoteStatusHistory).toContainEqual(expect.objectContaining({ fromStatus: "SIGNED", toStatus: "BOOKED" }));
  });

  it("CONFIRMED drives the Quote to CHARGED, even skipping BOOKED entirely", async () => {
    const { reconcileQuoteStatus } = await import("../quote-status");
    seedQuote({ status: "SIGNED" });
    seedBooking({ status: "CONFIRMED" });

    await reconcileQuoteStatus("booking-1");

    expect(quotes.get("quote-1")!.status).toBe("CHARGED");
  });

  it("PENDING_TICKETING leaves the Quote unchanged (stays SIGNED)", async () => {
    const { reconcileQuoteStatus } = await import("../quote-status");
    seedQuote({ status: "SIGNED" });
    seedBooking({ status: "PENDING_TICKETING" });

    await reconcileQuoteStatus("booking-1");

    expect(quotes.get("quote-1")!.status).toBe("SIGNED");
    expect(quoteStatusHistory).toHaveLength(0);
  });

  it("CANCELED leaves the Quote unchanged (stays SIGNED) — for now, per product decision", async () => {
    const { reconcileQuoteStatus } = await import("../quote-status");
    seedQuote({ status: "SIGNED" });
    seedBooking({ status: "CANCELED" });

    await reconcileQuoteStatus("booking-1");

    expect(quotes.get("quote-1")!.status).toBe("SIGNED");
    expect(quoteStatusHistory).toHaveLength(0);
  });

  it("never trusts customer name/email — uses the real Booking.quoteId relationship", async () => {
    const { reconcileQuoteStatus } = await import("../quote-status");
    // Two quotes for what would be the "same customer" in spirit — only the
    // one actually linked via Booking.quoteId may ever be touched.
    seedQuote({ id: "quote-1", status: "SIGNED" });
    seedQuote({ id: "quote-2", status: "SIGNED" });
    seedBooking({ id: "booking-1", quoteId: "quote-2", status: "TICKETED" });

    await reconcileQuoteStatus("booking-1");

    expect(quotes.get("quote-2")!.status).toBe("BOOKED");
    expect(quotes.get("quote-1")!.status).toBe("SIGNED");
  });

  it("regression: a later unrelated booking edit (still TICKETED) never downgrades an already-CHARGED quote", async () => {
    const { reconcileQuoteStatus } = await import("../quote-status");
    seedQuote({ status: "CHARGED" });
    seedBooking({ status: "TICKETED" });

    await reconcileQuoteStatus("booking-1");

    // Before the fix, this would have re-transitioned CHARGED -> BOOKED.
    expect(quotes.get("quote-1")!.status).toBe("CHARGED");
  });

  it("is a no-op for a booking that does not exist", async () => {
    const { reconcileQuoteStatus } = await import("../quote-status");
    const result = await reconcileQuoteStatus("does-not-exist");
    expect(result.transitioned).toBe(false);
    await expect(result.fireSideEffects()).resolves.toBeUndefined();
  });

  it("real bug regression: when called with a tx, side effects (activity log) do NOT fire until fireSideEffects() is invoked — never as extra round-trips while an outer transaction is still open", async () => {
    const { logActivity } = await import("@/server/activity-log");
    const { reconcileQuoteStatus } = await import("../quote-status");
    seedQuote({ status: "SIGNED" });
    seedBooking({ status: "TICKETED" });

    const result = await fakeClient.$transaction(async (tx: typeof fakeClient) => reconcileQuoteStatus("booking-1", tx));

    // The atomic write already happened...
    expect(quotes.get("quote-1")!.status).toBe("BOOKED");
    // ...but the side effect must not have fired yet.
    expect(logActivity).not.toHaveBeenCalled();

    await result.fireSideEffects();
    expect(logActivity).toHaveBeenCalledTimes(1);

    // Calling it again must be a safe no-op, not a duplicate side effect.
    await result.fireSideEffects();
    expect(logActivity).toHaveBeenCalledTimes(1);
  });
});

describe("transitionQuoteStatus — monotonic rank guard", () => {
  it("refuses to move a CHARGED quote backward to BOOKED", async () => {
    const { transitionQuoteStatus } = await import("../quote-status");
    seedQuote({ status: "CHARGED" });

    await transitionQuoteStatus("quote-1", "BOOKED");

    expect(quotes.get("quote-1")!.status).toBe("CHARGED");
    expect(quoteStatusHistory).toHaveLength(0);
  });

  it("still allows a genuine forward transition", async () => {
    const { transitionQuoteStatus } = await import("../quote-status");
    seedQuote({ status: "SIGNED" });

    await transitionQuoteStatus("quote-1", "BOOKED");

    expect(quotes.get("quote-1")!.status).toBe("BOOKED");
    expect(quoteStatusHistory).toContainEqual(expect.objectContaining({ fromStatus: "SIGNED", toStatus: "BOOKED" }));
  });

  it("always allows CANCELED regardless of current rank", async () => {
    const { transitionQuoteStatus } = await import("../quote-status");
    seedQuote({ status: "CHARGED" });

    await transitionQuoteStatus("quote-1", "CANCELED");

    expect(quotes.get("quote-1")!.status).toBe("CANCELED");
  });

  it("does not auto-transition a CANCELED quote back onto the progression", async () => {
    const { transitionQuoteStatus } = await import("../quote-status");
    seedQuote({ status: "CANCELED" });

    await transitionQuoteStatus("quote-1", "SENT");

    expect(quotes.get("quote-1")!.status).toBe("CANCELED");
  });
});
