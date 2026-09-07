// Pure, DB-free parsing for Bulk Subscribers (Part 5) — kept in its own
// plain module so it's directly unit-testable, same pattern as
// bulk-contact-paste.ts.

// A single global regex extraction, not separate split-by-delimiter logic
// for newlines/commas/semicolons/spaces — this one technique naturally
// handles every separator style at once (each is just whitespace/
// punctuation the pattern doesn't match, so it's skipped between matches),
// AND handles "surrounding text" gracefully (e.g. a mail client's copied
// "John Smith <john@example.com>" — the angle brackets and display name
// aren't email characters, so only the address itself is extracted) without
// a separate display-name-stripping step.
//
// Deliberately a CANDIDATE finder, not a validator: it only requires an "@"
// with plausible local-part/domain characters on each side (no longer a
// required ".tld" suffix — a previous, stricter version of this pattern
// silently dropped a malformed candidate like "john@nodomain" instead of
// surfacing it, which meant classifyBulkSubscribers (server/actions/
// subscribers.ts) could never flag it "invalid" since it was never even
// extracted in the first place). The actual valid/invalid determination now
// happens once, downstream, via Zod's real email validator — "prefer
// validation after extraction," not a hand-rolled regex doing double duty
// as both extractor and validator. Still bounded by real domain/local-part
// character classes (never a blind /\S+@\S+/) so it doesn't glue trailing
// punctuation from a comma/semicolon-separated list onto the match.
//
// The domain-side class also allows a second "@" (e.g. "a@@example.com",
// a realistic fat-fingered paste) so that shape is captured as ONE
// candidate — "a@@example.com" — rather than failing to match at all and
// silently vanishing the way it used to. Zod's email validator downstream
// correctly rejects a double-"@" string as invalid, so this only widens
// what gets SURFACED as a visible "invalid" row, never what gets accepted.
const EMAIL_CANDIDATE_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.@-]+/g;

/** Extracts every email-SHAPED candidate substring from pasted text, in the
 * order they appear — not necessarily valid emails (see the module comment
 * above). Does not dedupe, normalize case, or validate — the caller decides
 * that (see classifyBulkSubscribers in server/actions/subscribers.ts). */
export function parseEmailList(text: string): string[] {
  return text.match(EMAIL_CANDIDATE_PATTERN) ?? [];
}
