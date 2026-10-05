// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof of the customer "Send / Resend Airline Confirmation" email:
//  - every role with the Quotes area (Travel Agent, Ticketing Agent, Manager, Admin, Flight Expert)
//    can load the recipient list and send for a booking it can see — a returned result, never a throw;
//  - a Travel Agent / Manager outside the booking's scope, and a Marketing Agent, are refused (IDOR);
//  - the email is addressed ONLY to the selected customer addresses (chosen from the booking's own
//    verified ones), with NO Cc and NO Bcc — no Manager, Admin or other CRM user is ever copied;
//  - it is sent from the quote's creator, never from whoever clicked.
// Only the Gmail transport is replaced. Runs only when INTEGRATION_DATABASE_URL points at a
// DISPOSABLE PostgreSQL with this repo's migrations applied; removes its own tagged rows afterwards.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
}

type Role = "ADMIN" | "MANAGER" | "TRAVEL_AGENT" | "TICKETING_AGENT" | "FLIGHT_EXPERT" | "MARKETING_AGENT";
type Actor = { id: string; role: Role; companyId: string; fullName: string; email: string; phone: string | null; status: string; paymentPermissions: string[]; bookingPermissions: string[]; sessionCreatedAt: Date };
let currentActor: Actor | null = null;
const sent: Array<Record<string, unknown>> = [];
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async (args: Record<string, unknown>) => {
    sent.push(args);
    return { ok: true as const, messageId: `msg-${sent.length}` };
  }),
}));

const TAG = `acf-${Date.now()}`;
const mail = (name: string) => `${name.toLowerCase()}-${TAG}@example.test`;

describe.skipIf(!enabled)("Airline confirmation email — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let actions: typeof import("../bookings");
  const accounts: Record<string, Actor> = {};
  const accountIds: string[] = [];
  let contactId = "";
  let leadId = "";
  let quoteId = "";
  let bookingId = "";

  const as = (name: string) => {
    currentActor = accounts[name];
  };
  async function makeAccount(name: string, role: Role, extra: { managerId?: string | null } = {}) {
    const a = await prisma.account.create({ data: { fullName: name, email: mail(name), role, status: "ACTIVE", companyId: "default-company", ...extra } });
    accountIds.push(a.id);
    accounts[name] = { id: a.id, role, companyId: "default-company", fullName: name, email: a.email, phone: null, status: "ACTIVE", paymentPermissions: [], bookingPermissions: [], sessionCreatedAt: new Date() };
    return a;
  }

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    actions = await import("../bookings");
    await prisma.company.upsert({ where: { id: "default-company" }, update: {}, create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" } });

    await makeAccount("Admin", "ADMIN");
    const m1 = await makeAccount("MgrOne", "MANAGER");
    const m2 = await makeAccount("MgrTwo", "MANAGER");
    const a1 = await makeAccount("AgentOne", "TRAVEL_AGENT", { managerId: m1.id });
    await makeAccount("AgentTwo", "TRAVEL_AGENT", { managerId: m2.id });
    await makeAccount("Ticketer", "TICKETING_AGENT");
    await makeAccount("Expert", "FLIGHT_EXPERT");
    await makeAccount("Marketer", "MARKETING_AGENT");

    const contact = await prisma.contact.create({
      data: { firstName: "Jane", lastName: `Traveler${TAG}`, primaryEmail: mail("jane"), primaryPhone: "+14155550123", companyId: "default-company", ownerId: a1.id },
    });
    contactId = contact.id;
    await prisma.contactEmail.createMany({
      data: [
        { contactId, email: mail("jane"), isPrimary: true },
        { contactId, email: mail("alt"), isPrimary: false },
      ],
    });
    const lead = await prisma.lead.create({ data: { contactId, status: "QUOTED", source: "OTHER", assignedAgentId: a1.id } });
    leadId = lead.id;
    const quote = await prisma.quote.create({
      data: { quoteNumber: `Q-${TAG}`, secureToken: `tok-${TAG}`, leadId, contactId, agentId: a1.id, sentByAgentId: a1.id, status: "SENT", adults: 1, adultPrice: 500, taxes: 0, serviceFee: 0, total: 500 },
    });
    quoteId = quote.id;
    const booking = await prisma.booking.create({
      data: {
        quoteId,
        leadId,
        contactId,
        bookingReference: `BFT-${TAG}`.slice(0, 30),
        contactPhone: "+14155550000",
        contactEmail: mail("booking"), // the signed Booking Form address (not on the Contact)
        billingAddress: "1 Test St",
        billingCity: "Springfield",
        billingState: "IL",
        billingZip: "62704",
        billingCountry: "US",
        status: "CONFIRMED",
        airlineConfirmations: [{ id: "c1", airlineIata: "AA", confirmationNumber: "ABC123", eTicketNumbers: ["0012345678901"] }],
      },
    });
    bookingId = booking.id;
  });

  beforeEach(async () => {
    sent.length = 0;
    await prisma.booking.update({ where: { id: bookingId }, data: { airlineConfirmationFirstSentAt: null } });
    await prisma.emailLog.deleteMany({ where: { bookingId } });
  });

  afterAll(async () => {
    if (!enabled) return;
    await prisma.emailLog.deleteMany({ where: { bookingId } });
    await prisma.activity.deleteMany({ where: { bookingId } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: bookingId } });
    await prisma.quote.deleteMany({ where: { id: quoteId } });
    await prisma.lead.deleteMany({ where: { id: leadId } });
    await prisma.contact.deleteMany({ where: { id: contactId } });
    await prisma.account.updateMany({ where: { id: { in: accountIds } }, data: { managerId: null } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.$disconnect();
  });

  it.each(["AgentOne", "MgrOne", "Admin", "Ticketer", "Expert"])("%s can load the recipient list and send; the creator is the sender; To is exactly the selection; no Cc/Bcc", async (name) => {
    as(name);
    const list = await actions.getAirlineConfirmationRecipients(bookingId);
    // Booking Form address first, then the Contact's (primary first) — each once, customers only.
    expect(list.recipients.map((r) => r.email)).toEqual([mail("booking"), mail("jane"), mail("alt")]);
    expect(list.defaultSelected).toEqual([mail("booking")]);
    expect(list.sender).toEqual({ fullName: "AgentOne", email: mail("AgentOne") });

    const res = await actions.sendAirlineConfirmationEmail(bookingId, { recipients: [mail("booking"), mail("alt")] });
    expect(res).toEqual({ ok: true, sentTo: [mail("booking"), mail("alt")] });

    expect(sent).toHaveLength(1);
    expect(sent[0].accountId).toBe(accounts.AgentOne.id); // never the clicking user
    expect(sent[0].to).toBe(`${mail("booking")}, ${mail("alt")}`);
    expect("bcc" in sent[0]).toBe(false);
    expect("cc" in sent[0]).toBe(false);
    const blob = JSON.stringify(sent[0]);
    for (const staff of ["Admin", "MgrOne", "MgrTwo", "Ticketer", "Expert"]) expect(blob).not.toContain(mail(staff));

    const log = await prisma.emailLog.findFirstOrThrow({ where: { bookingId, type: "BOOKING_CONFIRMATION" } });
    expect(log.status).toBe("SENT");
    expect(log.toEmail).toBe(`${mail("booking")}, ${mail("alt")}`);
    expect(log.fromEmail).toBe(mail("AgentOne"));
  });

  it.each(["AgentTwo", "MgrTwo", "Marketer"])("%s (outside this booking's scope, or without Quotes) is refused on both the list and the send — and nothing is sent or claimed (IDOR)", async (name) => {
    as(name);
    await expect(actions.getAirlineConfirmationRecipients(bookingId)).rejects.toThrow(/not authorized/i);
    await expect(actions.sendAirlineConfirmationEmail(bookingId, { recipients: [mail("booking")] })).rejects.toThrow(/not authorized/i);
    expect(sent).toHaveLength(0);
    const b = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { airlineConfirmationFirstSentAt: true } });
    expect(b.airlineConfirmationFirstSentAt).toBeNull();
    expect(await prisma.emailLog.count({ where: { bookingId } })).toBe(0);
  });

  it("a made-up booking id is refused the same way (no existence leak)", async () => {
    as("Admin");
    await expect(actions.sendAirlineConfirmationEmail("does-not-exist", { recipients: [mail("booking")] })).rejects.toThrow(/not authorized/i);
  });

  it("manipulated recipients are rejected: a foreign address, a CRM user's address, none, and an injected header", async () => {
    as("AgentOne");
    for (const bad of [[mail("MgrOne")], [mail("Admin")], ["attacker@evil.test"], [mail("booking"), "attacker@evil.test"], [`${mail("booking")}\r\nBcc: x@evil.test`], []]) {
      const res = await actions.sendAirlineConfirmationEmail(bookingId, { recipients: bad });
      expect(res.ok).toBe(false);
    }
    expect(sent).toHaveLength(0);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { airlineConfirmationFirstSentAt: true } })).airlineConfirmationFirstSentAt).toBeNull();
  });

  it("a first send claims once; a second 'first' send is refused; Resend works with its own, different selection", async () => {
    as("Ticketer");
    expect((await actions.sendAirlineConfirmationEmail(bookingId, { recipients: [mail("booking")] })).ok).toBe(true);
    expect(await actions.sendAirlineConfirmationEmail(bookingId, { recipients: [mail("booking")] })).toEqual({ ok: false, error: expect.stringMatching(/already been sent/i) });
    await prisma.emailLog.deleteMany({ where: { bookingId } }); // clear the 60-second resend guard for the test
    const again = await actions.sendAirlineConfirmationEmail(bookingId, { resend: true, recipients: [mail("jane")] });
    expect(again).toEqual({ ok: true, sentTo: [mail("jane")] });
    expect(sent[sent.length - 1].to).toBe(mail("jane"));
  });

  it("two truly simultaneous first sends produce exactly ONE email", async () => {
    as("AgentOne");
    const results = await Promise.all([
      actions.sendAirlineConfirmationEmail(bookingId, { recipients: [mail("booking")] }),
      actions.sendAirlineConfirmationEmail(bookingId, { recipients: [mail("booking")] }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
});
