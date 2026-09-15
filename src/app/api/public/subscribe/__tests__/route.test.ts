import { describe, it, expect, vi, beforeEach } from "vitest";

// Real bug found and fixed: same class as contact-inquiry's own route —
// this route's database write path (subscriber lookup + upsert) was
// unguarded, unlike its sibling lead-capture route. These tests prove the
// happy path (both new-subscriber and re-subscribe) is unchanged, and
// that a database failure now returns a safe, structured error instead of
// throwing uncaught out of the Route Handler.

let companies: Map<string, { id: string }>;
let subscribers: Map<string, { id: string; status: string }>;
let findUniqueShouldThrow: boolean;
let upsertShouldThrow: boolean;

const notifyNewSubscriber = vi.fn(async (...args: unknown[]) => {});
vi.mock("@/server/admin-notifications", () => ({
  notifyNewSubscriber: (...args: unknown[]) => notifyNewSubscriber(...args),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    company: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => companies.get(where.id) ?? null),
    },
    subscriber: {
      findUnique: vi.fn(async ({ where }: { where: { companyId_email: { companyId: string; email: string } } }) => {
        if (findUniqueShouldThrow) throw new Error("connection terminated");
        const key = `${where.companyId_email.companyId}|${where.companyId_email.email}`;
        return subscribers.get(key) ?? null;
      }),
      upsert: vi.fn(async ({ where }: { where: { companyId_email: { companyId: string; email: string } } }) => {
        if (upsertShouldThrow) throw new Error("connection terminated");
        const key = `${where.companyId_email.companyId}|${where.companyId_email.email}`;
        const row = { id: subscribers.get(key)?.id ?? `sub-${subscribers.size + 1}`, status: "SUBSCRIBED" };
        subscribers.set(key, row);
        return row;
      }),
    },
  },
}));

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/public/subscribe", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const BASE_BODY = { companyId: "company-1", email: "jane@example.com" };

beforeEach(() => {
  companies = new Map([["company-1", { id: "company-1" }]]);
  subscribers = new Map();
  findUniqueShouldThrow = false;
  upsertShouldThrow = false;
  vi.clearAllMocks();
});

describe("POST /api/public/subscribe", () => {
  it("subscribes a new email and notifies (unchanged behavior)", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeRequest(BASE_BODY));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(subscribers.has("company-1|jane@example.com")).toBe(true);
    expect(notifyNewSubscriber).toHaveBeenCalledWith("company-1", "jane@example.com");
  });

  it("re-subscribing an existing email does not send a duplicate new-subscriber notification (unchanged behavior)", async () => {
    subscribers.set("company-1|jane@example.com", { id: "sub-1", status: "UNSUBSCRIBED" });
    const { POST } = await import("../route");
    const res = await POST(makeRequest(BASE_BODY));

    expect(res.status).toBe(200);
    expect(notifyNewSubscriber).not.toHaveBeenCalled();
  });

  it("a database failure during the existence check returns a clean, structured error instead of throwing", async () => {
    findUniqueShouldThrow = true;
    const { POST } = await import("../route");
    const res = await POST(makeRequest(BASE_BODY));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.ok).toBe(false);
    expect(typeof json.error).toBe("string");
    expect(notifyNewSubscriber).not.toHaveBeenCalled();
  });

  it("a database failure during the upsert returns a clean, structured error instead of throwing", async () => {
    upsertShouldThrow = true;
    const { POST } = await import("../route");
    const res = await POST(makeRequest(BASE_BODY));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.ok).toBe(false);
    expect(notifyNewSubscriber).not.toHaveBeenCalled();
  });
});
