import { describe, it, expect, vi, beforeEach } from "vitest";
import { serializeValidRows, parseImportText } from "@/lib/subscriber-import";

// The background subscriber import against an in-memory database: chunked, resumable, idempotent, and unable to re-subscribe anyone. Synthetic data only.

type Job = { id: string; companyId: string; status: string; payload: string | null; validRows: number; nextRow: number; importedRows: number; existingRows: number; skippedUnsubscribedOrSuppressed: number; createdAt: Date; startedAt: Date | null; finishedAt: Date | null };
type Sub = { companyId: string; email: string; status: string; firstName: string | null; lastName: string | null; source: string };
let jobs: Job[];
let subs: Map<string, Sub>;
let failCreateMany = false;
let beforeCas: (() => void) | null = null;

const key = (c: string, e: string) => `${c}|${e}`;
vi.mock("@/lib/prisma", () => ({
  prisma: {
    subscriberImportJob: {
      findFirst: vi.fn(async ({ where }: { where: { status: { in: string[] } } }) => jobs.filter((j) => where.status.in.includes(j.status)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => jobs.find((j) => j.id === where.id) ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; status?: string; nextRow?: number }; data: Record<string, unknown> }) => {
        beforeCas?.();
        const j = jobs.find((x) => x.id === where.id && (where.status === undefined || x.status === where.status) && (where.nextRow === undefined || x.nextRow === where.nextRow));
        if (!j) return { count: 0 };
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && "increment" in (v as object)) (j as unknown as Record<string, number>)[k] += (v as { increment: number }).increment;
          else (j as unknown as Record<string, unknown>)[k] = v;
        }
        return { count: 1 };
      }),
    },
    subscriber: {
      findMany: vi.fn(async ({ where }: { where: { companyId: string; email: { in: string[] } } }) =>
        where.email.in.map((e) => subs.get(key(where.companyId, e))).filter((s): s is Sub => !!s).map((s) => ({ email: s.email, status: s.status }))
      ),
      createMany: vi.fn(async ({ data, skipDuplicates }: { data: Array<{ companyId: string; email: string; firstName: string | null; lastName: string | null; source: string }>; skipDuplicates: boolean }) => {
        if (failCreateMany) throw new Error("db down postgres://u:p@h/db");
        let count = 0;
        for (const d of data) {
          if (subs.has(key(d.companyId, d.email))) {
            if (!skipDuplicates) throw new Error("unique");
            continue;
          }
          subs.set(key(d.companyId, d.email), { ...d, status: "SUBSCRIBED" });
          count++;
        }
        return { count };
      }),
    },
  },
}));

const mkJob = (rows: string, over: Partial<Job> = {}): Job => {
  const parsed = parseImportText(rows);
  return {
    id: `job-${jobs.length + 1}`, companyId: "co-1", status: "QUEUED", payload: serializeValidRows(parsed.valid), validRows: parsed.valid.length, nextRow: 0,
    importedRows: 0, existingRows: 0, skippedUnsubscribedOrSuppressed: 0, createdAt: new Date(2026, 0, jobs.length + 1), startedAt: null, finishedAt: null, ...over,
  };
};
const synthetic = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `u${from + i}@example.test,First${from + i},Last${from + i}`).join("\n");

beforeEach(() => {
  jobs = [];
  subs = new Map();
  failCreateMany = false;
  beforeCas = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("processSubscriberImportJobs", () => {
  it("imports a 100,000-row list in bounded chunks (never one request), and every address ends up as exactly one SUBSCRIBED row", async () => {
    jobs.push(mkJob(synthetic(100_000)));
    const { processSubscriberImportJobs } = await import("../subscriber-import-worker");
    let ticks = 0;
    let processed = 0;
    while (jobs[0].status !== "COMPLETED" && ticks < 200) {
      const r = await processSubscriberImportJobs(5, 1_000); // one worker tick = at most 5 chunks of 1,000
      processed += r.processedRows;
      expect(r.processedRows).toBeLessThanOrEqual(5_000);
      ticks++;
    }
    expect(jobs[0]).toMatchObject({ status: "COMPLETED", importedRows: 100_000, existingRows: 0, nextRow: 100_000, payload: null });
    expect(processed).toBe(100_000);
    expect(ticks).toBe(20);
    expect(subs.size).toBe(100_000);
    expect([...subs.values()].every((s) => s.status === "SUBSCRIBED" && s.source === "import")).toBe(true);
  });

  it("NEVER re-subscribes an unsubscribed or suppressed address, and never touches an existing subscriber's data - it only reports them", async () => {
    subs.set(key("co-1", "u1@example.test"), { companyId: "co-1", email: "u1@example.test", status: "UNSUBSCRIBED", firstName: "Orig", lastName: null, source: "manual" });
    subs.set(key("co-1", "u2@example.test"), { companyId: "co-1", email: "u2@example.test", status: "SUPPRESSED", firstName: null, lastName: null, source: "manual" });
    subs.set(key("co-1", "u3@example.test"), { companyId: "co-1", email: "u3@example.test", status: "SUBSCRIBED", firstName: "Keep", lastName: null, source: "manual" });
    jobs.push(mkJob(synthetic(6)));
    const { processSubscriberImportJobs } = await import("../subscriber-import-worker");
    await processSubscriberImportJobs(5, 1_000);
    expect(subs.get(key("co-1", "u1@example.test"))).toMatchObject({ status: "UNSUBSCRIBED", firstName: "Orig" });
    expect(subs.get(key("co-1", "u2@example.test"))!.status).toBe("SUPPRESSED");
    expect(subs.get(key("co-1", "u3@example.test"))).toMatchObject({ status: "SUBSCRIBED", firstName: "Keep" });
    expect(jobs[0]).toMatchObject({ status: "COMPLETED", importedRows: 3, existingRows: 3, skippedUnsubscribedOrSuppressed: 2 });
  });

  it("is company-scoped: the same address in another company is a different subscriber", async () => {
    subs.set(key("co-2", "u0@example.test"), { companyId: "co-2", email: "u0@example.test", status: "UNSUBSCRIBED", firstName: null, lastName: null, source: "x" });
    jobs.push(mkJob(synthetic(2)));
    const { processSubscriberImportJobs } = await import("../subscriber-import-worker");
    await processSubscriberImportJobs(5, 1_000);
    expect(subs.get(key("co-1", "u0@example.test"))!.status).toBe("SUBSCRIBED");
    expect(subs.get(key("co-2", "u0@example.test"))!.status).toBe("UNSUBSCRIBED");
  });

  it("resumes after a restart exactly where it stopped, with nothing duplicated or skipped", async () => {
    jobs.push(mkJob(synthetic(3_500)));
    const { processSubscriberImportJobs } = await import("../subscriber-import-worker");
    await processSubscriberImportJobs(2, 1_000); // "the server stops here": 2,000 done
    expect(jobs[0]).toMatchObject({ status: "PROCESSING", nextRow: 2_000, importedRows: 2_000 });
    // a restart: same database, a fresh worker call
    await processSubscriberImportJobs(10, 1_000);
    expect(jobs[0]).toMatchObject({ status: "COMPLETED", nextRow: 3_500, importedRows: 3_500 });
    expect(subs.size).toBe(3_500);
  });

  it("re-processing a chunk is harmless: a crash between the writes and the cursor update cannot double-count or double-create", async () => {
    jobs.push(mkJob(synthetic(1_500)));
    const { processSubscriberImportJobs } = await import("../subscriber-import-worker");
    // simulate "rows written, cursor never advanced": create the first 1,000 subscribers by hand and leave the cursor at 0
    for (let i = 0; i < 1_000; i++) subs.set(key("co-1", `u${i}@example.test`), { companyId: "co-1", email: `u${i}@example.test`, status: "SUBSCRIBED", firstName: null, lastName: null, source: "import" });
    jobs[0].status = "PROCESSING";
    await processSubscriberImportJobs(10, 1_000);
    expect(subs.size).toBe(1_500);
    expect(jobs[0]).toMatchObject({ status: "COMPLETED", importedRows: 500, existingRows: 1_000 });
  });

  it("two workers cannot both count the same chunk (compare-and-swap on the cursor)", async () => {
    jobs.push(mkJob(synthetic(1_000), { status: "PROCESSING", startedAt: new Date() }));
    const { processSubscriberImportJobs } = await import("../subscriber-import-worker");
    // between this worker's read and its update, another worker advances the cursor
    beforeCas = () => {
      beforeCas = null;
      jobs[0].nextRow = 1_000;
      jobs[0].importedRows = 1_000;
      jobs[0].status = "COMPLETED";
    };
    const r = await processSubscriberImportJobs(1, 1_000);
    expect(r.processedRows).toBe(0); // this worker's chunk was not counted
    expect(jobs[0].importedRows).toBe(1_000); // not 2,000
  });

  it("a failing chunk marks the job FAILED (keeping its payload and cursor so it can be resumed) and the log holds no connection string", async () => {
    jobs.push(mkJob(synthetic(10)));
    failCreateMany = true;
    const { processSubscriberImportJobs } = await import("../subscriber-import-worker");
    const r = await processSubscriberImportJobs(5, 1_000);
    expect(r.jobsFailed).toBe(1);
    expect(jobs[0]).toMatchObject({ status: "FAILED", nextRow: 0 });
    expect(jobs[0].payload).not.toBeNull();
    expect(vi.mocked(console.error).mock.calls.flat().join(" ")).not.toMatch(/postgres:\/\//);
    failCreateMany = false;
    jobs[0].status = "QUEUED"; // "Resume"
    await processSubscriberImportJobs(5, 1_000);
    expect(jobs[0].status).toBe("COMPLETED");
  });

  it("processes the oldest job first and ignores cancelled and finished ones", async () => {
    jobs.push(mkJob(synthetic(2, 100), { status: "CANCELLED" }));
    jobs.push(mkJob(synthetic(2, 200)));
    jobs.push(mkJob(synthetic(2, 300)));
    const { processSubscriberImportJobs } = await import("../subscriber-import-worker");
    await processSubscriberImportJobs(1, 1_000);
    expect(jobs[0].status).toBe("CANCELLED");
    expect(jobs[1].status).toBe("COMPLETED");
    expect(jobs[2].status).toBe("QUEUED");
    expect([...subs.keys()].some((k) => k.includes("u100@"))).toBe(false);
  });

  it("an empty queue is a quiet no-op", async () => {
    const { processSubscriberImportJobs } = await import("../subscriber-import-worker");
    expect(await processSubscriberImportJobs()).toEqual({ processedRows: 0, jobsFinished: 0, jobsFailed: 0 });
  });
});
