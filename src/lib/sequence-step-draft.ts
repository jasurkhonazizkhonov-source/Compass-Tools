// Small, pure helpers for the sequence step editor: converting an older plain-text step for the visual editor, and the draft that is kept in the browser while a step is being written.

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * An older plain-text step as visual-editor HTML: paragraphs are separated by blank lines, a single line break stays a line break, and addresses typed as text become links - the
 * same three things the plain-text email already did when it was sent, so a converted step reads exactly the same. Everything is HTML-escaped.
 */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const escaped = escapeText(p).replace(/\b(https?:\/\/[^\s<]+[^\s<.,;:!?)"'])/g, '<a href="$1">$1</a>');
      return `<p>${escaped.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

/** The visible text of a step's HTML, for the one-line summary of a collapsed step. Display only: it is rendered as plain text, never as markup. */
export function htmlToPlainText(html: string, maxChars = 220): string {
  const text = html
    .replace(/<(br|\/p|\/h[1-6]|\/li|\/tr|\/div)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

export type StepDraft = { subject: string; body: string; bodyFormat: "TEXT" | "HTML"; delayDays: number; savedAt: number };

export const stepDraftKey = (stepId: string | null, sequenceId: string) => `compass:step-draft:${stepId ?? `new:${sequenceId}`}`;

/** Parses what was stored, refusing anything that is not exactly a draft (the storage is the user's own browser, but it is never trusted). */
export function parseStepDraft(raw: string | null): StepDraft | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StepDraft>;
    if (typeof v.subject !== "string" || typeof v.body !== "string" || typeof v.savedAt !== "number") return null;
    if (v.subject.length > 998 || v.body.length > 200_000) return null;
    return { subject: v.subject, body: v.body, bodyFormat: v.bodyFormat === "HTML" ? "HTML" : "TEXT", delayDays: typeof v.delayDays === "number" && v.delayDays >= 0 ? v.delayDays : 0, savedAt: v.savedAt };
  } catch {
    return null;
  }
}

/** True when a stored draft says something other than what is saved, so offering to restore it is worth the person's attention. */
export function draftDiffers(draft: StepDraft, saved: { subject: string; body: string; bodyFormat: "TEXT" | "HTML"; delayDays: number }): boolean {
  return draft.subject !== saved.subject || draft.body !== saved.body || draft.bodyFormat !== saved.bodyFormat || draft.delayDays !== saved.delayDays;
}
