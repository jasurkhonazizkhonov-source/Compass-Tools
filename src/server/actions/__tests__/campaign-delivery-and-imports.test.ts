import { describe, it, expect, vi, beforeEach } from "vitest";

// Server actions behind the campaign builder and queued delivery: who may use them, what they refuse, and that they only ever queue (never send).

type Actor = { id: string; role: string; companyId: string; email: string; fullName: string };
let actor: Actor | null;
let campaigns: Array<Record<string, unknown> & { id: string; companyId: string; status: string }>;
let subscriberCount: number;
let sendRows: Array<{ id: string; campaignId: string; status: string; nextAttemptAt?: Date | null; errorMessage?: string | null }>;
let gmail: "CONNECTED" | "NOT_CONNECTED" | "REVOKED";
const audits: Array<Record<string, unknown>> = [];
const created: Array<Record<string, unknown>> = [];

vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => actor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/queries/gmail-connection", () => ({ getGmailConnectionState: vi.fn(async () => gmail) }));
vi.mock("@/server/queries/company", () => ({ getCompanyForAccountId: vi.fn(async () => ({ name: "Co" })) }));
vi.mock("@/lib/company-config", () => ({ resolveBaseUrl: () => "https://crm.example.test" }));
vi.mock("@/server/email/templates", () => ({ buildMarketingCampaignEmail: vi.fn((p: { htmlContent: string }) => ({ subject: "s", html: `<shell>${p.htmlContent}<a>Unsubscribe</a></shell>` })) }));
const sendEmail = vi.fn(async (args: unknown) => (void args, { ok: true, messageId: "m" }));
vi.mock("@/server/email/service", () => ({ sendEmail: (...a: unknown[]) => (sendEmail as unknown as (...x: unknown[]) => unknown)(...a) }));
const processNow = vi.fn(async (id: string) => (void id, { promoted: 0, snapshotted: 1, sent: 1, failed: 0, unknown: 0, skipped: 0, paused: 0, completed: 1 }));
vi.mock("@/server/marketing/campaign-worker", () => ({ processCampaignNow: (...a: unknown[]) => (processNow as unknown as (...x: unknown[]) => unknown)(...a), dailyLimit: () => 400, sendsPerMinute: () => 20, getCampaignStats: vi.fn(async () => ({ audience: 0, queued: 0, sent: 0, failed: 0, unknown: 0, skippedUnsubscribed: 0, skippedSuppressed: 0, completedFraction: 0 })) }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    marketingCampaign: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; companyId: string } }) => campaigns.find((c) => c.id === where.id && c.companyId === where.companyId) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `camp-${campaigns.length + 1}`, status: "DRAFT", ...data } as (typeof campaigns)[number];
        campaigns.push(row);
        created.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(campaigns.find((c) => c.id === where.id)!, data)),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; companyId: string; status: string | { in: string[] } }; data: Record<string, unknown> }) => {
        const hit = campaigns.filter((c) => c.id === where.id && c.companyId === where.companyId && (typeof where.status === "string" ? c.status === where.status : where.status.in.includes(c.status)));
        hit.forEach((c) => Object.assign(c, data));
        return { count: hit.length };
      }),
    },
    subscriber: { count: vi.fn(async () => subscriberCount), findMany: vi.fn(async () => []) },
    marketingCampaignSend: {
      count: vi.fn(async () => 0),
      // one atomic conditional update, as in the real database: the row changes only if EVERY condition still holds
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; campaignId: string; status: string; campaign: { companyId: string; status: { in: string[] } } }; data: Record<string, unknown> }) => {
        const camp = campaigns.find((c) => c.id === where.campaignId);
        const allowed = !!camp && camp.companyId === where.campaign.companyId && where.campaign.status.in.includes(camp.status);
        const hit = allowed ? sendRows.filter((r) => r.id === where.id && r.campaignId === where.campaignId && r.status === where.status) : [];
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string; campaignId: string; campaign: { companyId: string } } }) => {
        const r = sendRows.find((x) => x.id === where.id && x.campaignId === where.campaignId);
        const camp = r && campaigns.find((c) => c.id === r.campaignId);
        return r && camp && camp.companyId === where.campaign.companyId ? { status: r.status, campaign: { status: camp.status } } : null;
      }),
    },
    auditLog: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => void audits.push(data)) },
  },
}));

const as = (role: string, id = "u1", companyId = "co-1"): Actor => ({ id, role, companyId, email: "me@crm.test", fullName: "Me" });
const goodDesign = {
  version: 1 as const, accent: "#1d4ed8",
  blocks: [
    { id: "h", type: "heading" as const, text: "Hello {{firstName|there}}", level: 1 as const, align: "left" as const },
    { id: "b", type: "button" as const, label: "Go", url: "https://example.com/go", align: "left" as const, color: "#1d4ed8" },
  ],
};

beforeEach(() => {
  actor = as("MARKETING_AGENT");
  campaigns = [{ id: "c1", companyId: "co-1", status: "DRAFT", subject: "Subject", htmlContent: "<p>Hi</p>", createdById: "u1", designJson: null, scheduledAt: null }];
  subscriberCount = 10;
  sendRows = [];
  gmail = "CONNECTED";
  audits.length = 0;
  created.length = 0;
  sendEmail.mockClear();
  processNow.mockClear();
});

describe("authorization", () => {
  it.each(["MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT"])("a %s is refused by every campaign-delivery action", async (role) => {
    actor = as(role);
    const d = await import("../campaign-delivery");
    for (const call of [
      () => d.queueCampaign("c1"), () => d.pauseCampaignDelivery("c1"), () => d.resumeCampaignDelivery("c1"), () => d.cancelCampaignDelivery("c1"), () => d.getCampaignAnalytics("c1"),
      () => d.saveCampaignDesign({ name: "n", subject: "s", design: goodDesign }), () => d.previewCampaignDesign(goodDesign, "s"), () => d.sendCampaignTest("c1"),
      () => d.cancelCampaignRecipient("c1", "r1"),
    ]) await expect(call()).rejects.toThrow(/not authorized/i);
    expect(campaigns[0].status).toBe("DRAFT");
    expect(processNow).not.toHaveBeenCalled();
  });

  it("signed-out callers are refused", async () => {
    actor = null;
    const { queueCampaign } = await import("../campaign-delivery");
    await expect(queueCampaign("c1")).rejects.toThrow(/not authorized/i);
  });

  it("another company's campaign is 'not found' and is never changed", async () => {
    actor = as("ADMIN", "a1", "co-2");
    const { queueCampaign, pauseCampaignDelivery, cancelCampaignDelivery } = await import("../campaign-delivery");
    expect(await queueCampaign("c1")).toEqual({ ok: false, error: "Campaign not found." });
    campaigns[0].status = "SENDING";
    expect((await pauseCampaignDelivery("c1")).ok).toBe(false);
    expect((await cancelCampaignDelivery("c1")).ok).toBe(false);
    expect(campaigns[0].status).toBe("SENDING");
  });
});

describe("queueCampaign - hands the campaign to background delivery, sends nothing itself", () => {
  it("queues a valid draft: status QUEUED, audit entry, and not one email is sent by this request", async () => {
    const { queueCampaign } = await import("../campaign-delivery");
    expect(await queueCampaign("c1")).toEqual({ ok: true, status: "QUEUED", audience: 10 });
    expect(campaigns[0]).toMatchObject({ status: "QUEUED", scheduledAt: null });
    expect(audits[0]).toMatchObject({ action: "CAMPAIGN_QUEUED", entityId: "c1" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("schedules for a future time (SCHEDULED), and refuses a past time, a time too far ahead, and nonsense", async () => {
    const { queueCampaign } = await import("../campaign-delivery");
    expect(await queueCampaign("c1", new Date(Date.now() + 3_600_000).toISOString())).toMatchObject({ ok: true, status: "SCHEDULED" });
    campaigns[0].status = "DRAFT";
    expect(await queueCampaign("c1", new Date(Date.now() - 1000).toISOString())).toMatchObject({ ok: false, error: expect.stringMatching(/at least a minute/) });
    expect(await queueCampaign("c1", new Date(Date.now() + 200 * 86_400_000).toISOString())).toMatchObject({ ok: false, error: expect.stringMatching(/90 days/) });
    expect(await queueCampaign("c1", "not a date")).toMatchObject({ ok: false, error: expect.stringMatching(/valid date/) });
  });

  it("refuses an unfinished placeholder, an invalid builder design, an empty audience, a disconnected sender, and a non-draft", async () => {
    const { queueCampaign } = await import("../campaign-delivery");
    campaigns[0].subject = "Fares to [[Destination]]";
    expect(await queueCampaign("c1")).toMatchObject({ ok: false, error: expect.stringMatching(/\[\[Destination\]\]/) });
    campaigns[0].subject = "Subject";
    campaigns[0].designJson = { ...goodDesign, blocks: [{ id: "b", type: "button", label: "Go", url: "javascript:alert(1)", align: "left", color: "#1d4ed8" }] };
    expect(await queueCampaign("c1")).toMatchObject({ ok: false, error: expect.stringMatching(/http/) });
    campaigns[0].designJson = null;
    subscriberCount = 0;
    expect(await queueCampaign("c1")).toMatchObject({ ok: false, error: expect.stringMatching(/no active subscribers/) });
    subscriberCount = 5;
    gmail = "NOT_CONNECTED";
    expect(await queueCampaign("c1")).toMatchObject({ ok: false, error: expect.stringMatching(/Gmail/) });
    gmail = "CONNECTED";
    campaigns[0].status = "SENT";
    expect(await queueCampaign("c1")).toEqual({ ok: false, error: "Only a draft can be queued." });
    expect(campaigns[0].status).toBe("SENT");
  });

  describe("an audience of exactly one subscriber is sent directly (same worker pass, run once, right now)", () => {
    const tick = (over: Partial<Record<string, number>> = {}) => ({ promoted: 0, snapshotted: 1, sent: 0, failed: 0, unknown: 0, skipped: 0, paused: 0, completed: 0, ...over });

    it("runs the worker pass for THIS campaign once, and says it was sent; nothing is sent by the action itself (the worker does it)", async () => {
      subscriberCount = 1;
      const { queueCampaign } = await import("../campaign-delivery");
      expect(await queueCampaign("c1")).toEqual({ ok: true, status: "QUEUED", audience: 1, immediate: "sent" });
      expect(processNow).toHaveBeenCalledTimes(1);
      expect(processNow).toHaveBeenCalledWith("c1");
      expect(sendEmail).not.toHaveBeenCalled(); // the real send is inside the worker (claim, quota, suppression check); the action never calls the mail service itself
      expect(audits[0]).toMatchObject({ action: "CAMPAIGN_QUEUED", entityId: "c1" });
    });

    it.each([
      [tick({ sent: 1 }), "sent"],
      [tick({ unknown: 1 }), "unknown"],
      [tick({ skipped: 1 }), "skipped"],
      [tick({ paused: 1 }), "paused"],
      [tick(), "waiting"],
    ])("reports the real outcome of the pass honestly (%j -> %s)", async (t, expected) => {
      subscriberCount = 1;
      processNow.mockResolvedValueOnce(t as never);
      const { queueCampaign } = await import("../campaign-delivery");
      expect(await queueCampaign("c1")).toMatchObject({ ok: true, audience: 1, immediate: expected });
    });

    it("an unexpected failure of the immediate pass never turns a successful queueing into an error: the campaign stays queued for the poller", async () => {
      subscriberCount = 1;
      processNow.mockRejectedValueOnce(new Error("boom"));
      const { queueCampaign } = await import("../campaign-delivery");
      expect(await queueCampaign("c1")).toMatchObject({ ok: true, status: "QUEUED", immediate: "waiting" });
      expect(campaigns[0].status).toBe("QUEUED");
    });

    it("a larger audience is NEVER sent from the request (queue only), and neither is a scheduled one-subscriber campaign", async () => {
      const { queueCampaign } = await import("../campaign-delivery");
      subscriberCount = 2;
      expect(await queueCampaign("c1")).toEqual({ ok: true, status: "QUEUED", audience: 2 });
      campaigns[0].status = "DRAFT";
      subscriberCount = 1;
      expect(await queueCampaign("c1", new Date(Date.now() + 3_600_000).toISOString())).toEqual({ ok: true, status: "SCHEDULED", audience: 1 });
      expect(processNow).not.toHaveBeenCalled();
    });

    it("every existing refusal still applies first: disconnected Gmail, no subscribers, a non-draft and an unfinished placeholder never reach the worker", async () => {
      const { queueCampaign } = await import("../campaign-delivery");
      subscriberCount = 1;
      gmail = "NOT_CONNECTED";
      expect(await queueCampaign("c1")).toMatchObject({ ok: false });
      gmail = "CONNECTED";
      subscriberCount = 0;
      expect(await queueCampaign("c1")).toMatchObject({ ok: false });
      subscriberCount = 1;
      campaigns[0].subject = "Fares to [[Destination]]";
      expect(await queueCampaign("c1")).toMatchObject({ ok: false });
      campaigns[0].subject = "Subject";
      campaigns[0].status = "SENDING";
      expect(await queueCampaign("c1")).toEqual({ ok: false, error: "Only a draft can be queued." });
      expect(processNow).not.toHaveBeenCalled();
    });

    it("double click: only the request that wins the DRAFT -> QUEUED switch runs the pass, so the one subscriber cannot be handled twice from here", async () => {
      subscriberCount = 1;
      const { queueCampaign } = await import("../campaign-delivery");
      const [a, b] = await Promise.all([queueCampaign("c1"), queueCampaign("c1")]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      expect(processNow).toHaveBeenCalledTimes(1);
    });
  });

  it("queueing twice cannot double-queue (the second sees a campaign that is no longer a draft)", async () => {
    const { queueCampaign } = await import("../campaign-delivery");
    const [a, b] = await Promise.all([queueCampaign("c1"), queueCampaign("c1")]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(audits.filter((x) => x.action === "CAMPAIGN_QUEUED")).toHaveLength(1);
  });
});

describe("cancelCampaignRecipient - one recipient, never the campaign", () => {
  const rec = (id: string, status: string, over: Record<string, unknown> = {}) => sendRows.push({ id, campaignId: "c1", status, nextAttemptAt: null, errorMessage: null, ...over });
  const setup = (campaignStatus = "SENDING") => {
    campaigns[0].status = campaignStatus;
    rec("r-wait", "PENDING");
    rec("r-sched", "PENDING", { nextAttemptAt: new Date(Date.now() + 3_600_000), errorMessage: "Provider sending limit reached; will retry later" });
    rec("r-sent", "SENT");
    rec("r-unknown", "UNKNOWN");
    rec("r-failed", "FAILED");
    rec("r-skip", "SKIPPED_UNSUBSCRIBED");
  };
  const status = (id: string) => sendRows.find((r) => r.id === id)!.status;

  it("a Waiting recipient is cancelled: status CANCELLED, no retry time left, an audit entry that names the row but no address - and the CAMPAIGN is untouched", async () => {
    setup();
    const { cancelCampaignRecipient } = await import("../campaign-delivery");
    expect(await cancelCampaignRecipient("c1", "r-wait")).toEqual({ ok: true });
    expect(status("r-wait")).toBe("CANCELLED");
    expect(sendRows.find((r) => r.id === "r-wait")).toMatchObject({ nextAttemptAt: null, errorMessage: "Cancelled before it was sent" });
    expect(campaigns[0].status).toBe("SENDING"); // not the whole campaign
    expect(audits.at(-1)).toMatchObject({ action: "CAMPAIGN_RECIPIENT_CANCELLED", entityType: "MarketingCampaignSend", entityId: "r-wait", metadata: { campaignId: "c1" } });
    expect(JSON.stringify(audits.at(-1))).not.toMatch(/@/);
    for (const other of ["r-sched", "r-sent", "r-unknown", "r-failed", "r-skip"]) expect(status(other)).toBe({ "r-sched": "PENDING", "r-sent": "SENT", "r-unknown": "UNKNOWN", "r-failed": "FAILED", "r-skip": "SKIPPED_UNSUBSCRIBED" }[other]); // nobody else changed
  });

  it("a Scheduled recipient (waiting out a retry or the daily limit) can be cancelled too", async () => {
    setup();
    const { cancelCampaignRecipient } = await import("../campaign-delivery");
    expect(await cancelCampaignRecipient("c1", "r-sched")).toEqual({ ok: true });
    expect(sendRows.find((r) => r.id === "r-sched")).toMatchObject({ status: "CANCELLED", nextAttemptAt: null });
  });

  it("works while the campaign is queued, sending or paused", async () => {
    const { cancelCampaignRecipient } = await import("../campaign-delivery");
    for (const s of ["QUEUED", "SENDING", "PAUSED"]) {
      sendRows = [];
      rec("r1", "PENDING");
      campaigns[0].status = s;
      expect(await cancelCampaignRecipient("c1", "r1"), s).toEqual({ ok: true });
    }
  });

  it("a SENT message can never be cancelled retroactively, and it is left exactly as it was", async () => {
    setup();
    const { cancelCampaignRecipient } = await import("../campaign-delivery");
    expect(await cancelCampaignRecipient("c1", "r-sent")).toEqual({ ok: false, error: "This message has already been sent, so it cannot be cancelled." });
    expect(status("r-sent")).toBe("SENT");
  });

  it("a recipient the worker has already CLAIMED (UNKNOWN: the send began) is not reported as cancelled", async () => {
    setup();
    const { cancelCampaignRecipient } = await import("../campaign-delivery");
    const r = await cancelCampaignRecipient("c1", "r-unknown");
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/already started.*outcome is shown as unknown/i) });
    expect(status("r-unknown")).toBe("UNKNOWN");
  });

  it("failed, skipped and already-cancelled recipients: refused with the true reason, unchanged", async () => {
    setup();
    const { cancelCampaignRecipient } = await import("../campaign-delivery");
    expect(await cancelCampaignRecipient("c1", "r-failed")).toMatchObject({ ok: false, error: expect.stringMatching(/nothing to cancel/i) });
    expect(await cancelCampaignRecipient("c1", "r-skip")).toMatchObject({ ok: false, error: expect.stringMatching(/nothing to cancel/i) });
    expect(await cancelCampaignRecipient("c1", "r-wait")).toEqual({ ok: true });
    expect(await cancelCampaignRecipient("c1", "r-wait")).toMatchObject({ ok: false, error: "This recipient was already cancelled." });
    expect(status("r-failed")).toBe("FAILED");
    expect(status("r-skip")).toBe("SKIPPED_UNSUBSCRIBED");
  });

  it("two simultaneous cancellations of the same recipient: exactly one succeeds, one audit entry", async () => {
    setup();
    const { cancelCampaignRecipient } = await import("../campaign-delivery");
    const before = audits.length;
    const [a, b] = await Promise.all([cancelCampaignRecipient("c1", "r-wait"), cancelCampaignRecipient("c1", "r-wait")]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(audits.length - before).toBe(1);
  });

  it("a campaign that can no longer send (cancelled, finished, still a draft) refuses, and changes nothing", async () => {
    const { cancelCampaignRecipient } = await import("../campaign-delivery");
    for (const s of ["CANCELLED", "SENT", "DRAFT", "SCHEDULED"]) {
      sendRows = [];
      rec("r1", "PENDING");
      campaigns[0].status = s;
      expect(await cancelCampaignRecipient("c1", "r1"), s).toMatchObject({ ok: false, error: expect.stringMatching(/no longer sending/i) });
      expect(status("r1")).toBe("PENDING");
    }
  });

  it("another company's recipient, a recipient of another campaign and an unknown id are all 'not found' and untouched", async () => {
    setup();
    const { cancelCampaignRecipient } = await import("../campaign-delivery");
    actor = as("ADMIN", "a1", "co-2");
    expect(await cancelCampaignRecipient("c1", "r-wait")).toEqual({ ok: false, error: "That recipient could not be found." });
    expect(status("r-wait")).toBe("PENDING");
    actor = as("MARKETING_AGENT");
    expect(await cancelCampaignRecipient("c1", "nope")).toEqual({ ok: false, error: "That recipient could not be found." });
    expect(await cancelCampaignRecipient("other-campaign", "r-wait")).toEqual({ ok: false, error: "That recipient could not be found." });
    expect(status("r-wait")).toBe("PENDING");
    expect(await cancelCampaignRecipient("", "")).toMatchObject({ ok: false });
    expect(await cancelCampaignRecipient(undefined as never, 5 as never)).toMatchObject({ ok: false });
  });

  it("cancelling a recipient is not cancelling the campaign: the campaign-wide Cancel is a different action with a different effect", async () => {
    setup();
    const { cancelCampaignRecipient, cancelCampaignDelivery } = await import("../campaign-delivery");
    await cancelCampaignRecipient("c1", "r-wait");
    expect(campaigns[0].status).toBe("SENDING");
    expect((await cancelCampaignDelivery("c1")).ok).toBe(true);
    expect(campaigns[0].status).toBe("CANCELLED");
    expect(status("r-sched")).toBe("PENDING"); // the campaign-wide cancel does not rewrite recipient rows; the list reads them as Cancelled
  });
});

describe("pause / resume / cancel", () => {
  it("only valid transitions happen, each audited", async () => {
    const { pauseCampaignDelivery, resumeCampaignDelivery, cancelCampaignDelivery } = await import("../campaign-delivery");
    campaigns[0].status = "SENDING";
    expect(await pauseCampaignDelivery("c1")).toEqual({ ok: true });
    expect(campaigns[0].status).toBe("PAUSED");
    expect(await pauseCampaignDelivery("c1")).toEqual({ ok: false }); // already paused
    expect(await resumeCampaignDelivery("c1")).toEqual({ ok: true });
    expect(campaigns[0].status).toBe("QUEUED");
    expect(await cancelCampaignDelivery("c1")).toEqual({ ok: true });
    expect(campaigns[0].status).toBe("CANCELLED");
    expect(await resumeCampaignDelivery("c1")).toEqual({ ok: false }); // cancelled is final
    expect(await pauseCampaignDelivery("c1")).toEqual({ ok: false });
    expect(audits.map((a) => a.action)).toEqual(["CAMPAIGN_PAUSED", "CAMPAIGN_RESUMED", "CAMPAIGN_CANCELLED"]);
  });

  it("a campaign that has already finished cannot be paused or cancelled", async () => {
    const { pauseCampaignDelivery, cancelCampaignDelivery } = await import("../campaign-delivery");
    campaigns[0].status = "SENT";
    expect((await pauseCampaignDelivery("c1")).ok).toBe(false);
    expect((await cancelCampaignDelivery("c1")).ok).toBe(false);
    expect(campaigns[0].status).toBe("SENT");
  });

  it("resume refuses while the sending Gmail is still disconnected", async () => {
    const { resumeCampaignDelivery } = await import("../campaign-delivery");
    campaigns[0].status = "PAUSED";
    gmail = "REVOKED";
    expect(await resumeCampaignDelivery("c1")).toMatchObject({ ok: false, error: expect.stringMatching(/Gmail/) });
    expect(campaigns[0].status).toBe("PAUSED");
  });
});

describe("saveCampaignDesign", () => {
  it("stores the validated design and the rendered, cleaned HTML, owned by the saving user and company", async () => {
    const { saveCampaignDesign } = await import("../campaign-delivery");
    const r = await saveCampaignDesign({ name: "Spring", subject: "Hi {{firstName|there}}", design: goodDesign });
    expect(r).toMatchObject({ ok: true });
    expect(created[0]).toMatchObject({ companyId: "co-1", createdById: "u1", name: "Spring" });
    expect(String(created[0].htmlContent)).toContain("Hello {{firstName|there}}");
    expect(String(created[0].htmlContent)).toContain('href="https://example.com/go"');
    expect(created[0].designJson).toEqual(goodDesign);
  });

  it("re-validates on the server: a javascript: button link, an unknown field or a missing subject is refused and nothing is stored", async () => {
    const { saveCampaignDesign } = await import("../campaign-delivery");
    const bad = { ...goodDesign, blocks: [{ id: "b", type: "button" as const, label: "Go", url: "javascript:alert(1)", align: "left" as const, color: "#1d4ed8" }] };
    expect(await saveCampaignDesign({ name: "n", subject: "s", design: bad })).toMatchObject({ ok: false });
    expect(await saveCampaignDesign({ name: "n", subject: "Hi {{nickname}}", design: goodDesign })).toMatchObject({ ok: false, error: expect.stringMatching(/nickname/) });
    expect(await saveCampaignDesign({ name: "n", subject: "  ", design: goodDesign })).toMatchObject({ ok: false });
    expect(await saveCampaignDesign({ name: "", subject: "s", design: goodDesign })).toMatchObject({ ok: false });
    expect(created).toHaveLength(0);
  });

  it("only a draft can be edited", async () => {
    const { saveCampaignDesign } = await import("../campaign-delivery");
    campaigns[0].status = "SENDING";
    expect(await saveCampaignDesign({ campaignId: "c1", name: "n", subject: "s", design: goodDesign })).toMatchObject({ ok: false, error: expect.stringMatching(/Only a draft/) });
  });
});

describe("sendCampaignTest - independent of the subscriber list", () => {
  it("sends one test to the signed-in user's own address with an empty subscriber list, and creates no send record", async () => {
    subscriberCount = 0;
    const { sendCampaignTest } = await import("../campaign-delivery");
    expect(await sendCampaignTest("c1")).toEqual({ ok: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: "me@crm.test", accountId: "u1" });
    expect(campaigns[0].status).toBe("DRAFT");
  });
  it("needs a connected Gmail", async () => {
    gmail = "NOT_CONNECTED";
    const { sendCampaignTest } = await import("../campaign-delivery");
    expect(await sendCampaignTest("c1")).toMatchObject({ ok: false });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
