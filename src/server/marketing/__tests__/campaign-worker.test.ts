import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Durable campaign delivery against an in-memory database: queueing, audience snapshots, rate limits, send-time suppression, uncertain outcomes, retries with backoff,
// pause / resume / cancel, concurrency and crash recovery. Synthetic subscribers only; the mail provider is a fake and nothing leaves the process.

type Campaign = Record<string, unknown> & { id: string; companyId: string; status: string; createdById: string | null; audienceCursor: string | null; audienceComplete: boolean; recipientCount: number; queuedAt: Date | null; scheduledAt: Date | null };
type Subscriber = { id: string; companyId: string; email: string; firstName: string | null; lastName: string | null; status: string; unsubscribeToken: string; lastCampaignSentAt: Date | null };
type Send = { id: string; campaignId: string; subscriberId: string; status: string; attempts: number; nextAttemptAt: Date | null; lastAttemptAt: Date | null; sentAt: Date | null; errorMessage: string | null; providerMessageId: string | null };

let campaigns: Campaign[];
let subscribers: Subscriber[];
let sends: Send[];
let outbox: Array<{ to: string; subject: string; html: string }>;
let providerBehaviour: (to: string) => Record<string, unknown>;
let sendSeq = 0;
// Emulates the per-sender PostgreSQL advisory lock of claimWithinQuota: claim transactions run one at a time, in arrival order (the real lock does the same per
// sender; one global queue is the stricter, simpler stand-in). The interleaving of everything else is left to the event loop, so the races are real.
let claimLock: Promise<void> = Promise.resolve();

const matches = (row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean => {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (k === "OR") return (cond as Array<Record<string, unknown>>).some((c) => matches(row, c));
    if (k === "campaign") return matches(campaigns.find((c) => c.id === row.campaignId) ?? {}, cond as Record<string, unknown>);
    const v = row[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as Record<string, unknown>;
      if ("in" in c) return (c.in as unknown[]).includes(v);
      if ("lte" in c) return v !== null && (v as Date) <= (c.lte as Date);
      if ("gte" in c) return v !== null && (v as Date) >= (c.gte as Date);
      if ("gt" in c) return (v as string) > (c.gt as string);
      return false;
    }
    return v === cond;
  });
};
const apply = (row: Record<string, unknown>, data: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && !(v instanceof Date) && "increment" in (v as object)) row[k] = ((row[k] as number) ?? 0) + (v as { increment: number }).increment;
    else row[k] = v;
  }
};

vi.mock("@/lib/prisma", () => {
  const prismaFake: Record<string, unknown> = {
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const run = claimLock.then(() => fn(prismaFake));
      claimLock = run.then(() => undefined, () => undefined);
      return run;
    }),
    marketingCampaign: {
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = campaigns.filter((c) => matches(c, where));
        hit.forEach((c) => apply(c, data));
        return { count: hit.length };
      }),
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take: number }) => campaigns.filter((c) => matches(c, where)).slice(0, take)),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => campaigns.find((c) => c.id === where.id) ?? null),
    },
    marketingCampaignSend: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => sends.filter((s) => matches(s, where)).length),
      findMany: vi.fn(async ({ where, take }: { where: Record<string, unknown>; take: number }) =>
        sends.filter((s) => matches(s, where)).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, take).map((s) => ({ ...s, subscriber: { ...subscribers.find((x) => x.id === s.subscriberId)! } }))
      ),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = sends.filter((s) => matches(s, where));
        hit.forEach((s) => apply(s, data));
        return { count: hit.length };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const s = sends.find((x) => x.id === where.id)!;
        apply(s, data);
        return s;
      }),
      createMany: vi.fn(async ({ data, skipDuplicates }: { data: Array<{ campaignId: string; subscriberId: string }>; skipDuplicates: boolean }) => {
        let count = 0;
        for (const d of data) {
          if (sends.some((s) => s.campaignId === d.campaignId && s.subscriberId === d.subscriberId)) {
            if (!skipDuplicates) throw new Error("unique");
            continue;
          }
          sends.push({ id: `s${String(++sendSeq).padStart(7, "0")}`, ...d, status: "PENDING", attempts: 0, nextAttemptAt: null, lastAttemptAt: null, sentAt: null, errorMessage: null, providerMessageId: null });
          count++;
        }
        return { count };
      }),
      groupBy: vi.fn(async ({ where }: { where: { campaignId: string } }) => {
        const m = new Map<string, number>();
        sends.filter((s) => s.campaignId === where.campaignId).forEach((s) => m.set(s.status, (m.get(s.status) ?? 0) + 1));
        return [...m].map(([status, n]) => ({ status, _count: { _all: n } }));
      }),
    },
    subscriber: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const s = subscribers.find((x) => x.id === where.id);
        return s ? { status: s.status } : null;
      }),
      findMany: vi.fn(async ({ where, take }: { where: { companyId: string; status: string; id?: { gt: string } }; take: number }) =>
        subscribers.filter((s) => s.companyId === where.companyId && s.status === where.status && (!where.id || s.id > where.id.gt)).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, take).map((s) => ({ id: s.id }))
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => apply(subscribers.find((s) => s.id === where.id)! as unknown as Record<string, unknown>, data)),
    },
    account: { findUnique: vi.fn(async () => ({ id: "sender-1", fullName: "Sender", email: "sender@crm.test" })) },
    emailLog: { create: vi.fn(async () => ({})) },
  };
  return { prisma: prismaFake };
});
vi.mock("@/server/queries/company", () => ({ getCompanyForAccountId: vi.fn(async () => ({ name: "Co" })) }));
vi.mock("@/lib/company-config", () => ({ resolveBaseUrl: () => "https://crm.example.test" }));
vi.mock("@/server/email/templates", () => ({
  buildMarketingCampaignEmail: vi.fn((p: { subject: string; htmlContent: string; unsubscribeUrl: string }) => ({ subject: p.subject, html: `${p.htmlContent}<a href="${p.unsubscribeUrl}">Unsubscribe</a>` })),
}));
vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async (a: { to: string; subject: string; html: string }) => {
    const r = providerBehaviour(a.to);
    if (r.throw) throw new Error("socket hang up");
    if (r.ok !== false) outbox.push({ to: a.to, subject: a.subject, html: a.html });
    return r.ok === false ? r : { ok: true, messageId: `m-${outbox.length}` };
  }),
}));

const NOW = new Date("2026-11-20T18:00:00Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

function addSubscribers(n: number, status = "SUBSCRIBED", prefix = "u") {
  const start = subscribers.length;
  for (let i = 0; i < n; i++) {
    const k = String(start + i).padStart(6, "0");
    subscribers.push({ id: `sub${k}`, companyId: "co-1", email: `${prefix}${k}@example.test`, firstName: i % 2 ? `First${k}` : null, lastName: null, status, unsubscribeToken: `tok${k}`, lastCampaignSentAt: null });
  }
}
function addCampaign(over: Partial<Campaign> = {}): Campaign {
  const c: Campaign = {
    id: `camp${campaigns.length + 1}`, companyId: "co-1", name: "Spring", subject: "Hi {{firstName|there}}", htmlContent: "<p>Hello {{firstName|there}}</p>", status: "QUEUED", createdById: "sender-1",
    audienceCursor: null, audienceComplete: false, recipientCount: 0, queuedAt: NOW, scheduledAt: null, previewText: null, senderName: null, replyTo: null, ...over,
  };
  campaigns.push(c);
  return c;
}
const counts = () => sends.reduce<Record<string, number>>((m, s) => ((m[s.status] = (m[s.status] ?? 0) + 1), m), {});

beforeEach(async () => {
  // A test may install its own provider behaviour (for example one that unsubscribes somebody during a send); it must never leak into the next test.
  const svc = await import("@/server/email/service");
  (svc.sendEmail as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (m: { to: string; subject: string; html: string }) => {
    const r = providerBehaviour(m.to);
    if (r.throw) throw new Error("socket hang up");
    if (r.ok !== false) outbox.push({ to: m.to, subject: m.subject, html: m.html });
    return r.ok === false ? r : { ok: true, messageId: `m-${outbox.length}` };
  });
  campaigns = [];
  subscribers = [];
  sends = [];
  outbox = [];
  sendSeq = 0;
  providerBehaviour = () => ({ ok: true });
  vi.stubEnv("CAMPAIGN_SENDS_PER_MINUTE", "20");
  vi.stubEnv("CAMPAIGN_DAILY_LIMIT", "400");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe("batching and rate limits", () => {
  it("never sends more than the per-minute budget in one pass, and carries on in the next pass", async () => {
    addSubscribers(50);
    const c = addCampaign();
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    const t1 = await drainMarketingCampaigns(NOW);
    expect(t1.sent).toBe(20);
    expect(outbox).toHaveLength(20);
    expect(c.status).toBe("SENDING");
    await drainMarketingCampaigns(minutes(1));
    await drainMarketingCampaigns(minutes(2));
    expect(outbox).toHaveLength(50);
    expect(c.status).toBe("SENT");
    expect(counts()).toEqual({ SENT: 50 });
  });

  it("respects the rolling 24-hour cap per sending account, and resumes by itself when the window moves on", async () => {
    vi.stubEnv("CAMPAIGN_DAILY_LIMIT", "30");
    addSubscribers(60);
    const c = addCampaign();
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    await drainMarketingCampaigns(NOW); // 20
    await drainMarketingCampaigns(minutes(1)); // 10 more: cap reached
    await drainMarketingCampaigns(minutes(2));
    expect(outbox).toHaveLength(30);
    expect(c.status).toBe("SENDING"); // not failed, not complete: it is waiting for the window
    expect(counts().FAILED).toBeUndefined();
    // A day later the first sends have aged out. (sentAt is stamped with the real clock, so "a day later" is measured from the real clock, not from NOW.)
    await drainMarketingCampaigns(new Date(Date.now() + 25 * 3_600_000));
    expect(outbox.length).toBeGreaterThan(30);
  });

  it("the audience is fixed in bounded keyset chunks and one row is created per subscriber, once", async () => {
    addSubscribers(2_500);
    const c = addCampaign();
    const { snapshotAudienceChunk } = await import("../campaign-worker");
    c.status = "SENDING";
    let cursor: string | null = null;
    let made = 0;
    for (let i = 0; i < 5 && !c.audienceComplete; i++) {
      made += await snapshotAudienceChunk(c.id, "co-1", cursor, 1_000);
      cursor = c.audienceCursor;
    }
    expect(made).toBe(2_500);
    expect(c.audienceComplete).toBe(true);
    expect(sends).toHaveLength(2_500);
    expect(new Set(sends.map((s) => s.subscriberId)).size).toBe(2_500);
    // taking the same chunk again (a retry) creates nothing new
    expect(await snapshotAudienceChunk(c.id, "co-1", null, 1_000)).toBe(0);
  });

  it("only SUBSCRIBED people are in the audience; unsubscribed and suppressed addresses are never selected", async () => {
    addSubscribers(5);
    addSubscribers(3, "UNSUBSCRIBED", "un");
    addSubscribers(2, "SUPPRESSED", "sp");
    addCampaign();
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    await drainMarketingCampaigns(NOW);
    expect(outbox.map((o) => o.to).every((to) => to.startsWith("u0"))).toBe(true);
    expect(sends).toHaveLength(5);
  });
});

describe("suppression and consent at SEND time", () => {
  it("someone who unsubscribes AFTER the audience was fixed is skipped, not emailed", async () => {
    addSubscribers(10);
    const c = addCampaign();
    const { snapshotAudienceChunk, drainMarketingCampaigns } = await import("../campaign-worker");
    c.status = "SENDING";
    await snapshotAudienceChunk(c.id, "co-1", null, 1_000);
    subscribers[3].status = "UNSUBSCRIBED";
    subscribers[4].status = "SUPPRESSED";
    await drainMarketingCampaigns(NOW);
    expect(outbox).toHaveLength(8);
    expect(outbox.some((o) => o.to === subscribers[3].email || o.to === subscribers[4].email)).toBe(false);
    expect(counts()).toEqual({ SENT: 8, SKIPPED_UNSUBSCRIBED: 1, SKIPPED_SUPPRESSED: 1 });
  });

  it("every message carries that subscriber's own unsubscribe link, and personalization uses their data with the fallback when empty", async () => {
    addSubscribers(2);
    addCampaign();
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    await drainMarketingCampaigns(NOW);
    const byTo = Object.fromEntries(outbox.map((o) => [o.to, o]));
    expect(byTo[subscribers[0].email].html).toContain("https://crm.example.test/api/public/unsubscribe?token=tok000000");
    expect(byTo[subscribers[0].email].subject).toBe("Hi there"); // no first name -> fallback
    expect(byTo[subscribers[1].email].subject).toBe("Hi First000001");
    expect(byTo[subscribers[1].email].html).toContain("Hello First000001");
    expect(outbox.every((o) => !/\{\{/.test(o.html + o.subject))).toBe(true);
  });
});

describe("failures: retries, uncertain outcomes, provider limits, disconnected sender", () => {
  it("a definite failure is retried with growing delays and becomes FAILED after the third attempt - it is never silently dropped or retried forever", async () => {
    addSubscribers(1);
    addCampaign();
    providerBehaviour = () => ({ ok: false, error: "Invalid recipient", code: "SEND_FAILED" });
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    await drainMarketingCampaigns(NOW);
    expect(sends[0]).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(sends[0].nextAttemptAt!.getTime()).toBe(minutes(5).getTime());
    await drainMarketingCampaigns(minutes(1)); // not due yet
    expect(sends[0].attempts).toBe(1);
    await drainMarketingCampaigns(minutes(6));
    expect(sends[0]).toMatchObject({ status: "PENDING", attempts: 2 });
    expect(sends[0].nextAttemptAt!.getTime()).toBe(minutes(36).getTime()); // 30 min after the second attempt
    await drainMarketingCampaigns(minutes(40));
    expect(sends[0]).toMatchObject({ status: "FAILED", attempts: 3 });
    expect(campaigns[0].status).toBe("SENT"); // finished: nothing pending (one recipient failed, reported as failed)
    expect(outbox).toHaveLength(0);
  });

  it("an UNCERTAIN outcome (no answer / timeout) is held as UNKNOWN and is NEVER sent again by a later pass", async () => {
    addSubscribers(3);
    addCampaign();
    providerBehaviour = (to) => (to.includes("000001") ? { ok: false, error: "timeout", code: "SEND_FAILED", ambiguous: true } : { ok: true });
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    const t = await drainMarketingCampaigns(NOW);
    expect(t.unknown).toBe(1);
    providerBehaviour = () => ({ ok: true });
    await drainMarketingCampaigns(minutes(5));
    await drainMarketingCampaigns(minutes(60));
    expect(sends.find((s) => s.subscriberId === "sub000001")).toMatchObject({ status: "UNKNOWN", attempts: 1 });
    expect(outbox.filter((o) => o.to.includes("000001"))).toHaveLength(0); // never re-sent automatically
    expect(outbox).toHaveLength(2);
  });

  it("a send call that throws is also treated as uncertain, not retried", async () => {
    addSubscribers(2);
    addCampaign();
    providerBehaviour = (to) => (to.includes("000000") ? { throw: true } : { ok: true });
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    await drainMarketingCampaigns(NOW);
    providerBehaviour = () => ({ ok: true });
    await drainMarketingCampaigns(minutes(10));
    expect(sends[0].status).toBe("UNKNOWN");
    expect(outbox.filter((o) => o.to.includes("000000"))).toHaveLength(0);
  });

  it("crash recovery: a recipient claimed (write-ahead) by a worker that died before recording the outcome stays UNKNOWN and is not sent again", async () => {
    addSubscribers(2);
    const c = addCampaign({ status: "SENDING", audienceComplete: true });
    sends.push({ id: "s1", campaignId: c.id, subscriberId: "sub000000", status: "UNKNOWN", attempts: 1, nextAttemptAt: null, lastAttemptAt: NOW, sentAt: null, errorMessage: null, providerMessageId: null });
    sends.push({ id: "s2", campaignId: c.id, subscriberId: "sub000001", status: "PENDING", attempts: 0, nextAttemptAt: null, lastAttemptAt: null, sentAt: null, errorMessage: null, providerMessageId: null });
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    await drainMarketingCampaigns(minutes(30));
    expect(outbox.map((o) => o.to)).toEqual([subscribers[1].email]);
    expect(sends[0].status).toBe("UNKNOWN");
    expect(c.status).toBe("SENT");
  });

  it("a provider sending-limit error backs the recipient off for an hour, stops the batch, and is not counted as a failure", async () => {
    addSubscribers(5);
    addCampaign();
    providerBehaviour = () => ({ ok: false, error: "User-rate limit exceeded. Retry after later", code: "SEND_FAILED" });
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    const t = await drainMarketingCampaigns(NOW);
    expect(t.failed).toBe(0);
    expect(sends.filter((s) => s.lastAttemptAt !== null)).toHaveLength(1); // stopped after the first refusal: the other four were never even claimed
    expect(sends[0]).toMatchObject({ status: "PENDING", attempts: 0 });
    expect(sends[0].nextAttemptAt!.getTime()).toBe(NOW.getTime() + 3_600_000);
    expect(counts().FAILED).toBeUndefined();
  });

  it("a sender whose Gmail is disconnected PAUSES the campaign: nothing is marked failed, the recipient keeps its attempt, and resuming continues", async () => {
    addSubscribers(3);
    const c = addCampaign();
    providerBehaviour = () => ({ ok: false, error: "Connect Gmail", code: "NOT_CONNECTED" });
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    const t = await drainMarketingCampaigns(NOW);
    expect(t.paused).toBe(1);
    expect(c.status).toBe("PAUSED");
    expect(counts()).toEqual({ PENDING: 3 });
    expect(sends.every((s) => s.attempts === 0)).toBe(true);
    // the user reconnects and resumes
    providerBehaviour = () => ({ ok: true });
    c.status = "QUEUED";
    await drainMarketingCampaigns(minutes(5));
    expect(outbox).toHaveLength(3);
  });

  it("a campaign with no sending account is paused rather than sent from somewhere else", async () => {
    addSubscribers(2);
    const c = addCampaign({ createdById: null });
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    await drainMarketingCampaigns(NOW);
    expect(c.status).toBe("PAUSED");
    expect(outbox).toHaveLength(0);
  });
});

describe("lifecycle: schedule, pause, cancel, concurrency", () => {
  it("a scheduled campaign waits for its time and is then sent", async () => {
    addSubscribers(3);
    const c = addCampaign({ status: "SCHEDULED", scheduledAt: minutes(30) });
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    await drainMarketingCampaigns(NOW);
    await drainMarketingCampaigns(minutes(29));
    expect(outbox).toHaveLength(0);
    expect(c.status).toBe("SCHEDULED");
    const t = await drainMarketingCampaigns(minutes(31));
    expect(t.promoted).toBe(1);
    expect(outbox).toHaveLength(3);
  });

  it("paused and cancelled campaigns are never touched by the worker", async () => {
    addSubscribers(5);
    const paused = addCampaign({ status: "PAUSED" });
    const cancelled = addCampaign({ status: "CANCELLED" });
    const draft = addCampaign({ status: "DRAFT" });
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    await drainMarketingCampaigns(NOW);
    expect(outbox).toHaveLength(0);
    expect([paused.status, cancelled.status, draft.status]).toEqual(["PAUSED", "CANCELLED", "DRAFT"]);
    expect(sends).toHaveLength(0);
  });

  it("a campaign paused in the middle stops at the next pass and what was already sent stays sent", async () => {
    addSubscribers(50);
    const c = addCampaign();
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    await drainMarketingCampaigns(NOW);
    expect(outbox).toHaveLength(20);
    c.status = "PAUSED";
    await drainMarketingCampaigns(minutes(1));
    expect(outbox).toHaveLength(20);
    expect(counts()).toEqual({ SENT: 20, PENDING: 30 });
  });

  it("two workers running at the same moment never send the same recipient twice", async () => {
    addSubscribers(40);
    addCampaign();
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    await Promise.all([drainMarketingCampaigns(NOW), drainMarketingCampaigns(NOW), drainMarketingCampaigns(NOW)]);
    await Promise.all([drainMarketingCampaigns(minutes(1)), drainMarketingCampaigns(minutes(1))]);
    const recipients = outbox.map((o) => o.to);
    expect(new Set(recipients).size).toBe(recipients.length); // no duplicate email, whatever the interleaving
  });

  it("drives a whole 3,000-subscriber campaign to completion in rate-limited passes with every recipient emailed exactly once", async () => {
    vi.stubEnv("CAMPAIGN_SENDS_PER_MINUTE", "600");
    vi.stubEnv("CAMPAIGN_DAILY_LIMIT", "100000");
    addSubscribers(3_000);
    const c = addCampaign();
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    let pass = 0;
    while (c.status !== "SENT" && pass < 30) {
      await drainMarketingCampaigns(minutes(pass));
      expect(outbox.length).toBeLessThanOrEqual((pass + 1) * 600);
      pass++;
    }
    expect(c.status).toBe("SENT");
    expect(outbox).toHaveLength(3_000);
    expect(new Set(outbox.map((o) => o.to)).size).toBe(3_000);
    expect(c.recipientCount).toBe(3_000);
  });
});

describe("statistics", () => {
  it("states the honest counts and fractions", async () => {
    const { summarizeSendCounts } = await import("../campaign-worker");
    expect(summarizeSendCounts({ PENDING: 10, SENT: 70, FAILED: 5, UNKNOWN: 3, SKIPPED_UNSUBSCRIBED: 8, SKIPPED_SUPPRESSED: 4 })).toEqual({
      audience: 100, queued: 10, sent: 70, failed: 5, unknown: 3, skippedUnsubscribed: 8, skippedSuppressed: 4, completedFraction: 0.9,
    });
    expect(summarizeSendCounts({})).toMatchObject({ audience: 0, completedFraction: 0 });
  });

  it("getCampaignStats reads the live rows", async () => {
    addSubscribers(4);
    addCampaign();
    const { drainMarketingCampaigns, getCampaignStats } = await import("../campaign-worker");
    await drainMarketingCampaigns(NOW);
    expect(await getCampaignStats("camp1")).toMatchObject({ audience: 4, sent: 4, queued: 0 });
  });

  it("detects provider rate-limit wording", async () => {
    const { isRateLimitError } = await import("../campaign-worker");
    for (const m of ["Rate Limit Exceeded", "userRateLimitExceeded", "Daily sending quota exceeded", "429 Too Many Requests", "Too many messages"]) expect(isRateLimitError(m), m).toBe(true);
    for (const m of ["Invalid recipient", "Mailbox not found", "Message too large"]) expect(isRateLimitError(m), m).toBe(false);
  });
});

describe("the per-minute limit is shared by every worker on the same database", () => {
  it("a second worker in the same minute sees what the first already attempted and sends only the remainder of the budget", async () => {
    addSubscribers(60);
    addCampaign();
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    await drainMarketingCampaigns(NOW); // instance A: 20
    const t = await drainMarketingCampaigns(new Date(NOW.getTime() + 10_000)); // instance B, 10 s later: the minute's budget is spent
    expect(t.sent).toBe(0);
    expect(outbox).toHaveLength(20);
    await drainMarketingCampaigns(minutes(1)); // the next minute
    expect(outbox).toHaveLength(40);
  });
});

describe("pause, cancel and unsubscribe take effect between recipients inside a running batch", () => {
  it("a pause that lands in the middle of a batch stops the very next recipient (not the rest of the batch)", async () => {
    addSubscribers(20);
    const c = addCampaign();
    const svc = await import("@/server/email/service");
    let n = 0;
    (svc.sendEmail as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (a: { to: string; subject: string; html: string }) => {
      outbox.push({ to: a.to, subject: a.subject, html: a.html });
      if (++n === 3) c.status = "PAUSED"; // the operator clicks Pause while the third message is going out
      return { ok: true, messageId: `m${n}` };
    });
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    await drainMarketingCampaigns(NOW);
    expect(outbox).toHaveLength(3);
    expect(counts()).toEqual({ SENT: 3, PENDING: 17 });
  });

  it("a subscriber who unsubscribes while the batch is running is skipped even though the batch was already selected", async () => {
    addSubscribers(5);
    addCampaign();
    const svc = await import("@/server/email/service");
    (svc.sendEmail as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (a: { to: string; subject: string; html: string }) => {
      outbox.push({ to: a.to, subject: a.subject, html: a.html });
      subscribers[3].status = "UNSUBSCRIBED"; // unsubscribes during the first send
      return { ok: true, messageId: "m" };
    });
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    await drainMarketingCampaigns(NOW);
    expect(outbox.some((o) => o.to === subscribers[3].email)).toBe(false);
    expect(sends.find((s) => s.subscriberId === subscribers[3].id)!.status).toBe("SKIPPED_UNSUBSCRIBED");
  });
});

describe("the quota is claimed atomically: concurrent workers can never overshoot a limit", () => {
  it("ten workers ticking at the same instant claim at most the per-minute budget in total (the previous design could overshoot by a whole batch)", async () => {
    addSubscribers(300);
    addCampaign();
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    await Promise.all(Array.from({ length: 10 }, () => drainMarketingCampaigns(NOW)));
    expect(sends.filter((s) => s.lastAttemptAt !== null)).toHaveLength(20);
    expect(outbox).toHaveLength(20);
  });

  it("many campaigns of ONE sender share one budget; another sender's campaigns have their own", async () => {
    addSubscribers(100);
    addCampaign({ id: "a1", createdById: "sender-1" });
    addCampaign({ id: "a2", createdById: "sender-1" });
    addCampaign({ id: "b1", createdById: "sender-2" });
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    await Promise.all([drainMarketingCampaigns(NOW), drainMarketingCampaigns(NOW), drainMarketingCampaigns(NOW)]);
    const byCampaign = (ids: string[]) => sends.filter((s) => ids.includes(s.campaignId) && s.lastAttemptAt !== null).length;
    expect(byCampaign(["a1", "a2"])).toBe(20); // sender-1: one shared minute budget across both campaigns
    expect(byCampaign(["b1"])).toBe(20); // sender-2: its own budget
  });

  it("the rolling daily cap holds under concurrency too, and uncertain (UNKNOWN) messages count against it because they may have been delivered", async () => {
    vi.stubEnv("CAMPAIGN_DAILY_LIMIT", "25");
    addSubscribers(100);
    const c = addCampaign();
    // five messages whose outcome is unknown, claimed in the last day: they are part of the day's usage
    for (let i = 0; i < 5; i++) sends.push({ id: `old${i}`, campaignId: c.id, subscriberId: `ghost${i}`, status: "UNKNOWN", attempts: 1, nextAttemptAt: null, lastAttemptAt: minutes(-600), sentAt: null, errorMessage: null, providerMessageId: null });
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    for (let minute = 0; minute < 5; minute++) await Promise.all(Array.from({ length: 4 }, () => drainMarketingCampaigns(minutes(minute))));
    expect(outbox).toHaveLength(20); // 25 - 5 uncertain
    expect(c.status).toBe("SENDING"); // waiting for the window, not failed
  });

  it("a crashed worker that had claimed some recipients does not let the others exceed the budget (their claims still count)", async () => {
    addSubscribers(100);
    const c = addCampaign();
    for (let i = 0; i < 12; i++) sends.push({ id: `dead${i}`, campaignId: c.id, subscriberId: `ghost${i}`, status: "UNKNOWN", attempts: 1, nextAttemptAt: null, lastAttemptAt: NOW, sentAt: null, errorMessage: null, providerMessageId: null });
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    await Promise.all([drainMarketingCampaigns(NOW), drainMarketingCampaigns(NOW)]);
    expect(outbox).toHaveLength(8); // 20 per minute - 12 already claimed this minute
  });

  it("the claim is a compare-and-swap: two workers racing for the SAME row produce one claim, never two sends", async () => {
    addSubscribers(1);
    const c = addCampaign();
    const { snapshotAudienceChunk, claimWithinQuota } = await import("../campaign-worker");
    await snapshotAudienceChunk(c.id, c.companyId, null);
    const row = { id: sends[0].id, attempts: 0 };
    const results = await Promise.all([claimWithinQuota("sender-1", row, NOW), claimWithinQuota("sender-1", row, NOW), claimWithinQuota("sender-1", row, NOW)]);
    expect(results.filter((r) => r === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r === "lost")).toHaveLength(2);
    expect(sends[0].attempts).toBe(1);
  });

  it("a spent quota is reported as 'quota' and leaves the row untouched and pending", async () => {
    vi.stubEnv("CAMPAIGN_SENDS_PER_MINUTE", "1");
    addSubscribers(3);
    const c = addCampaign();
    const { snapshotAudienceChunk, claimWithinQuota } = await import("../campaign-worker");
    await snapshotAudienceChunk(c.id, c.companyId, null);
    expect(await claimWithinQuota("sender-1", { id: sends[0].id, attempts: 0 }, NOW)).toBe("claimed");
    expect(await claimWithinQuota("sender-1", { id: sends[1].id, attempts: 0 }, NOW)).toBe("quota");
    expect(sends[1]).toMatchObject({ status: "PENDING", attempts: 0, lastAttemptAt: null });
    expect(await claimWithinQuota("sender-1", { id: sends[1].id, attempts: 0 }, minutes(2))).toBe("claimed"); // the next minute
  });

  it("the claim runs under the per-sender advisory lock inside one transaction (the lock is what makes the check and the claim inseparable)", async () => {
    addSubscribers(1);
    const c = addCampaign();
    const { prisma } = await import("@/lib/prisma");
    const { snapshotAudienceChunk, claimWithinQuota } = await import("../campaign-worker");
    await snapshotAudienceChunk(c.id, c.companyId, null);
    await claimWithinQuota("sender-1", { id: sends[0].id, attempts: 0 }, NOW);
    expect(prisma.$transaction).toHaveBeenCalled();
    const lockCall = (prisma.$queryRaw as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)!;
    expect((lockCall[0] as string[]).join("?")).toContain("pg_advisory_xact_lock");
    expect(lockCall[1]).toBe("campaign-send-quota:sender-1");
  });
});

describe("one-click unsubscribe header (RFC 8058)", () => {
  it("every campaign message is handed to the mail provider with THAT recipient's own unsubscribe URL for the List-Unsubscribe pair", async () => {
    addSubscribers(3);
    addCampaign();
    const svc = await import("@/server/email/service");
    const spy = svc.sendEmail as unknown as ReturnType<typeof vi.fn>;
    spy.mockClear();
    const { drainMarketingCampaigns } = await import("../campaign-worker");
    await drainMarketingCampaigns(NOW);
    const calls = spy.mock.calls.map((c) => c[0] as { to: string; listUnsubscribeUrl?: string });
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      const sub = subscribers.find((s) => s.email === c.to)!;
      expect(c.listUnsubscribeUrl).toBe(`https://crm.example.test/api/public/unsubscribe?token=${sub.unsubscribeToken}`);
    }
    expect(new Set(calls.map((c) => c.listUnsubscribeUrl)).size).toBe(3); // never one shared link
  });
});
