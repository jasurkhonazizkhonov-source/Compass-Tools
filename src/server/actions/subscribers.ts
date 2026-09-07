"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canViewSubscriptions } from "@/lib/permissions";
import { parseEmailList } from "@/lib/bulk-subscriber-parse";
import type { SubscriberStatus } from "@/generated/prisma/client";

const emailSchema = z.string().email();

/** Admin or Marketing Agent — same rule Subscriptions/Marketing Campaigns
 * already enforce (see marketing-campaigns.ts's identical helper). Kept as
 * its own local copy rather than a shared import, matching this codebase's
 * established convention for these small per-file authorization asserts
 * (e.g. bulk-contacts.ts's assertBulkImportAccess is its own local
 * function too, not shared with accounts.ts's assertAdmin). */
async function assertMarketingAccess() {
  const current = await getCurrentAccount();
  if (!canViewSubscriptions(current?.role)) {
    throw new Error("You are not authorized to manage subscribers");
  }
  return current!;
}

/** Deletes exactly one subscriber — the row itself only. No cascade to any
 * other CRM entity exists (Subscriber has no relations back to
 * Contact/Lead/Quote/Booking at all — see schema.prisma), so this cannot
 * touch unrelated CRM records by construction, not merely by care taken
 * here. Company-scoped so a subscriberId from a different company (guessed
 * or otherwise) is silently a no-op rather than an error that would leak
 * whether that id exists. */
export async function deleteSubscriber(subscriberId: string) {
  const admin = await assertMarketingAccess();
  await prisma.subscriber.deleteMany({ where: { id: subscriberId, companyId: admin.companyId } });
  revalidatePath("/subscriptions");
}

/** Bulk delete — same company-scoping guarantee as deleteSubscriber above,
 * applied to every id in one batched deleteMany rather than N individual
 * requests. Ids that don't belong to the caller's company (or don't exist
 * at all) are silently excluded rather than causing a partial failure —
 * the caller only ever supplies ids it just displayed from its own
 * company-scoped list, so this is defense-in-depth, not an expected path. */
export async function deleteSubscribers(subscriberIds: string[]) {
  const admin = await assertMarketingAccess();
  if (subscriberIds.length === 0) return { deleted: 0 };
  const result = await prisma.subscriber.deleteMany({ where: { id: { in: subscriberIds }, companyId: admin.companyId } });
  revalidatePath("/subscriptions");
  return { deleted: result.count };
}

/**
 * Pass 9 §8 — refreshes the "N subscribers matching this filter" count
 * right before a cross-page bulk delete is confirmed. The banner/count
 * shown while the user was browsing (`filteredTotal`, computed when the
 * page itself was rendered) can go stale — another user or process may
 * have added/removed matching subscribers since. This is called once, when
 * the confirmation dialog opens for a "select all matching" delete, so the
 * number the user actually confirms reflects current server truth rather
 * than a client-cached value. The DELETE itself (deleteSubscribersMatchingFilter)
 * never depended on this number anyway — it always re-evaluates the WHERE
 * clause live at delete time — this only makes the CONFIRMATION text
 * honest, closing a narrow but real staleness gap without changing how the
 * delete itself is authorized or scoped.
 */
export async function getSubscriberCountForFilter(status?: SubscriberStatus) {
  const admin = await assertMarketingAccess();
  return prisma.subscriber.count({ where: { companyId: admin.companyId, ...(status ? { status } : {}) } });
}

/**
 * Pass 8 §2 — "Select all N subscribers matching this filter" bulk delete.
 * Deliberately does NOT take a client-supplied id list for the bulk target
 * — the browser never fetches/holds/transmits the full matching id set (the
 * whole point of this action existing separately from deleteSubscribers
 * above). Instead the server re-derives exactly which rows match, using the
 * same filter shape (status) and the SAME company scope every other
 * subscriber query already enforces — a malicious/stale `status` value
 * can't reach outside the caller's own company regardless. `excludeIds` is
 * the only client-supplied id data, and it can only ever SHRINK the delete
 * target (an attacker manipulating it can, at worst, delete fewer rows than
 * intended — never more, and never a row outside companyId + status).
 */
export async function deleteSubscribersMatchingFilter(params: { status?: SubscriberStatus; excludeIds: string[] }) {
  const admin = await assertMarketingAccess();
  const result = await prisma.subscriber.deleteMany({
    where: {
      companyId: admin.companyId,
      ...(params.status ? { status: params.status } : {}),
      ...(params.excludeIds.length > 0 ? { id: { notIn: params.excludeIds } } : {}),
    },
  });
  revalidatePath("/subscriptions");
  return { deleted: result.count };
}

// Practical UI/paste ceiling, not an architecture limit — protects against
// a pathological paste (Part 26: "extremely large bulk input cannot crash
// the application") without needing a queue/job system for what's still an
// ordinary batch operation at realistic scale.
const MAX_BULK_SUBSCRIBERS = 2000;

export type BulkSubscriberRowResult = {
  email: string;
  outcome: "new" | "already_subscribed" | "previously_unsubscribed" | "duplicate_in_paste" | "invalid";
  message: string;
};

async function classifyBulkSubscribers(rawText: string, companyId: string): Promise<BulkSubscriberRowResult[]> {
  const extracted = parseEmailList(rawText).slice(0, MAX_BULK_SUBSCRIBERS);
  const seenInBatch = new Set<string>();
  const candidates: { raw: string; normalized: string }[] = [];
  const results: BulkSubscriberRowResult[] = [];

  for (const raw of extracted) {
    const normalized = raw.trim().toLowerCase();
    // parseEmailList only extracts a CANDIDATE (something @-shaped) — the
    // real valid/invalid determination happens here, once, via the CRM's
    // established Zod email validator (matching Bulk Contacts' own
    // convention), not a second hand-rolled regex. This is what lets a
    // malformed candidate the old stricter extraction regex used to just
    // silently drop (e.g. "john@nodomain", "john@@example.com") actually
    // surface as its own "invalid" row instead of vanishing without a
    // trace.
    if (!emailSchema.safeParse(normalized).success) {
      results.push({ email: raw, outcome: "invalid", message: `"${raw}" doesn't look like a valid email address` });
      continue;
    }
    if (seenInBatch.has(normalized)) {
      results.push({ email: normalized, outcome: "duplicate_in_paste", message: `${normalized} appears more than once in this paste` });
      continue;
    }
    seenInBatch.add(normalized);
    candidates.push({ raw, normalized });
  }

  if (candidates.length > 0) {
    const existing = await prisma.subscriber.findMany({
      where: { companyId, email: { in: candidates.map((c) => c.normalized) } },
      select: { email: true, status: true },
    });
    const existingByEmail = new Map(existing.map((e) => [e.email, e.status]));

    for (const { normalized } of candidates) {
      const status = existingByEmail.get(normalized);
      if (status === "SUBSCRIBED") {
        results.push({ email: normalized, outcome: "already_subscribed", message: `${normalized} is already an active subscriber` });
      } else if (status === "UNSUBSCRIBED") {
        // Part 14's explicit safety rule: importing an email again must
        // NEVER silently flip a previously-unsubscribed person back to
        // subscribed. Reported as its own distinct reason (not folded
        // into "already subscribed") specifically so this is transparent
        // rather than looking identical to an already-active subscriber.
        results.push({ email: normalized, outcome: "previously_unsubscribed", message: `${normalized} previously unsubscribed — not automatically re-subscribed` });
      } else {
        results.push({ email: normalized, outcome: "new", message: `${normalized} will be added` });
      }
    }
  }

  return results;
}

/** Validates + classifies a pasted batch WITHOUT writing anything — the
 * review step (Part 8). */
export async function previewBulkSubscribers(rawText: string) {
  const admin = await assertMarketingAccess();
  return classifyBulkSubscribers(rawText, admin.companyId);
}

/**
 * Creates every "new" email from the batch in one createMany call — Part 3
 * / Part 13's "use a batch operation rather than individual requests"
 * (same reasoning, and the same real scalability lesson learned, as Bulk
 * Contacts' createMany rewrite this session). Re-classifies server-side
 * rather than trusting whatever the client saw during preview (Part
 * 20/22 — never trust client-supplied classification for what's actually
 * about to be written), so a subscriber who was unsubscribed or added by
 * someone else in the moments between preview and this call is still
 * handled correctly rather than blindly created from stale client state.
 */
export async function createBulkSubscribers(rawText: string) {
  const admin = await assertMarketingAccess();
  const results = await classifyBulkSubscribers(rawText, admin.companyId);
  const toCreate = results.filter((r) => r.outcome === "new").map((r) => ({ companyId: admin.companyId, email: r.email, source: "bulk_import" }));

  if (toCreate.length > 0) {
    await prisma.subscriber.createMany({ data: toCreate });
  }

  revalidatePath("/subscriptions");
  return { created: toCreate.length, results };
}
