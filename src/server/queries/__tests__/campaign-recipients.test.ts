import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The recipient-level Delivery Status of a campaign: grouping and order, server-side pagination (25 / 50 / 75 / 100), the daily-limit reason, and what may be cancelled.
// The pure planning is tested directly; the database part runs against an in-memory fake that evaluates the same `where` / `orderBy` shapes and records every query, so the tests can
// also prove that no query ever asks for more than one page of rows. No real address is used.

type Row = { id: string; campaignId: string; status: string; sentAt: Date | null; nextAttemptAt: Date | null; lastAttemptAt: Date | null; errorMessage: string | null; email: string };
type Campaign = { id: string; companyId: string; status: string; scheduledAt: Date | null; createdById: string | null };
let campaigns: Campaign[];
let sends: Row[];
const findManyCalls: Array<{ take: number; skip: number }> = [];

// ── a small evaluator for the filters the query uses ──
function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === "OR") {
      if (!(cond as Array<Record<string, unknown>>).some((w) => matches(row, w))) return false;
    } else if (key === "campaign") {
      const c = campaigns.find((x) => x.id === row.campaignId)!;
      for (const [k, v] of Object.entries(cond as Record<string, unknown>)) if ((c as unknown as Record<string, unknown>)[k] !== v) return false;
    } else {
      const value = (row as unknown as Record<string, unknown>)[key];
      if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as { gt?: Date; gte?: Date; lte?: Date; in?: unknown[] };
        if (c.in && !c.in.includes(value)) return false;
        if (c.gt && !(value instanceof Date && value.getTime() > c.gt.getTime())) return false;
        if (c.gte && !(value instanceof Date && value.getTime() >= c.gte.getTime())) return false;
        if (c.lte && !(value instanceof Date && value.getTime() <= c.lte.getTime())) return false;
      } else if (value !== cond) return false;
    }
  }
  return true;
}
function sortRows(rows: Row[], orderBy: Array<Record<string, unknown>> | Record<string, unknown> | undefined) {
  const list = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return [...rows].sort((a, b) => {
    for (const o of list) {
      const [field, dir] = Object.entries(o)[0] as [string, "asc" | "desc" | { sort: "asc" | "desc"; nulls?: "first" | "last" }];
      const direction = typeof dir === "string" ? dir : dir.sort;
      const nullsLast = typeof dir === "object" ? dir.nulls === "last" : false;
      const av = (a as unknown as Record<string, unknown>)[field];
      const bv = (b as unknown as Record<string, unknown>)[field];
      if (av == null && bv == null) continue;
      if (av == null) return nullsLast ? 1 : -1;
      if (bv == null) return nullsLast ? -1 : 1;
      const an = av instanceof Date ? av.getTime() : (av as number | string);
      const bn = bv instanceof Date ? bv.getTime() : (bv as number | string);
      if (an === bn) continue;
      const cmp = an < bn ? -1 : 1;
      return direction === "asc" ? cmp : -cmp;
    }
    return 0;
  });
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    marketingCampaign: { findFirst: vi.fn(async ({ where }: { where: { id: string; companyId: string } }) => campaigns.find((c) => c.id === where.id && c.companyId === where.companyId) ?? null) },
    marketingCampaignSend: {
      groupBy: vi.fn(async ({ where }: { where: { campaignId: string } }) => {
        const m = new Map<string, number>();
        for (const r of sends.filter((s) => s.campaignId === where.campaignId)) m.set(r.status, (m.get(r.status) ?? 0) + 1);
        return [...m].map(([status, n]) => ({ status, _count: { _all: n } }));
      }),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => sends.filter((r) => matches(r, where)).length),
      findFirst: vi.fn(async ({ where, orderBy }: { where: Record<string, unknown>; orderBy: Array<Record<string, unknown>> | Record<string, unknown> }) => sortRows(sends.filter((r) => matches(r, where)), orderBy)[0] ?? null),
      findMany: vi.fn(async ({ where, orderBy, skip, take }: { where: Record<string, unknown>; orderBy: Array<Record<string, unknown>>; skip: number; take: number }) => {
        findManyCalls.push({ take, skip });
        return sortRows(sends.filter((r) => matches(r, where)), orderBy).slice(skip, skip + take).map((r) => ({ ...r, subscriber: { email: r.email } }));
      }),
    },
  },
}));

const NOW = new Date("2026-11-22T20:00:00Z");
const min = (m: number) => new Date(NOW.getTime() + m * 60_000);
const hours = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
let seq = 0;
function add(status: string, over: Partial<Row> = {}, campaignId = "camp-1"): Row {
  seq += 1;
  const r: Row = { id: `s${String(seq).padStart(6, "0")}`, campaignId, status, sentAt: null, nextAttemptAt: null, lastAttemptAt: null, errorMessage: null, email: `person${seq}@example.test`, ...over };
  sends.push(r);
  return r;
}
const many = (n: number, status: string, over: Partial<Row> | ((i: number) => Partial<Row>) = {}, campaignId = "camp-1") => Array.from({ length: n }, (_, i) => add(status, typeof over === "function" ? over(i) : over, campaignId));

const { planSegments, sliceSegments, describeRecipient, getCampaignRecipientPage, RECIPIENT_GROUP_ORDER } = await import("../campaign-recipients");

beforeEach(() => {
  seq = 0;
  sends = [];
  findManyCalls.length = 0;
  campaigns = [{ id: "camp-1", companyId: "co-1", status: "SENDING", scheduledAt: null, createdById: "sender-1" }];
  vi.stubEnv("CAMPAIGN_DAILY_LIMIT", "400");
});
afterEach(() => vi.unstubAllEnvs());

describe("planSegments / sliceSegments (pure)", () => {
  const plan = (over: Partial<Parameters<typeof planSegments>[0]> = {}) =>
    planSegments({ campaignStatus: "SENDING", counts: {}, pendingBackoff: 0, dailyLimitReached: false, now: NOW, ...over });

  it("the groups come in the required order: Sent, Scheduled, Waiting, Outcome unknown, Failed, Skipped x2, Cancelled - and empty groups are left out", () => {
    const segs = plan({ counts: { SENT: 3, PENDING: 5, UNKNOWN: 1, FAILED: 2, SKIPPED_UNSUBSCRIBED: 1, SKIPPED_SUPPRESSED: 1, CANCELLED: 2 }, pendingBackoff: 2 });
    expect(segs.map((s) => s.group)).toEqual(["SENT", "SCHEDULED", "WAITING", "UNKNOWN", "FAILED", "SKIPPED_UNSUBSCRIBED", "SKIPPED_SUPPRESSED", "CANCELLED"]);
    expect(segs.map((s) => s.group)).toEqual(RECIPIENT_GROUP_ORDER.slice());
    expect(plan({ counts: { SENT: 1 } }).map((s) => s.group)).toEqual(["SENT"]);
  });

  it("pending recipients split into Scheduled (own retry time in the future) and Waiting (the rest); the counts add up", () => {
    const segs = plan({ counts: { PENDING: 10 }, pendingBackoff: 3 });
    expect(segs.find((s) => s.group === "SCHEDULED")!.count).toBe(3);
    expect(segs.find((s) => s.group === "WAITING")!.count).toBe(7);
  });

  it("when the daily limit is reached EVERY unsent recipient is Scheduled", () => {
    const segs = plan({ counts: { PENDING: 10 }, pendingBackoff: 3, dailyLimitReached: true });
    expect(segs.map((s) => [s.group, s.count])).toEqual([["SCHEDULED", 10]]);
  });

  it("a paused campaign keeps them Waiting; a cancelled campaign turns them into Cancelled (alongside the individually cancelled)", () => {
    expect(plan({ campaignStatus: "PAUSED", counts: { PENDING: 4 }, pendingBackoff: 1 }).map((s) => [s.group, s.count])).toEqual([["WAITING", 4]]);
    expect(plan({ campaignStatus: "CANCELLED", counts: { PENDING: 4, CANCELLED: 2, SENT: 1 } }).map((s) => [s.group, s.count])).toEqual([["SENT", 1], ["CANCELLED", 6]]);
  });

  it("slicing: page sizes 25 / 50 / 75 / 100 cut exact windows across group boundaries, never more than a page, and cover every recipient exactly once", () => {
    const segs = plan({ counts: { SENT: 60, PENDING: 70, CANCELLED: 20 }, pendingBackoff: 10 }); // 150 recipients: 60 / 10 / 60 / 20
    for (const size of [25, 50, 75, 100]) {
      const total = 150;
      const pageCount = Math.ceil(total / size);
      let seen = 0;
      for (let page = 1; page <= pageCount; page++) {
        const { slices, pageCount: pc } = sliceSegments(segs, page, size);
        expect(pc).toBe(pageCount);
        const taken = slices.reduce((n, s) => n + s.take, 0);
        expect(taken).toBe(Math.min(size, total - (page - 1) * size));
        expect(taken).toBeLessThanOrEqual(size);
        seen += taken;
      }
      expect(seen).toBe(total);
    }
    // page 3 of 25 = recipients 51..75: 10 sent (51-60), 10 scheduled (61-70), 5 waiting (71-75)
    const p3 = sliceSegments(segs, 3, 25).slices.map((s) => [s.segment.group, s.skip, s.take]);
    expect(p3).toEqual([["SENT", 50, 10], ["SCHEDULED", 0, 10], ["WAITING", 0, 5]]);
  });

  it("an out-of-range or invalid page is clamped, an empty list is one empty page", () => {
    const segs = plan({ counts: { SENT: 30 } });
    expect(sliceSegments(segs, 99, 25).page).toBe(2);
    expect(sliceSegments(segs, 0, 25).page).toBe(1);
    expect(sliceSegments(segs, Number.NaN, 25).page).toBe(1);
    expect(sliceSegments([], 1, 25)).toMatchObject({ total: 0, pageCount: 1, slices: [] });
  });
});

describe("describeRecipient (pure)", () => {
  const ctx = { campaignStatus: "SENDING", dailyLimitReached: false, capacityFreesAt: null as Date | null, limit: 400, now: NOW };
  const row = (status: string, over: Partial<{ sentAt: Date | null; nextAttemptAt: Date | null; errorMessage: string | null }> = {}) => ({ id: "x", status: status as never, sentAt: null, nextAttemptAt: null, errorMessage: null, subscriber: { email: "a@example.test" }, ...over });

  it("Sent shows its time and can never be cancelled", () => {
    const d = describeRecipient(row("SENT", { sentAt: min(-5) }), ctx);
    expect(d).toMatchObject({ group: "SENT", label: "Sent", atKind: "sent", canCancel: false });
    expect(d.at).toEqual(min(-5));
  });

  it("Outcome unknown is never Sent, never cancellable, and says it is not sent again", () => {
    const d = describeRecipient(row("UNKNOWN"), ctx);
    expect(d).toMatchObject({ group: "UNKNOWN", label: "Outcome unknown", canCancel: false });
    expect(d.reason).toMatch(/not sent again/i);
  });

  it("Failed, Skipped and Cancelled recipients are final: no cancel control", () => {
    for (const s of ["FAILED", "SKIPPED_UNSUBSCRIBED", "SKIPPED_SUPPRESSED", "CANCELLED"]) expect(describeRecipient(row(s), ctx).canCancel, s).toBe(false);
  });

  it("Waiting: in the queue, cancellable; Scheduled by its own retry shows the REAL reason and time", () => {
    expect(describeRecipient(row("PENDING"), ctx)).toMatchObject({ group: "WAITING", reason: "In the sending queue", canCancel: true, at: null });
    const s = describeRecipient(row("PENDING", { nextAttemptAt: min(30), errorMessage: "Provider sending limit reached; will retry later" }), ctx);
    expect(s).toMatchObject({ group: "SCHEDULED", atKind: "next", reason: "Provider sending limit reached; will retry later", canCancel: true });
    expect(s.at).toEqual(min(30));
  });

  it("daily limit: Scheduled with the limit reason, and the earliest time only when it is known - no time is invented", () => {
    const known = describeRecipient(row("PENDING"), { ...ctx, dailyLimitReached: true, capacityFreesAt: hours(5) });
    expect(known).toMatchObject({ group: "SCHEDULED", atKind: "earliest", canCancel: true });
    expect(known.reason).toMatch(/Daily sending limit reached \(400 per 24 hours/);
    expect(known.reason).toMatch(/continues automatically/);
    const unknown = describeRecipient(row("PENDING"), { ...ctx, dailyLimitReached: true, capacityFreesAt: null });
    expect(unknown).toMatchObject({ at: null, atKind: null });
  });

  it("a paused campaign: Waiting (paused) and still cancellable; a cancelled campaign: Cancelled and NOT cancellable; a finished one: not cancellable", () => {
    expect(describeRecipient(row("PENDING"), { ...ctx, campaignStatus: "PAUSED" })).toMatchObject({ group: "WAITING", reason: "The campaign is paused", canCancel: true });
    expect(describeRecipient(row("PENDING"), { ...ctx, campaignStatus: "CANCELLED" })).toMatchObject({ group: "CANCELLED", canCancel: false });
    expect(describeRecipient(row("PENDING"), { ...ctx, campaignStatus: "SENT" }).canCancel).toBe(false);
  });
});

describe("getCampaignRecipientPage (database part, in-memory)", () => {
  it("lists Sent first, then Scheduled, Waiting, Outcome unknown, Failed, Skipped, Cancelled - each group ordered inside itself", async () => {
    add("CANCELLED");
    add("SKIPPED_SUPPRESSED");
    add("SKIPPED_UNSUBSCRIBED");
    add("FAILED", { errorMessage: "Sending failed" });
    add("UNKNOWN", { lastAttemptAt: min(-10) });
    add("PENDING"); // waiting
    add("PENDING", { nextAttemptAt: min(90), errorMessage: "Sending failed; will retry" }); // scheduled, later
    add("PENDING", { nextAttemptAt: min(10), errorMessage: "Provider sending limit reached; will retry later" }); // scheduled, sooner
    add("SENT", { sentAt: min(-60), lastAttemptAt: min(-60) }); // older
    add("SENT", { sentAt: min(-5), lastAttemptAt: min(-5) }); // newest
    const page = (await getCampaignRecipientPage({ campaignId: "camp-1", companyId: "co-1", now: NOW }))!;
    expect(page.rows.map((r) => r.group)).toEqual(["SENT", "SENT", "SCHEDULED", "SCHEDULED", "WAITING", "UNKNOWN", "FAILED", "SKIPPED_UNSUBSCRIBED", "SKIPPED_SUPPRESSED", "CANCELLED"]);
    expect(page.rows[0].at).toEqual(min(-5)); // newest sent first
    expect(page.rows[2].at).toEqual(min(10)); // the sooner retry first
    expect(page.total).toBe(10);
    expect(page.groupCounts.map((g) => [g.label, g.count])).toEqual([["Sent", 2], ["Scheduled", 2], ["Waiting", 1], ["Outcome unknown", 1], ["Failed", 1], ["Skipped: unsubscribed", 1], ["Skipped: suppressed", 1], ["Cancelled", 1]]);
  });

  it("only Waiting / Scheduled recipients of a campaign that can still send are cancellable", async () => {
    add("SENT", { sentAt: min(-5) });
    add("UNKNOWN");
    add("PENDING");
    add("PENDING", { nextAttemptAt: min(30) });
    const page = (await getCampaignRecipientPage({ campaignId: "camp-1", companyId: "co-1", now: NOW }))!;
    expect(page.rows.map((r) => [r.group, r.canCancel])).toEqual([["SENT", false], ["SCHEDULED", true], ["WAITING", true], ["UNKNOWN", false]]);
  });

  it("pagination: 25 by default; 50 / 75 / 100 on request; anything else falls back to 25; never more rows than the page size", async () => {
    many(130, "SENT", (i) => ({ sentAt: min(-1 - i) }));
    const get = (pageSize?: number | string, p = 1) => getCampaignRecipientPage({ campaignId: "camp-1", companyId: "co-1", page: p, pageSize, now: NOW });
    expect((await get())!.rows).toHaveLength(25);
    expect((await get())!.pageSize).toBe(25);
    for (const size of [25, 50, 75, 100]) {
      const first = (await get(size))!;
      expect(first.rows).toHaveLength(size);
      expect(first.pageSize).toBe(size);
      expect(first.total).toBe(130);
      expect(first.pageCount).toBe(Math.ceil(130 / size));
    }
    expect((await get(100, 2))!.rows).toHaveLength(30);
    for (const bad of [10, 26, 10_000, -5, "abc", "100; DROP"]) expect((await get(bad as never))!.pageSize, String(bad)).toBe(25);
    expect(findManyCalls.every((c) => c.take <= 100)).toBe(true);
  });

  it("a large campaign is read one page at a time: the rows asked for in one request never exceed the page size, whatever the audience", async () => {
    many(5_000, "SENT", (i) => ({ sentAt: new Date(NOW.getTime() - 30 * 3_600_000 - i * 60_000) })); // sent more than 24 hours ago, so the daily limit is not in play
    many(3_000, "PENDING");
    findManyCalls.length = 0;
    const inside = (await getCampaignRecipientPage({ campaignId: "camp-1", companyId: "co-1", page: 41, pageSize: 100, now: NOW }))!; // rows 4,001-4,100: all Sent
    expect(inside.total).toBe(8_000);
    expect(inside.rows).toHaveLength(100);
    expect(inside.rows.every((r) => r.group === "SENT")).toBe(true);
    expect(findManyCalls).toEqual([{ take: 100, skip: 4_000 }]); // exactly one page was fetched
    findManyCalls.length = 0;
    const crossing = (await getCampaignRecipientPage({ campaignId: "camp-1", companyId: "co-1", page: 67, pageSize: 75, now: NOW }))!; // rows 4,951-5,025: crosses the Sent / Waiting boundary
    expect(crossing.rows).toHaveLength(75);
    expect(crossing.rows.filter((r) => r.group === "SENT")).toHaveLength(50);
    expect(crossing.rows.filter((r) => r.group === "WAITING")).toHaveLength(25);
    expect(findManyCalls.reduce((n, c) => n + c.take, 0)).toBe(75); // two small reads that together are one page, never the audience
    expect(findManyCalls.every((c) => c.take <= 75)).toBe(true);
  });

  it("daily limit reached: unsent recipients are Scheduled with the limit reason, the earliest time is when the oldest counted message leaves the 24 hours, and sent ones stay Sent", async () => {
    vi.stubEnv("CAMPAIGN_DAILY_LIMIT", "5");
    many(5, "SENT", (i) => ({ sentAt: hours(-20 + i), lastAttemptAt: hours(-20 + i) })); // 5 in the last 24h = the limit
    many(3, "PENDING");
    const page = (await getCampaignRecipientPage({ campaignId: "camp-1", companyId: "co-1", now: NOW }))!;
    expect(page.dailyLimitReached).toBe(true);
    const scheduled = page.rows.filter((r) => r.group === "SCHEDULED");
    expect(scheduled).toHaveLength(3);
    expect(scheduled[0].reason).toMatch(/Daily sending limit reached \(5 per 24 hours/);
    expect(scheduled[0]).toMatchObject({ atKind: "earliest" });
    expect(scheduled[0].at).toEqual(hours(4)); // the oldest counted send was at -20h: it leaves the window at +4h
    expect(page.rows.filter((r) => r.group === "SENT")).toHaveLength(5);
    expect(scheduled.every((r) => r.canCancel)).toBe(true);
  });

  it("an uncertain (Outcome unknown) attempt counts toward the daily limit, exactly as the worker counts it", async () => {
    vi.stubEnv("CAMPAIGN_DAILY_LIMIT", "3");
    many(2, "SENT", { sentAt: hours(-2) });
    add("UNKNOWN", { lastAttemptAt: hours(-1) });
    add("PENDING");
    expect((await getCampaignRecipientPage({ campaignId: "camp-1", companyId: "co-1", now: NOW }))!.dailyLimitReached).toBe(true);
  });

  it("below the limit, or with another sender's messages only, nothing is deferred by the limit", async () => {
    vi.stubEnv("CAMPAIGN_DAILY_LIMIT", "5");
    campaigns.push({ id: "camp-2", companyId: "co-1", status: "SENT", scheduledAt: null, createdById: "other-sender" });
    many(9, "SENT", { sentAt: hours(-1), lastAttemptAt: hours(-1) }, "camp-2");
    many(4, "SENT", { sentAt: hours(-1), lastAttemptAt: hours(-1) });
    add("PENDING");
    const page = (await getCampaignRecipientPage({ campaignId: "camp-1", companyId: "co-1", now: NOW }))!;
    expect(page.dailyLimitReached).toBe(false);
    expect(page.rows.find((r) => r.group === "WAITING")).toBeTruthy();
  });

  it("messages older than 24 hours do not count: capacity is back and the recipients are simply Waiting", async () => {
    vi.stubEnv("CAMPAIGN_DAILY_LIMIT", "3");
    many(3, "SENT", { sentAt: hours(-25), lastAttemptAt: hours(-25) });
    add("PENDING");
    expect((await getCampaignRecipientPage({ campaignId: "camp-1", companyId: "co-1", now: NOW }))!.dailyLimitReached).toBe(false);
  });

  it("a cancelled campaign: unsent recipients read Cancelled with no control; a paused one: Waiting (paused) and cancellable", async () => {
    add("SENT", { sentAt: min(-5) });
    add("PENDING");
    campaigns[0].status = "CANCELLED";
    let page = (await getCampaignRecipientPage({ campaignId: "camp-1", companyId: "co-1", now: NOW }))!;
    expect(page.rows.map((r) => [r.group, r.canCancel])).toEqual([["SENT", false], ["CANCELLED", false]]);
    campaigns[0].status = "PAUSED";
    page = (await getCampaignRecipientPage({ campaignId: "camp-1", companyId: "co-1", now: NOW }))!;
    expect(page.rows.map((r) => [r.group, r.canCancel, r.reason])).toEqual([["SENT", false, null], ["WAITING", true, "The campaign is paused"]]);
  });

  it("another company's campaign is 'not found' (null), and a scheduled campaign with no rows yet is an empty page", async () => {
    expect(await getCampaignRecipientPage({ campaignId: "camp-1", companyId: "co-2", now: NOW })).toBeNull();
    campaigns[0].status = "SCHEDULED";
    expect(await getCampaignRecipientPage({ campaignId: "camp-1", companyId: "co-1", now: NOW })).toMatchObject({ total: 0, rows: [], pageCount: 1 });
  });

  it("recipients of other campaigns never appear", async () => {
    campaigns.push({ id: "camp-2", companyId: "co-1", status: "SENDING", scheduledAt: null, createdById: "sender-1" });
    add("SENT", { sentAt: min(-1) });
    add("SENT", { sentAt: min(-1) }, "camp-2");
    const page = (await getCampaignRecipientPage({ campaignId: "camp-1", companyId: "co-1", now: NOW }))!;
    expect(page.total).toBe(1);
  });
});
