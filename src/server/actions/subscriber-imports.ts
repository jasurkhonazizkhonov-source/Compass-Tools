"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewSubscriptions } from "@/lib/permissions";
import { IMPORT_CHUNK_SIZE, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, buildErrorReport, parseImportText, serializeValidRows } from "@/lib/subscriber-import";

// Subscriber imports run as background jobs (server/marketing/subscriber-import-worker.ts): the request only validates and queues. Admin / Marketing Agent only, company-scoped.

async function assertMarketingAccess() {
  const current = await getCurrentAccount();
  if (!canViewSubscriptions(current?.role)) throw new Error("You are not authorized to manage subscribers");
  return current!;
}

export type ImportPreview = {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateInFile: number;
  newSubscribers: number;
  alreadySubscribed: number;
  previouslyUnsubscribed: number;
  suppressed: number;
  truncated: boolean;
};

type Guarded = { ok: true; text: string } | { ok: false; error: string };
function guard(text: unknown): Guarded {
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "Paste or upload a list of email addresses first." };
  if (text.length > IMPORT_MAX_BYTES) return { ok: false, error: `That list is larger than ${Math.round(IMPORT_MAX_BYTES / 1024 / 1024)} MB. Split it into smaller files.` };
  return { ok: true, text };
}

/** Classifies against the existing list in bounded queries and reports COUNTS only - nothing is written and no address is returned. */
export async function previewSubscriberImport(text: string): Promise<{ ok: true; preview: ImportPreview } | { ok: false; error: string }> {
  const admin = await assertMarketingAccess();
  const g = guard(text);
  if (!g.ok) return g;
  const parsed = parseImportText(g.text);
  let already = 0;
  let unsub = 0;
  let suppressed = 0;
  for (let i = 0; i < parsed.valid.length; i += IMPORT_CHUNK_SIZE) {
    const slice = parsed.valid.slice(i, i + IMPORT_CHUNK_SIZE).map((r) => r.email);
    const found = await prisma.subscriber.findMany({ where: { companyId: admin.companyId, email: { in: slice } }, select: { status: true } });
    for (const f of found) {
      if (f.status === "SUBSCRIBED") already++;
      else if (f.status === "UNSUBSCRIBED") unsub++;
      else suppressed++;
    }
  }
  return {
    ok: true,
    preview: {
      totalRows: parsed.totalRows,
      validRows: parsed.valid.length,
      invalidRows: parsed.invalidRows,
      duplicateInFile: parsed.duplicateInFile,
      newSubscribers: parsed.valid.length - already - unsub - suppressed,
      alreadySubscribed: already,
      previouslyUnsubscribed: unsub,
      suppressed,
      truncated: parsed.truncated,
    },
  };
}

/** Validates (again, server-side: the preview is never trusted) and queues the import. Returns immediately; the worker does the writing. */
export async function createSubscriberImportJob(text: string, source = "PASTE"): Promise<{ ok: true; jobId: string; validRows: number } | { ok: false; error: string }> {
  const admin = await assertMarketingAccess();
  const g = guard(text);
  if (!g.ok) return g;
  const parsed = parseImportText(g.text);
  if (parsed.truncated) return { ok: false, error: `Imports are limited to ${IMPORT_MAX_ROWS.toLocaleString("en-US")} rows at a time. Split the file and import it in parts.` };
  if (parsed.valid.length === 0) return { ok: false, error: "No valid email addresses were found in that list." };
  const job = await prisma.subscriberImportJob.create({
    data: {
      companyId: admin.companyId,
      createdById: admin.id,
      source: source === "FILE" ? "FILE" : "PASTE",
      payload: serializeValidRows(parsed.valid),
      totalRows: parsed.totalRows,
      validRows: parsed.valid.length,
      invalidRows: parsed.invalidRows,
      duplicateInFile: parsed.duplicateInFile,
      errorReport: parsed.problems.length > 0 ? buildErrorReport(parsed.problems) : null,
    },
    select: { id: true },
  });
  await prisma.auditLog.create({
    data: { actorId: admin.id, action: "SUBSCRIBER_IMPORT_QUEUED", entityType: "SubscriberImportJob", entityId: job.id, metadata: { totalRows: parsed.totalRows, validRows: parsed.valid.length } },
  });
  revalidatePath("/subscriptions");
  return { ok: true, jobId: job.id, validRows: parsed.valid.length };
}

export type ImportJobRow = {
  id: string;
  status: string;
  source: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateInFile: number;
  existingRows: number;
  importedRows: number;
  skippedUnsubscribedOrSuppressed: number;
  processedRows: number;
  hasErrorReport: boolean;
  createdAt: string;
  finishedAt: string | null;
};

/** Import history, newest first, with live progress. No payload, no addresses. */
export async function listSubscriberImportJobs(limit = 20): Promise<ImportJobRow[]> {
  const admin = await assertMarketingAccess();
  const rows = await prisma.subscriberImportJob.findMany({
    where: { companyId: admin.companyId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(1, Math.trunc(limit) || 20), 100),
    select: {
      id: true, status: true, source: true, totalRows: true, validRows: true, invalidRows: true, duplicateInFile: true, existingRows: true, importedRows: true,
      skippedUnsubscribedOrSuppressed: true, nextRow: true, errorReport: true, createdAt: true, finishedAt: true,
    },
  });
  return rows.map((r) => ({
    id: r.id, status: r.status, source: r.source, totalRows: r.totalRows, validRows: r.validRows, invalidRows: r.invalidRows, duplicateInFile: r.duplicateInFile,
    existingRows: r.existingRows, importedRows: r.importedRows, skippedUnsubscribedOrSuppressed: r.skippedUnsubscribedOrSuppressed,
    processedRows: Math.min(r.nextRow, r.validRows), hasErrorReport: !!r.errorReport, createdAt: r.createdAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null,
  }));
}

/** The downloadable error report ("row,reason" lines - row numbers and fixed codes, never an address). */
export async function getSubscriberImportErrorReport(jobId: string): Promise<string | null> {
  const admin = await assertMarketingAccess();
  const job = await prisma.subscriberImportJob.findFirst({ where: { id: jobId, companyId: admin.companyId }, select: { errorReport: true } });
  return job?.errorReport ?? null;
}

export async function cancelSubscriberImport(jobId: string): Promise<{ ok: boolean }> {
  const admin = await assertMarketingAccess();
  const res = await prisma.subscriberImportJob.updateMany({
    where: { id: jobId, companyId: admin.companyId, status: { in: ["QUEUED", "PROCESSING"] } },
    data: { status: "CANCELLED", finishedAt: new Date(), payload: null },
  });
  revalidatePath("/subscriptions");
  return { ok: res.count === 1 };
}

/** Puts a FAILED job back in the queue; it continues at its cursor (already-imported rows are skipped, never duplicated). */
export async function resumeSubscriberImport(jobId: string): Promise<{ ok: boolean }> {
  const admin = await assertMarketingAccess();
  const res = await prisma.subscriberImportJob.updateMany({ where: { id: jobId, companyId: admin.companyId, status: "FAILED", payload: { not: null } }, data: { status: "QUEUED", finishedAt: null } });
  revalidatePath("/subscriptions");
  return { ok: res.count === 1 };
}
