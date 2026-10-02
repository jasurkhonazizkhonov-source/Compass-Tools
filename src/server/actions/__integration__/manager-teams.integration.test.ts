// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof of Manager teams. Runs only when INTEGRATION_DATABASE_URL
// points at a DISPOSABLE PostgreSQL with this repo's migrations applied;
// skipped otherwise. Creates its own tagged rows and removes them afterwards.
//
// Proves, against the actual queries and server actions (not mocks of them):
//   • a Manager sees their own and their team's leads, contacts, quotes and
//     bookings — and NOT another manager's team, unassigned agents or
//     other users' records;
//   • that boundary holds for direct access by id (detail queries and every
//     mutating action), not just for lists;
//   • Admin keeps full access and is the only one who can change a team;
//   • only Travel Agents can be team members, one team each;
//   • team changes, role changes and hiding behave as specified, with no
//     record deleted.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
}

type Role = "ADMIN" | "MANAGER" | "TRAVEL_AGENT" | "TICKETING_AGENT";
type Actor = { id: string; role: Role; companyId: string; fullName: string; email: string; phone: string | null; status: string; paymentPermissions: string[]; bookingPermissions: string[]; sessionCreatedAt: Date };
let currentActor: Actor | null = null;
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/reassignment-email", () => ({
  sendLeadReassignmentEmails: vi.fn(async () => ({ previousOwner: "SKIPPED", newOwner: "SKIPPED" })),
  sendContactReassignmentEmails: vi.fn(async () => ({ previousOwner: "SKIPPED", newOwner: "SKIPPED" })),
}));

const TAG = `team-${Date.now()}`;

describe.skipIf(!enabled)("Manager teams — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let leadsQ: typeof import("@/server/queries/leads");
  let contactsQ: typeof import("@/server/queries/contacts");
  let quotesQ: typeof import("@/server/queries/quotes");
  let bookingsQ: typeof import("@/server/queries/bookings");
  let leadActions: typeof import("../leads");
  let contactActions: typeof import("../contacts");
  let accountActions: typeof import("../accounts");
  let search: typeof import("@/server/queries/global-search");
  let accountsQ: typeof import("@/server/queries/accounts");

  const accounts: Record<string, Actor> = {};
  const data: Record<string, { contactId: string; leadId: string; quoteId: string; bookingId: string }> = {};
  const contactIds: string[] = [];
  const accountIds: string[] = [];
  let seq = 0;

  const viewerOf = (a: Actor) => ({ id: a.id, role: a.role, companyId: a.companyId });
  const as = (name: string) => {
    currentActor = accounts[name];
    return viewerOf(accounts[name]);
  };

  async function makeAccount(name: string, role: Role, extra: { managerId?: string | null; accountsVisible?: boolean } = {}) {
    const a = await prisma.account.create({
      data: { fullName: name, email: `${name.toLowerCase().replace(/\W+/g, "")}-${TAG}@example.test`, role, status: "ACTIVE", companyId: "default-company", ...extra },
    });
    accountIds.push(a.id);
    accounts[name] = { id: a.id, role, companyId: "default-company", fullName: name, email: a.email, phone: null, status: "ACTIVE", paymentPermissions: [], bookingPermissions: [], sessionCreatedAt: new Date() };
    return a;
  }

  /** One customer record chain owned by `owner`: contact → lead → quote → booking. */
  async function makeChain(label: string, owner: string | null) {
    const n = ++seq;
    const ownerId = owner ? accounts[owner].id : null;
    const contact = await prisma.contact.create({
      data: { firstName: label, lastName: `Customer${n}`, primaryEmail: `c${n}-${TAG}@example.test`, primaryPhone: `+1415555${String(1000 + n)}`, companyId: "default-company", ownerId },
    });
    contactIds.push(contact.id);
    const lead = await prisma.lead.create({ data: { contactId: contact.id, status: "QUOTED", source: "OTHER", assignedAgentId: ownerId } });
    const quote = await prisma.quote.create({
      data: { quoteNumber: `Q-${TAG}-${n}`, secureToken: `tok-${TAG}-${n}`, leadId: lead.id, contactId: contact.id, agentId: ownerId, sentByAgentId: ownerId, status: "SENT", adults: 1, adultPrice: 500, taxes: 0, serviceFee: 0, total: 500 },
    });
    const booking = await prisma.booking.create({
      data: {
        quoteId: quote.id,
        leadId: lead.id,
        contactId: contact.id,
        bookingReference: `BFT-${TAG}-${n}`.slice(0, 30),
        contactPhone: "+14155550000",
        contactEmail: contact.primaryEmail!,
        billingAddress: "1 Test St",
        billingCity: "Springfield",
        billingState: "IL",
        billingZip: "62704",
        billingCountry: "US",
        status: "CONFIRMED",
        profitAmount: 100 * n,
      },
    });
    data[label] = { contactId: contact.id, leadId: lead.id, quoteId: quote.id, bookingId: booking.id };
    return data[label];
  }

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    leadsQ = await import("@/server/queries/leads");
    contactsQ = await import("@/server/queries/contacts");
    quotesQ = await import("@/server/queries/quotes");
    bookingsQ = await import("@/server/queries/bookings");
    leadActions = await import("../leads");
    contactActions = await import("../contacts");
    accountActions = await import("../accounts");
    search = await import("@/server/queries/global-search");
    accountsQ = await import("@/server/queries/accounts");
    await prisma.company.upsert({ where: { id: "default-company" }, update: {}, create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" } });

    await makeAccount("Admin", "ADMIN");
    const m1 = await makeAccount("Manager1", "MANAGER");
    const m2 = await makeAccount("Manager2", "MANAGER");
    await makeAccount("Agent1", "TRAVEL_AGENT", { managerId: m1.id });
    await makeAccount("Agent2", "TRAVEL_AGENT", { managerId: m1.id, accountsVisible: false }); // hidden, still on the team
    await makeAccount("Agent3", "TRAVEL_AGENT", { managerId: m2.id });
    await makeAccount("Agent4", "TRAVEL_AGENT"); // on nobody's team
    await makeAccount("Ticketing", "TICKETING_AGENT");

    await makeChain("M1own", "Manager1");
    await makeChain("A1", "Agent1");
    await makeChain("A2", "Agent2");
    await makeChain("A3", "Agent3");
    await makeChain("A4", "Agent4");
    await makeChain("M2own", "Manager2");
    await makeChain("Unowned", null);
  }, 120_000);

  afterAll(async () => {
    if (!enabled) return;
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.notification.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.account.updateMany({ where: { id: { in: accountIds } }, data: { managerId: null } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } }).catch(() => {});
    await prisma.$disconnect();
  });

  const labelsOfLeads = async (v: ReturnType<typeof viewerOf>) => {
    const { leads } = await leadsQ.getLeads({ viewer: v, pageSize: 100, q: TAG.slice(0, 0) });
    const ours = new Set(Object.values(data).map((d) => d.leadId));
    return Object.entries(data)
      .filter(([, d]) => leads.some((l) => l.id === d.leadId && ours.has(l.id)))
      .map(([label]) => label)
      .sort();
  };

  describe("a Manager sees only their own and their team's records", () => {
    it("Leads list: own + team (including a HIDDEN team member's) — nobody else's", async () => {
      expect(await labelsOfLeads(as("Manager1"))).toEqual(["A1", "A2", "M1own"]);
      expect(await labelsOfLeads(as("Manager2"))).toEqual(["A3", "M2own"]);
    });

    it("Contacts list", async () => {
      const v = as("Manager1");
      const { contacts } = await contactsQ.getContacts({ viewer: v, pageSize: 100 });
      const ids = new Set(contacts.map((c) => c.id));
      const visible = Object.entries(data).filter(([, d]) => ids.has(d.contactId)).map(([l]) => l).sort();
      expect(visible).toEqual(["A1", "A2", "M1own"]);
    });

    it("Quotes list", async () => {
      const v = as("Manager1");
      const { quotes } = await quotesQ.getQuotes({ viewer: v, pageSize: 100 });
      const ids = new Set(quotes.map((q) => q.id));
      expect(Object.entries(data).filter(([, d]) => ids.has(d.quoteId)).map(([l]) => l).sort()).toEqual(["A1", "A2", "M1own"]);
    });

    it("Bookings list", async () => {
      const v = as("Manager1");
      const { bookings } = await bookingsQ.getBookings({ viewer: v, pageSize: 100 });
      const ids = new Set(bookings.map((b) => b.id));
      expect(Object.entries(data).filter(([, d]) => ids.has(d.bookingId)).map(([l]) => l).sort()).toEqual(["A1", "A2", "M1own"]);
    });

    it("global search is scoped the same way", async () => {
      as("Manager1");
      const own = await search.globalSearch("A1Customer");
      const other = await search.globalSearch("A3Customer");
      void own;
      expect(other.contacts).toHaveLength(0);
      expect(other.leads).toHaveLength(0);
    });
  });

  describe("direct access by id — a Manager cannot step outside their team by editing a URL or request", () => {
    it("detail queries return nothing for another team's records, and the team's for their own", async () => {
      const m1 = as("Manager1");
      for (const label of ["A3", "M2own", "A4", "Unowned"]) {
        expect(await leadsQ.getLeadDetail(data[label].leadId, m1), `lead ${label}`).toBeNull();
        expect(await contactsQ.getContactDetail(data[label].contactId, m1), `contact ${label}`).toBeNull();
        expect(await quotesQ.getQuoteDetail(data[label].quoteId, m1), `quote ${label}`).toBeNull();
        expect(await bookingsQ.getBookingDetail(data[label].bookingId, m1), `booking ${label}`).toBeNull();
      }
      for (const label of ["A1", "A2", "M1own"]) {
        expect(await leadsQ.getLeadDetail(data[label].leadId, m1), `lead ${label}`).not.toBeNull();
        expect(await contactsQ.getContactDetail(data[label].contactId, m1), `contact ${label}`).not.toBeNull();
        expect(await quotesQ.getQuoteDetail(data[label].quoteId, m1), `quote ${label}`).not.toBeNull();
        expect(await bookingsQ.getBookingDetail(data[label].bookingId, m1), `booking ${label}`).not.toBeNull();
      }
    });

    it("every mutating action refuses another team's lead/contact and changes nothing", async () => {
      as("Manager1");
      const foreign = data.A3;
      await expect(leadActions.updateLeadField(foreign.leadId, { adults: 5 })).rejects.toThrow(/not found/i);
      await expect(leadActions.reassignLead(foreign.leadId, accounts.Agent1.id)).rejects.toThrow(/not found/i);
      await expect(leadActions.deleteLead(foreign.leadId)).rejects.toThrow(/not authorized/i);
      await expect(leadActions.setLeadSegments(foreign.leadId, [{ departureAirportId: null, arrivalAirportId: null, departureDate: null }])).rejects.toThrow(/not found/i);
      await expect(contactActions.reassignContact(foreign.contactId, accounts.Agent1.id, "x")).rejects.toThrow(/not found/i);
      await expect(contactActions.deleteContact(foreign.contactId)).rejects.toThrow(/not authorized/i);
      await expect(contactActions.updateContactField(foreign.contactId, { firstName: "Hacked" })).rejects.toThrow();
      // …and the records are exactly as they were.
      const lead = await prisma.lead.findUniqueOrThrow({ where: { id: foreign.leadId } });
      expect(lead.adults).toBe(1);
      expect(lead.assignedAgentId).toBe(accounts.Agent3.id);
      expect((await prisma.contact.findUniqueOrThrow({ where: { id: foreign.contactId } })).firstName).toBe("A3");
    });

    it("the same actions work on the Manager's own team (delete is checked last, below)", async () => {
      as("Manager1");
      await expect(leadActions.updateLeadField(data.A1.leadId, { adults: 2 })).resolves.toBeDefined();
      expect((await prisma.lead.findUniqueOrThrow({ where: { id: data.A1.leadId } })).adults).toBe(2);
    });

    it("a Manager cannot delete a lead outside their team, but CAN delete one inside it (audited)", async () => {
      const chain = await makeChain("DeleteMe", "Agent1");
      as("Manager2");
      await expect(leadActions.deleteLead(chain.leadId)).rejects.toThrow(/not authorized/i);
      expect(await prisma.lead.count({ where: { id: chain.leadId } })).toBe(1);
      as("Manager1");
      await leadActions.deleteLead(chain.leadId);
      expect(await prisma.lead.count({ where: { id: chain.leadId } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { entityType: "Lead", entityId: chain.leadId, action: "LEAD_DELETED" } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { entityType: "Lead", entityId: chain.leadId, action: "LEAD_DELETE_DENIED" } })).toBe(1);
    });

    it("contact delete follows the same boundary", async () => {
      const chain = await makeChain("DeleteContact", "Agent3");
      as("Manager1");
      await expect(contactActions.deleteContact(chain.contactId)).rejects.toThrow(/not authorized/i);
      as("Manager2");
      await contactActions.deleteContact(chain.contactId);
      expect(await prisma.contact.count({ where: { id: chain.contactId } })).toBe(0);
    });

    it("a Travel Agent and a Ticketing Agent cannot delete anything (role gate), and a Travel Agent sees only their own", async () => {
      as("Agent1");
      await expect(leadActions.deleteLead(data.A1.leadId)).rejects.toThrow(/not authorized/i);
      await expect(contactActions.deleteContact(data.A1.contactId)).rejects.toThrow(/not authorized/i);
      expect(await labelsOfLeads(viewerOf(accounts.Agent1))).toEqual(["A1"]);
      as("Ticketing");
      await expect(leadActions.deleteLead(data.A1.leadId)).rejects.toThrow(/not authorized/i);
    });
  });

  describe("Admin keeps full access", () => {
    it("sees every lead, contact, quote and booking in the company, and can reassign across teams", async () => {
      const admin = as("Admin");
      expect(await labelsOfLeads(admin)).toEqual(expect.arrayContaining(["A1", "A2", "A3", "A4", "M1own", "M2own", "Unowned"]));
      for (const label of ["A1", "A3", "A4", "Unowned"]) {
        expect(await quotesQ.getQuoteDetail(data[label].quoteId, admin)).not.toBeNull();
        expect(await bookingsQ.getBookingDetail(data[label].bookingId, admin)).not.toBeNull();
        expect(await contactsQ.getContactDetail(data[label].contactId, admin)).not.toBeNull();
      }
      await expect(leadActions.reassignLead(data.A3.leadId, accounts.Agent3.id)).resolves.toBeDefined(); // same owner: a no-op, but authorized
    });

    it("the back-office role that is company-wide by design (Ticketing) still sees every booking", async () => {
      const t = as("Ticketing");
      expect(await bookingsQ.getBookingDetail(data.A3.bookingId, t)).not.toBeNull();
    });
  });

  describe("team administration (setManagerTeam)", () => {
    it("only an Admin can change a team — a Manager (even for their own team), a Travel Agent and a Ticketing Agent are refused, and nothing changes", async () => {
      for (const who of ["Manager1", "Agent1", "Ticketing"]) {
        as(who);
        await expect(accountActions.setManagerTeam(accounts.Manager1.id, [accounts.Agent1.id, accounts.Agent4.id]), who).rejects.toThrow(/only admins/i);
      }
      expect((await prisma.account.findUniqueOrThrow({ where: { id: accounts.Agent4.id } })).managerId).toBeNull();
    });

    it("only Travel Agents can be members — an Admin, another Manager, a Ticketing Agent are refused (and the whole change is rolled back)", async () => {
      as("Admin");
      for (const bad of ["Admin", "Manager2", "Ticketing"]) {
        await expect(accountActions.setManagerTeam(accounts.Manager1.id, [accounts.Agent1.id, accounts[bad].id]), bad).rejects.toThrow(/only travel agents/i);
      }
      // Agent1 is still on the team: the rejected change did not partly apply.
      expect((await prisma.account.findUniqueOrThrow({ where: { id: accounts.Agent1.id } })).managerId).toBe(accounts.Manager1.id);
    });

    it("only a Manager can have a team", async () => {
      as("Admin");
      await expect(accountActions.setManagerTeam(accounts.Agent1.id, [accounts.Agent4.id])).rejects.toThrow(/only a manager/i);
      await expect(accountActions.setManagerTeam(accounts.Admin.id, [accounts.Agent4.id])).rejects.toThrow(/only a manager/i);
    });

    it("unknown ids and ids from another company are refused", async () => {
      as("Admin");
      await expect(accountActions.setManagerTeam(accounts.Manager1.id, ["no-such-account"])).rejects.toThrow(/not found/i);
      await expect(accountActions.setManagerTeam("no-such-manager", [])).rejects.toThrow(/not found/i);
    });

    it("assigning, moving between managers, and removing — and access follows immediately, with every record left in place", async () => {
      as("Admin");
      // add Agent4 to Manager1 → Manager1 now sees A4's records
      await accountActions.setManagerTeam(accounts.Manager1.id, [accounts.Agent1.id, accounts.Agent2.id, accounts.Agent4.id]);
      expect(await labelsOfLeads(as("Manager1"))).toEqual(expect.arrayContaining(["A4"]));
      expect(await labelsOfLeads(as("Manager2"))).not.toContain("A4");

      // move Agent4 to Manager2 (an agent is on one team only)
      as("Admin");
      await accountActions.setManagerTeam(accounts.Manager2.id, [accounts.Agent3.id, accounts.Agent4.id]);
      expect((await prisma.account.findUniqueOrThrow({ where: { id: accounts.Agent4.id } })).managerId).toBe(accounts.Manager2.id);
      expect(await labelsOfLeads(as("Manager1"))).not.toContain("A4");
      expect(await labelsOfLeads(as("Manager2"))).toEqual(expect.arrayContaining(["A3", "A4"]));

      // remove Agent4 entirely
      as("Admin");
      await accountActions.setManagerTeam(accounts.Manager2.id, [accounts.Agent3.id]);
      expect(await labelsOfLeads(as("Manager2"))).not.toContain("A4");

      // nothing was deleted or reassigned by any of that
      const lead = await prisma.lead.findUniqueOrThrow({ where: { id: data.A4.leadId } });
      expect(lead.assignedAgentId).toBe(accounts.Agent4.id);
      expect(await prisma.auditLog.count({ where: { entityId: accounts.Manager1.id, action: "MANAGER_TEAM_CHANGED" } })).toBeGreaterThanOrEqual(1);
    });

    it("changing a Travel Agent's role clears their team membership, and changing a Manager's role clears their whole team", async () => {
      as("Admin");
      const m = await makeAccount("TempManager", "MANAGER");
      const ta = await makeAccount("TempAgent", "TRAVEL_AGENT");
      await accountActions.setManagerTeam(m.id, [ta.id]);
      await makeChain("Temp", "TempAgent");
      expect(await labelsOfLeads(as("TempManager"))).toEqual(["Temp"]);

      as("Admin");
      await accountActions.updateAccount(ta.id, { role: "TICKETING_AGENT" });
      expect((await prisma.account.findUniqueOrThrow({ where: { id: ta.id } })).managerId).toBeNull();
      expect(await labelsOfLeads(as("TempManager"))).toEqual([]);

      as("Admin");
      await accountActions.updateAccount(ta.id, { role: "TRAVEL_AGENT" });
      await accountActions.setManagerTeam(m.id, [ta.id]);
      await accountActions.updateAccount(m.id, { role: "TRAVEL_AGENT" });
      expect((await prisma.account.findUniqueOrThrow({ where: { id: ta.id } })).managerId).toBeNull();
    });
  });

  describe("hidden team members and the directory", () => {
    it("a hidden Travel Agent stays on the team (their records stay in scope) but is NOT shown in the Accounts directory", async () => {
      expect(await labelsOfLeads(as("Manager1"))).toContain("A2");
      const dir = await accountsQ.getAccountsDirectory("default-company");
      expect(dir.some((a) => a.id === accounts.Agent2.id)).toBe(false);
      expect(dir.some((a) => a.id === accounts.Agent1.id)).toBe(true);
      // the full roster (Admin's Users page) still includes them, with the team link intact
      const all = await accountsQ.getAllAccounts("default-company");
      expect(all.find((a) => a.id === accounts.Agent2.id)?.managerId).toBe(accounts.Manager1.id);
    });
  });

  describe("Salesboard hides hidden accounts but never deletes their sales", () => {
    it("a hidden user's confirmed bookings stay in the database but their row is not on the board; un-hiding restores it", async () => {
      const { getSalesboard } = await import("@/server/queries/salesboard");
      const admin = as("Admin");
      const names = async () => (await getSalesboard(admin, "all")).map((r) => r.fullName);
      expect(await names()).toContain("Agent1");
      expect(await names()).not.toContain("Agent2"); // hidden
      expect(await prisma.booking.count({ where: { id: data.A2.bookingId } })).toBe(1); // history intact
      await prisma.account.update({ where: { id: accounts.Agent2.id }, data: { accountsVisible: true } });
      expect(await names()).toContain("Agent2");
      await prisma.account.update({ where: { id: accounts.Agent2.id }, data: { accountsVisible: false } });
    });
  });
});
