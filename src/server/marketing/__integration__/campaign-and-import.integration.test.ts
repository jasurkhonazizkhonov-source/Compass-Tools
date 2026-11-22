// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

// REAL-DATABASE proof of the background workers: the SQL behind the claims, the unique rows, the cursor compare-and-swap and the shared rate limit.
//   * concurrent workers never send the same recipient twice and never create a recipient row twice;
//   * a recipient claimed by a worker that died stays UNKNOWN and is never sent again;
//   * pause / unsubscribe / suppression that happen while a batch is running take effect for the next recipient;
//   * the per-minute budget is shared through the database (sequential workers cannot exceed it; simultaneous ticks can overshoot by at most one batch each - a documented softness);
//   * a subscriber import is chunked, resumable, idempotent under concurrent workers, and never changes an unsubscribed or suppressed subscriber.
// Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL with this repo's migrations applied (the guard in src/test/integration-database-guard.ts enforces it).
// NOT RUN in the environment where it was written (no disposable database was available); CI (.github/workflows/ci.yml) runs it against its throw-away postgres service.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
  process.env.CAMPAIGN_SENDS_PER_MINUTE = "20";
  process.env.CAMPAIGN_DAILY_LIMIT = "400";
}

const outbox: string[] = [];
let onSend: ((to: string) => Promise<void>) | null = null;
vi.mock("@/server/email/service", () => ({
  sendEmail: vi.fn(async (a: { to: string }) => {
    await new Promise((r) => setTimeout(r, 5)); // lets concurrent workers genuinely interleave
    outbox.push(a.to);
    if (onSend) await onSend(a.to);
    return { ok: true as const, messageId: `m-${outbox.length}` };
  }),
}));
vi.mock("@/server/queries/company", () => ({
  getCompanyForAccountId: vi.fn(async () => ({ id: "default-company", name: "Test Co", website: null, phone: null, brandColor: "#1c3a5e", logoEmailUrl: "", logoWebUrl: "", logoIconUrl: "", signatureTemplate: "" })),
}));

const TAG = `cwi-${Date.now()}`;

describe.skipIf(!enabled)("campaign worker and import worker - real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let drain: typeof import("../campaign-worker").drainMarketingCampaigns;
  let importTick: typeof import("../subscriber-import-worker").processSubscriberImportJobs;
  let serialize: typeof import("@/lib/subscriber-import").serializeValidRows;
  let senderId: string;
  const campaignIds: string[] = [];
  const COMPANY = "default-company";

  const subscribers = async (n: number, prefix: string) => {
    await prisma.subscriber.createMany({ data: Array.from({ length: n }, (_, i) => ({ companyId: COMPANY, email: `${prefix}${String(i).padStart(4, "0")}-${TAG}@example.test`, source: "test" })) });
  };
  const newCampaign = async (name: string) => {
    const c = await prisma.marketingCampaign.create({
      data: { companyId: COMPANY, name: `${name}-${TAG}`, subject: "Hi {{firstName|there}}", htmlContent: "<p>Hello</p>", status: "QUEUED", queuedAt: new Date(), createdById: senderId },
    });
    campaignIds.push(c.id);
    return c;
  };
  const clean = async () => {
    await prisma.marketingCampaignSend.deleteMany({ where: { campaignId: { in: campaignIds } } });
    await prisma.marketingCampaign.deleteMany({ where: { id: { in: campaignIds } } });
    campaignIds.length = 0;
    await prisma.subscriber.deleteMany({ where: { email: { contains: TAG } } });
    await prisma.subscriberImportJob.deleteMany({ where: { createdById: senderId } });
  };

  beforeAll(async () => {
    ({ prisma } = await import("@/lib/prisma"));
    ({ drainMarketingCampaigns: drain } = await import("../campaign-worker"));
    ({ processSubscriberImportJobs: importTick } = await import("../subscriber-import-worker"));
    ({ serializeValidRows: serialize } = await import("@/lib/subscriber-import"));
    await prisma.company.upsert({ where: { id: COMPANY }, update: {}, create: { id: COMPANY, name: "Test Co", signatureTemplate: "Regards" } });
    senderId = (await prisma.account.create({ data: { fullName: "Sender", email: `sender-${TAG}@example.test`, role: "MARKETING_AGENT", status: "ACTIVE", companyId: COMPANY } })).id;
  });
  beforeEach(async () => {
    await clean();
    outbox.length = 0;
    onSend = null;
  });
  afterAll(async () => {
    if (!enabled) return;
    await clean();
    await prisma.account.deleteMany({ where: { id: senderId } });
    await prisma.$disconnect();
  });

  it("three workers ticking at the same instant never email the same recipient twice, and every recipient has exactly one row", async () => {
    await subscribers(30, "a");
    await newCampaign("concurrent");
    const now = new Date();
    await Promise.all([drain(now), drain(now), drain(now)]);
    expect(new Set(outbox).size).toBe(outbox.length); // no duplicate email
    expect(outbox.length).toBeLessThanOrEqual(60); // documented bound: at most one batch per simultaneously ticking worker
    const rows = await prisma.marketingCampaignSend.findMany({ where: { campaignId: { in: campaignIds } } });
    expect(new Set(rows.map((r) => r.subscriberId)).size).toBe(rows.length); // unique (campaign, subscriber)
    expect(rows.filter((r) => r.status === "SENT")).toHaveLength(outbox.length);
  });

  it("workers that run one after another share the per-minute budget through the database: 20 in the minute, never 40", async () => {
    await subscribers(60, "b");
    await newCampaign("budget");
    const t0 = new Date();
    await drain(t0);
    await drain(new Date(t0.getTime() + 10_000));
    await drain(new Date(t0.getTime() + 20_000));
    expect(outbox).toHaveLength(20);
    await drain(new Date(t0.getTime() + 61_000));
    expect(outbox).toHaveLength(40);
  });

  it("a recipient claimed by a worker that died (write-ahead UNKNOWN) is never sent again", async () => {
    await subscribers(5, "c");
    const c = await newCampaign("crash");
    await drain(new Date(Date.now() - 3_600_000)); // snapshot the audience and send
    const victim = await prisma.marketingCampaignSend.findFirst({ where: { campaignId: c.id }, include: { subscriber: true } });
    await prisma.marketingCampaignSend.update({ where: { id: victim!.id }, data: { status: "UNKNOWN", attempts: 1, sentAt: null } });
    await prisma.marketingCampaign.update({ where: { id: c.id }, data: { status: "QUEUED", completedAt: null } }); // the campaign is live again, so the worker really looks at it
    outbox.length = 0;
    await drain(new Date());
    await drain(new Date(Date.now() + 120_000));
    expect(outbox).not.toContain(victim!.subscriber.email);
    expect((await prisma.marketingCampaignSend.findUnique({ where: { id: victim!.id } }))!.status).toBe("UNKNOWN");
  });

  it("a pause that happens while a batch is running stops the very next recipient; an unsubscribe mid-batch is skipped", async () => {
    await subscribers(12, "d");
    const c = await newCampaign("pause");
    let n = 0;
    onSend = async () => {
      if (++n === 3) await prisma.marketingCampaign.update({ where: { id: c.id }, data: { status: "PAUSED" } });
    };
    await drain(new Date());
    expect(outbox).toHaveLength(3);
    await prisma.marketingCampaign.update({ where: { id: c.id }, data: { status: "QUEUED" } });
    const next = await prisma.marketingCampaignSend.findFirst({ where: { campaignId: c.id, status: "PENDING" }, orderBy: { id: "asc" }, include: { subscriber: true } });
    await prisma.subscriber.update({ where: { id: next!.subscriberId }, data: { status: "UNSUBSCRIBED" } });
    onSend = null;
    await drain(new Date(Date.now() + 120_000));
    expect(outbox).not.toContain(next!.subscriber.email);
    expect((await prisma.marketingCampaignSend.findUnique({ where: { id: next!.id } }))!.status).toBe("SKIPPED_UNSUBSCRIBED");
  });

  it("an import is chunked, concurrent workers do not double count, and unsubscribed / suppressed subscribers are untouched", async () => {
    await prisma.subscriber.create({ data: { companyId: COMPANY, email: `i0001-${TAG}@example.test`, status: "UNSUBSCRIBED", firstName: "Keep" } });
    await prisma.subscriber.create({ data: { companyId: COMPANY, email: `i0002-${TAG}@example.test`, status: "SUPPRESSED" } });
    const rows = Array.from({ length: 2_500 }, (_, i) => ({ row: i + 1, email: `i${String(i).padStart(4, "0")}-${TAG}@example.test`, firstName: null, lastName: null }));
    const job = await prisma.subscriberImportJob.create({ data: { companyId: COMPANY, createdById: senderId, payload: serialize(rows), totalRows: rows.length, validRows: rows.length } });
    for (let i = 0; i < 4; i++) await Promise.all([importTick(5, 1_000), importTick(5, 1_000)]);
    const done = await prisma.subscriberImportJob.findUnique({ where: { id: job.id } });
    expect(done).toMatchObject({ status: "COMPLETED", nextRow: 2_500, importedRows: 2_498, existingRows: 2, skippedUnsubscribedOrSuppressed: 2, payload: null });
    expect(await prisma.subscriber.count({ where: { email: { startsWith: "i", endsWith: `-${TAG}@example.test` } } })).toBe(2_500);
    expect(await prisma.subscriber.findFirst({ where: { email: `i0001-${TAG}@example.test` } })).toMatchObject({ status: "UNSUBSCRIBED", firstName: "Keep" });
    expect((await prisma.subscriber.findFirst({ where: { email: `i0002-${TAG}@example.test` } }))!.status).toBe("SUPPRESSED");
  });
});
