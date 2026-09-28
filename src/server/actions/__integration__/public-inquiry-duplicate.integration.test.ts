// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// REAL-DATABASE proof of the CRM contact form's duplicate-submission guard
// under genuine concurrency (a double-click fires two requests within
// milliseconds), plus proof that the Business Flights Get In Touch route does
// NOT get the CRM route's stricter behavior. Runs only when
// INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL with this repo's
// migrations applied. Creates its own company and deletes it afterward.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) process.env.DATABASE_URL = URL_UNDER_TEST;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const TAG = `pidup-${Date.now()}`;
const COMPANY = `${TAG}-co`;

describe.skipIf(!enabled)("public inquiry duplicate guard — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let crmRoute: typeof import("@/app/api/public/crm-inquiry/route");
  let bfRoute: typeof import("@/app/api/public/contact-inquiry/route");
  let ip = 0;

  const post = (route: { POST: (r: Request) => Promise<Response> }, payload: unknown) =>
    route.POST(
      new Request("http://localhost/api/public/x", {
        method: "POST",
        body: JSON.stringify(payload),
        // A distinct client IP per request keeps the shared rate limiter out of the way.
        headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${Math.floor(++ip / 250)}.${ip % 250}` },
      })
    );

  const body = (over: Record<string, unknown> = {}) => ({
    companyId: COMPANY,
    firstName: "Dup",
    lastName: "Check",
    email: `dup-${TAG}@example.test`,
    phone: "4155550142",
    phoneCountry: "US",
    subject: "GENERAL_INQUIRY",
    message: `Concurrent message ${TAG}`,
    ...over,
  });

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    crmRoute = await import("@/app/api/public/crm-inquiry/route");
    bfRoute = await import("@/app/api/public/contact-inquiry/route");
    await prisma.company.create({ data: { id: COMPANY, name: "Dup Co", signatureTemplate: "x" } });
  });

  afterAll(async () => {
    if (!enabled) return;
    await prisma.notification.deleteMany({ where: { account: { companyId: COMPANY } } });
    await prisma.contactInquiry.deleteMany({ where: { companyId: COMPANY } });
    await prisma.company.delete({ where: { id: COMPANY } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.contactInquiry.deleteMany({ where: { companyId: COMPANY } });
  });

  it("simultaneous identical CRM submissions create exactly ONE row and return the same id", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => post(crmRoute, body())));
    const jsons = await Promise.all(results.map((r) => r.json()));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(jsons.map((j) => j.id)).size).toBe(1);
    const rows = await prisma.contactInquiry.findMany({ where: { companyId: COMPANY } });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("CRM_WEBSITE");
    expect(rows[0].phone).toBe("+14155550142");
  });

  it("a different message from the same visitor is stored separately", async () => {
    await post(crmRoute, body());
    await post(crmRoute, body({ message: `Another question ${TAG}` }));
    expect(await prisma.contactInquiry.count({ where: { companyId: COMPANY } })).toBe(2);
  });

  it("the Business Flights Get In Touch route keeps its lenient behavior: no phone required, no duplicate collapsing, disposable domain not screened", async () => {
    const { phone: _p, phoneCountry: _c, ...noPhone } = body({ email: `bf-${TAG}@mailinator.com` });
    void _p;
    void _c;
    const a = await post(bfRoute, noPhone);
    const b = await post(bfRoute, noPhone);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const rows = await prisma.contactInquiry.findMany({ where: { companyId: COMPANY } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.source === "BUSINESS_FLIGHTS_WEBSITE")).toBe(true);

    // The CRM route, by contrast, rejects the same disposable address.
    const crm = await post(crmRoute, body({ email: `crm-${TAG}@mailinator.com` }));
    expect(crm.status).toBe(400);
  });
});
