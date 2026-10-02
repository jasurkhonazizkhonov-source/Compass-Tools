// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof for (1) the "Updated" time on leads and contacts — what
// moves it, what must not, and that the lists sort by it in the database — and
// (2) multi-city travel requests, from the public website endpoint through the
// CRM's add / edit / remove / reorder. Runs only when INTEGRATION_DATABASE_URL
// points at a DISPOSABLE PostgreSQL with this repo's migrations applied.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
}

type Actor = { id: string; role: string; companyId: string; fullName: string; email: string; phone: string | null; status: string; paymentPermissions: string[] };
let currentActor: Actor | null = null;
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// The website endpoint hands new leads to the queue; not under test here.
vi.mock("@/server/actions/lead-queue", () => ({ distributeNewWebsiteLead: vi.fn(async () => undefined) }));

const TAG = `upd-${Date.now()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!enabled)("lead/contact Updated time and multi-city itineraries — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let leadActions: typeof import("../leads");
  let contactActions: typeof import("../contacts");
  let leadsQ: typeof import("@/server/queries/leads");
  let contactsQ: typeof import("@/server/queries/contacts");
  let capture: typeof import("@/app/api/public/lead-capture/route");
  let itinerary: typeof import("@/lib/lead-itinerary");
  let admin: Actor;
  const airports: Record<string, number> = {};
  const contactIds: string[] = [];
  let seq = 0;

  const viewer = () => ({ id: admin.id, role: admin.role as "ADMIN", companyId: admin.companyId });

  async function makeLead(over: { tripType?: "ONE_WAY" | "ROUND_TRIP" | "MULTI_CITY" } = {}) {
    const n = ++seq;
    const contact = await prisma.contact.create({
      data: { firstName: `Upd${n}`, lastName: `Customer-${TAG}`, primaryEmail: `u${n}-${TAG}@example.test`, primaryPhone: `+1415556${String(1000 + n)}`, companyId: "default-company", ownerId: admin.id },
    });
    contactIds.push(contact.id);
    await prisma.contactEmail.create({ data: { contactId: contact.id, email: contact.primaryEmail!, isPrimary: true } });
    await prisma.contactPhone.create({ data: { contactId: contact.id, number: contact.primaryPhone!, isPrimary: true, type: "MOBILE" } });
    const lead = await prisma.lead.create({
      data: { contactId: contact.id, status: "NEW", source: "WEBSITE", assignedAgentId: admin.id, tripType: over.tripType ?? "ROUND_TRIP", departureAirportId: airports.JFK, arrivalAirportId: airports.LHR },
    });
    return { contact, lead };
  }
  const leadRow = (id: string) => prisma.lead.findUniqueOrThrow({ where: { id } });
  const contactRow = (id: string) => prisma.contact.findUniqueOrThrow({ where: { id } });

  async function post(body: Record<string, unknown>) {
    const ip = `198.51.100.${1 + (seq++ % 250)}`;
    const res = await capture.POST(
      new Request("http://localhost/api/public/lead-capture", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ companyId: "default-company", firstName: "Web", lastName: `Lead-${TAG}`, phone: "+14155557777", email: `web${seq}-${TAG}@example.test`, ...body }) })
    );
    const json = (await res.json()) as { ok: boolean; leadId?: string; error?: string };
    return { status: res.status, json };
  }
  const newestLead = async () => {
    const lead = await prisma.lead.findFirstOrThrow({ where: { contact: { lastName: `Lead-${TAG}` } }, orderBy: { createdAt: "desc" }, include: { segments: { orderBy: { sequence: "asc" } } } });
    contactIds.push(lead.contactId);
    return lead;
  };

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    leadActions = await import("../leads");
    contactActions = await import("../contacts");
    leadsQ = await import("@/server/queries/leads");
    contactsQ = await import("@/server/queries/contacts");
    capture = await import("@/app/api/public/lead-capture/route");
    itinerary = await import("@/lib/lead-itinerary");
    await prisma.company.upsert({ where: { id: "default-company" }, update: {}, create: { id: "default-company", name: "Test Co", signatureTemplate: "Regards" } });
    const a = await prisma.account.create({ data: { fullName: "Updated Admin", email: `admin-${TAG}@example.test`, role: "ADMIN", status: "ACTIVE", companyId: "default-company" } });
    admin = { id: a.id, role: "ADMIN", companyId: "default-company", fullName: a.fullName, email: a.email, phone: null, status: "ACTIVE", paymentPermissions: [] };
    currentActor = admin;
    for (const [iata, name, city, country] of [["JFK", "John F. Kennedy International", "New York", "United States"], ["LHR", "Heathrow", "London", "United Kingdom"], ["CDG", "Charles de Gaulle", "Paris", "France"], ["LAX", "Los Angeles International", "Los Angeles", "United States"]] as const) {
      const row = await prisma.airport.upsert({ where: { iata }, update: {}, create: { iata, name, city, country } });
      airports[iata] = row.id;
    }
  }, 120_000);

  afterAll(async () => {
    if (!enabled) return;
    await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
    await prisma.account.deleteMany({ where: { email: `admin-${TAG}@example.test` } }).catch(() => {});
    await prisma.$disconnect();
  });

  describe("Created vs Updated", () => {
    it("a new lead has its original capture time in createdAt, and an editing it never rewrites createdAt", async () => {
      const { lead } = await makeLead();
      const created = lead.createdAt.getTime();
      await sleep(20);
      await leadActions.updateLeadField(lead.id, { adults: 3 });
      const after = await leadRow(lead.id);
      expect(after.createdAt.getTime()).toBe(created);
      expect(after.updatedAt.getTime()).toBeGreaterThan(created);
    });

    it.each([
      ["route (departure airport)", (id: string) => leadActions.updateLeadField(id, { departureAirportId: airports.CDG })],
      ["route (arrival airport)", (id: string) => leadActions.updateLeadField(id, { arrivalAirportId: airports.LAX })],
      ["departure date", (id: string) => leadActions.updateLeadField(id, { departureDate: "2026-12-01" })],
      ["return date", (id: string) => leadActions.updateLeadField(id, { returnDate: "2026-12-10" })],
      ["passenger count", (id: string) => leadActions.updateLeadField(id, { adults: 2, children: 1 })],
      ["trip type", (id: string) => leadActions.updateLeadField(id, { tripType: "ONE_WAY" })],
      ["cabin class", (id: string) => leadActions.updateLeadField(id, { cabinClass: "BUSINESS" })],
      ["notes / request information", (id: string) => leadActions.updateLeadField(id, { notes: "Window seat please" })],
    ])("changing the lead's %s updates Updated", async (_label, change) => {
      const { lead } = await makeLead();
      const before = (await leadRow(lead.id)).updatedAt.getTime();
      await sleep(20);
      await change(lead.id);
      expect((await leadRow(lead.id)).updatedAt.getTime()).toBeGreaterThan(before);
    });

    it("changing the customer's NAME, EMAIL or PHONE updates the lead's Updated (and the contact's)", async () => {
      const { lead, contact } = await makeLead();
      const stamp = async () => ({ lead: (await leadRow(lead.id)).updatedAt.getTime(), contact: (await contactRow(contact.id)).updatedAt.getTime() });

      let before = await stamp();
      await sleep(20);
      await contactActions.updateContactField(contact.id, { firstName: "Renamed" }, lead.id);
      let after = await stamp();
      expect(after.lead).toBeGreaterThan(before.lead);
      expect(after.contact).toBeGreaterThan(before.contact);

      before = after;
      await sleep(20);
      await contactActions.updatePrimaryEmailAddress(contact.id, `new-${TAG}-${seq}@example.test`, lead.id);
      after = await stamp();
      expect(after.lead).toBeGreaterThan(before.lead);
      expect(after.contact).toBeGreaterThan(before.contact);

      before = after;
      await sleep(20);
      await contactActions.updatePrimaryPhoneNumber(contact.id, "+14155558888", lead.id);
      after = await stamp();
      expect(after.lead).toBeGreaterThan(before.lead);
      expect(after.contact).toBeGreaterThan(before.contact);
    });

    it("VIEWING does not change Updated: opening a lead/contact and loading the lists leave both timestamps untouched", async () => {
      const { lead, contact } = await makeLead();
      const before = { lead: (await leadRow(lead.id)).updatedAt.getTime(), contact: (await contactRow(contact.id)).updatedAt.getTime() };
      await sleep(25);
      await leadsQ.getLeadDetail(lead.id, viewer());
      await contactsQ.getContactDetail(contact.id, viewer());
      await leadsQ.getLeads({ viewer: viewer(), pageSize: 100 });
      await contactsQ.getContacts({ viewer: viewer(), pageSize: 100 });
      await leadsQ.getLeadDetail(lead.id, viewer());
      expect({ lead: (await leadRow(lead.id)).updatedAt.getTime(), contact: (await contactRow(contact.id)).updatedAt.getTime() }).toEqual(before);
    });
  });

  describe("sorting by Updated happens in the database", () => {
    it("Leads: the most recently updated lead comes first; updating another lead moves it to the top; viewing does not", async () => {
      const a = await makeLead();
      await sleep(30);
      const b = await makeLead();
      await sleep(30);
      const c = await makeLead();
      const order = async () => {
        const { leads } = await leadsQ.getLeads({ viewer: viewer(), pageSize: 100 });
        const ids = [a.lead.id, b.lead.id, c.lead.id];
        return leads.map((l) => l.id).filter((id) => ids.includes(id));
      };
      expect(await order()).toEqual([c.lead.id, b.lead.id, a.lead.id]);

      await leadsQ.getLeadDetail(a.lead.id, viewer()); // opening the oldest must not promote it
      expect(await order()).toEqual([c.lead.id, b.lead.id, a.lead.id]);

      await sleep(30);
      await leadActions.updateLeadField(a.lead.id, { adults: 4 });
      expect(await order()).toEqual([a.lead.id, c.lead.id, b.lead.id]);
    });

    it("Contacts: same behaviour — editing a contact moves it to the top, viewing does not", async () => {
      const a = await makeLead();
      await sleep(30);
      const b = await makeLead();
      const order = async () => {
        const { contacts } = await contactsQ.getContacts({ viewer: viewer(), pageSize: 100 });
        return contacts.map((c) => c.id).filter((id) => [a.contact.id, b.contact.id].includes(id));
      };
      expect(await order()).toEqual([b.contact.id, a.contact.id]);
      await contactsQ.getContactDetail(a.contact.id, viewer());
      expect(await order()).toEqual([b.contact.id, a.contact.id]);
      await sleep(30);
      await contactActions.updateContactField(a.contact.id, { lastName: `Customer-${TAG}` });
      expect(await order()).toEqual([a.contact.id, b.contact.id]);
    });

    it("the Updated value shown comes straight from the row's updatedAt (and the list is paginated, never an unbounded fetch)", async () => {
      const { lead } = await makeLead();
      const { leads, pageSize } = await leadsQ.getLeads({ viewer: viewer(), pageSize: 25 });
      expect(pageSize).toBeLessThanOrEqual(100);
      expect(leads.length).toBeLessThanOrEqual(100);
      const row = leads.find((l) => l.id === lead.id);
      if (row) expect(row.updatedAt.getTime()).toBe((await leadRow(lead.id)).updatedAt.getTime());
    });
  });

  describe("website lead capture — itineraries", () => {
    it("the original single-route payload still works exactly as before", async () => {
      const r = await post({ departureAirportIata: "JFK", arrivalAirportIata: "LHR", departureDate: "2026-11-03", tripType: "ONE_WAY" });
      expect(r.status).toBe(200);
      const lead = await newestLead();
      expect(lead.tripType).toBe("ONE_WAY");
      expect(lead.departureAirportId).toBe(airports.JFK);
      expect(lead.arrivalAirportId).toBe(airports.LHR);
      expect(lead.segments).toHaveLength(0);
    });

    it("a round trip keeps its return date and has no segments", async () => {
      await post({ departureAirportIata: "JFK", arrivalAirportIata: "CDG", departureDate: "2026-11-03", returnDate: "2026-11-17", tripType: "ROUND_TRIP" });
      const lead = await newestLead();
      expect(lead.tripType).toBe("ROUND_TRIP");
      expect(lead.returnDate?.toISOString().slice(0, 10)).toBe("2026-11-17");
      expect(lead.segments).toHaveLength(0);
    });

    it("a multi-city submission stores EVERY segment, in order, and mirrors the first onto the lead", async () => {
      const r = await post({
        tripType: "MULTI_CITY",
        segments: [
          { departureAirportIata: "JFK", arrivalAirportIata: "LHR", departureDate: "2026-10-20" },
          { departureAirportIata: "LHR", arrivalAirportIata: "CDG", departureDate: "2026-10-24" },
          { departureAirportIata: "CDG", arrivalAirportIata: "JFK", departureDate: "2026-10-30" },
        ],
      });
      expect(r.status).toBe(200);
      const lead = await newestLead();
      expect(lead.tripType).toBe("MULTI_CITY");
      expect(lead.segments.map((s) => [s.sequence, s.departureAirportId, s.arrivalAirportId, s.departureDate?.toISOString().slice(0, 10)])).toEqual([
        [1, airports.JFK, airports.LHR, "2026-10-20"],
        [2, airports.LHR, airports.CDG, "2026-10-24"],
        [3, airports.CDG, airports.JFK, "2026-10-30"],
      ]);
      expect(lead.departureAirportId).toBe(airports.JFK); // mirror of segment 1
      expect(lead.arrivalAirportId).toBe(airports.LHR);
      expect(lead.departureDate?.toISOString().slice(0, 10)).toBe("2026-10-20");
      expect(lead.returnDate).toBeNull();
    });

    it("the CRM shows all of them: the detail query returns the segments in order with their airports, and the list label is the whole chain", async () => {
      await post({
        tripType: "MULTI_CITY",
        segments: [
          { departureAirportIata: "JFK", arrivalAirportIata: "LHR", departureDate: "2026-10-20" },
          { departureAirportIata: "LHR", arrivalAirportIata: "CDG", departureDate: "2026-10-24" },
          { departureAirportIata: "CDG", arrivalAirportIata: "JFK", departureDate: "2026-10-30" },
        ],
      });
      const lead = await newestLead();
      const detail = await leadsQ.getLeadDetail(lead.id, viewer());
      expect(detail!.segments.map((s) => `${s.departureAirport?.iata}→${s.arrivalAirport?.iata}`)).toEqual(["JFK→LHR", "LHR→CDG", "CDG→JFK"]);
      const { leads } = await leadsQ.getLeads({ viewer: viewer(), pageSize: 100 });
      const row = leads.find((l) => l.id === lead.id)!;
      expect(itinerary.leadRouteLabel(row)).toBe("JFK → LHR → CDG → JFK");
      expect(itinerary.leadRouteLabel(detail!)).toBe("JFK → LHR → CDG → JFK");
    });

    it("two or more legs are treated as multi-city even if the form says nothing about the trip type; a lone leg on a round trip is just that trip's route", async () => {
      await post({ tripType: "ROUND_TRIP", segments: [{ departureAirportIata: "JFK", arrivalAirportIata: "LHR" }, { departureAirportIata: "LHR", arrivalAirportIata: "CDG" }] });
      expect((await newestLead()).tripType).toBe("MULTI_CITY");
      await post({ tripType: "ROUND_TRIP", segments: [{ departureAirportIata: "JFK", arrivalAirportIata: "LHR" }] });
      const lone = await newestLead();
      expect(lone.tripType).toBe("ROUND_TRIP");
      expect(lone.segments).toHaveLength(0);
    });

    it("an unknown airport code in a leg is stored as 'not set' rather than rejecting the whole request", async () => {
      await post({ tripType: "MULTI_CITY", segments: [{ departureAirportIata: "JFK", arrivalAirportIata: "ZZZ" }, { departureAirportIata: "ZZZ", arrivalAirportIata: "LHR" }] });
      const lead = await newestLead();
      expect(lead.segments).toHaveLength(2);
      expect(lead.segments[0].arrivalAirportId).toBeNull();
    });

    it("more than the maximum number of legs is rejected with a clear error", async () => {
      const many = Array.from({ length: itinerary.MAX_LEAD_SEGMENTS + 1 }, () => ({ departureAirportIata: "JFK", arrivalAirportIata: "LHR" }));
      const r = await post({ tripType: "MULTI_CITY", segments: many });
      expect(r.status).toBe(400);
    });
  });

  describe("Travel Request: add, edit, remove and reorder segments in the CRM", () => {
    const seg = (from: string, to: string, date: string | null = null) => ({ departureAirportId: airports[from], arrivalAirportId: airports[to], departureDate: date });
    const read = async (leadId: string) => (await prisma.leadSegment.findMany({ where: { leadId }, orderBy: { sequence: "asc" }, include: { departureAirport: true, arrivalAirport: true } })).map((s) => `${s.sequence}:${s.departureAirport?.iata}→${s.arrivalAirport?.iata}:${s.departureDate?.toISOString().slice(0, 10) ?? "-"}`);

    it("add → edit → reorder → remove, each saved atomically, with the lead-level route re-mirrored from the first segment and Updated bumped", async () => {
      const { lead } = await makeLead({ tripType: "MULTI_CITY" });
      const before = (await leadRow(lead.id)).updatedAt.getTime();
      await sleep(20);

      await leadActions.setLeadSegments(lead.id, [seg("JFK", "LHR", "2026-10-20")]);
      expect(await read(lead.id)).toEqual(["1:JFK→LHR:2026-10-20"]);

      // add
      await leadActions.setLeadSegments(lead.id, [seg("JFK", "LHR", "2026-10-20"), seg("LHR", "CDG", "2026-10-24")]);
      expect(await read(lead.id)).toEqual(["1:JFK→LHR:2026-10-20", "2:LHR→CDG:2026-10-24"]);

      // edit the second leg
      await leadActions.setLeadSegments(lead.id, [seg("JFK", "LHR", "2026-10-20"), seg("LHR", "LAX", "2026-10-25")]);
      expect(await read(lead.id)).toEqual(["1:JFK→LHR:2026-10-20", "2:LHR→LAX:2026-10-25"]);

      // reorder
      await leadActions.setLeadSegments(lead.id, [seg("LHR", "LAX", "2026-10-25"), seg("JFK", "LHR", "2026-10-20")]);
      expect(await read(lead.id)).toEqual(["1:LHR→LAX:2026-10-25", "2:JFK→LHR:2026-10-20"]);
      const mirrored = await leadRow(lead.id);
      expect(mirrored.departureAirportId).toBe(airports.LHR);
      expect(mirrored.arrivalAirportId).toBe(airports.LAX);

      // remove one (down to a single segment)
      await leadActions.setLeadSegments(lead.id, [seg("JFK", "LHR", "2026-10-20")]);
      expect(await read(lead.id)).toEqual(["1:JFK→LHR:2026-10-20"]);
      expect((await leadRow(lead.id)).updatedAt.getTime()).toBeGreaterThan(before);
      expect(await prisma.activity.count({ where: { leadId: lead.id, type: "LEAD_UPDATED", description: { startsWith: "Updated itinerary" } } })).toBeGreaterThanOrEqual(4);
    });

    it("the LAST segment cannot be removed (an empty itinerary is refused and the saved one is untouched)", async () => {
      const { lead } = await makeLead({ tripType: "MULTI_CITY" });
      await leadActions.setLeadSegments(lead.id, [seg("JFK", "LHR"), seg("LHR", "CDG")]);
      await expect(leadActions.setLeadSegments(lead.id, [])).rejects.toThrow(/at least one flight segment/i);
      expect(await read(lead.id)).toHaveLength(2);
    });

    it("more than the maximum, an unknown airport, a malformed date, and a non-multi-city lead are all refused", async () => {
      const { lead } = await makeLead({ tripType: "MULTI_CITY" });
      await leadActions.setLeadSegments(lead.id, [seg("JFK", "LHR")]);
      await expect(leadActions.setLeadSegments(lead.id, Array.from({ length: itinerary.MAX_LEAD_SEGMENTS + 1 }, () => seg("JFK", "LHR")))).rejects.toThrow();
      await expect(leadActions.setLeadSegments(lead.id, [{ departureAirportId: 99999999, arrivalAirportId: airports.LHR, departureDate: null }])).rejects.toThrow(/airport/i);
      await expect(leadActions.setLeadSegments(lead.id, [{ departureAirportId: airports.JFK, arrivalAirportId: airports.LHR, departureDate: "not-a-date" }])).rejects.toThrow();
      expect(await read(lead.id)).toEqual(["1:JFK→LHR:-"]);
      const rt = await makeLead({ tripType: "ROUND_TRIP" });
      await expect(leadActions.setLeadSegments(rt.lead.id, [seg("JFK", "LHR")])).rejects.toThrow(/multi-city/i);
    });

    it("existing single-segment and round-trip leads are untouched by any of this", async () => {
      const rt = await makeLead({ tripType: "ROUND_TRIP" });
      const row = await leadsQ.getLeadDetail(rt.lead.id, viewer());
      expect(row!.segments).toHaveLength(0);
      expect(itinerary.leadRouteLabel(row!)).toBe("JFK → LHR");
    });

    it("a legacy multi-city lead (captured before segments existed) still shows its one route", async () => {
      const { lead } = await makeLead({ tripType: "MULTI_CITY" });
      const row = await leadsQ.getLeadDetail(lead.id, viewer());
      expect(row!.segments).toHaveLength(0);
      expect(itinerary.leadRouteLabel(row!)).toBe("JFK → LHR");
    });

    it("deleting the lead removes its segments with it (cascade) and nothing else", async () => {
      const { lead, contact } = await makeLead({ tripType: "MULTI_CITY" });
      await leadActions.setLeadSegments(lead.id, [seg("JFK", "LHR"), seg("LHR", "CDG")]);
      await leadActions.deleteLead(lead.id);
      expect(await prisma.leadSegment.count({ where: { leadId: lead.id } })).toBe(0);
      expect(await prisma.contact.count({ where: { id: contact.id } })).toBe(1);
    });
  });
});
