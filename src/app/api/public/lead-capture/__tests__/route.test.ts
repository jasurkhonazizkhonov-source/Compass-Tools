import { describe, it, expect, vi, beforeEach } from "vitest";

// Database-portability pass (Test F) — the public website lead-capture
// endpoint was previously the ONE bypass of the centralized, self-healing
// reference-data layer (it called prisma.airport.findUnique directly).
// Now routed through resolveAirportCodes, which itself self-heals from the
// bundled JSON on a fresh/unseeded database — these tests prove that
// change didn't break the route (a case-sensitivity regression was caught
// and fixed live during this exact pass, see reference-data.ts's own
// comment on resolveAirportCodes for why the map is keyed by the ORIGINAL
// input string, not a normalized one).

let companies: Map<string, { id: string }>;
let leads: Array<Record<string, unknown>>;
let resolvedAirports: Record<string, { id: number; iata: string } | null>;

// Exposed via vi.hoisted so individual tests can override its resolved
// value per-call (mockResolvedValueOnce) — Pass 10 needs to simulate an
// existing-Contact match with vs. without an owner, which the original
// fixed `() => ({ ownerId: null })` implementation couldn't express.
const { prismaContactFindUnique } = vi.hoisted(() => ({
  prismaContactFindUnique: vi.fn(async () => ({ ownerId: null as string | null })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    company: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => companies.get(where.id) ?? null),
    },
    contact: {
      findUnique: prismaContactFindUnique,
    },
    lead: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const lead = { id: `lead-${leads.length + 1}`, ...data };
        leads.push(lead);
        return { id: lead.id };
      }),
    },
  },
}));

vi.mock("@/server/contact-resolution", () => ({
  resolveContactForNewLead: vi.fn(async () => ({ contactId: "contact-1", isNewContact: true })),
}));

vi.mock("@/server/actions/lead-queue", () => ({
  distributeNewWebsiteLead: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/server/activity-log", () => ({
  logActivity: vi.fn(async () => {}),
}));

vi.mock("@/server/queries/reference-data", () => ({
  resolveAirportCodes: vi.fn(async (codes: string[]) => {
    const map: Record<string, { id: number; iata: string } | null> = {};
    for (const c of codes) map[c] = resolvedAirports[c] ?? null;
    return map;
  }),
}));

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/public/lead-capture", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const BASE_BODY = {
  companyId: "company-1",
  firstName: "Jane",
  lastName: "Traveler",
  phone: "+14155550100",
};

beforeEach(() => {
  companies = new Map([["company-1", { id: "company-1" }]]);
  leads = [];
  resolvedAirports = {};
  vi.clearAllMocks();
});

describe("POST /api/public/lead-capture — airport resolution (Test F)", () => {
  it("resolves an uppercase IATA code to a real departureAirportId, even on a database that only just self-healed", async () => {
    resolvedAirports = { LAX: { id: 42, iata: "LAX" } };
    const { POST } = await import("../route");
    const res = await POST(makeRequest({ ...BASE_BODY, departureAirportIata: "LAX" }));
    expect(res.status).toBe(200);
    expect(leads[0].departureAirportId).toBe(42);
  });

  it("resolves a lowercase IATA code just as correctly (bug fix regression guard — the route uppercases once and reuses that exact value for both the resolve call and the lookup)", async () => {
    resolvedAirports = { LAX: { id: 42, iata: "LAX" } };
    const { POST } = await import("../route");
    const res = await POST(makeRequest({ ...BASE_BODY, departureAirportIata: "lax" }));
    expect(res.status).toBe(200);
    expect(leads[0].departureAirportId).toBe(42);
  });

  it("an unknown/unresolvable airport code never blocks submission — the lead is still created, with that airport field simply omitted", async () => {
    resolvedAirports = {}; // nothing resolves
    const { POST } = await import("../route");
    const res = await POST(makeRequest({ ...BASE_BODY, departureAirportIata: "ZZZ" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(leads[0].departureAirportId).toBeUndefined();
  });

  it("both departure and arrival airports resolve independently in the same request", async () => {
    resolvedAirports = { LAX: { id: 42, iata: "LAX" }, JFK: { id: 99, iata: "JFK" } };
    const { POST } = await import("../route");
    const res = await POST(makeRequest({ ...BASE_BODY, departureAirportIata: "LAX", arrivalAirportIata: "JFK" }));
    expect(res.status).toBe(200);
    expect(leads[0].departureAirportId).toBe(42);
    expect(leads[0].arrivalAirportId).toBe(99);
  });

  it("works fine with no airport codes supplied at all (both optional)", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeRequest(BASE_BODY));
    expect(res.status).toBe(200);
    expect(leads[0].departureAirportId).toBeUndefined();
    expect(leads[0].arrivalAirportId).toBeUndefined();
  });

  it("rejects an unknown company as a 400, never attempting airport resolution or lead creation", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeRequest({ ...BASE_BODY, companyId: "no-such-company" }));
    expect(res.status).toBe(400);
    expect(leads).toHaveLength(0);
  });

  it("rejects malformed JSON gracefully as a 400, not a 500 or crash", async () => {
    const { POST } = await import("../route");
    const badReq = new Request("http://localhost/api/public/lead-capture", { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
    const res = await POST(badReq);
    expect(res.status).toBe(400);
  });
});

// Pass 6 — this unauthenticated endpoint previously accepted `phone` as any
// 1-50 character string with zero format validation. A direct POST here
// (not just the real website widget) must not be able to create a Lead
// with a garbage phone value.
describe("POST /api/public/lead-capture — phone/email validation (Pass 6)", () => {
  it("rejects an unparseable phone number as a 400, never creating a lead", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeRequest({ ...BASE_BODY, phone: "123" }));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/phone/i);
    expect(leads).toHaveLength(0);
  });

  it("still accepts a real international number with no leading '+' recoverable as NANP (Excel-mangled recovery)", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeRequest({ ...BASE_BODY, phone: "14155550100" }));
    expect(res.status).toBe(200);
  });

  it("rejects a malformed email while phone is valid", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeRequest({ ...BASE_BODY, email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(leads).toHaveLength(0);
  });

  it("trims a submitted email before it reaches contact resolution", async () => {
    const { POST } = await import("../route");
    const { resolveContactForNewLead } = await import("@/server/contact-resolution");
    await POST(makeRequest({ ...BASE_BODY, email: "  spaced@example.com  " }));
    expect(vi.mocked(resolveContactForNewLead)).toHaveBeenCalledWith(
      expect.anything(),
      "spaced@example.com",
      expect.anything(),
      expect.anything()
    );
  });

  it("still works with no email at all (optional field, unaffected by the new phone check)", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeRequest(BASE_BODY));
    expect(res.status).toBe(200);
  });
});

// Pass 10 §1/§5/§10 — traced this workflow end to end: a website request
// must never become invisible merely because nobody was available in the
// Lead Queue. These tests prove the actual, current behavior of the real
// route (not an assumption) for the specific scenarios Pass 10 is
// concerned with.
describe("POST /api/public/lead-capture — unassigned outcome when nobody is accepting leads (Pass 10 §1/§5/§10)", () => {
  it("a brand-new Contact (no existing owner) creates the Lead with assignedAgentId left unset — never auto-assigned to anyone", async () => {
    const { resolveContactForNewLead } = await import("@/server/contact-resolution");
    vi.mocked(resolveContactForNewLead).mockResolvedValueOnce({ contactId: "contact-new", isNewContact: true });
    const { POST } = await import("../route");
    const res = await POST(makeRequest(BASE_BODY));

    expect(res.status).toBe(200);
    expect(leads[0].assignedAgentId).toBeUndefined(); // Prisma's own "not set" — stored as NULL
  });

  it("the Lead is still successfully created and stored even when distributeNewWebsiteLead reports no active queue workers — never silently dropped", async () => {
    const { distributeNewWebsiteLead } = await import("@/server/actions/lead-queue");
    vi.mocked(distributeNewWebsiteLead).mockResolvedValueOnce({ offered: false, reason: "no_active_workers" });
    const { POST } = await import("../route");
    const res = await POST(makeRequest(BASE_BODY));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(leads).toHaveLength(1);
    expect(leads[0].assignedAgentId).toBeUndefined();
    // Status is the existing, unchanged default for this path — Pass 10
    // deliberately does not introduce a new "Unassigned"/"Queue Failed"
    // status; ownership (not status) represents this state.
    expect(leads[0].status).toBe("ATTEMPTING_TO_CONTACT");
  });

  it("even if distributeNewWebsiteLead itself throws, the Lead has already been created and committed (best-effort distribution, never lead-losing)", async () => {
    const { distributeNewWebsiteLead } = await import("@/server/actions/lead-queue");
    vi.mocked(distributeNewWebsiteLead).mockRejectedValueOnce(new Error("transient queue error"));
    const { POST } = await import("../route");
    const res = await POST(makeRequest(BASE_BODY));

    expect(res.status).toBe(200);
    expect(leads).toHaveLength(1);
  });

  it("a matched Contact WITH an existing owner assigns the Lead directly to that owner and never calls distributeNewWebsiteLead at all", async () => {
    const { resolveContactForNewLead } = await import("@/server/contact-resolution");
    const { distributeNewWebsiteLead } = await import("@/server/actions/lead-queue");
    vi.mocked(resolveContactForNewLead).mockResolvedValueOnce({ contactId: "contact-owned", isNewContact: false });
    vi.mocked(prismaContactFindUnique).mockResolvedValueOnce({ ownerId: "agent-existing" });

    const { POST } = await import("../route");
    const res = await POST(makeRequest(BASE_BODY));

    expect(res.status).toBe(200);
    expect(leads[0].assignedAgentId).toBe("agent-existing");
    expect(leads[0].status).toBe("ACCEPTED");
    expect(distributeNewWebsiteLead).not.toHaveBeenCalled();
  });

  it("a matched Contact with NO existing owner still goes to the queue (isNewContact: false, ownerId: null)", async () => {
    const { resolveContactForNewLead } = await import("@/server/contact-resolution");
    const { distributeNewWebsiteLead } = await import("@/server/actions/lead-queue");
    vi.mocked(resolveContactForNewLead).mockResolvedValueOnce({ contactId: "contact-unowned", isNewContact: false });
    vi.mocked(prismaContactFindUnique).mockResolvedValueOnce({ ownerId: null });

    const { POST } = await import("../route");
    const res = await POST(makeRequest(BASE_BODY));

    expect(res.status).toBe(200);
    expect(leads[0].assignedAgentId).toBeUndefined();
    expect(distributeNewWebsiteLead).toHaveBeenCalledWith(leads[0].id);
  });
});
