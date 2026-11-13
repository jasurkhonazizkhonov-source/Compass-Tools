// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { deriveInquiryId } from "@/server/inquiry-id";

// REAL-DATABASE proof of the Business Flights "Get In Touch" idempotency (POST /api/public/contact-inquiry with a `submissionId`), which is built on
// a derived primary key and two transaction-scoped advisory locks (src/server/public-inquiry.ts). The mocked tests in
// src/server/__tests__/public-inquiry-idempotency.test.ts prove the handler's LOGIC; only a real PostgreSQL can prove what they cannot:
//   * pg_advisory_xact_lock(hashtextextended(...)) really serialises requests inside Prisma's interactive transaction on the pg adapter,
//   * the explicit-id insert really collides on the primary key, and the two-lock order really cannot deadlock,
//   * the second transaction really sees the first one's committed row (READ COMMITTED) after it acquires the lock.
//
// Runs ONLY when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL (the project's fail-closed guard, src/test/integration-database-guard.ts,
// accepts nothing but the local `compass_test` database) with this repo's migrations applied. Without it the whole file is skipped - which is the
// state it was written in: it has NOT been run yet. Creates its own company and deletes everything it created.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) process.env.DATABASE_URL = URL_UNDER_TEST;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const TAG = `pidem-${Date.now()}`;
const COMPANY = `${TAG}-co`;
const SOURCE = "BUSINESS_FLIGHTS_WEBSITE";

describe.skipIf(!enabled)("contact-inquiry idempotency (submissionId) - real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let route: typeof import("@/app/api/public/contact-inquiry/route");
  let ip = 0;
  let n = 0;

  const post = (payload: unknown) =>
    route.POST(
      new Request("http://localhost/api/public/contact-inquiry", {
        method: "POST",
        body: JSON.stringify(payload),
        // A distinct client IP per request keeps the shared rate limiter out of the way.
        headers: { "content-type": "application/json", "x-forwarded-for": `10.8.${Math.floor(++ip / 250)}.${ip % 250}` },
      })
    );
  const key = () => `${TAG}-key-${++n}`;
  const body = (over: Record<string, unknown> = {}) => ({
    companyId: COMPANY,
    firstName: "Idem",
    lastName: "Potent",
    email: `idem-${TAG}@example.test`,
    phone: "+14155550142",
    subject: "GENERAL_INQUIRY",
    message: `First message ${TAG}`,
    ...over,
  });
  const rows = () => prisma.contactInquiry.findMany({ where: { companyId: COMPANY }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    route = await import("@/app/api/public/contact-inquiry/route");
    await prisma.company.create({ data: { id: COMPANY, name: "Idempotency Co", signatureTemplate: "x" } });
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

  it("a keyed submission is stored once, under the derived id", async () => {
    const k = key();
    const res = await post(body({ submissionId: k }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.duplicate).toBeUndefined();
    const expectedId = deriveInquiryId(COMPANY, SOURCE, k);
    expect(json.id).toBe(expectedId);
    expect(expectedId).toMatch(/^c[0-9a-f]{24}$/);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(expectedId);
    expect(stored[0].source).toBe(SOURCE);
  });

  it("a resend after a lost reply (same key, same text) stores nothing new and answers duplicate:true with the same id", async () => {
    const k = key();
    const first = await (await post(body({ submissionId: k }))).json();
    const again = await post(body({ submissionId: k }));
    const json = await again.json();
    expect(again.status).toBe(200);
    expect(json).toMatchObject({ ok: true, id: first.id, duplicate: true });
    expect(await rows()).toHaveLength(1);
  });

  it("SIMULTANEOUS identical keyed requests serialise on the advisory lock: exactly one row, one id, the rest answered as duplicates", async () => {
    const k = key();
    const results = await Promise.all(Array.from({ length: 8 }, () => post(body({ submissionId: k }))));
    const jsons = await Promise.all(results.map((r) => r.json()));
    expect(results.map((r) => r.status)).toEqual(Array(8).fill(200)); // no 500 from a lost race, a deadlock or a lock timeout
    expect(new Set(jsons.map((j) => j.id)).size).toBe(1);
    expect(jsons.filter((j) => j.duplicate === true)).toHaveLength(7);
    expect(await rows()).toHaveLength(1);
  });

  it("SIMULTANEOUS requests with the SAME key but DIFFERENT messages: one is stored, the others get 409, none is a 500, and no deadlock occurs", async () => {
    const k = key();
    const messages = ["Message A", "Message B", "Message C", "Message D"].map((m) => `${m} ${TAG}`);
    const results = await Promise.all(messages.flatMap((message) => [post(body({ submissionId: k, message })), post(body({ submissionId: k, message }))]));
    const statuses = results.map((r) => r.status);
    expect(statuses.every((s) => s === 200 || s === 409), `unexpected statuses: ${statuses.join(",")}`).toBe(true);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(messages).toContain(stored[0].message); // the winner's text, unmodified by any loser
  });

  it("the same key reused later for a different message or a different e-mail is refused (409) and never overwrites the stored inquiry", async () => {
    const k = key();
    await post(body({ submissionId: k }));
    const otherMessage = await post(body({ submissionId: k, message: `Different text ${TAG}` }));
    const otherEmail = await post(body({ submissionId: k, email: `someone-else-${TAG}@example.test` }));
    expect(otherMessage.status).toBe(409);
    expect(otherEmail.status).toBe(409);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0].message).toBe(`First message ${TAG}`);
    expect(stored[0].email).toBe(`idem-${TAG}@example.test`);
  });

  it("different keys with different messages from the same address are stored separately", async () => {
    await post(body({ submissionId: key(), message: `One ${TAG}` }));
    await post(body({ submissionId: key(), message: `Two ${TAG}` }));
    expect(await rows()).toHaveLength(2);
  });

  it("a keyed row coexists with a cuid-keyed row, and an UNKEYED request is still stored on every call exactly as before (no content de-duplication)", async () => {
    await post(body()); // unkeyed -> generated id
    await post(body()); // unkeyed again -> a second row
    const keyed = await (await post(body({ submissionId: key() }))).json();
    const stored = await rows();
    expect(stored).toHaveLength(3);
    expect(new Set(stored.map((r) => r.id)).size).toBe(3);
    expect(stored.some((r) => r.id === keyed.id)).toBe(true);
  });

  it("the same key in another company is a different inquiry (the company is part of the derived id)", async () => {
    const OTHER = `${TAG}-other`;
    await prisma.company.create({ data: { id: OTHER, name: "Other Co", signatureTemplate: "x" } });
    try {
      const k = key();
      const a = await (await post(body({ submissionId: k }))).json();
      const b = await (await post(body({ submissionId: k, companyId: OTHER }))).json();
      expect(a.id).not.toBe(b.id);
      expect(await prisma.contactInquiry.count({ where: { companyId: { in: [COMPANY, OTHER] } } })).toBe(2);
    } finally {
      await prisma.contactInquiry.deleteMany({ where: { companyId: OTHER } });
      await prisma.company.delete({ where: { id: OTHER } }).catch(() => undefined);
    }
  });
});
