// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof of three flows. Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE
// PostgreSQL with this repo's migrations applied (including the two 20261004 ones); skipped otherwise.
//
//   1. A website lead POSTed to the public endpoint stores the server-observed IP and approximate
//      location in the same insert, and only people allowed to see that lead can read it (Manager =
//      own team; IDOR-safe).
//   2. A booking signing stores its approximate location with the event, and the authorised reveal
//      returns it (and nothing is invented where none was captured).
//   3. The public unsubscribe page changes state only on POST, stores an optional reason once,
//      is idempotent, never re-subscribes, and the CRM's Respond leaves the subscription untouched.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.TRUSTED_PROXY = "vercel";
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
}

type Role = "ADMIN" | "MANAGER" | "TRAVEL_AGENT" | "TICKETING_AGENT" | "MARKETING_AGENT";
type Actor = { id: string; role: Role; companyId: string; fullName: string; email: string; phone: string | null; status: string; paymentPermissions: string[]; bookingPermissions: string[]; sessionCreatedAt: Date };
let currentActor: Actor | null = null;
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/actions/lead-queue", () => ({ distributeNewWebsiteLead: vi.fn(async () => ({ ok: true })) }));
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const sendEmail = vi.fn(async (_args: unknown) => ({ ok: true as const, messageId: "m-1" }));
vi.mock("@/server/email/service", () => ({ sendEmail: (a: unknown) => sendEmail(a) }));
vi.mock("@/server/queries/gmail-connection", () => ({ getGmailConnectionState: vi.fn(async () => "CONNECTED") }));

const TAG = `geo-${Date.now()}`;

describe.skipIf(!enabled)("IP/geo capture and unsubscribe — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  const accounts: Record<string, Actor> = {};
  const accountIds: string[] = [];
  const contactIds: string[] = [];
  const subscriberIds: string[] = [];
  const as = (n: string) => {
    currentActor = accounts[n];
    return { id: accounts[n].id, role: accounts[n].role, companyId: "default-company" };
  };
  async function makeAccount(name: string, role: Role, extra: { managerId?: string } = {}) {
    const a = await prisma.account.create({ data: { fullName: name, email: `${name.toLowerCase()}-${TAG}@example.test`, role, status: "ACTIVE", companyId: "default-company", ...extra } });
    accountIds.push(a.id);
    accounts[name] = { id: a.id, role, companyId: "default-company", fullName: name, email: a.email, phone: null, status: "ACTIVE", paymentPermissions: [], bookingPermissions: [], sessionCreatedAt: new Date() };
    return a;
  }

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    await prisma.company.upsert({ where: { id: "default-company" }, update: {}, create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" } });
    const mgr = await makeAccount("Mgr", "MANAGER");
    const mgr2 = await makeAccount("Mgr2", "MANAGER");
    await makeAccount("Admin", "ADMIN");
    await makeAccount("Agent", "TRAVEL_AGENT", { managerId: mgr.id });
    await makeAccount("Stranger", "TRAVEL_AGENT", { managerId: mgr2.id });
    await makeAccount("Marketer", "MARKETING_AGENT");
  }, 120_000);

  afterAll(async () => {
    if (!enabled) return;
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.subscriber.deleteMany({ where: { id: { in: subscriberIds } } });
    await prisma.emailLog.deleteMany({ where: { toEmail: { contains: TAG } } });
    await prisma.account.updateMany({ where: { id: { in: accountIds } }, data: { managerId: null } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } }).catch(() => {});
    await prisma.$disconnect();
  });

  // ── 1. lead capture ───────────────────────────────────────────────────────────────────────────
  describe("website lead → LeadSubmissionInfo", () => {
    const EDGE = { "x-vercel-forwarded-for": "203.0.113.42", "x-vercel-ip-city": "Los%20Angeles", "x-vercel-ip-country": "US", "x-vercel-ip-country-region": "CA", "x-vercel-ip-timezone": "America/Los_Angeles" };
    async function capture(phoneSuffix: string, headers: Record<string, string>) {
      const { POST } = await import("@/app/api/public/lead-capture/route");
      const res = await POST(
        new Request("http://localhost/api/public/lead-capture", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ companyId: "default-company", firstName: `Cap${phoneSuffix}`, lastName: TAG, phone: `+1415557${phoneSuffix}`, email: `cap${phoneSuffix}-${TAG}@example.test`, ipAddress: "6.6.6.6" }),
        })
      );
      expect(res.status).toBe(200);
      const { id } = (await res.json()) as { id: string };
      const lead = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { contactId: true } });
      contactIds.push(lead.contactId);
      return id;
    }

    it("persists the IP + approximate location WITH the lead; a forged body IP is ignored; the lead's own createdAt is the submission time", async () => {
      const id = await capture("0001", EDGE);
      const info = await prisma.leadSubmissionInfo.findUniqueOrThrow({ where: { leadId: id } });
      expect(info).toMatchObject({ ipAddress: "203.0.113.42", ipVersion: "v4", city: "Los Angeles", region: "California", country: "United States", countryCode: "US", timeZone: "America/Los_Angeles", geoSource: "Vercel edge geolocation (approximate)" });
      const lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
      expect(Math.abs(info.capturedAt.getTime() - lead.createdAt.getTime())).toBeLessThan(5_000);
    });

    it("IPv6 is stored in full", async () => {
      const id = await capture("0002", { "x-vercel-forwarded-for": "2001:db8:85a3::8a2e:370:7334", "x-vercel-ip-country": "NL" });
      expect(await prisma.leadSubmissionInfo.findUniqueOrThrow({ where: { leadId: id } })).toMatchObject({ ipAddress: "2001:db8:85a3::8a2e:370:7334", ipVersion: "v6", countryCode: "NL", city: null });
    });

    it("unavailable geo: the IP is kept, city/country stay null; unavailable everything: no row but the lead exists", async () => {
      const a = await capture("0003", { "x-vercel-forwarded-for": "198.51.100.23" });
      expect(await prisma.leadSubmissionInfo.findUniqueOrThrow({ where: { leadId: a } })).toMatchObject({ ipAddress: "198.51.100.23", city: null, country: null });
      const b = await capture("0004", {});
      expect(await prisma.lead.count({ where: { id: b } })).toBe(1);
      expect(await prisma.leadSubmissionInfo.count({ where: { leadId: b } })).toBe(0);
    });

    it("who can read it: Admin and the owning Manager/agent yes; another Manager/agent and a Marketing Agent no (IDOR-safe)", async () => {
      const { getLeadSubmissionInfo } = await import("@/server/queries/lead-submission-info");
      const id = await capture("0005", EDGE);
      const lead = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { contactId: true } });
      await prisma.lead.update({ where: { id }, data: { assignedAgentId: accounts.Agent.id } });
      await prisma.contact.update({ where: { id: lead.contactId }, data: { ownerId: accounts.Agent.id } });

      for (const who of ["Admin", "Mgr", "Agent"]) {
        const info = await getLeadSubmissionInfo(id, as(who));
        expect(info, who).toMatchObject({ hasIp: true, ipMasked: "203.x.x.x", ipVersion: "v4", city: "Los Angeles" });
        expect(JSON.stringify(info), who).not.toContain("203.0.113.42"); // the page query never carries the full address
      }
      for (const who of ["Mgr2", "Stranger", "Marketer"]) {
        expect(await getLeadSubmissionInfo(id, as(who)), who).toBeNull();
      }
      expect(await getLeadSubmissionInfo(id, null)).toBeNull();
      // moving the agent to the other Manager hands the access over immediately
      await prisma.account.update({ where: { id: accounts.Agent.id }, data: { managerId: accounts.Mgr2.id } });
      expect(await getLeadSubmissionInfo(id, as("Mgr"))).toBeNull();
      expect(await getLeadSubmissionInfo(id, as("Mgr2"))).not.toBeNull();
      await prisma.account.update({ where: { id: accounts.Agent.id }, data: { managerId: accounts.Mgr.id } });
    });

    it("the FULL IP only comes from the audited Reveal: Admin yes; a Travel Agent no (even on their own lead); a Manager only with the grant and only for their team; the audit never holds the address", async () => {
      const { revealLeadSubmissionIp } = await import("../lead-submission");
      const id = await capture("0007", EDGE);
      const lead = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { contactId: true } });
      await prisma.lead.update({ where: { id }, data: { assignedAgentId: accounts.Agent.id } });
      await prisma.contact.update({ where: { id: lead.contactId }, data: { ownerId: accounts.Agent.id } });

      as("Admin");
      expect(await revealLeadSubmissionIp(id)).toEqual({ ipAddress: "203.0.113.42", ipVersion: "v4" });

      as("Agent");
      await expect(revealLeadSubmissionIp(id)).rejects.toThrow(/not authorized/i);
      as("Marketer");
      await expect(revealLeadSubmissionIp(id)).rejects.toThrow(/not authorized/i);

      as("Mgr"); // on the agent's team but WITHOUT the grant
      await expect(revealLeadSubmissionIp(id)).rejects.toThrow(/not authorized/i);
      accounts.Mgr.bookingPermissions = ["bookings.reveal_ip"];
      expect(await revealLeadSubmissionIp(id)).toMatchObject({ ipAddress: "203.0.113.42" });
      accounts.Mgr2.bookingPermissions = ["bookings.reveal_ip"];
      as("Mgr2"); // has the grant, but not this lead's team
      await expect(revealLeadSubmissionIp(id)).rejects.toThrow(/not authorized/i);

      const audit = await prisma.auditLog.findMany({ where: { entityType: "Lead", entityId: id } });
      expect(audit.filter((a) => a.action === "LEAD_IP_REVEALED")).toHaveLength(2);
      expect(audit.filter((a) => a.action === "LEAD_IP_REVEAL_DENIED").length).toBeGreaterThanOrEqual(4);
      expect(JSON.stringify(audit)).not.toContain("203.0.113.42");
    });

    it("the Reveal is rate limited per account (real counter table)", async () => {
      const { revealLeadSubmissionIp } = await import("../lead-submission");
      const id = await capture("0008", EDGE);
      as("Admin");
      let limited: unknown = null;
      for (let i = 0; i < 30 && !limited; i++) {
        const r = await revealLeadSubmissionIp(id);
        if ("error" in r) limited = r;
      }
      expect(limited).toEqual({ error: expect.stringMatching(/Too many Reveal attempts/) });
      await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: `acct:${accounts.Admin.id}|IP_REVEAL|` } } });
    });

    it("the ordinary lead queries never load it", async () => {
      const { getLeadDetail, getLeads } = await import("@/server/queries/leads");
      const id = await capture("0006", EDGE);
      const detail = await getLeadDetail(id, as("Admin"));
      expect(JSON.stringify(detail)).not.toMatch(/203\.0\.113\.42|submissionInfo/);
      const { leads } = await getLeads({ viewer: as("Admin"), pageSize: 100 });
      expect(JSON.stringify(leads)).not.toMatch(/203\.0\.113\.42|submissionInfo/);
    });
  });

  // ── 2. booking signing geo ───────────────────────────────────────────────────────────────────
  describe("booking signing → stored location → authorised reveal", () => {
    async function makeBooking(label: string) {
      const contact = await prisma.contact.create({ data: { firstName: label, lastName: TAG, primaryEmail: `${label}-${TAG}@example.test`, primaryPhone: `+1415558${Math.floor(1000 + Math.random() * 8999)}`, companyId: "default-company", ownerId: accounts.Agent.id } });
      contactIds.push(contact.id);
      const lead = await prisma.lead.create({ data: { contactId: contact.id, status: "QUOTED", source: "OTHER", assignedAgentId: accounts.Agent.id } });
      const quote = await prisma.quote.create({ data: { quoteNumber: `Q-${TAG}-${label}`, secureToken: `tok-${TAG}-${label}`, leadId: lead.id, contactId: contact.id, agentId: accounts.Agent.id, sentByAgentId: accounts.Agent.id, status: "SENT", adults: 1, adultPrice: 500, taxes: 0, serviceFee: 0, total: 500 } });
      return prisma.booking.create({
        data: { quoteId: quote.id, leadId: lead.id, contactId: contact.id, bookingReference: `BFT-${label}-${TAG}`.slice(0, 30), contactPhone: "+14155550000", contactEmail: contact.primaryEmail!, billingAddress: "1 St", billingCity: "X", billingState: "IL", billingZip: "62704", billingCountry: "US", status: "CONFIRMED", profitAmount: 1, signature: { create: { signedName: "Jane", ipAddress: "203.0.113.42", userAgent: "UA" } } },
      });
    }

    it("recordIpCapture stores the location with the event; revealBookingIp returns IP + location + signing time to an authorised Admin", async () => {
      const { recordIpCapture } = await import("@/server/security/ip-capture");
      const { revealBookingIp } = await import("../booking-security");
      const booking = await makeBooking("geo1");
      await recordIpCapture({
        ip: "203.0.113.42",
        userAgent: "UA",
        formType: "NEW_BOOKING",
        bookingId: booking.id,
        signerName: "Jane",
        signerEmail: `geo1-${TAG}@example.test`,
        location: { city: "Los Angeles", region: "California", regionCode: "CA", country: "United States", countryCode: "US", timeZone: "America/Los_Angeles" },
      });
      const stored = await prisma.ipCapture.findFirstOrThrow({ where: { bookingId: booking.id } });
      expect(stored).toMatchObject({ geoCity: "Los Angeles", geoRegion: "California", geoCountry: "United States", geoCountryCode: "US", geoTimeZone: "America/Los_Angeles", geoSource: "Vercel edge geolocation (approximate)" });
      expect(stored.encryptedIp).not.toContain("203.0.113.42"); // the vault copy is still encrypted

      as("Admin");
      const result = await revealBookingIp(booking.id);
      expect(result).toMatchObject({ ipAddress: "203.0.113.42", ipVersion: "v4", location: { city: "Los Angeles", country: "United States", countryCode: "US", region: "California", timeZone: "America/Los_Angeles" } });
      if ("error" in result) throw new Error("unexpected");
      expect(result.signedAt).toBeInstanceOf(Date);

      const audit = await prisma.auditLog.findMany({ where: { entityType: "Booking", entityId: booking.id } });
      expect(audit.length).toBeGreaterThan(0);
      expect(JSON.stringify(audit)).not.toMatch(/203\.0\.113\.42|Los Angeles|California/);
    });

    it("an event captured without a location (older booking / no trusted edge) reveals location: null — nothing is fabricated", async () => {
      const { recordIpCapture } = await import("@/server/security/ip-capture");
      const { revealBookingIp } = await import("../booking-security");
      const booking = await makeBooking("geo2");
      await recordIpCapture({ ip: "203.0.113.42", userAgent: "UA", formType: "NEW_BOOKING", bookingId: booking.id, signerEmail: `geo2-${TAG}@example.test` });
      const stored = await prisma.ipCapture.findFirstOrThrow({ where: { bookingId: booking.id } });
      expect(stored).toMatchObject({ geoCity: null, geoCountry: null, geoSource: null });
      as("Admin");
      expect(await revealBookingIp(booking.id)).toMatchObject({ ipAddress: "203.0.113.42", location: null });
    });

    it("only an authorised role can reveal, and another team's Manager cannot (IDOR)", async () => {
      const { revealBookingIp } = await import("../booking-security");
      const booking = await makeBooking("geo3");
      for (const who of ["Agent", "Stranger", "Marketer"]) {
        as(who);
        await expect(revealBookingIp(booking.id), who).rejects.toThrow(/not authorized/i);
      }
      accounts.Mgr2.bookingPermissions = ["bookings.reveal_ip"];
      as("Mgr2");
      await expect(revealBookingIp(booking.id)).rejects.toThrow(/not authorized/i); // not their team
      accounts.Mgr.bookingPermissions = ["bookings.reveal_ip"];
      as("Mgr");
      expect(await revealBookingIp(booking.id)).toMatchObject({ ipAddress: "203.0.113.42" }); // their team, with the grant
    });
  });

  // ── 3. unsubscribe ───────────────────────────────────────────────────────────────────────────
  describe("public unsubscribe + CRM Respond", () => {
    const BASE = "https://app.example.com/api/public/unsubscribe";
    async function makeSubscriber(label: string) {
      const s = await prisma.subscriber.create({ data: { companyId: "default-company", email: `${label}-${TAG}@example.test`, source: "website" } });
      subscriberIds.push(s.id);
      return s;
    }
    const post = (token: string, fields: Record<string, string> = {}) =>
      new Request(BASE, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", host: "app.example.com" }, body: new URLSearchParams({ token, ...fields }).toString() });

    it("GET never changes anything; POST unsubscribes, stores the optional reason once and records the source", async () => {
      const { GET, POST } = await import("@/app/api/public/unsubscribe/route");
      const s = await makeSubscriber("u1");
      const page = await GET(new Request(`${BASE}?token=${s.unsubscribeToken}`));
      expect(page.status).toBe(200);
      expect((await prisma.subscriber.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("SUBSCRIBED");

      const done = await POST(post(s.unsubscribeToken, { reason: "NOT_RELEVANT", comment: "Not relevant to my business." }));
      expect(done.status).toBe(200);
      const after = await prisma.subscriber.findUniqueOrThrow({ where: { id: s.id } });
      expect(after).toMatchObject({ status: "UNSUBSCRIBED", unsubscribeReasonCategory: "NOT_RELEVANT", unsubscribeReason: "Not relevant to my business.", unsubscribeSource: "EMAIL_LINK" });
      expect(after.unsubscribedAt).toBeInstanceOf(Date);

      // idempotent — a second submit changes nothing, a later GET says "already"
      await POST(post(s.unsubscribeToken, { reason: "OTHER", comment: "second" }));
      expect(await prisma.subscriber.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ unsubscribeReasonCategory: "NOT_RELEVANT", unsubscribeReason: "Not relevant to my business.", unsubscribedAt: after.unsubscribedAt });
      expect(await (await GET(new Request(`${BASE}?token=${s.unsubscribeToken}`))).text()).toContain("already unsubscribed");
    });

    it("no reason → no reason columns; a 1,001-character comment is refused and nothing is stored; a tampered category is dropped", async () => {
      const { POST } = await import("@/app/api/public/unsubscribe/route");
      const a = await makeSubscriber("u2");
      await POST(post(a.unsubscribeToken));
      expect(await prisma.subscriber.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "UNSUBSCRIBED", unsubscribeReasonCategory: null, unsubscribeReason: null });

      const b = await makeSubscriber("u3");
      expect((await POST(post(b.unsubscribeToken, { comment: "x".repeat(1001) }))).status).toBe(400);
      expect((await prisma.subscriber.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("SUBSCRIBED");
      await POST(post(b.unsubscribeToken, { reason: "HACK", comment: "<script>alert(1)</script>" }));
      expect(await prisma.subscriber.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ unsubscribeReasonCategory: null, unsubscribeReason: "<script>alert(1)</script>" }); // inert plain text
    });

    it("the CRM list shows the reason with no token in the payload; only Admin/Marketing see it", async () => {
      const { getSubscribers } = await import("@/server/queries/subscribers");
      const s = await makeSubscriber("u4");
      const { POST } = await import("@/app/api/public/unsubscribe/route");
      await POST(post(s.unsubscribeToken, { reason: "TOO_MANY_EMAILS", comment: "Too many." }));
      const { subscribers } = await getSubscribers({ companyId: "default-company", pageSize: 100 });
      const row = subscribers.find((r) => r.id === s.id)!;
      expect(row).toMatchObject({ unsubscribeReasonCategory: "TOO_MANY_EMAILS", unsubscribeReason: "Too many.", unsubscribeSource: "EMAIL_LINK" });
      expect(JSON.stringify(subscribers)).not.toContain(s.unsubscribeToken);
      const { respondToUnsubscribedSubscriber } = await import("../subscribers");
      for (const who of ["Agent", "Mgr"]) {
        as(who);
        await expect(respondToUnsubscribedSubscriber(s.id, { subject: "x", body: "y" }), who).rejects.toThrow(/not authorized/i);
      }
    });

    it("Respond sends a personal email to the stored address, logs it, marks the follow-up, and leaves the subscription exactly as it was", async () => {
      const { POST } = await import("@/app/api/public/unsubscribe/route");
      const { respondToUnsubscribedSubscriber } = await import("../subscribers");
      const s = await makeSubscriber("u5");
      await POST(post(s.unsubscribeToken, { reason: "NO_LONGER_INTERESTED" }));
      const before = await prisma.subscriber.findUniqueOrThrow({ where: { id: s.id } });
      sendEmail.mockClear();

      as("Marketer");
      expect(await respondToUnsubscribedSubscriber(s.id, { subject: "Regarding your email preferences", body: "Thank you for telling us." })).toEqual({ ok: true });
      expect(sendEmail).toHaveBeenCalledTimes(1);
      const sent = sendEmail.mock.calls[0][0] as { to: string; html: string; accountId: string; replyTo: string };
      expect(sent).toMatchObject({ to: s.email, accountId: accounts.Marketer.id, replyTo: accounts.Marketer.email });
      expect(sent.html).not.toContain("Unsubscribe");
      expect(await prisma.emailLog.count({ where: { type: "SUBSCRIBER_EMAIL", toEmail: s.email, status: "SENT" } })).toBe(1);

      const after = await prisma.subscriber.findUniqueOrThrow({ where: { id: s.id } });
      expect(after).toMatchObject({ status: "UNSUBSCRIBED", unsubscribeReasonCategory: before.unsubscribeReasonCategory, unsubscribedAt: before.unsubscribedAt });
      expect(after.unsubscribeRespondedAt).toBeInstanceOf(Date);
      expect(after.unsubscribeRespondedById).toBe(accounts.Marketer.id);
    });

    it("only the public subscribe endpoint opts someone back in, and that retires the old reason", async () => {
      const { POST } = await import("@/app/api/public/unsubscribe/route");
      const s = await makeSubscriber("u6");
      await POST(post(s.unsubscribeToken, { reason: "OTHER", comment: "going away" }));
      const sub = await import("@/app/api/public/subscribe/route");
      const res = await sub.POST(new Request("http://localhost/api/public/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ companyId: "default-company", email: s.email }) }));
      expect(res.status).toBe(200);
      expect(await prisma.subscriber.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ status: "SUBSCRIBED", unsubscribedAt: null, unsubscribeReason: null, unsubscribeReasonCategory: null, unsubscribeRespondedAt: null });
    });
  });
});
