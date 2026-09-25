// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// REAL-DATABASE proof for two quote actions that used to have no server-side
// protection:
//   - updateQuotePricing: no status guard, last write wins.
//   - sendQuote: no dedupe — a double click / retry / two tabs emailed the
//     customer twice.
// Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL
// with this repo's migrations applied (see booking-submit.integration.test.ts).

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) process.env.DATABASE_URL = URL_UNDER_TEST;

type Actor = { id: string; role: string; companyId: string; fullName: string; email: string; phone: string | null; status: string; paymentPermissions: string[] };
let currentActor: Actor | null = null;
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const sendEmailMock = vi.fn<(...args: unknown[]) => Promise<{ ok: true; messageId: string } | { ok: false; error: string }>>();
vi.mock("@/server/email/service", () => ({ sendEmail: (...a: unknown[]) => sendEmailMock(...a) }));

const TAG = `qsp-${Date.now()}`;

describe.skipIf(!enabled)("quote pricing guard and send idempotency — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let actions: typeof import("../quotes");
  let rules: typeof import("@/lib/quote-send-rules");
  let agent: Actor;
  const contactIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    actions = await import("../quotes");
    rules = await import("@/lib/quote-send-rules");
    await prisma.company.upsert({
      where: { id: "default-company" },
      update: {},
      create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" },
    });
    const a = await prisma.account.create({ data: { fullName: "Quote Agent", email: `agent-${TAG}@example.test`, role: "ADMIN", companyId: "default-company" } });
    agent = { id: a.id, role: "ADMIN", companyId: "default-company", fullName: a.fullName, email: a.email, phone: null, status: "ACTIVE", paymentPermissions: [] };
    // Generous: importing the whole server-action graph is slow when the full
    // suite runs many files in parallel.
  }, 60_000);

  afterAll(async () => {
    if (!enabled) return;
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.account.deleteMany({ where: { email: agent?.email ?? `agent-${TAG}@example.test` } });
    await prisma.$disconnect();
  });

  beforeEach(() => {
    currentActor = agent;
    sendEmailMock.mockReset();
    sendEmailMock.mockImplementation(async () => {
      // A little latency so concurrent callers genuinely overlap.
      await new Promise((r) => setTimeout(r, 40));
      return { ok: true, messageId: `m-${Math.random()}` };
    });
  });

  async function makeQuote(status: "DRAFT" | "SENT" | "SIGNED" | "BOOKED" = "DRAFT", emails: string[] = [`c${seq + 1}-${TAG}@example.test`]) {
    const n = ++seq;
    const contact = await prisma.contact.create({
      data: { firstName: "Jane", lastName: `Traveler${n}`, primaryEmail: emails[0], companyId: "default-company", emails: { create: emails.map((email, i) => ({ email, isPrimary: i === 0 })) } },
    });
    contactIds.push(contact.id);
    const lead = await prisma.lead.create({ data: { contactId: contact.id, status: "NEW", source: "OTHER" } });
    const quote = await prisma.quote.create({
      data: {
        quoteNumber: `Q-${TAG}-${n}`,
        secureToken: `tok-${TAG}-${n}`,
        leadId: lead.id,
        contactId: contact.id,
        agentId: agent.id,
        status,
        adults: 1,
        adultPrice: 500,
        taxes: 50,
        serviceFee: 20,
        total: 570,
      },
    });
    return quote;
  }

  const pricingPatch = (adultPrice: number) => ({ adults: 1, children: 0, infants: 0, adultPrice, childPrice: 0, infantPrice: 0, taxes: 50, serviceFee: 20, gratuity: 0 });

  describe("updateQuotePricing", () => {
    it("edits a DRAFT quote and recomputes the total", async () => {
      const q = await makeQuote("DRAFT");
      const r = await actions.updateQuotePricing(q.id, pricingPatch(600));
      expect(r.total).toBe(670);
      const row = await prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
      expect(Number(row.adultPrice)).toBe(600);
      expect(Number(row.total)).toBe(670);
    });

    it.each(["SENT", "SIGNED", "BOOKED"] as const)("refuses to change pricing once a quote is %s, and leaves it untouched", async (status) => {
      const q = await makeQuote(status);
      await expect(actions.updateQuotePricing(q.id, pricingPatch(999))).rejects.toThrow(/already been sent/);
      const row = await prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
      expect(Number(row.adultPrice)).toBe(500);
      expect(Number(row.total)).toBe(570);
    });

    it("rejects malformed pricing (negative / fractional passenger counts / NaN) before touching the database", async () => {
      const q = await makeQuote("DRAFT");
      await expect(actions.updateQuotePricing(q.id, { ...pricingPatch(500), adultPrice: -1 })).rejects.toThrow();
      await expect(actions.updateQuotePricing(q.id, { ...pricingPatch(500), adults: 1.5 })).rejects.toThrow();
      await expect(actions.updateQuotePricing(q.id, { ...pricingPatch(500), adultPrice: Number.NaN })).rejects.toThrow();
      await expect(actions.updateQuotePricing(q.id, { ...pricingPatch(500), currency: "EUR" })).rejects.toThrow(/exchange rate/i);
      const row = await prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
      expect(Number(row.total)).toBe(570);
    });

    it("a stale editor (expectedUpdatedAt older than the stored version) is refused instead of overwriting newer data", async () => {
      const q = await makeQuote("DRAFT");
      const loadedVersion = q.updatedAt.toISOString();
      await new Promise((r) => setTimeout(r, 15));
      await actions.updateQuotePricing(q.id, pricingPatch(700)); // someone else saved first
      await expect(actions.updateQuotePricing(q.id, { ...pricingPatch(800), expectedUpdatedAt: loadedVersion })).rejects.toThrow(/changed while you were editing/);
      const row = await prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
      expect(Number(row.adultPrice)).toBe(700);
    });

    it("two editors racing with the same loaded version: exactly one wins, the other is told", async () => {
      const q = await makeQuote("DRAFT");
      const version = q.updatedAt.toISOString();
      const results = await Promise.allSettled([
        actions.updateQuotePricing(q.id, { ...pricingPatch(610), expectedUpdatedAt: version }),
        actions.updateQuotePricing(q.id, { ...pricingPatch(620), expectedUpdatedAt: version }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    });

    it("an edit racing a send can never change the price of a quote that has been sent", async () => {
      const q = await makeQuote("DRAFT");
      const [send, edit] = await Promise.allSettled([actions.sendQuote(q.id), actions.updateQuotePricing(q.id, pricingPatch(900))]);
      const row = await prisma.quote.findUniqueOrThrow({ where: { id: q.id } });
      const snapshot = row.pricingSnapshot as { total?: number } | null;
      if (row.status !== "DRAFT") {
        // The customer was sent a quote: the stored price must be exactly what
        // the frozen snapshot (and therefore the email) said.
        expect(send.status).toBe("fulfilled");
        expect(snapshot).not.toBeNull();
        expect(Number(row.total)).toBe(Number(snapshot!.total));
      } else {
        // The send lost the race and reported so; nothing was left half-done.
        expect(edit.status).toBe("fulfilled");
      }
    });
  });

  describe("sendQuote idempotency", () => {
    it("two concurrent sends of the same quote to the same address email the customer exactly once", async () => {
      const q = await makeQuote("DRAFT");
      const [a, b] = await Promise.all([actions.sendQuote(q.id), actions.sendQuote(q.id)]);
      expect(a.ok && b.ok).toBe(true);
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      expect([a, b].filter((r) => "duplicate" in r && r.duplicate)).toHaveLength(1);
      expect(await prisma.emailLog.count({ where: { quoteId: q.id, type: "QUOTE" } })).toBe(1);
      expect((await prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("SENT");
    });

    it("a burst of ten concurrent identical sends still emails once", async () => {
      const q = await makeQuote("DRAFT");
      const results = await Promise.all(Array.from({ length: 10 }, () => actions.sendQuote(q.id)));
      expect(results.every((r) => r.ok)).toBe(true);
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
    });

    it("sending to two DIFFERENT addresses at once (the multi-recipient picker) sends to both", async () => {
      const q = await makeQuote("DRAFT", [`one-${TAG}@example.test`, `two-${TAG}@example.test`]);
      const results = await Promise.all([actions.sendQuote(q.id, `one-${TAG}@example.test`), actions.sendQuote(q.id, `two-${TAG}@example.test`)]);
      expect(results.every((r) => r.ok && !("duplicate" in r))).toBe(true);
      expect(sendEmailMock).toHaveBeenCalledTimes(2);
      expect(await prisma.emailLog.count({ where: { quoteId: q.id, type: "QUOTE", status: "SENT" } })).toBe(2);
    });

    it("recipient matching is case-insensitive for dedupe (same address, different casing, is one send)", async () => {
      const q = await makeQuote("DRAFT", [`Mixed-${TAG}@Example.test`]);
      await Promise.all([actions.sendQuote(q.id, `mixed-${TAG}@example.test`), actions.sendQuote(q.id, `MIXED-${TAG}@EXAMPLE.TEST`)]);
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
    });

    it("a deliberate LATER resend (after the dedupe window) is allowed", async () => {
      const q = await makeQuote("DRAFT");
      expect((await actions.sendQuote(q.id)).ok).toBe(true);
      // Within the window: swallowed.
      const again = await actions.sendQuote(q.id);
      expect(again.ok && "duplicate" in again && again.duplicate).toBe(true);
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      // Age the claim past the window, as if the agent clicked Resend later.
      await prisma.quoteSendClaim.updateMany({ where: { quoteId: q.id }, data: { claimedAt: new Date(Date.now() - rules.QUOTE_SEND_DEDUPE_WINDOW_MS - 1000) } });
      const resend = await actions.sendQuote(q.id);
      expect(resend.ok && !("duplicate" in resend)).toBe(true);
      expect(sendEmailMock).toHaveBeenCalledTimes(2);
    });

    it("a failed send releases the claim so the agent can retry immediately", async () => {
      const q = await makeQuote("DRAFT");
      sendEmailMock.mockImplementationOnce(async () => ({ ok: false, error: "Gmail is unavailable" }));
      const first = await actions.sendQuote(q.id);
      expect(first).toEqual({ ok: false, error: "Gmail is unavailable" });
      expect((await prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("DRAFT");
      const retry = await actions.sendQuote(q.id);
      expect(retry.ok && !("duplicate" in retry)).toBe(true);
      expect(sendEmailMock).toHaveBeenCalledTimes(2);
    });

    it("a thrown error while building/sending also releases the claim", async () => {
      const q = await makeQuote("DRAFT");
      sendEmailMock.mockImplementationOnce(async () => {
        throw new Error("boom");
      });
      await expect(actions.sendQuote(q.id)).rejects.toThrow("boom");
      expect(await prisma.quoteSendClaim.count({ where: { quoteId: q.id } })).toBe(0);
      expect((await actions.sendQuote(q.id)).ok).toBe(true);
    });

    it.each(["SIGNED", "BOOKED"] as const)("refuses to email a %s quote or rewrite its frozen snapshot", async (status) => {
      const q = await makeQuote(status);
      const r = await actions.sendQuote(q.id);
      expect(r.ok).toBe(false);
      expect(sendEmailMock).not.toHaveBeenCalled();
      expect((await prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).pricingSnapshot).toBeNull();
    });

    it("an already-SENT quote may be deliberately resent (statuses SENT/READ/VIEWED stay sendable)", async () => {
      const q = await makeQuote("SENT");
      expect((await actions.sendQuote(q.id)).ok).toBe(true);
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
    });
  });
});
