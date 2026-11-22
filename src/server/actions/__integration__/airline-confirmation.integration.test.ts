// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { maskCustomerEmail } from "@/lib/customer-email-mask";

// REAL-DATABASE proof of the customer "Send / Resend Airline Confirmation" email:
//  - every role with the Quotes area (Travel Agent, Ticketing Agent, Manager, Admin, Flight Expert)
//    can load the recipient list and send for a booking it can see — a returned result, never a throw;
//  - a Travel Agent / Manager outside the booking's scope, and a Marketing Agent, are refused (IDOR);
//  - the email is addressed ONLY to the selected customer addresses (chosen from the booking's own
//    verified ones), with NO Cc and NO Bcc — no Manager, Admin or other CRM user is ever copied;
//  - CUSTOMER EMAIL PRIVACY (server/privacy/customer-email.ts): an Administrator, or a user an Administrator switched to "Unlimited Customer Email Access", sees the
//    real addresses and names recipients by address; every other role sees MASKED labels with opaque ids (r0, r1, ...), selects by id, can never submit a raw address,
//    and is told only the masked form of whom the email went to - while the real customers still receive the real email;
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
  async function makeAccount(name: string, role: Role, extra: { managerId?: string | null; unlimitedCustomerEmailAccess?: boolean } = {}) {
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
    await makeAccount("TicketerUnlimited", "TICKETING_AGENT", { unlimitedCustomerEmailAccess: true }); // the Administrator's per-user switch, stored on the account
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

  const REAL = () => [mail("booking"), mail("jane"), mail("alt")]; // the Booking Form address first, then the Contact's (primary first) - each once, customers only
  const noStaffAddress = (value: unknown) => {
    const blob = JSON.stringify(value);
    for (const staff of ["Admin", "MgrOne", "MgrTwo", "Ticketer", "TicketerUnlimited", "Expert"]) expect(blob).not.toContain(mail(staff));
  };
  async function expectOneCleanSend(sentToAddresses: string[]) {
    expect(sent).toHaveLength(1);
    expect(sent[0].accountId).toBe(accounts.AgentOne.id); // the quote's creator sends - never the clicking user
    expect(sent[0].to).toBe(sentToAddresses.join(", ")); // the REAL customers receive the REAL email
    expect("bcc" in sent[0]).toBe(false);
    expect("cc" in sent[0]).toBe(false);
    noStaffAddress(sent[0]);
    const log = await prisma.emailLog.findFirstOrThrow({ where: { bookingId, type: "BOOKING_CONFIRMATION" } });
    expect(log.status).toBe("SENT");
    expect(log.toEmail).toBe(sentToAddresses.join(", "));
    expect(log.fromEmail).toBe(mail("AgentOne"));
  }

  describe("a viewer who may see complete addresses (Administrator; a user with Unlimited Customer Email Access): the address is the key", () => {
    it.each(["Admin", "TicketerUnlimited"])("%s loads the real addresses and sends by address; the creator is the sender; To is exactly the selection; no Cc/Bcc", async (name) => {
      as(name);
      const list = await actions.getAirlineConfirmationRecipients(bookingId);
      expect(list.recipients.map((r) => r.email)).toEqual(REAL());
      expect(list.defaultSelected).toEqual([mail("booking")]);
      expect(list.sender).toEqual({ fullName: "AgentOne", email: mail("AgentOne") });
      noStaffAddress(list.recipients);

      const res = await actions.sendAirlineConfirmationEmail(bookingId, { recipients: [mail("booking"), mail("alt")] });
      expect(res).toEqual({ ok: true, sentTo: [mail("booking"), mail("alt")] });
      await expectOneCleanSend([mail("booking"), mail("alt")]);
    });

    it("a foreign address, a CRM user's address, none, and an injected header are all rejected, and nothing is sent or claimed", async () => {
      as("Admin");
      for (const bad of [[mail("MgrOne")], [mail("Admin")], ["attacker@evil.test"], [mail("booking"), "attacker@evil.test"], [`${mail("booking")}\r\nBcc: x@evil.test`], []]) {
        const res = await actions.sendAirlineConfirmationEmail(bookingId, { recipients: bad });
        expect(res.ok, JSON.stringify(bad)).toBe(false);
      }
      expect(sent).toHaveLength(0);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { airlineConfirmationFirstSentAt: true } })).airlineConfirmationFirstSentAt).toBeNull();
    });
  });

  describe("every other role (Travel Agent, Manager, Ticketing Agent, Flight Expert): masked labels, opaque ids, never a raw address", () => {
    it.each(["AgentOne", "MgrOne", "Ticketer", "Expert"])("%s sees only masked addresses, selects by id, and the real customers still receive the real email", async (name) => {
      as(name);
      const list = await actions.getAirlineConfirmationRecipients(bookingId);
      // the list is a union of the two shapes (address-keyed for a full-access viewer, id-keyed and masked for everyone else): a restricted viewer must get the second
      const masked = list.recipients as unknown as Array<{ id: string; email: string; masked: boolean }>;
      expect(masked.map((r) => r.id)).toEqual(["r0", "r1", "r2"]);
      expect(masked.map((r) => r.email)).toEqual(REAL().map(maskCustomerEmail));
      expect(masked.every((r) => r.masked === true)).toBe(true);
      expect(list.defaultSelected).toEqual(["r0"]);
      expect(list.sender).toEqual({ fullName: "AgentOne", email: mail("AgentOne") });
      // nothing in what the browser receives holds a complete customer address, in any field
      for (const real of REAL()) expect(JSON.stringify(list)).not.toContain(real);

      const res = await actions.sendAirlineConfirmationEmail(bookingId, { recipientIds: ["r0", "r2"] });
      // the confirmation names the recipients in masked form only ...
      expect(res).toEqual({ ok: true, sentTo: [maskCustomerEmail(mail("booking")), maskCustomerEmail(mail("alt"))] });
      for (const real of REAL()) expect(JSON.stringify(res)).not.toContain(real);
      // ... while the email itself went to exactly the two real addresses that were selected
      await expectOneCleanSend([mail("booking"), mail("alt")]);
      // the activity entry carries a count, never an address
      const activity = await prisma.activity.findMany({ where: { bookingId } });
      for (const real of REAL()) expect(JSON.stringify(activity)).not.toContain(real);
    });

    it.each(["AgentOne", "Ticketer"])("%s cannot submit a raw address at all (it would be a probe for 'is this address on file?'): refused, nothing sent, nothing claimed", async (name) => {
      as(name);
      for (const raw of [[mail("booking")], [mail("alt")], ["attacker@evil.test"]]) {
        expect(await actions.sendAirlineConfirmationEmail(bookingId, { recipients: raw })).toEqual({ ok: false, error: expect.stringMatching(/choose the recipients from the list/i) });
      }
      expect(sent).toHaveLength(0);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { airlineConfirmationFirstSentAt: true } })).airlineConfirmationFirstSentAt).toBeNull();
    });

    it("manipulated ids are rejected: out of range, not an id, an injected header, a CRM user's address, none - nothing is sent or claimed", async () => {
      as("AgentOne");
      const bad: unknown[] = [["r9"], ["r3"], ["r-1"], ["x0"], ["r0", "r7"], [`r0\r\nBcc: x@evil.test`], [mail("MgrOne")], [mail("Admin")], [], [1], [null], "r0"];
      for (const ids of bad) {
        const res = await actions.sendAirlineConfirmationEmail(bookingId, { recipientIds: ids as string[] });
        expect(res.ok, JSON.stringify(ids)).toBe(false);
      }
      expect(sent).toHaveLength(0);
      expect(await prisma.emailLog.count({ where: { bookingId } })).toBe(0);
      expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, select: { airlineConfirmationFirstSentAt: true } })).airlineConfirmationFirstSentAt).toBeNull();
    });
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

  it("a first send claims once; a second 'first' send is refused; an immediate Resend is held by the 60-second guard; a later Resend works with its own, different selection", async () => {
    as("Ticketer"); // a restricted role: ids, masked answers
    expect((await actions.sendAirlineConfirmationEmail(bookingId, { recipientIds: ["r0"] })).ok).toBe(true);
    expect(await actions.sendAirlineConfirmationEmail(bookingId, { recipientIds: ["r0"] })).toEqual({ ok: false, error: expect.stringMatching(/already been sent/i) });
    // Resend is a separate path with its own safeguard: not a way around the first-send claim, and not repeatable within a minute
    expect(await actions.sendAirlineConfirmationEmail(bookingId, { resend: true, recipientIds: ["r1"] })).toEqual({ ok: false, error: expect.stringMatching(/wait a minute/i) });
    expect(sent).toHaveLength(1);
    await prisma.emailLog.deleteMany({ where: { bookingId } }); // clear the 60-second resend guard for the test
    const again = await actions.sendAirlineConfirmationEmail(bookingId, { resend: true, recipientIds: ["r1"] });
    expect(again).toEqual({ ok: true, sentTo: [maskCustomerEmail(mail("jane"))] });
    expect(sent).toHaveLength(2);
    expect(sent[sent.length - 1].to).toBe(mail("jane"));
    expect(sent[sent.length - 1].accountId).toBe(accounts.AgentOne.id);
  });

  it("Resend is its own path: it skips the first-send claim by design, but still validates the selection, goes only to it, and is held by the 60-second guard", async () => {
    as("Admin");
    // a resend naming an address that is not the booking's own is rejected exactly like a first send, and sends nothing
    for (const bad of [["attacker@evil.test"], [mail("MgrOne")], [mail("booking"), "attacker@evil.test"], []]) {
      expect((await actions.sendAirlineConfirmationEmail(bookingId, { resend: true, recipients: bad })).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(sent).toHaveLength(0);
    // a valid resend goes out to exactly the selection ...
    expect(await actions.sendAirlineConfirmationEmail(bookingId, { resend: true, recipients: [mail("jane")] })).toEqual({ ok: true, sentTo: [mail("jane")] });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(mail("jane"));
    // ... and a second one straight after it is held by the 60-second guard, whoever sends it
    expect(await actions.sendAirlineConfirmationEmail(bookingId, { resend: true, recipients: [mail("jane")] })).toEqual({ ok: false, error: expect.stringMatching(/wait a minute/i) });
    as("Ticketer");
    expect(await actions.sendAirlineConfirmationEmail(bookingId, { resend: true, recipientIds: ["r1"] })).toEqual({ ok: false, error: expect.stringMatching(/wait a minute/i) });
    expect(sent).toHaveLength(1);
  });

  it("two truly simultaneous first sends produce exactly ONE email (by id, as a restricted agent)", async () => {
    as("AgentOne");
    const results = await Promise.all([
      actions.sendAirlineConfirmationEmail(bookingId, { recipientIds: ["r0"] }),
      actions.sendAirlineConfirmationEmail(bookingId, { recipientIds: ["r0"] }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(mail("booking"));
    expect(await prisma.emailLog.count({ where: { bookingId, type: "BOOKING_CONFIRMATION" } })).toBe(1);
  });

  it("two truly simultaneous first sends produce exactly ONE email (by address, as an Administrator)", async () => {
    as("Admin");
    const results = await Promise.all([
      actions.sendAirlineConfirmationEmail(bookingId, { recipients: [mail("booking")] }),
      actions.sendAirlineConfirmationEmail(bookingId, { recipients: [mail("booking")] }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
});
