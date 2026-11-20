// Background subscriber import. A job is a durable row (SubscriberImportJob) holding the validated rows and a cursor (nextRow). The worker processes it in bounded chunks,
// so a 100,000-row import is never one request, survives a restart (it continues at nextRow) and re-processing a chunk is harmless:
//   - only addresses with NO subscriber row are created (createMany skipDuplicates against @@unique([companyId, email]));
//   - an existing SUBSCRIBED / UNSUBSCRIBED / SUPPRESSED subscriber is never modified - an import can NEVER re-subscribe someone who unsubscribed or was suppressed;
//   - counters advance with a compare-and-swap on the cursor, so two workers can never both count the same chunk.
import { prisma } from "@/lib/prisma";
import { IMPORT_CHUNK_SIZE, readPayloadSlice } from "@/lib/subscriber-import";
import { safeErrorTag } from "@/lib/safe-error-log";

export type ImportTickResult = { processedRows: number; jobsFinished: number; jobsFailed: number };

/** Processes up to `maxChunks` chunks of the oldest active import job(s). Never throws. */
export async function processSubscriberImportJobs(maxChunks = 5, chunkSize = IMPORT_CHUNK_SIZE): Promise<ImportTickResult> {
  const result: ImportTickResult = { processedRows: 0, jobsFinished: 0, jobsFailed: 0 };
  try {
    let chunks = 0;
    while (chunks < maxChunks) {
      const job = await prisma.subscriberImportJob.findFirst({ where: { status: { in: ["QUEUED", "PROCESSING"] } }, orderBy: { createdAt: "asc" } });
      if (!job) break;
      if (job.status === "QUEUED") {
        const started = await prisma.subscriberImportJob.updateMany({ where: { id: job.id, status: "QUEUED" }, data: { status: "PROCESSING", startedAt: new Date() } });
        if (started.count === 0) continue; // another worker claimed it
      }
      chunks++;
      try {
        const done = await processOneChunk(job.id, chunkSize, result);
        if (done) result.jobsFinished++;
      } catch (err) {
        result.jobsFailed++;
        console.error(`[subscriber-import] chunk failed (${safeErrorTag(err)})`);
        await prisma.subscriberImportJob
          .updateMany({ where: { id: job.id, status: "PROCESSING" }, data: { status: "FAILED", finishedAt: new Date() } })
          .catch(() => undefined);
      }
    }
  } catch (err) {
    console.error(`[subscriber-import] tick failed (${safeErrorTag(err)})`);
  }
  return result;
}

async function processOneChunk(jobId: string, chunkSize: number, tally: ImportTickResult): Promise<boolean> {
  const job = await prisma.subscriberImportJob.findUnique({ where: { id: jobId } });
  if (!job || job.status !== "PROCESSING") return false;
  const payload = job.payload ?? "";
  const { rows, next } = readPayloadSlice(payload, job.nextRow, chunkSize);

  let created = 0;
  let existing = 0;
  let skippedProtected = 0;
  if (rows.length > 0) {
    const found = await prisma.subscriber.findMany({
      where: { companyId: job.companyId, email: { in: rows.map((r) => r.email) } },
      select: { email: true, status: true },
    });
    const byEmail = new Map(found.map((f) => [f.email, f.status]));
    const fresh = rows.filter((r) => !byEmail.has(r.email));
    existing = rows.length - fresh.length;
    skippedProtected = found.filter((f) => f.status === "UNSUBSCRIBED" || f.status === "SUPPRESSED").length;
    if (fresh.length > 0) {
      const res = await prisma.subscriber.createMany({
        data: fresh.map((r) => ({ companyId: job.companyId, email: r.email, firstName: r.firstName, lastName: r.lastName, source: "import" })),
        skipDuplicates: true,
      });
      created = res.count;
    }
  }

  const finished = next >= job.validRows || rows.length === 0;
  // Compare-and-swap on the cursor: only the worker that still sees the cursor where it read it records the chunk's counters.
  const advanced = await prisma.subscriberImportJob.updateMany({
    where: { id: jobId, status: "PROCESSING", nextRow: job.nextRow },
    data: {
      nextRow: next,
      importedRows: { increment: created },
      existingRows: { increment: existing },
      skippedUnsubscribedOrSuppressed: { increment: skippedProtected },
      ...(finished ? { status: "COMPLETED", finishedAt: new Date(), payload: null } : {}),
    },
  });
  if (advanced.count === 1) tally.processedRows += rows.length;
  return advanced.count === 1 && finished;
}
