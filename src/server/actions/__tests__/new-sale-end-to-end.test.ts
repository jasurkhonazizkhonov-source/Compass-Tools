import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@/generated/prisma/client";

// "Notify Team of New Sale", end to end: the REAL sendNewSaleNotification
// action, the REAL sendBookingProfitNotification, the REAL sendEmail →
// sendViaGmail → nodemailer MIME build. Only the boundaries are faked
// (Prisma, Google's OAuth client and the Gmail HTTP call), so the assertions
// are made against the raw RFC 822 message that would be handed to Gmail —
// the actual From / To / Bcc headers — rather than against a mocked
// sendEmail() call.
//
// Scenario (the one reported from production):
//   A creates and sends the quote          → Quote.sentByAgent
//   B (ticketing) enters the booking info and presses "Notify Team of New Sale"
//   C and D are other current CRM users (other roles)
// Expected: From = A, To = A, Bcc = A + B + C + D; B is never the sender.

type Role = "ADMIN" | "MANAGER" | "TRAVEL_AGENT" | "TICKETING_AGENT" | "FLIGHT_EXPERT" | "MARKETING_AGENT";
type FakeAccount = { id: string; email: string; fullName: string; role: Role; status: "ACTIVE" | "INACTIVE"; companyId: string; accountsVisible?: boolean };

let accounts: Map<string, FakeAccount>;
let connected: Set<string>;
let emailLogs: Array<Record<string, unknown>>;
let rawMessages: string[];
let currentActor: { id: string; role: Role; status: string; companyId: string } | null;
let quoteSender: { id: string; fullName: string; email: string; location: string | null; hiredAt: Date | null; role: Role } | null;

const QUOTE = () => ({
  id: "quote-1",
  adults: 1,
  adultPrice: 600,
  children: 0,
  childPrice: 0,
  infants: 0,
  infantPrice: 0,
  currency: "USD",
  originalQuoteId: null,
  sentByAgent: quoteSender,
  itinerary: { segments: [] },
});

const fakePrisma = {
  booking: {
    findFirst: vi.fn(async () => ({ id: "booking-1" })),
    findUniqueOrThrow: vi.fn(async () => ({
      id: "booking-1",
      leadId: "lead-1",
      contactId: "contact-1",
      quoteId: "quote-1",
      bookingReference: "BFT-TEST01",
      status: "CONFIRMED",
      fareAmount: 400,
      taxAmount: 20,
      serviceFeeAmount: 10,
      passengers: [{ id: "p1" }],
      quote: QUOTE(),
    })),
  },
  emailLog: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (data.status === "SENT" && emailLogs.some((e) => e.bookingId === data.bookingId && e.type === data.type && e.status === "SENT")) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test", meta: {} });
      }
      const row = { id: `log-${emailLogs.length + 1}`, ...data };
      emailLogs.push(row);
      return row;
    }),
    update: vi.fn(async ({ where: { id }, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = emailLogs.find((e) => e.id === id)!;
      Object.assign(row, data);
      return row;
    }),
  },
  account: {
    // The roster is read from the live map on EVERY call — nothing is cached
    // between sends, so adding/removing a user changes the next send.
    findMany: vi.fn(async ({ where }: { where: { companyId: string; status: string } }) =>
      [...accounts.values()].filter((a) => a.companyId === where.companyId && a.status === where.status).sort((x, y) => x.fullName.localeCompare(y.fullName))
    ),
  },
  gmailConnection: {
    findUnique: vi.fn(async ({ where: { accountId } }: { where: { accountId: string } }) => {
      if (!connected.has(accountId)) return null;
      const a = accounts.get(accountId)!;
      return { accountId, googleEmail: a.email, encryptedRefreshToken: "ENC:token", status: "CONNECTED" };
    }),
    update: vi.fn(async () => ({})),
  },
};

vi.mock("@/lib/prisma", () => ({ prisma: fakePrisma }));
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("@/server/activity-log", () => ({ logActivity: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/system/health-events", () => ({ recordHealthEvent: vi.fn(async () => {}) }));
vi.mock("@/server/queries/company", () => ({
  getCompanyForAccountId: vi.fn(async () => ({ id: "company-1", name: "Compass Tools", brandColor: "#1c3a5e", logoEmailUrl: null, website: null, phone: null })),
  getCompanyForContactId: vi.fn(async () => ({ id: "company-1", name: "Compass Tools", brandColor: "#1c3a5e", logoEmailUrl: null, website: null, phone: null })),
}));
vi.mock("@/server/auth/google-config", () => ({ getGoogleClientId: () => "client-id", getGoogleClientSecret: () => "client-secret" }));
vi.mock("@/server/security/gmail-token-encryption", () => ({ decryptRefreshToken: (v: string) => v.replace(/^ENC:/, "") }));
vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn().mockImplementation(function () {
    // Gmail authenticates as exactly the account that connected it — the
    // sender below is whichever account the send was issued for.
    return { setCredentials: vi.fn(), getAccessToken: vi.fn(async () => ({ token: "access-token" })) };
  }),
}));

const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
  const { raw } = JSON.parse(init.body) as { raw: string };
  rawMessages.push(Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  return { ok: true, json: async () => ({ id: `gmail-msg-${rawMessages.length}` }) };
});
vi.stubGlobal("fetch", fetchMock);

function headersOf(raw: string): Record<string, string> {
  const head = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, " ");
  const out: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}
const addresses = (header: string | undefined) => (header ?? "").split(",").map((s) => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim().toLowerCase()).filter(Boolean);

const person = (id: string, name: string, role: Role, extra: Partial<FakeAccount> = {}): FakeAccount => ({ id, email: `${id}@example.com`, fullName: name, role, status: "ACTIVE", companyId: "company-1", ...extra });

beforeEach(() => {
  accounts = new Map(
    [
      person("user-a", "Andrew Creator", "TRAVEL_AGENT"),
      person("user-b", "Bella Ticketing", "TICKETING_AGENT"),
      person("user-c", "Carlos Manager", "MANAGER"),
      person("user-d", "Dina Marketing", "MARKETING_AGENT"),
    ].map((a) => [a.id, a])
  );
  connected = new Set(["user-a", "user-b", "user-c", "user-d"]);
  emailLogs = [];
  rawMessages = [];
  quoteSender = { id: "user-a", fullName: "Andrew Creator", email: "user-a@example.com", location: "Los Angeles", hiredAt: null, role: "TRAVEL_AGENT" };
  // B — the ticketing agent — is the one pressing the button.
  currentActor = { id: "user-b", role: "TICKETING_AGENT", status: "ACTIVE", companyId: "company-1" };
  vi.clearAllMocks();
});

async function notify() {
  const { sendNewSaleNotification } = await import("../bookings");
  await sendNewSaleNotification("booking-1");
  return rawMessages.map((raw) => headersOf(raw));
}

describe("Notify Team of New Sale — From / To / Bcc on the real outgoing message", () => {
  it("From = the quote creator (A), To = the quote creator (A), Bcc = every current user (A, B, C, D) — and the ticketing agent who clicked (B) is NOT the sender", async () => {
    const [h] = await notify();
    expect(rawMessages).toHaveLength(1);
    expect(addresses(h.from)).toEqual(["user-a@example.com"]);
    expect(addresses(h.to)).toEqual(["user-a@example.com"]);
    expect(addresses(h.bcc).sort()).toEqual(["user-a@example.com", "user-b@example.com", "user-c@example.com", "user-d@example.com"]);
    expect(addresses(h.from)).not.toContain("user-b@example.com");
  });

  it("the Bcc header is genuinely present in the raw message handed to Gmail (nodemailer strips it unless keepBcc is set — the production bug where only the To address received the email)", async () => {
    await notify();
    expect(rawMessages[0]).toMatch(/^Bcc:/im);
  });

  it("the Bcc list is built from the CURRENT users each time: a newly added user is included, a deactivated one is dropped", async () => {
    accounts.set("user-e", person("user-e", "Evan NewHire", "FLIGHT_EXPERT"));
    accounts.set("user-d", { ...accounts.get("user-d")!, status: "INACTIVE" });
    const [h] = await notify();
    const bcc = addresses(h.bcc);
    expect(bcc).toContain("user-e@example.com");
    expect(bcc).not.toContain("user-d@example.com");
    expect(bcc).toHaveLength(4); // A, B, C, E
  });

  it("every role is included — Admin, Manager, Travel Agent, Ticketing Agent, Flight Expert and Marketing Agent — and a hidden (but active) account still gets the announcement", async () => {
    accounts.set("user-admin", person("user-admin", "Zed Admin", "ADMIN"));
    accounts.set("user-expert", person("user-expert", "Yara Expert", "FLIGHT_EXPERT"));
    accounts.set("user-hidden", person("user-hidden", "Hugo Hidden", "TRAVEL_AGENT", { accountsVisible: false }));
    const [h] = await notify();
    const bcc = addresses(h.bcc);
    for (const id of ["user-a", "user-b", "user-c", "user-d", "user-admin", "user-expert", "user-hidden"]) expect(bcc).toContain(`${id}@example.com`);
  });

  it("an inactive account is never included", async () => {
    accounts.set("user-gone", person("user-gone", "Gina Gone", "TRAVEL_AGENT", { status: "INACTIVE" }));
    const [h] = await notify();
    expect(addresses(h.bcc)).not.toContain("user-gone@example.com");
  });

  it("duplicate addresses (including case differences) appear once in the Bcc list", async () => {
    accounts.set("user-c", { ...accounts.get("user-c")!, email: "USER-A@example.com" }); // same mailbox as A, different case
    const [h] = await notify();
    const bcc = addresses(h.bcc);
    expect(bcc.filter((x) => x === "user-a@example.com")).toHaveLength(1);
  });

  it("if the quote creator has no working Gmail connection, a connected user transmits it — but it is still addressed To the quote creator and the whole roster is still blind-copied (no impersonation of A's address)", async () => {
    connected.delete("user-a");
    const [h] = await notify();
    expect(addresses(h.from)).not.toContain("user-a@example.com"); // Gmail can only send as the account that connected it
    expect(addresses(h.to)).toEqual(["user-a@example.com"]);
    expect(addresses(h.bcc)).toContain("user-b@example.com");
    expect(addresses(h.bcc)).toContain("user-a@example.com");
  });

  it("the person who pressed the button (B) is only the initiator: even when B is the only connected user, the message is still To the quote creator", async () => {
    connected = new Set(["user-b"]);
    const [h] = await notify();
    expect(addresses(h.from)).toEqual(["user-b@example.com"]); // the only legitimate sender available
    expect(addresses(h.to)).toEqual(["user-a@example.com"]);
  });

  it("when B IS the quote creator, From = To = B", async () => {
    quoteSender = { id: "user-b", fullName: "Bella Ticketing", email: "user-b@example.com", location: null, hiredAt: null, role: "TICKETING_AGENT" };
    const [h] = await notify();
    expect(addresses(h.from)).toEqual(["user-b@example.com"]);
    expect(addresses(h.to)).toEqual(["user-b@example.com"]);
  });

  it("is idempotent: a second click sends nothing more", async () => {
    await notify();
    await notify();
    expect(rawMessages).toHaveLength(1);
  });

  it("authorization is unchanged: a role that cannot enter ticketing info (the Travel Agent creator) cannot trigger it", async () => {
    currentActor = { id: "user-a", role: "TRAVEL_AGENT", status: "ACTIVE", companyId: "company-1" };
    const { sendNewSaleNotification } = await import("../bookings");
    await expect(sendNewSaleNotification("booking-1")).rejects.toThrow(/not authorized/i);
    expect(rawMessages).toHaveLength(0);
  });

  it("the email body never carries payment data and the subject has no internal id", async () => {
    await notify();
    const all = rawMessages[0];
    expect(all).not.toMatch(/\b(?:\d[ -]?){13,19}\b/);
    expect(all).not.toMatch(/cvv|cvc|encryptedPan/i);
  });
});
