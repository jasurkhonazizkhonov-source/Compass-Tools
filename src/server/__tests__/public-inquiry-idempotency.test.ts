import { describe, it, expect, vi, beforeEach } from "vitest";
import { deriveInquiryId } from "../inquiry-id";

// Idempotent "Get In Touch" submissions. The website sends a per-submission key (`submissionId`); the CRM derives the inquiry's primary key from
// (company, inbox, key), so a double click, a retry after a timeout, two simultaneous identical requests and a retry after a LOST answer all land on
// ONE row, while a different message (or a different person) is always stored on its own. No schema change.
//
// These tests use an in-memory stand-in for the database (no PostgreSQL is involved): transactions are serialised the way the real advisory lock
// serialises them, `create` with an existing id fails like a primary-key collision would, and the rows are real objects the assertions can inspect.
// They prove the HANDLER's logic; the real lock and primary key are exercised only by the (deferred) database integration suite.

type Row = Record<string, unknown> & { id: string };
let rows: Row[];
let notified: string[];
let txChain: Promise<unknown>;
let nextId: number;

vi.mock("@/server/admin-notifications", () => ({ notifyNewInquiry: vi.fn(async (_c: string, id: string) => void notified.push(id)) }));
vi.mock("@/server/geo/ip-geolocation", () => ({ lookupIpLocation: vi.fn(async () => ({ status: "unresolved", reason: "not-found" })) }));
vi.mock("@/server/security/rate-limit", () => ({
  checkPublicRateLimit: vi.fn(async () => ({ allowed: true })),
  RATE_LIMITS: { CONTACT_INQUIRY: { windowMs: 1, maxAttempts: 1 }, CRM_INQUIRY: { windowMs: 1, maxAttempts: 1 } },
}));
vi.mock("@/lib/prisma", () => {
  const contactInquiry = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const email = (where.email as { equals: string }).equals.toLowerCase();
      return rows.find((r) => r.companyId === where.companyId && r.source === where.source && String(r.email).toLowerCase() === email && r.message === where.message) ?? null;
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const id = (data.id as string | undefined) ?? `auto-${++nextId}`;
      if (rows.some((r) => r.id === id)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      const row = { ...data, id } as Row;
      rows.push(row);
      return row;
    }),
  };
  const prisma: Record<string, unknown> = {
    company: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })) },
    contact: { findFirst: vi.fn(async () => null) },
    contactInquiry,
    $executeRaw: vi.fn(async () => 0),
  };
  // One transaction at a time: what pg_advisory_xact_lock does for requests that share a lock key.
  prisma.$transaction = (fn: (tx: unknown) => Promise<unknown>) => {
    const run = txChain.then(() => fn(prisma));
    txChain = run.catch(() => undefined);
    return run;
  };
  return { prisma };
});

const BODY = { companyId: "company-1", firstName: "Jane", lastName: "Traveler", email: "jane@example.com", phone: "4155550123", phoneCountry: "US", subject: "GENERAL_INQUIRY", message: "Hello, I have a question about business class fares." };
const KEY = "form-3f9c2a7e-1b64-4d0e-9a55-0c7d1e2f3a4b.7d2f1c0a9b8e";
const post = (body: Record<string, unknown>) =>
  new Request("http://localhost/api/public/contact-inquiry", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const send = async (body: Record<string, unknown>) => {
  const { POST } = await import("@/app/api/public/contact-inquiry/route");
  const res = await POST(post(body));
  return { status: res.status, json: (await res.json()) as { ok: boolean; id?: string; duplicate?: boolean; error?: string } };
};

beforeEach(() => {
  rows = [];
  notified = [];
  txChain = Promise.resolve();
  nextId = 0;
});

describe("deriveInquiryId", () => {
  it("is stable, cuid-shaped and depends on company, inbox and key", () => {
    const a = deriveInquiryId("company-1", "BUSINESS_FLIGHTS_WEBSITE", KEY);
    expect(a).toBe(deriveInquiryId("company-1", "BUSINESS_FLIGHTS_WEBSITE", KEY));
    expect(a).toMatch(/^c[0-9a-f]{24}$/);
    expect(a).not.toBe(deriveInquiryId("company-2", "BUSINESS_FLIGHTS_WEBSITE", KEY));
    expect(a).not.toBe(deriveInquiryId("company-1", "CRM_WEBSITE", KEY));
    expect(a).not.toBe(deriveInquiryId("company-1", "BUSINESS_FLIGHTS_WEBSITE", KEY + "x"));
  });
});

describe("POST /api/public/contact-inquiry with a submission key", () => {
  it("a first submission is stored once, under the derived id, and the team is notified once", async () => {
    const r = await send({ ...BODY, submissionId: KEY });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, id: deriveInquiryId("company-1", "BUSINESS_FLIGHTS_WEBSITE", KEY) });
    expect(r.json.duplicate).toBeUndefined(); // additive flag appears only on repeats
    expect(rows).toHaveLength(1);
    expect(notified).toHaveLength(1);
  });

  it("the same request sent twice (double click) stores ONE row and answers the repeat as a duplicate with the same id", async () => {
    const first = await send({ ...BODY, submissionId: KEY });
    const second = await send({ ...BODY, submissionId: KEY });
    expect(second.status).toBe(200);
    expect(second.json).toEqual({ ok: true, id: first.json.id, duplicate: true });
    expect(rows).toHaveLength(1);
    expect(notified).toHaveLength(1); // no second alert either
  });

  it("a retry after a timeout or a lost answer (the first request WAS stored) does not create a second row", async () => {
    await send({ ...BODY, submissionId: KEY }); // stored, but the website never saw the reply
    const retry = await send({ ...BODY, submissionId: KEY }); // the website's retry
    expect(retry.json.ok).toBe(true);
    expect(retry.json.duplicate).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it("two SIMULTANEOUS identical submissions store exactly one row", async () => {
    const results = await Promise.all([send({ ...BODY, submissionId: KEY }), send({ ...BODY, submissionId: KEY }), send({ ...BODY, submissionId: KEY })]);
    expect(results.every((r) => r.status === 200 && r.json.ok)).toBe(true);
    expect(results.filter((r) => r.json.duplicate).length).toBe(2);
    expect(new Set(results.map((r) => r.json.id)).size).toBe(1);
    expect(rows).toHaveLength(1);
    expect(notified).toHaveLength(1);
  });

  it("different messages from the SAME email are stored separately (different keys)", async () => {
    const a = await send({ ...BODY, message: "First question about a flight to Paris.", submissionId: "key-aaaaaaaa-1" });
    const b = await send({ ...BODY, message: "A second, different question about Rome.", submissionId: "key-bbbbbbbb-2" });
    expect(a.json.id).not.toBe(b.json.id);
    expect(rows).toHaveLength(2);
    expect(notified).toHaveLength(2);
  });

  it("different people never collide, even with the same message text", async () => {
    const a = await send({ ...BODY, email: "jane@example.com", submissionId: "key-aaaaaaaa-1" });
    const b = await send({ ...BODY, email: "john@example.com", submissionId: "key-bbbbbbbb-2" });
    expect(a.json.id).not.toBe(b.json.id);
    expect(rows).toHaveLength(2);
  });

  it("the same key reused for a DIFFERENT message is refused (409) and never overwrites the stored one", async () => {
    await send({ ...BODY, submissionId: KEY });
    const clash = await send({ ...BODY, message: "A completely different message under the same key.", submissionId: KEY });
    expect(clash.status).toBe(409);
    expect(clash.json.ok).toBe(false);
    expect(clash.json.id).toBeUndefined(); // the stored inquiry's id is not revealed
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe(BODY.message);
    expect(notified).toHaveLength(1);
  });

  it("the same key from a different email is a conflict too", async () => {
    await send({ ...BODY, submissionId: KEY });
    const clash = await send({ ...BODY, email: "someone.else@example.com", submissionId: KEY });
    expect(clash.status).toBe(409);
    expect(rows).toHaveLength(1);
  });

  it("an email that differs only in letter case is the same submission", async () => {
    await send({ ...BODY, submissionId: KEY });
    const again = await send({ ...BODY, email: "JANE@Example.com", submissionId: KEY });
    expect(again.json.duplicate).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it("a malformed key is a validation failure, not a stored row", async () => {
    for (const bad of ["short", "has spaces in it", "x".repeat(201), "semi;colon;key;value", 12345678]) {
      const r = await send({ ...BODY, submissionId: bad });
      expect(r.status, String(bad)).toBe(400);
    }
    expect(rows).toHaveLength(0);
  });
});

describe("POST /api/public/contact-inquiry without a submission key (older website builds)", () => {
  it("still works: the message is stored once and no key is required", async () => {
    const r = await send(BODY);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it("is stored exactly as before: no key, no content-based de-duplication, no change to the response", async () => {
    const a = await send(BODY);
    const b = await send(BODY);
    expect(a.json.duplicate).toBeUndefined();
    expect(b.json.duplicate).toBeUndefined();
    expect(a.json.id).not.toBe(b.json.id);
    expect(rows).toHaveLength(2); // nothing changes for a caller that sends no key (the older website build)
  });
});

describe("the key is opt-in per route", () => {
  it("a route that does not opt in ignores the field and stores a normal row", async () => {
    const { POST } = await import("@/app/api/public/crm-inquiry/route");
    const res = await POST(post({ ...BODY, submissionId: KEY }));
    expect(res.status).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^auto-/); // not the derived id
  });
});
