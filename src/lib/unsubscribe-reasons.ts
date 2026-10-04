// The optional reason a customer can give when unsubscribing from marketing
// email. Shared by the public page (which collects it) and the CRM (which shows
// it), so the wording can never drift. The reason is OPTIONAL everywhere: a
// customer can unsubscribe with none, and nothing is stored unless they gave one.

export const UNSUBSCRIBE_REASONS = [
  { value: "TOO_MANY_EMAILS", label: "I receive too many emails" },
  { value: "NOT_RELEVANT", label: "The emails aren't relevant to me" },
  { value: "NO_LONGER_INTERESTED", label: "I'm no longer interested" },
  { value: "NOT_USEFUL", label: "The information wasn't useful" },
  { value: "OTHER", label: "Other" },
] as const;

export type UnsubscribeReasonCategory = (typeof UNSUBSCRIBE_REASONS)[number]["value"];

/** Longest free-text reason accepted. Bounded on purpose — never arbitrary text. */
export const MAX_UNSUBSCRIBE_REASON_LENGTH = 1000;

export function unsubscribeReasonLabel(category: string | null | undefined): string | null {
  return UNSUBSCRIBE_REASONS.find((r) => r.value === category)?.label ?? null;
}

export type NormalizedUnsubscribeReason =
  | { ok: true; category: UnsubscribeReasonCategory | null; text: string | null }
  | { ok: false; error: string };

/**
 * Validates and normalises what the unsubscribe form submitted. Pure; never
 * trusts the input shape:
 *   • an unknown / tampered category is dropped (not stored), not an error;
 *   • the text is treated strictly as PLAIN TEXT — control characters are removed
 *     (newlines kept, normalised to \n), surrounding whitespace trimmed, and any
 *     markup is left as literal characters (every place that shows it escapes it,
 *     so "<script>" is just those characters);
 *   • more than MAX_UNSUBSCRIBE_REASON_LENGTH characters is refused, not silently cut;
 *   • nothing provided at all → { category: null, text: null }, i.e. no reason is stored.
 */
export function normalizeUnsubscribeReason(input: { category?: unknown; text?: unknown }): NormalizedUnsubscribeReason {
  const category = typeof input.category === "string" ? UNSUBSCRIBE_REASONS.find((r) => r.value === input.category)?.value ?? null : null;
  let text: string | null = null;
  if (typeof input.text === "string") {
    const cleaned = input.text
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/g, "")
      .trim();
    if (cleaned.length > MAX_UNSUBSCRIBE_REASON_LENGTH) {
      return { ok: false, error: `Please keep your comment under ${MAX_UNSUBSCRIBE_REASON_LENGTH} characters.` };
    }
    text = cleaned.length > 0 ? cleaned : null;
  }
  return { ok: true, category, text };
}
