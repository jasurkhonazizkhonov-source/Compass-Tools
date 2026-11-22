import { describe, it, expect, vi, beforeEach } from "vitest";

// Server actions behind the campaign builder, queued delivery and background imports: who may use them, what they refuse, and that they only ever queue (never send).

type Actor = { id: string; role: string; companyId: string; email: string; fullName: string };
let actor: Actor | null;
let campaigns: Array<Record<string, unknown> & { id: string; companyId: string; status: string }>;
let importJobs: Array<Record<string, unknown> & { id: string; companyId: string; status: string }>;
let subscriberCount: number;
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
vi.mock("@/server/marketing/campaign-worker", () => ({ dailyLimit: () => 400, sendsPerMinute: () => 20, getCampaignStats: vi.fn(async () => ({ audience: 0, queued: 0, sent: 0, failed: 0, unknown: 0, skippedUnsubscribed: 0, skippedSuppressed: 0, completedFraction: 0 })) }));

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
    marketingCampaignSend: { count: vi.fn(async () => 0) },
    subscriberImportJob: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `job-${importJobs.length + 1}`, status: "QUEUED", ...data } as (typeof importJobs)[number];
        importJobs.push(row);
        return { id: row.id };
      }),
      findMany: vi.fn(async ({ where }: { where: { companyId: string } }) => importJobs.filter((j) => j.companyId === where.companyId).map((j) => ({ nextRow: 0, errorReport: null, createdAt: new Date(), finishedAt: null, source: "PASTE", totalRows: 0, validRows: 0, invalidRows: 0, duplicateInFile: 0, existingRows: 0, importedRows: 0, skippedUnsubscribedOrSuppressed: 0, ...j }))),
      findFirst: vi.fn(async ({ where }: { where: { id: string; companyId: string } }) => importJobs.find((j) => j.id === where.id && j.companyId === where.companyId) ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; companyId: string; status: { in: string[] } | string }; data: Record<string, unknown> }) => {
        const hit = importJobs.filter((j) => j.id === where.id && j.companyId === where.companyId && (typeof where.status === "string" ? j.status === where.status : where.status.in.includes(j.status)));
        hit.forEach((j) => Object.assign(j, data));
        return { count: hit.length };
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
  importJobs = [];
  subscriberCount = 10;
  gmail = "CONNECTED";
  audits.length = 0;
  created.length = 0;
  sendEmail.mockClear();
});

describe("authorization", () => {
  it.each(["MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT"])("a %s is refused by every campaign-delivery and import action", async (role) => {
    actor = as(role);
    const d = await import("../campaign-delivery");
    const i = await import("../subscriber-imports");
    for (const call of [
      () => d.queueCampaign("c1"), () => d.pauseCampaignDelivery("c1"), () => d.resumeCampaignDelivery("c1"), () => d.cancelCampaignDelivery("c1"), () => d.getCampaignAnalytics("c1"),
      () => d.saveCampaignDesign({ name: "n", subject: "s", design: goodDesign }), () => d.previewCampaignDesign(goodDesign, "s"), () => d.sendCampaignTest("c1"),
      () => i.previewSubscriberImport("a@example.com"), () => i.createSubscriberImportJob("a@example.com"), () => i.listSubscriberImportJobs(), () => i.getSubscriberImportErrorReport("j1"),
      () => i.cancelSubscriberImport("j1"), () => i.resumeSubscriberImport("j1"),
    ]) await expect(call()).rejects.toThrow(/not authorized/i);
    expect(campaigns[0].status).toBe("DRAFT");
    expect(importJobs).toHaveLength(0);
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

  it("queueing twice cannot double-queue (the second sees a campaign that is no longer a draft)", async () => {
    const { queueCampaign } = await import("../campaign-delivery");
    const [a, b] = await Promise.all([queueCampaign("c1"), queueCampaign("c1")]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(audits.filter((x) => x.action === "CAMPAIGN_QUEUED")).toHaveLength(1);
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

describe("subscriber import actions", () => {
  it("queues a validated import (nothing is written to the subscriber list by the request), with counts and an error report that holds no address", async () => {
    const { createSubscriberImportJob } = await import("../subscriber-imports");
    const r = await createSubscriberImportJob("a@example.com,Ada\nbroken\nA@example.com\nb@example.com");
    expect(r).toMatchObject({ ok: true, validRows: 2 });
    expect(importJobs[0]).toMatchObject({ companyId: "co-1", totalRows: 4, validRows: 2, invalidRows: 1, duplicateInFile: 1, status: "QUEUED" });
    expect(importJobs[0].errorReport).toBe("row,reason\n2,INVALID_EMAIL\n3,DUPLICATE_IN_FILE");
    expect(audits[0]).toMatchObject({ action: "SUBSCRIBER_IMPORT_QUEUED" });
    expect(JSON.stringify(audits[0])).not.toMatch(/@example/);
  });

  it("refuses an empty list, a list with no valid address, an oversized file and a list over the row limit", async () => {
    const { createSubscriberImportJob } = await import("../subscriber-imports");
    expect(await createSubscriberImportJob("   ")).toMatchObject({ ok: false });
    expect(await createSubscriberImportJob("nope\nalso nope")).toMatchObject({ ok: false, error: expect.stringMatching(/No valid email/) });
    expect(await createSubscriberImportJob("a@example.com\n".repeat(1_000_000))).toMatchObject({ ok: false, error: expect.stringMatching(/larger than 4 MB/) });
    const many = Array.from({ length: 250_001 }, (_, i) => `u${i}@e.co`).join("\n");
    expect(await createSubscriberImportJob(many)).toMatchObject({ ok: false, error: expect.stringMatching(/250,000/) });
    expect(importJobs).toHaveLength(0);
  });

  it("the supported maximum is the SMALLER of 250,000 rows and 4 MB: exactly 250,000 short rows are accepted, one more row is refused, and a multi-byte file is measured in BYTES", async () => {
    const { createSubscriberImportJob } = await import("../subscriber-imports");
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `${i}@e.co`).join("\n");
    const ok = await createSubscriberImportJob(rows(250_000));
    expect(ok).toMatchObject({ ok: true, validRows: 250_000 });
    expect(String(importJobs.at(-1)!.payload).length).toBeLessThan(4 * 1024 * 1024); // the stored payload fits the byte limit too
    expect(await createSubscriberImportJob(rows(250_001))).toMatchObject({ ok: false, error: expect.stringMatching(/250,000/) });
    // 1.5 million 3-byte characters: only ~1.5 million UTF-16 units but ~4.5 MB of bytes -> refused on bytes, not on length
    expect(await createSubscriberImportJob("\u20AC".repeat(1_500_000))).toMatchObject({ ok: false, error: expect.stringMatching(/larger than 4 MB/) });
  });
  it("lists only this company's jobs, never exposing the payload, and cancel / resume only act on this company's job in a valid state", async () => {
    const { listSubscriberImportJobs, cancelSubscriberImport, resumeSubscriberImport } = await import("../subscriber-imports");
    importJobs.push({ id: "mine", companyId: "co-1", status: "PROCESSING", payload: "secret@example.com,,\n" }, { id: "theirs", companyId: "co-2", status: "PROCESSING", payload: "x@y.co,," });
    const list = await listSubscriberImportJobs();
    expect(list.map((j) => j.id)).toEqual(["mine"]);
    expect(JSON.stringify(list)).not.toMatch(/secret@|payload/);
    expect(await cancelSubscriberImport("theirs")).toEqual({ ok: false });
    expect(await cancelSubscriberImport("mine")).toEqual({ ok: true });
    expect(importJobs.find((j) => j.id === "mine")).toMatchObject({ status: "CANCELLED", payload: null });
    expect(await resumeSubscriberImport("mine")).toEqual({ ok: false }); // only FAILED jobs resume
  });
});
