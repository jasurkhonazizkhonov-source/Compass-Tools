"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentAccount } from "@/lib/dev-session";
import { canManageSequences } from "@/lib/permissions";
import { LEAD_STATUS_META } from "@/lib/status-meta";
import { leadVisibilityWhere, sequenceVisibilityWhere } from "@/server/visibility";
import { classifyLeadsForEnrollment } from "@/server/sequence-enrollment-eligibility";
import { enrollLeads } from "@/server/actions/sequences";
import { isRecipientMode, type RecipientMode } from "@/server/sequence-recipients";
import type { LeadStatus } from "@/generated/prisma/client";

// Sequences section -> a sequence -> Enroll Leads -> "By status": enroll every eligible lead whose CURRENT status is one of the chosen ones.
//
// Nothing here trusts the browser. The statuses are validated against the canonical LeadStatus list (LEAD_STATUS_META, which is typed over the
// whole enum), the matching leads are looked up on the server by status within the caller's own visibility (leadVisibilityWhere - the same rule
// every Leads list uses, so company/ownership boundaries hold), and BOTH the preview and the enrollment run the same classification
// (classifyLeadsForEnrollment) that enrollLeads itself uses. The enrollment re-queries by status at confirmation time, so a lead whose status
// changed after the preview is simply no longer matched, and the result says how many fewer/more leads matched than were previewed.
//
// Bounded on purpose: at most MAX_MATCHES leads per operation and CHUNK per classification/enrollment call (the in-transaction advisory locking
// in enrollLeads is chunked too), so a large selection never becomes one unbounded query or transaction. If more leads match, nothing is
// enrolled and the person is asked to narrow the selection.

const MAX_MATCHES = 5000;
const CHUNK = 200;
const KNOWN_STATUSES = new Set<string>(Object.keys(LEAD_STATUS_META));

type Counts = {
  /** Leads currently matching the chosen statuses (and visible to the caller). */
  matched: number;
  /** Leads that would be (preview) / were (enroll) given a new ACTIVE enrollment. */
  eligible: number;
  alreadyActive: number;
  missingEmail: number;
  addressSuppressed: number;
  noAssignedAgent: number;
  gmailUnavailable: number;
  inaccessible: number;
};

export type EnrollByStatusPreview = ({ ok: true; sequenceName: string; truncated: boolean; gmailMessage?: string } & Counts) | { ok: false; error: string };

export type EnrollByStatusResult =
  | ({
      ok: true;
      sequenceName: string;
      enrolled: number;
      /** Leads whose enrollment could not be completed for a reason other than the counted ones (e.g. a transient database error). */
      failedOther: number;
      /** matched-now minus the count shown at preview, when the caller passed it: leads that stopped/started matching in between. */
      changedSincePreview: number;
      gmailMessage?: string;
    } & Omit<Counts, "eligible">)
  | { ok: false; error: string };

function parseStatuses(input: unknown): LeadStatus[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > KNOWN_STATUSES.size) return null;
  const unique = [...new Set(input)];
  if (!unique.every((s): s is LeadStatus => typeof s === "string" && KNOWN_STATUSES.has(s))) return null;
  return unique as LeadStatus[];
}

async function authorize(sequenceId: unknown) {
  const actor = await getCurrentAccount();
  if (!actor || !canManageSequences(actor.role) || typeof sequenceId !== "string" || !sequenceId) return null;
  const sequence = await prisma.sequence.findFirst({
    where: { id: sequenceId, ...sequenceVisibilityWhere(actor) },
    select: { id: true, name: true, _count: { select: { steps: true } } },
  });
  if (!sequence) return null;
  return { actor, sequence };
}

async function findMatchingLeadIds(actor: NonNullable<Awaited<ReturnType<typeof getCurrentAccount>>>, statuses: LeadStatus[]) {
  const rows = await prisma.lead.findMany({
    where: { status: { in: statuses }, ...leadVisibilityWhere(actor) },
    select: { id: true },
    orderBy: { id: "asc" },
    take: MAX_MATCHES + 1,
  });
  const truncated = rows.length > MAX_MATCHES;
  return { ids: rows.slice(0, MAX_MATCHES).map((r) => r.id), truncated };
}

const NOT_AVAILABLE = "That sequence is not available.";
const NARROW = `More than ${MAX_MATCHES.toLocaleString("en-US")} leads match these statuses. Choose fewer statuses so the selection can be checked and enrolled safely.`;

export async function previewEnrollByStatus(input: { sequenceId: string; statuses: string[]; recipientMode?: RecipientMode }): Promise<EnrollByStatusPreview> {
  const recipientMode: RecipientMode = isRecipientMode(input?.recipientMode) ? input.recipientMode : "primary";
  const auth = await authorize(input?.sequenceId);
  if (!auth) return { ok: false, error: NOT_AVAILABLE };
  const statuses = parseStatuses(input.statuses);
  if (!statuses) return { ok: false, error: "Choose at least one lead status." };
  if (auth.sequence._count.steps === 0) return { ok: false, error: "This sequence has no steps yet." };

  const { ids, truncated } = await findMatchingLeadIds(auth.actor, statuses);
  const counts: Counts = { matched: ids.length, eligible: 0, alreadyActive: 0, missingEmail: 0, addressSuppressed: 0, noAssignedAgent: 0, gmailUnavailable: 0, inaccessible: 0 };
  if (truncated) return { ok: true, sequenceName: auth.sequence.name, truncated: true, gmailMessage: undefined, ...counts };
  let gmailMessage: string | undefined;
  for (let i = 0; i < ids.length; i += CHUNK) {
    // Local checks only for a preview (no Google call per chunk, per checkbox click); the enrollment itself verifies the token.
    const c = await classifyLeadsForEnrollment({ actor: auth.actor, sequenceId: auth.sequence.id, leadIds: ids.slice(i, i + CHUNK), recipientMode, verifyGmail: false });
    for (const v of c.verdicts.values()) {
      if (v === "eligible") counts.eligible++;
      else counts[v]++;
    }
    gmailMessage ??= c.gmailMessage;
  }
  return { ok: true, sequenceName: auth.sequence.name, truncated: false, gmailMessage, ...counts };
}

export async function enrollLeadsByStatus(input: { sequenceId: string; statuses: string[]; previewMatched?: number; recipientMode?: RecipientMode }): Promise<EnrollByStatusResult> {
  const recipientMode: RecipientMode = isRecipientMode(input?.recipientMode) ? input.recipientMode : "primary";
  const auth = await authorize(input?.sequenceId);
  if (!auth) return { ok: false, error: NOT_AVAILABLE };
  const statuses = parseStatuses(input.statuses);
  if (!statuses) return { ok: false, error: "Choose at least one lead status." };
  if (auth.sequence._count.steps === 0) return { ok: false, error: "This sequence has no steps yet." };

  const { ids, truncated } = await findMatchingLeadIds(auth.actor, statuses);
  if (truncated) return { ok: false, error: NARROW };
  if (ids.length === 0) return { ok: false, error: "No leads currently have the selected status." };

  const out = {
    matched: ids.length,
    enrolled: 0,
    alreadyActive: 0,
    missingEmail: 0,
    addressSuppressed: 0,
    noAssignedAgent: 0,
    gmailUnavailable: 0,
    inaccessible: 0,
    failedOther: 0,
    changedSincePreview: typeof input.previewMatched === "number" && Number.isFinite(input.previewMatched) ? Math.abs(ids.length - Math.max(0, Math.trunc(input.previewMatched))) : 0,
  };
  let gmailMessage: string | undefined;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    try {
      // enrollLeads re-checks authorization, visibility, duplicates (under a lock) and Gmail for this chunk on its own.
      const r = await enrollLeads(auth.sequence.id, chunk, undefined, { recipientMode });
      out.enrolled += r.enrolled;
      out.alreadyActive += r.alreadyActive;
      out.missingEmail += r.missingEmail;
      out.addressSuppressed += r.addressSuppressed;
      out.noAssignedAgent += r.noAssignedAgent;
      out.gmailUnavailable += r.gmailUnavailable;
      out.inaccessible += r.inaccessible;
      gmailMessage ??= r.gmailMessage;
    } catch {
      out.failedOther += chunk.length; // never claim success for a chunk that threw
    }
  }
  revalidatePath(`/sequences/${auth.sequence.id}`);
  return { ok: true, sequenceName: auth.sequence.name, gmailMessage, ...out };
}
