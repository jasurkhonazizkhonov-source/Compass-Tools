// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// REAL-DATABASE proof that the two inquiry systems stay SEPARATE:
//   - Business Flights "Get In Touch" (source BUSINESS_FLIGHTS_WEBSITE)
//   - CRM Inquiries                    (source CRM_WEBSITE)
// They share one table (ContactInquiry) — the only inquiry table that exists;
// the Business Flights website app inserts into it directly — so every list,
// detail, mutation and notification must be scoped by source. Runs only when
// INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL with this repo's
// migrations applied (see booking-submit.integration.test.ts). Creates its own
// company and deletes it afterward.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) process.env.DATABASE_URL = URL_UNDER_TEST;

type Actor = { id: string; role: string; companyId: string; fullName: string; email: string; phone: string | null };
let currentActor: Actor | null = null;
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const TAG = `insep-${Date.now()}`;
const COMPANY = `${TAG}-co`;

describe.skipIf(!enabled)("Business Flights Get In Touch vs CRM Inquiries — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let actions: typeof import("../contact-inquiries");
  let queries: typeof import("@/server/queries/contact-inquiries");
  let notifications: typeof import("@/server/admin-notifications");
  let bfRoute: typeof import("@/app/api/public/contact-inquiry/route");
  let crmRoute: typeof import("@/app/api/public/crm-inquiry/route");
  let sourceMeta: typeof import("@/lib/inquiry-source");
  let admin: Actor;
  let manager: Actor;
  let n = 0;

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    actions = await import("../contact-inquiries");
    queries = await import("@/server/queries/contact-inquiries");
    notifications = await import("@/server/admin-notifications");
    bfRoute = await import("@/app/api/public/contact-inquiry/route");
    crmRoute = await import("@/app/api/public/crm-inquiry/route");
    sourceMeta = await import("@/lib/inquiry-source");
    await prisma.company.create({ data: { id: COMPANY, name: "Separation Co", signatureTemplate: "x" } });
    const a = await prisma.account.create({ data: { fullName: "Admin One", email: `admin-${TAG}@example.test`, role: "ADMIN", companyId: COMPANY } });
    const m = await prisma.account.create({ data: { fullName: "Manager One", email: `mgr-${TAG}@example.test`, role: "MANAGER", companyId: COMPANY } });
    admin = { id: a.id, role: "ADMIN", companyId: COMPANY, fullName: a.fullName, email: a.email, phone: null };
    manager = { id: m.id, role: "MANAGER", companyId: COMPANY, fullName: m.fullName, email: m.email, phone: null };
  });

  afterAll(async () => {
    if (!enabled) return;
    await prisma.notification.deleteMany({ where: { account: { companyId: COMPANY } } });
    await prisma.contactInquiry.deleteMany({ where: { companyId: COMPANY } });
    await prisma.account.deleteMany({ where: { companyId: COMPANY } });
    await prisma.company.delete({ where: { id: COMPANY } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    currentActor = admin;
    await prisma.notification.deleteMany({ where: { account: { companyId: COMPANY } } });
    await prisma.contactInquiry.deleteMany({ where: { companyId: COMPANY } });
    notifications.resetInquiryCatchUpThrottleForTests();
  });

  const body = (label: string) => ({
    companyId: COMPANY,
    firstName: label,
    lastName: "Sample",
    email: `${label.toLowerCase()}-${++n}@example.test`,
    phone: "+15550100",
    subject: "GENERAL_INQUIRY",
    message: `Message from ${label}`,
  });
  const post = (route: { POST: (r: Request) => Promise<Response> }, payload: unknown, url = "http://localhost/api/public/x") =>
    route.POST(new Request(url, { method: "POST", body: JSON.stringify(payload), headers: { "content-type": "application/json" } }));

  /** Mimics the Business Flights website app: a raw insert with NO source column. */
  async function insertLikeBusinessFlightsWebsite(firstName: string) {
    const id = `${TAG}-bf-${++n}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ContactInquiry" ("id","companyId","firstName","lastName","email","phone","subject","message","status","updatedAt")
       VALUES ($1,$2,$3,'Website','bf@example.test','+15550111','FLIGHT_REQUEST_HELP','From the Business Flights website','NEW',now())`,
      id, COMPANY, firstName
    );
    return id;
  }

  it("a row inserted by the Business Flights website app (no source column) is classified Business Flights by the column default", async () => {
    const id = await insertLikeBusinessFlightsWebsite("Bea");
    expect((await prisma.contactInquiry.findUniqueOrThrow({ where: { id } })).source).toBe("BUSINESS_FLIGHTS_WEBSITE");
  });

  it("each public route tags its own source; a forged `source` in the body is ignored", async () => {
    const bf = await (await post(bfRoute, { ...body("Bf"), source: "CRM_WEBSITE" })).json();
    const crm = await (await post(crmRoute, { ...body("Crm"), source: "BUSINESS_FLIGHTS_WEBSITE" })).json();
    expect((await prisma.contactInquiry.findUniqueOrThrow({ where: { id: bf.id } })).source).toBe("BUSINESS_FLIGHTS_WEBSITE");
    expect((await prisma.contactInquiry.findUniqueOrThrow({ where: { id: crm.id } })).source).toBe("CRM_WEBSITE");
  });

  it("each inbox lists ONLY its own records (and counts only its own unread)", async () => {
    const siteId = await insertLikeBusinessFlightsWebsite("Bea");
    const viaBfRoute = (await (await post(bfRoute, body("Bob"))).json()).id;
    const viaCrmRoute = (await (await post(crmRoute, body("Cara"))).json()).id;

    const bf = await queries.getContactInquiries({ companyId: COMPANY, source: "BUSINESS_FLIGHTS_WEBSITE" });
    const crm = await queries.getContactInquiries({ companyId: COMPANY, source: "CRM_WEBSITE" });

    expect(bf.inquiries.map((i) => i.id).sort()).toEqual([siteId, viaBfRoute].sort());
    expect(crm.inquiries.map((i) => i.id)).toEqual([viaCrmRoute]);
    expect(await queries.getUnreadInquiryCount(COMPANY, "BUSINESS_FLIGHTS_WEBSITE")).toBe(2);
    expect(await queries.getUnreadInquiryCount(COMPANY, "CRM_WEBSITE")).toBe(1);
  });

  it("an id from the OTHER system is 'not found' in detail queries", async () => {
    const bfId = (await (await post(bfRoute, body("Bob"))).json()).id;
    const crmId = (await (await post(crmRoute, body("Cara"))).json()).id;

    expect(await queries.getContactInquiryDetail(bfId, COMPANY, "BUSINESS_FLIGHTS_WEBSITE")).not.toBeNull();
    expect(await queries.getContactInquiryDetail(bfId, COMPANY, "CRM_WEBSITE")).toBeNull();
    expect(await queries.getContactInquiryDetail(crmId, COMPANY, "CRM_WEBSITE")).not.toBeNull();
    expect(await queries.getContactInquiryDetail(crmId, COMPANY, "BUSINESS_FLIGHTS_WEBSITE")).toBeNull();
  });

  it("mutations issued from one section can NOT touch the other system's record (status, assignment, note, read, delete)", async () => {
    const bfId = (await (await post(bfRoute, body("Bob"))).json()).id;
    const crmId = (await (await post(crmRoute, body("Cara"))).json()).id;

    // Attempts from the CRM Inquiries section against a Business Flights record:
    await expect(actions.updateInquiryStatus(bfId, "CLOSED", "CRM_WEBSITE")).rejects.toThrow(/not found/i);
    await expect(actions.assignInquiry(bfId, admin.id, "CRM_WEBSITE")).rejects.toThrow(/not found/i);
    await expect(actions.addInquiryNote(bfId, "sneaky", "CRM_WEBSITE")).rejects.toThrow(/not found/i);
    await expect(actions.markInquiryRead(bfId, "CRM_WEBSITE")).rejects.toThrow(/not found/i);
    await expect(actions.deleteInquiry(bfId, "CRM_WEBSITE")).rejects.toThrow(/not found/i);
    // ...and the reverse direction.
    await expect(actions.updateInquiryStatus(crmId, "CLOSED", "BUSINESS_FLIGHTS_WEBSITE")).rejects.toThrow(/not found/i);
    await expect(actions.deleteInquiry(crmId, "BUSINESS_FLIGHTS_WEBSITE")).rejects.toThrow(/not found/i);

    const bf = await prisma.contactInquiry.findUniqueOrThrow({ where: { id: bfId }, include: { notes: true } });
    expect(bf).toMatchObject({ status: "NEW", assignedAdminId: null, readAt: null });
    expect(bf.notes).toHaveLength(0);
    expect(await prisma.contactInquiry.count({ where: { id: { in: [bfId, crmId] } } })).toBe(2);
  });

  it("mutations from the CORRECT section change only that record; deleting one leaves the other", async () => {
    const bfId = (await (await post(bfRoute, body("Bob"))).json()).id;
    const crmId = (await (await post(crmRoute, body("Cara"))).json()).id;

    await actions.updateInquiryStatus(bfId, "REPLIED", "BUSINESS_FLIGHTS_WEBSITE");
    await actions.assignInquiry(crmId, admin.id, "CRM_WEBSITE");
    await actions.addInquiryNote(crmId, "call back", "CRM_WEBSITE");

    expect((await prisma.contactInquiry.findUniqueOrThrow({ where: { id: bfId } })).status).toBe("REPLIED");
    expect((await prisma.contactInquiry.findUniqueOrThrow({ where: { id: crmId } })).status).toBe("NEW"); // untouched by the BF update
    expect((await prisma.contactInquiry.findUniqueOrThrow({ where: { id: crmId } })).assignedAdminId).toBe(admin.id);
    expect((await prisma.contactInquiry.findUniqueOrThrow({ where: { id: bfId } })).assignedAdminId).toBeNull();
    expect(await prisma.inquiryNote.count({ where: { inquiryId: crmId } })).toBe(1);
    expect(await prisma.inquiryNote.count({ where: { inquiryId: bfId } })).toBe(0);

    await actions.deleteInquiry(bfId, "BUSINESS_FLIGHTS_WEBSITE");
    expect(await prisma.contactInquiry.findUnique({ where: { id: bfId } })).toBeNull();
    expect(await prisma.contactInquiry.findUnique({ where: { id: crmId } })).not.toBeNull();
    expect(await prisma.inquiryNote.count({ where: { inquiryId: crmId } })).toBe(1); // the CRM record's own note survives
  });

  it("notifications name the right system and point at the right record and section", async () => {
    const bfId = (await (await post(bfRoute, body("Bob"))).json()).id;
    const crmId = (await (await post(crmRoute, body("Cara"))).json()).id;

    const rows = await prisma.notification.findMany({
      where: { accountId: admin.id, contactInquiryId: { in: [bfId, crmId] } },
      include: { contactInquiry: { select: { id: true, source: true } } },
    });
    const bf = rows.find((r) => r.contactInquiryId === bfId)!;
    const crm = rows.find((r) => r.contactInquiryId === crmId)!;
    expect(bf).toMatchObject({ type: "NEW_INQUIRY", title: "New Business Flights Get In Touch Message" });
    expect(crm).toMatchObject({ type: "NEW_CRM_INQUIRY", title: "New CRM Inquiry" });
    // The path the bell opens, derived from the LINKED inquiry's own source:
    expect(sourceMeta.inquiryDetailPath(bf.contactInquiry!.source, bf.contactInquiry!.id)).toBe(`/get-in-touch/${bfId}`);
    expect(sourceMeta.inquiryDetailPath(crm.contactInquiry!.source, crm.contactInquiry!.id)).toBe(`/crm-inquiries/${crmId}`);
    // Only Admins are notified.
    expect(await prisma.notification.count({ where: { accountId: manager.id } })).toBe(0);
  });

  it("an inquiry inserted by the Business Flights website app gets its notification via catch-up — once, Admin-only, typed by its own source", async () => {
    const id = await insertLikeBusinessFlightsWebsite("Bea");
    expect(await prisma.notification.count({ where: { contactInquiryId: id } })).toBe(0); // that app cannot create one

    expect(await notifications.ensureInquiryNotifications(COMPANY, Date.now())).toBe(1);
    const created = await prisma.notification.findMany({ where: { contactInquiryId: id } });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ accountId: admin.id, type: "NEW_INQUIRY" });

    // Idempotent: a second pass (after the throttle) creates nothing more.
    expect(await notifications.ensureInquiryNotifications(COMPANY, Date.now() + 60_000)).toBe(0);
    expect(await prisma.notification.count({ where: { contactInquiryId: id } })).toBe(1);
  });

  it("concurrent catch-up passes (several Admins polling at once) never create duplicate notifications", async () => {
    const id = await insertLikeBusinessFlightsWebsite("Bea");
    const start = Date.now() + 120_000;
    await Promise.all(Array.from({ length: 6 }, (_, i) => notifications.ensureInquiryNotifications(COMPANY, start + i * 60_000)));
    expect(await prisma.notification.count({ where: { contactInquiryId: id } })).toBe(1);
  });

  it("authorization: a Manager cannot use any inquiry action, in either section", async () => {
    const bfId = (await (await post(bfRoute, body("Bob"))).json()).id;
    const crmId = (await (await post(crmRoute, body("Cara"))).json()).id;
    currentActor = manager;

    await expect(actions.updateInquiryStatus(bfId, "CLOSED", "BUSINESS_FLIGHTS_WEBSITE")).rejects.toThrow(/Admins/i);
    await expect(actions.deleteInquiry(crmId, "CRM_WEBSITE")).rejects.toThrow(/Admins/i);
    currentActor = null;
    await expect(actions.markInquiryRead(bfId, "BUSINESS_FLIGHTS_WEBSITE")).rejects.toThrow(/Admins/i);
    expect(await prisma.contactInquiry.count({ where: { id: { in: [bfId, crmId] } } })).toBe(2);
  });

  it("company isolation still holds: another company's admin cannot see or change these records", async () => {
    const bfId = (await (await post(bfRoute, body("Bob"))).json()).id;
    expect((await queries.getContactInquiries({ companyId: "some-other-company", source: "BUSINESS_FLIGHTS_WEBSITE" })).total).toBe(0);
    expect(await queries.getContactInquiryDetail(bfId, "some-other-company", "BUSINESS_FLIGHTS_WEBSITE")).toBeNull();
  });
});
