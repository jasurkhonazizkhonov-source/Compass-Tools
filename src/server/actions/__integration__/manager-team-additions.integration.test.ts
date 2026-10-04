// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof that adding a Travel Agent to a Manager's team gives that Manager access to
// the agent's Leads, Contacts, Quotes and Bookings IMMEDIATELY — on every surface (lists, search,
// detail by id, actions) — and that the same boundary holds against another agent/team (IDOR).
// Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL with this repo's
// migrations applied; creates its own tagged rows and removes them afterwards.
//
// It also covers the incremental team change (changeManagerTeam) the Users page now uses, including
// the stale-snapshot case that the old "replace the whole team" call got wrong.

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

const TAG = `adds-${Date.now()}`;

describe.skipIf(!enabled)("Manager team additions — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let leadsQ: typeof import("@/server/queries/leads");
  let contactsQ: typeof import("@/server/queries/contacts");
  let quotesQ: typeof import("@/server/queries/quotes");
  let bookingsQ: typeof import("@/server/queries/bookings");
  let leadActions: typeof import("../leads");
  let contactActions: typeof import("../contacts");
  let accountActions: typeof import("../accounts");
  let search: typeof import("@/server/queries/global-search");

  const accounts: Record<string, Actor> = {};
  const chains: Record<string, { contactId: string; leadId: string; quoteId: string; bookingId: string }> = {};
  const contactIds: string[] = [];
  const accountIds: string[] = [];
  let seq = 0;

  const viewerOf = (a: Actor) => ({ id: a.id, role: a.role, companyId: a.companyId });
  const as = (name: string) => {
    currentActor = accounts[name];
    return viewerOf(accounts[name]);
  };

  function register(name: string, a: { id: string; email: string }, role: Role) {
    accountIds.push(a.id);
    accounts[name] = { id: a.id, role, companyId: "default-company", fullName: name, email: a.email, phone: null, status: "ACTIVE", paymentPermissions: [], bookingPermissions: [], sessionCreatedAt: new Date() };
  }
  async function makeAccount(name: string, role: Role, extra: { managerId?: string | null; accountsVisible?: boolean } = {}) {
    const a = await prisma.account.create({ data: { fullName: name, email: `${name.toLowerCase().replace(/\W+/g, "")}-${TAG}@example.test`, role, status: "ACTIVE", companyId: "default-company", ...extra } });
    register(name, a, role);
    return a;
  }
  /** Creates a Travel Agent the way the Users page does — through the real createAccount action. */
  async function createAgentViaAction(name: string) {
    as("Admin");
    const email = `${name.toLowerCase().replace(/\W+/g, "")}-${TAG}@example.test`;
    await accountActions.createAccount({ fullName: name, email, role: "TRAVEL_AGENT" });
    const a = await prisma.account.findFirstOrThrow({ where: { email } });
    register(name, a, "TRAVEL_AGENT");
    return a;
  }

  async function makeChain(label: string, owner: string) {
    const n = ++seq;
    const ownerId = accounts[owner].id;
    const contact = await prisma.contact.create({
      data: { firstName: label, lastName: `Cust${n}`, primaryEmail: `c${n}-${TAG}@example.test`, primaryPhone: `+1415556${String(1000 + n)}`, companyId: "default-company", ownerId },
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
        profitAmount: 100,
      },
    });
    chains[label] = { contactId: contact.id, leadId: lead.id, quoteId: quote.id, bookingId: booking.id };
    return chains[label];
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
    await prisma.company.upsert({ where: { id: "default-company" }, update: {}, create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" } });
    await makeAccount("Admin", "ADMIN");
    await makeAccount("MgrA", "MANAGER");
    await makeAccount("MgrB", "MANAGER");
    await makeAccount("Bystander", "TRAVEL_AGENT"); // on nobody's team, has records throughout
    await makeChain("Bystander", "Bystander");
  }, 120_000);

  afterAll(async () => {
    if (!enabled) return;
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.auditLog.deleteMany({ where: { entityId: { in: accountIds } } }).catch(() => {});
    await prisma.account.updateMany({ where: { id: { in: accountIds } }, data: { managerId: null } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } }).catch(() => {});
    await prisma.$disconnect();
  });

  const ALL = (label: string) => chains[label];
  const sees = async (who: string, label: string) => {
    const v = as(who);
    const c = ALL(label);
    const [lead, contact, quote, booking] = await Promise.all([
      leadsQ.getLeadDetail(c.leadId, v),
      contactsQ.getContactDetail(c.contactId, v),
      quotesQ.getQuoteDetail(c.quoteId, v),
      bookingsQ.getBookingDetail(c.bookingId, v),
    ]);
    return { lead: !!lead, contact: !!contact, quote: !!quote, booking: !!booking };
  };
  const inLists = async (who: string, label: string) => {
    const v = as(who);
    const c = ALL(label);
    const [{ leads }, { contacts }, { quotes }, { bookings }] = await Promise.all([
      leadsQ.getLeads({ viewer: v, pageSize: 100 }),
      contactsQ.getContacts({ viewer: v, pageSize: 100 }),
      quotesQ.getQuotes({ viewer: v, pageSize: 100 }),
      bookingsQ.getBookings({ viewer: v, pageSize: 100 }),
    ]);
    return {
      lead: leads.some((l) => l.id === c.leadId),
      contact: contacts.some((x) => x.id === c.contactId),
      quote: quotes.some((q) => q.id === c.quoteId),
      booking: bookings.some((b) => b.id === c.bookingId),
    };
  };
  const NONE = { lead: false, contact: false, quote: false, booking: false };
  const ALLOWED = { lead: true, contact: true, quote: true, booking: true };

  it("a Travel Agent created through the Users action is on nobody's team, so no Manager sees their records", async () => {
    const agent = await createAgentViaAction("NewAgent");
    expect(agent.managerId).toBeNull();
    await makeChain("New1", "NewAgent");
    expect(await sees("MgrA", "New1")).toEqual(NONE);
    expect(await inLists("MgrA", "New1")).toEqual(NONE);
  });

  it("adding the new agent to a Manager's team gives that Manager access at once — lists, detail by id, search — for Leads, Contacts, Quotes and Bookings", async () => {
    as("Admin");
    const result = await accountActions.changeManagerTeam(accounts.MgrA.id, { add: [accounts.NewAgent.id] });
    expect(result).toMatchObject({ added: 1, removed: 0, teamSize: 1 });

    expect(await inLists("MgrA", "New1")).toEqual(ALLOWED);
    expect(await sees("MgrA", "New1")).toEqual(ALLOWED);

    as("MgrA");
    const found = await search.globalSearch("New1");
    expect(found.leads.length + found.contacts.length).toBeGreaterThan(0);
    // …and the other Manager still sees none of it.
    expect(await sees("MgrB", "New1")).toEqual(NONE);
    expect(await inLists("MgrB", "New1")).toEqual(NONE);
    // Admin is unaffected.
    expect(await sees("Admin", "New1")).toEqual(ALLOWED);
  });

  it("records the agent creates AFTER joining the team are visible to the Manager immediately too", async () => {
    await makeChain("New2", "NewAgent");
    expect(await sees("MgrA", "New2")).toEqual(ALLOWED);
    expect(await inLists("MgrA", "New2")).toEqual(ALLOWED);
  });

  it("the Manager can act on the new agent's records through the real actions (still audited / scoped)", async () => {
    as("MgrA");
    await expect(leadActions.updateLeadField(ALL("New1").leadId, { adults: 3 })).resolves.toBeDefined();
    await contactActions.updateContactField(ALL("New1").contactId, { firstName: "Renamed" });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: ALL("New1").contactId } })).firstName).toBe("Renamed");
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: ALL("New1").leadId } })).adults).toBe(3);
    // reassigning to a team member works; the actor never leaves their scope to do it
    await leadActions.reassignLead(ALL("New2").leadId, accounts.NewAgent.id);
  });

  it("IDOR: the Manager cannot reach another agent's records by changing ids — not by detail query, not by any action", async () => {
    expect(await sees("MgrA", "Bystander")).toEqual(NONE);
    expect(await inLists("MgrA", "Bystander")).toEqual(NONE);
    as("MgrA");
    const foreign = ALL("Bystander");
    await expect(leadActions.updateLeadField(foreign.leadId, { adults: 9 })).rejects.toThrow(/not found/i);
    await expect(leadActions.reassignLead(foreign.leadId, accounts.NewAgent.id)).rejects.toThrow(/not found/i);
    await expect(leadActions.deleteLead(foreign.leadId)).rejects.toThrow(/not authorized/i);
    await expect(contactActions.updateContactField(foreign.contactId, { firstName: "Hacked" })).rejects.toThrow();
    await expect(contactActions.deleteContact(foreign.contactId)).rejects.toThrow(/not authorized/i);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: foreign.leadId } })).adults).toBe(1);
    const found = await search.globalSearch("Bystander");
    expect(found.leads).toHaveLength(0);
    expect(found.contacts).toHaveLength(0);
  });

  it("MOVE: moving the agent to Manager B hands the access over — A loses it, B gains it, nothing is deleted", async () => {
    as("Admin");
    await accountActions.changeManagerTeam(accounts.MgrB.id, { add: [accounts.NewAgent.id] });
    expect(await sees("MgrA", "New1")).toEqual(NONE);
    expect(await sees("MgrA", "New2")).toEqual(NONE);
    expect(await inLists("MgrA", "New1")).toEqual(NONE);
    expect(await sees("MgrB", "New1")).toEqual(ALLOWED);
    expect(await inLists("MgrB", "New2")).toEqual(ALLOWED);
    expect(await prisma.lead.count({ where: { id: { in: [ALL("New1").leadId, ALL("New2").leadId] } } })).toBe(2);
  });

  it("STALE SNAPSHOT: an editor that still shows the agent on Manager A can add someone else without pulling the agent back", async () => {
    const other = await createAgentViaAction("OtherAgent");
    await makeChain("Other1", "OtherAgent");
    // The stale editor for Manager A thinks A's team is [NewAgent]; it adds OtherAgent.
    as("Admin");
    await accountActions.changeManagerTeam(accounts.MgrA.id, { add: [other.id] });
    expect((await prisma.account.findUniqueOrThrow({ where: { id: accounts.NewAgent.id } })).managerId).toBe(accounts.MgrB.id); // still B's
    expect(await sees("MgrB", "New1")).toEqual(ALLOWED);
    expect(await sees("MgrA", "New1")).toEqual(NONE);
    expect(await sees("MgrA", "Other1")).toEqual(ALLOWED);
  });

  it("STALE SNAPSHOT: removing an agent that is no longer on this team is a no-op — it never strips the Manager they were moved to", async () => {
    as("Admin");
    const result = await accountActions.changeManagerTeam(accounts.MgrA.id, { remove: [accounts.NewAgent.id] });
    expect(result).toMatchObject({ added: 0, removed: 0 });
    expect((await prisma.account.findUniqueOrThrow({ where: { id: accounts.NewAgent.id } })).managerId).toBe(accounts.MgrB.id);
    expect(await sees("MgrB", "New2")).toEqual(ALLOWED);
  });

  it("REMOVE: removing the agent from the team ends the Manager's access at once and leaves every record in place", async () => {
    as("Admin");
    await accountActions.changeManagerTeam(accounts.MgrB.id, { remove: [accounts.NewAgent.id] });
    expect(await sees("MgrB", "New1")).toEqual(NONE);
    expect(await inLists("MgrB", "New2")).toEqual(NONE);
    expect(await sees("Admin", "New1")).toEqual(ALLOWED);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: ALL("New1").leadId } })).assignedAgentId).toBe(accounts.NewAgent.id);
  });

  it("only an Admin can change a team, only Travel Agents can be added, and nothing partly applies", async () => {
    for (const who of ["MgrA", "NewAgent"]) {
      as(who);
      await expect(accountActions.changeManagerTeam(accounts.MgrA.id, { add: [accounts.NewAgent.id] }), who).rejects.toThrow(/only admins/i);
    }
    as("Admin");
    await expect(accountActions.changeManagerTeam(accounts.MgrA.id, { add: [accounts.NewAgent.id, accounts.MgrB.id] })).rejects.toThrow(/only travel agents/i);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: accounts.NewAgent.id } })).managerId).toBeNull(); // the valid half was rolled back too
    await expect(accountActions.changeManagerTeam(accounts.NewAgent.id, { add: [accounts.Bystander.id] })).rejects.toThrow(/only a manager/i);
    await expect(accountActions.changeManagerTeam(accounts.MgrA.id, { add: ["no-such-account"] })).rejects.toThrow(/not found/i);
    await expect(accountActions.changeManagerTeam("no-such-manager", {})).rejects.toThrow(/not found/i);
  });

  it("ROLE CHANGE: re-roling a team member ends the Manager's access to their records", async () => {
    as("Admin");
    await accountActions.changeManagerTeam(accounts.MgrA.id, { add: [accounts.NewAgent.id] });
    expect(await sees("MgrA", "New1")).toEqual(ALLOWED);
    as("Admin");
    await accountActions.updateAccount(accounts.NewAgent.id, { role: "TICKETING_AGENT" });
    expect(await sees("MgrA", "New1")).toEqual(NONE);
    as("Admin");
    await accountActions.updateAccount(accounts.NewAgent.id, { role: "TRAVEL_AGENT" });
    expect(await sees("MgrA", "New1")).toEqual(NONE); // back to Travel Agent does NOT silently restore the team link
  });

  it("HIDDEN / INACTIVE: a hidden or inactive new team member's records stay in the Manager's scope, and being on a team never makes them visible in the directory", async () => {
    const hidden = await createAgentViaAction("HiddenAgent");
    await makeChain("Hidden1", "HiddenAgent");
    as("Admin");
    await prisma.account.update({ where: { id: hidden.id }, data: { accountsVisible: false } });
    await accountActions.changeManagerTeam(accounts.MgrA.id, { add: [hidden.id] });
    expect(await sees("MgrA", "Hidden1")).toEqual(ALLOWED);
    const accountsQ = await import("@/server/queries/accounts");
    const dir = await accountsQ.getAccountsDirectory("default-company");
    expect(dir.some((a) => a.id === hidden.id)).toBe(false);

    as("Admin");
    await accountActions.setAccountStatus(hidden.id, "INACTIVE");
    expect(await sees("MgrA", "Hidden1")).toEqual(ALLOWED); // inactive ≠ out of scope
    expect((await prisma.account.findUniqueOrThrow({ where: { id: hidden.id } })).accountsVisible).toBe(false); // still hidden
  });

  it("the old replace-the-whole-team action still works for callers that use it", async () => {
    as("Admin");
    await accountActions.setManagerTeam(accounts.MgrB.id, [accounts.Bystander.id]);
    expect(await sees("MgrB", "Bystander")).toEqual(ALLOWED);
    as("Admin");
    await accountActions.setManagerTeam(accounts.MgrB.id, []);
    expect(await sees("MgrB", "Bystander")).toEqual(NONE);
  });
});
