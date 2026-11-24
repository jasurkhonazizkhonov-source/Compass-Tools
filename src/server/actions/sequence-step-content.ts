"use server";

import { getCurrentAccount } from "@/lib/dev-session";
import { canManageSequences } from "@/lib/permissions";
import { getCompanyForAccountId } from "@/server/queries/company";
import { resolveBaseUrl } from "@/lib/company-config";
import { buildSequenceEmail } from "@/server/email/templates";
import { analyzeStepContent, renderStepBodyHtml, type StepAnalysis } from "@/server/email/sequence-content";
import { renderSequenceTemplate, SEQUENCE_VARIABLES, VARIABLE_TOKEN_META, type SequenceVariableContext } from "@/lib/sequence-variables";

// The visual email editor's two server-side helpers: judge a draft (errors that would stop it being saved, warnings that are only advice) and render it exactly as a customer's mail
// program will be given it. Neither touches the database or sends anything; both need the same permission as editing a sequence. The draft comes from the browser, so it is
// bounded in size and always cleaned the same way a real send is (never trusted).

const MAX_DRAFT_CHARS = 150_000; // a little above the 100,000-character limit a step may have, so the analysis can still say "too large"

type DraftInput = { subject: string; body: string; bodyFormat: "TEXT" | "HTML" };
const NOT_AVAILABLE = "Not available.";

function parseDraft(input: unknown): DraftInput | null {
  const v = input as Partial<DraftInput> | null;
  if (!v || typeof v.subject !== "string" || typeof v.body !== "string") return null;
  if (v.subject.length > 998 || v.body.length > MAX_DRAFT_CHARS) return null;
  return { subject: v.subject, body: v.body, bodyFormat: v.bodyFormat === "HTML" ? "HTML" : "TEXT" };
}

async function requireSequenceEditor() {
  const actor = await getCurrentAccount();
  if (!actor || !canManageSequences(actor.role)) throw new Error(NOT_AVAILABLE);
  return actor;
}

/** Errors (they block saving) and warnings (advice) for a draft step. */
export async function analyzeSequenceStepDraft(input: DraftInput): Promise<StepAnalysis> {
  await requireSequenceEditor();
  const draft = parseDraft(input);
  if (!draft) {
    return { errors: [{ level: "error", code: "too-large", message: "The email is too large to check or save." }], warnings: [], linkCount: 0, imageCount: 0, sizeChars: 0, ok: false };
  }
  return analyzeStepContent({ subject: draft.subject, body: draft.body, format: draft.bodyFormat });
}

function sampleContext(): SequenceVariableContext {
  return Object.fromEntries(SEQUENCE_VARIABLES.map((v) => [v.key, VARIABLE_TOKEN_META[v.key.replace(/([A-Z])/g, "_$1").toLowerCase()]?.sample ?? ""])) as SequenceVariableContext;
}

export type StepPreview = { ok: true; subject: string; html: string } | { ok: false; error: string };

/** The whole email as the customer would receive it, filled with sample data (never a real customer's), including the signature and the unsubscribe footer. */
export async function previewSequenceStepEmail(input: DraftInput): Promise<StepPreview> {
  const actor = await requireSequenceEditor();
  const draft = parseDraft(input);
  if (!draft) return { ok: false, error: "The email is too large to preview." };
  const company = await getCompanyForAccountId(actor.id);
  const context = sampleContext();
  const subject = renderSequenceTemplate(draft.subject, context);
  const isHtml = draft.bodyFormat === "HTML";
  const { html } = buildSequenceEmail({
    subject,
    bodyText: isHtml ? "" : renderSequenceTemplate(draft.body, context),
    ...(isHtml ? { bodyHtml: renderStepBodyHtml(draft.body, context, company.brandColor) } : {}),
    agent: { fullName: actor.fullName, email: actor.email, phone: (actor as { phone?: string | null }).phone ?? null },
    company,
    // A preview link that cannot unsubscribe anyone: there is no enrollment behind it.
    unsubscribeUrl: `${resolveBaseUrl()}/api/public/sequence-unsubscribe?enrollment=preview`,
  });
  return { ok: true, subject, html };
}
