import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@/generated/prisma/client";

// Pass 16 §7 — regression coverage for the batched/resumable marketing
// campaign send, replacing the old single-request MAX_RECIPIENTS_PER_SEND
// = 400 hard cap that silently left every subscriber past #400 permanently
// unsent. These tests prove: (1) a small campaign still completes in one
// call exactly as before, (2) a campaign larger than one batch requires
// (and correctly supports) multiple "Continue Sending" calls and reaches
// every subscriber with none skipped or duplicated, (3) a failed send is
// retried on the next batch rather than being permanently stuck, (4)
// unsubscribed subscribers are never emailed regardless of when they
// unsubscribed relative to the batches, (5) the pre-existing
// draft-claim/already-sent protections still hold.

type Status = "SUBSCRIBED" | "UNSUBSCRIBED";
type SendStatus = "PENDING" | "SENT" | "FAILED" | "SKIPPED_UNSUBSCRIBED";
type FakeSubscriber = { id: string; companyId: string; email: string; status: Status; subscribedAt: Date; unsubscribeToken: string };
type FakeSend = { id: string; campaignId: string; subscriberId: string; status: SendStatus; sentAt: Date | null; errorMessage: string | null };
type FakeCampaign = { id: string; companyId: string; subject: string; htmlContent: string; status: "DRAFT" | "SENDING" | "SENT"; recipientCount: number; sentAt: Date | null };

let subscribers: Map<string, FakeSubscriber>;
let campaigns: Map<string, FakeCampaign>;
let sends: FakeSend[];
let emailLogs: Array<Record<string, unknown>>;
let sendEmailCalls: Array<{ to: string }>;
/** Emails (by `to` address) that should fail on their NEXT send attempt —
 * consumed (removed) once used, so a retry on a later batch can succeed. */
let failNextAttemptFor: Set<string>;
let currentActor: { id: string; role: string; companyId: string; fullName: string; email: string } | null;

function sendsNoneMatch(subscriberId: string, campaignId: string, status?: SendStatus) {
  return !sends.some((s) => s.subscriberId === subscriberId && s.campaignId === campaignId && (status ? s.status === status : true));
}

function filterSubscribers(where: { companyId: string; status: Status; sends?: { none: { campaignId: string; status?: SendStatus } } }) {
  let list = [...subscribers.values()].filter((s) => s.companyId === where.companyId && s.status === where.status);
  if (where.sends?.none) list = list.filter((s) => sendsNoneMatch(s.id, where.sends!.none.campaignId, where.sends!.none.status));
  list.sort((a, b) => a.subscribedAt.getTime() - b.subscribedAt.getTime());
  return list;
}

const fakePrisma = {
  subscriber: {
    findMany: vi.fn(async ({ where, take }: { where: Parameters<typeof filterSubscribers>[0]; take?: number }) => {
      const list = filterSubscribers(where);
      return take ? list.slice(0, take) : list;
    }),
    count: vi.fn(async ({ where }: { where: Parameters<typeof filterSubscribers>[0] }) => filterSubscribers(where).length),
  },
  marketingCampaign: {
    findFirst: vi.fn(async ({ where }: { where: { id: string; companyId: string } }) => {
      const c = campaigns.get(where.id);
      return c && c.companyId === where.companyId ? c : null;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: { id: string; companyId: string; status: string }; data: Partial<FakeCampaign> }) => {
      const c = campaigns.get(where.id);
      if (c && c.companyId === where.companyId && c.status === where.status) {
        Object.assign(c, data);
        return { count: 1 };
      }
      return { count: 0 };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeCampaign> }) => {
      const c = campaigns.get(where.id)!;
      Object.assign(c, data);
      return c;
    }),
  },
  marketingCampaignSend: {
    // Pass 22 — replaces the old `upsert` fake: sendMarketingCampaign now
    // claims a subscriber via `create` (throwing a real P2002-shaped error
    // on a conflict, exactly like the actual `@@unique([campaignId,
    // subscriberId])` constraint would) BEFORE sending, then records the
    // outcome via a plain `update` afterward — the fake mirrors that same
    // create-then-update shape so a genuine duplicate-claim attempt is
    // rejected the same way a real concurrent Postgres insert would be.
    create: vi.fn(async ({ data }: { data: Omit<FakeSend, "id" | "sentAt" | "errorMessage"> }) => {
      const existing = sends.find((s) => s.campaignId === data.campaignId && s.subscriberId === data.subscriberId);
      if (existing) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`campaignId`,`subscriberId`)", {
          code: "P2002",
          clientVersion: "test",
          meta: { target: ["campaignId", "subscriberId"] },
        });
      }
      const row: FakeSend = { id: `send-${sends.length + 1}`, sentAt: null, errorMessage: null, ...data };
      sends.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: { campaignId_subscriberId: { campaignId: string; subscriberId: string } }; data: Partial<FakeSend> }) => {
      const { campaignId, subscriberId } = where.campaignId_subscriberId;
      const existing = sends.find((s) => s.campaignId === campaignId && s.subscriberId === subscriberId);
      if (!existing) throw new Error("send row not found");
      Object.assign(existing, data);
      return existing;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: { campaignId: string; subscriberId: string; status: SendStatus }; data: Partial<FakeSend> }) => {
      const existing = sends.find((s) => s.campaignId === where.campaignId && s.subscriberId === where.subscriberId && s.status === where.status);
      if (!existing) return { count: 0 };
      Object.assign(existing, data);
      return { count: 1 };
    }),
    createMany: vi.fn(async ({ data, skipDuplicates }: { data: Array<Omit<FakeSend, "id" | "sentAt" | "errorMessage">>; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const d of data) {
        const dup = sends.some((s) => s.campaignId === d.campaignId && s.subscriberId === d.subscriberId);
        if (dup && skipDuplicates) continue;
        sends.push({ id: `send-${sends.length + 1}`, sentAt: null, errorMessage: null, ...d });
        count++;
      }
      return { count };
    }),
    count: vi.fn(async ({ where }: { where: { campaignId: string; status?: SendStatus } }) =>
      sends.filter((s) => s.campaignId === where.campaignId && (where.status ? s.status === where.status : true)).length
    ),
  },
  emailLog: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      emailLogs.push(data);
      return {};
    }),
  },
};

vi.mock("@/lib/prisma", () => ({ prisma: fakePrisma }));
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => currentActor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/company-config", () => ({ resolveBaseUrl: vi.fn(() => "https://example.com") }));
vi.mock("@/server/queries/company", () => ({
  getCompanyForAccountId: vi.fn(async () => ({ id: "company-1", name: "Test Travel Co", brandColor: "#1c3a5e", logoEmailUrl: null, logoWebUrl: "", logoIconUrl: "", website: null, phone: null, signatureTemplate: "" })),
}));
vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async (args: { to: string }) => {
    sendEmailCalls.push({ to: args.to });
    if (failNextAttemptFor.has(args.to)) {
      failNextAttemptFor.delete(args.to);
      return { ok: false as const, error: "Simulated provider failure" };
    }
    return { ok: true as const, messageId: `msg-${sendEmailCalls.length}` };
  }),
}));

function makeSubscribers(count: number, companyId = "company-1", status: Status = "SUBSCRIBED"): void {
  for (let i = 0; i < count; i++) {
    const id = `sub-${companyId}-${i}`;
    subscribers.set(id, { id, companyId, email: `sub${i}@example.com`, status, subscribedAt: new Date(2026, 0, 1, 0, 0, i), unsubscribeToken: `token-${id}` });
  }
}

beforeEach(() => {
  subscribers = new Map();
  campaigns = new Map([["campaign-1", { id: "campaign-1", companyId: "company-1", subject: "Sale!", htmlContent: "<p>Hello</p>", status: "DRAFT", recipientCount: 0, sentAt: null }]]);
  sends = [];
  emailLogs = [];
  sendEmailCalls = [];
  failNextAttemptFor = new Set();
  currentActor = { id: "admin-1", role: "ADMIN", companyId: "company-1", fullName: "Admin User", email: "admin@example.com" };
  vi.clearAllMocks();
});

describe("sendMarketingCampaign — small campaign (fits in one batch)", () => {
  it("sends to every subscriber and reaches the terminal SENT status in a single call", async () => {
    makeSubscribers(3);
    const { sendMarketingCampaign } = await import("../marketing-campaigns");
    const result = await sendMarketingCampaign("campaign-1");
    expect(result).toMatchObject({ sent: 3, failed: 0, remaining: 0, done: true });
    expect(campaigns.get("campaign-1")!.status).toBe("SENT");
    expect(sendEmailCalls).toHaveLength(3);
  });

  it("throws and leaves the campaign in DRAFT when there are no subscribed subscribers", async () => {
    const { sendMarketingCampaign } = await import("../marketing-campaigns");
    await expect(sendMarketingCampaign("campaign-1")).rejects.toThrow(/no active subscribers/i);
    expect(campaigns.get("campaign-1")!.status).toBe("DRAFT");
  });

  it("rejects sending an already-SENT campaign again", async () => {
    makeSubscribers(1);
    const { sendMarketingCampaign } = await import("../marketing-campaigns");
    await sendMarketingCampaign("campaign-1");
    await expect(sendMarketingCampaign("campaign-1")).rejects.toThrow(/already been sent/i);
  });

  it("never emails an UNSUBSCRIBED subscriber, and records a SKIPPED_UNSUBSCRIBED row instead", async () => {
    makeSubscribers(2, "company-1", "SUBSCRIBED");
    makeSubscribers(1, "company-1", "UNSUBSCRIBED");
    const { sendMarketingCampaign } = await import("../marketing-campaigns");
    await sendMarketingCampaign("campaign-1");
    expect(sendEmailCalls.some((c) => c.to === "sub0@example.com")).toBe(false);
    const skipped = sends.find((s) => s.status === "SKIPPED_UNSUBSCRIBED");
    expect(skipped).toBeTruthy();
  });
});

describe("sendMarketingCampaign — large campaign requires multiple batches (Pass 16 §7)", () => {
  it("a campaign larger than one batch is NOT silently truncated — every subscriber is eventually reached across repeated calls, with none duplicated", async () => {
    makeSubscribers(250); // MAX_RECIPIENTS_PER_BATCH is 100 — needs 3 calls
    const { sendMarketingCampaign } = await import("../marketing-campaigns");

    const first = await sendMarketingCampaign("campaign-1");
    expect(first).toMatchObject({ sent: 100, done: false, remaining: 150 });
    expect(campaigns.get("campaign-1")!.status).toBe("SENDING");

    const second = await sendMarketingCampaign("campaign-1"); // "Continue Sending"
    expect(second).toMatchObject({ sent: 100, done: false, remaining: 50 });
    expect(campaigns.get("campaign-1")!.status).toBe("SENDING");

    const third = await sendMarketingCampaign("campaign-1");
    expect(third).toMatchObject({ sent: 50, done: true, remaining: 0 });
    expect(campaigns.get("campaign-1")!.status).toBe("SENT");

    // The real point of this fix: all 250 were reached, and NONE twice.
    expect(sendEmailCalls).toHaveLength(250);
    const uniqueRecipients = new Set(sendEmailCalls.map((c) => c.to));
    expect(uniqueRecipients.size).toBe(250);
    expect(sends.filter((s) => s.status === "SENT")).toHaveLength(250);
  });

  it("a subscriber whose send fails is retried on the next batch, not permanently stuck", async () => {
    makeSubscribers(1);
    failNextAttemptFor.add("sub0@example.com");
    const { sendMarketingCampaign } = await import("../marketing-campaigns");

    const first = await sendMarketingCampaign("campaign-1");
    expect(first).toMatchObject({ sent: 0, failed: 1, done: false });
    expect(sends.find((s) => s.subscriberId === "sub-company-1-0")!.status).toBe("FAILED");

    // Second attempt (Continue Sending) — this time it succeeds, and the
    // SAME row is updated (upsert), never a second row for the same
    // subscriber (the DB-level unique constraint's whole purpose).
    const second = await sendMarketingCampaign("campaign-1");
    expect(second).toMatchObject({ sent: 1, failed: 0, done: true });
    const rowsForSubscriber = sends.filter((s) => s.subscriberId === "sub-company-1-0" && s.campaignId === "campaign-1");
    expect(rowsForSubscriber).toHaveLength(1);
    expect(rowsForSubscriber[0].status).toBe("SENT");
  });

  it("Pass 22 — two GENUINELY CONCURRENT 'Continue Sending' calls (Promise.all, not sequential) never both email the same subscriber", async () => {
    // Unlike the fully-synchronous fakes elsewhere in this codebase's test
    // suite (see booking-retry.test.ts's own comment on this), sendEmail
    // here IS awaited inside the per-subscriber loop, and every await —
    // even on an already-resolved value — yields to the microtask queue in
    // real Node.js semantics. Two Promise.all'd calls to
    // sendMarketingCampaign genuinely interleave their per-subscriber
    // iterations as a result, so this is a real test of the atomic
    // `create`-based claim, not a relabeled sequential one.
    makeSubscribers(20);
    const { sendMarketingCampaign } = await import("../marketing-campaigns");
    // First call alone claims DRAFT -> SENDING (that transition already
    // had its own atomic claim before this pass) so both racing calls
    // below are genuine "Continue Sending" batches against the same
    // still-SENDING campaign and the same not-yet-attempted subscribers.
    campaigns.get("campaign-1")!.status = "SENDING";

    const [a, b] = await Promise.all([sendMarketingCampaign("campaign-1"), sendMarketingCampaign("campaign-1")]);

    // Only 20 real sends must have happened in total, split however the
    // race actually resolved between the two calls — never 40 (one full
    // duplicate pass) and never fewer than 20 (a subscriber silently
    // dropped by both calls skipping it).
    expect(a.sent + b.sent).toBe(20);
    expect(sendEmailCalls).toHaveLength(20);
    const uniqueRecipients = new Set(sendEmailCalls.map((c) => c.to));
    expect(uniqueRecipients.size).toBe(20); // no subscriber emailed twice
    expect(sends.filter((s) => s.status === "SENT")).toHaveLength(20); // no duplicate row either
  });

  it("a subscriber who unsubscribes between two batches is never emailed by a later batch", async () => {
    makeSubscribers(150);
    const { sendMarketingCampaign } = await import("../marketing-campaigns");
    await sendMarketingCampaign("campaign-1"); // sends the first 100

    // A subscriber still in the "not yet attempted" group unsubscribes.
    const stillPending = subscribers.get("sub-company-1-120")!;
    stillPending.status = "UNSUBSCRIBED";

    await sendMarketingCampaign("campaign-1"); // continues with the remaining 49
    expect(sendEmailCalls.some((c) => c.to === "sub120@example.com")).toBe(false);
    expect(campaigns.get("campaign-1")!.status).toBe("SENT");
  });
});
