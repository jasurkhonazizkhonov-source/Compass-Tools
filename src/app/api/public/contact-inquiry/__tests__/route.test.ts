import { describe, it, expect, vi, beforeEach } from "vitest";

// Real bug found and fixed: this route's database write path (contact
// lookup + contactInquiry.create) was unguarded, unlike its sibling
// lead-capture route — an unexpected database exception (e.g. the same
// class of transient connection failure the CRM's own connection-pool
// sizing fix addresses) would propagate as Next's own generic,
// unstructured error instead of this endpoint's own clean
// {ok:false,error} JSON shape the website's integration expects on every
// other failure path. These tests prove the happy path is unchanged and
// that a database failure now returns a safe, structured error instead of
// throwing uncaught.

let companies: Map<string, { id: string }>;
let inquiries: Array<Record<string, unknown>>;
let contactFindUniqueShouldThrow: boolean;
let inquiryCreateShouldThrow: boolean;

const notifyNewInquiry = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
vi.mock("@/server/admin-notifications", () => ({
  notifyNewInquiry: (...args: unknown[]) => notifyNewInquiry(...args),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    company: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => companies.get(where.id) ?? null),
    },
    contact: {
      findFirst: vi.fn(async () => {
        if (contactFindUniqueShouldThrow) throw new Error("connection terminated");
        return null;
      }),
    },
    contactInquiry: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (inquiryCreateShouldThrow) throw new Error("connection terminated");
        const inquiry = { id: `inquiry-${inquiries.length + 1}`, ...data };
        inquiries.push(inquiry);
        return inquiry;
      }),
    },
  },
}));

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/public/contact-inquiry", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const BASE_BODY = {
  companyId: "company-1",
  firstName: "Jane",
  lastName: "Traveler",
  email: "jane@example.com",
  subject: "GENERAL_INQUIRY",
  message: "Hello, I have a question.",
};

beforeEach(() => {
  companies = new Map([["company-1", { id: "company-1" }]]);
  inquiries = [];
  contactFindUniqueShouldThrow = false;
  inquiryCreateShouldThrow = false;
  vi.clearAllMocks();
});

describe("POST /api/public/contact-inquiry", () => {
  it("creates the inquiry and notifies on the happy path (unchanged behavior)", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeRequest(BASE_BODY));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(inquiries).toHaveLength(1);
    expect(notifyNewInquiry).toHaveBeenCalledWith("company-1", json.id, "Jane Traveler");
  });

  it("a database failure during the contact lookup returns a clean, structured error instead of throwing", async () => {
    contactFindUniqueShouldThrow = true;
    const { POST } = await import("../route");
    const res = await POST(makeRequest(BASE_BODY));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.ok).toBe(false);
    expect(typeof json.error).toBe("string");
    expect(inquiries).toHaveLength(0);
    expect(notifyNewInquiry).not.toHaveBeenCalled();
  });

  it("a database failure creating the inquiry returns a clean, structured error instead of throwing", async () => {
    inquiryCreateShouldThrow = true;
    const { POST } = await import("../route");
    const res = await POST(makeRequest(BASE_BODY));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.ok).toBe(false);
    expect(notifyNewInquiry).not.toHaveBeenCalled();
  });
});
