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
      findFirst: vi.fn(async ({ where }: { where: { email: { equals: string }; message: string } }) => {
        // The duplicate-submission guard's own lookup — a fresh scratch array per
        // test means "no recent duplicate" unless a test seeds one explicitly.
        return inquiries.find((i) => (i.email as string) === where.email.equals && i.message === where.message) ?? null;
      }),
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
  return new Request("http://localhost/api/public/crm-inquiry", {
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
  phone: "4155550123",
  phoneCountry: "US",
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

describe("POST /api/public/crm-inquiry", () => {
  it("creates the inquiry and notifies on the happy path (unchanged behavior)", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeRequest(BASE_BODY));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(inquiries).toHaveLength(1);
    expect(notifyNewInquiry).toHaveBeenCalledWith("company-1", json.id, "Jane Traveler", "CRM_WEBSITE");
    // Tagged as a CRM Inquiry — never a Business Flights Get In Touch inquiry.
    expect(inquiries[0].source).toBe("CRM_WEBSITE");
  });

  it("the source is fixed by the ROUTE — a forged `source` in the request body cannot move an inquiry into the other inbox", async () => {
    const { POST } = await import("../route");
    await POST(makeRequest({ ...BASE_BODY, source: "BUSINESS_FLIGHTS_WEBSITE" }));
    expect(inquiries[0].source).toBe("CRM_WEBSITE");
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

  // This route (unlike /api/public/contact-inquiry) opts into requirePhone,
  // honeypot and a duplicate-submission window — see route.ts.
  describe("phone is required and country-aware (this route only)", () => {
    it("rejects a missing phone with a clear, safe message and creates nothing", async () => {
      const { POST } = await import("../route");
      const { phone: _phone, ...withoutPhone } = BASE_BODY;
      void _phone;
      const res = await POST(makeRequest(withoutPhone));
      const json = await res.json();
      expect(res.status).toBe(400);
      expect(json).toEqual({ ok: false, error: "Please check the phone number and country code." });
      expect(inquiries).toHaveLength(0);
    });

    it("rejects a phone that cannot be parsed for the given country", async () => {
      const { POST } = await import("../route");
      const res = await POST(makeRequest({ ...BASE_BODY, phone: "123", phoneCountry: "US" }));
      expect(res.status).toBe(400);
      expect(inquiries).toHaveLength(0);
    });

    it("accepts an international number for a non-US country and stores it normalized to E.164", async () => {
      const { POST } = await import("../route");
      const res = await POST(makeRequest({ ...BASE_BODY, phone: "7911123456", phoneCountry: "GB" }));
      expect(res.status).toBe(200);
      expect(inquiries[0].phone).toBe("+447911123456");
    });
  });

  describe("honeypot (this route only)", () => {
    it("a filled honeypot field silently succeeds without creating an inquiry or notifying anyone", async () => {
      const { POST } = await import("../route");
      const res = await POST(makeRequest({ ...BASE_BODY, companyWebsite: "http://spam-bot.example" }));
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(inquiries).toHaveLength(0);
      expect(notifyNewInquiry).not.toHaveBeenCalled();
    });

    it("an empty honeypot field behaves like a normal submission", async () => {
      const { POST } = await import("../route");
      const res = await POST(makeRequest({ ...BASE_BODY, companyWebsite: "" }));
      expect(res.status).toBe(200);
      expect(inquiries).toHaveLength(1);
    });
  });

  describe("duplicate-submission guard (this route only)", () => {
    it("an identical resubmission (same email + message) returns the SAME id and does not create a second row or notify twice", async () => {
      const { POST } = await import("../route");
      const first = await (await POST(makeRequest(BASE_BODY))).json();
      const second = await (await POST(makeRequest(BASE_BODY))).json();
      expect(second.ok).toBe(true);
      expect(second.id).toBe(first.id);
      expect(inquiries).toHaveLength(1);
      expect(notifyNewInquiry).toHaveBeenCalledTimes(1);
    });

    it("a different message from the same visitor is NOT treated as a duplicate", async () => {
      const { POST } = await import("../route");
      await POST(makeRequest(BASE_BODY));
      await POST(makeRequest({ ...BASE_BODY, message: "A completely different question." }));
      expect(inquiries).toHaveLength(2);
    });
  });
});
