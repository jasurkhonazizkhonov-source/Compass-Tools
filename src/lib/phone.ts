// Single source of truth for phone-number handling — international
// formatting, validation, and normalization. Uses libphonenumber-js (no
// international phone component existed in this codebase before; this is
// the one canonical implementation every phone field should use).
//
// The normalized (E.164, e.g. "+14153298390") form is what gets persisted
// and matched against — never the raw as-typed string. Two different
// formattings of the same number ("(415) 329-8390" vs "415-329-8390" vs
// "+1 415 329 8390") normalize to the identical E.164 string, so contact
// matching/dedup can compare them directly without inventing its own
// character-stripping logic.

import { parsePhoneNumberFromString, getCountries, getCountryCallingCode, isSupportedCountry, type CountryCode } from "libphonenumber-js";

export type { CountryCode };

/** Every ISO country code libphonenumber-js has calling-code data for —
 * the full list, not a hand-picked subset, so "select the country" isn't
 * artificially limited to a handful of examples. */
export const PHONE_COUNTRIES: CountryCode[] = getCountries();

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/** "United States (+1)" — built from Intl's own region names + the
 * library's own calling-code data, never a hardcoded country list. */
export function countryDisplayLabel(country: CountryCode): string {
  const name = regionNames.of(country) ?? country;
  return `${name} (+${getCountryCallingCode(country)})`;
}

export { getCountryCallingCode, isSupportedCountry };

/**
 * Normalizes a phone number to E.164 (e.g. "+14153298390") given the
 * country the customer selected (used to resolve a national-format number
 * with no leading "+"). Returns null for something that isn't a real,
 * possible phone number — callers should treat that as a validation
 * failure, never silently fall back to storing the raw unparsed string.
 */
export function normalizePhoneNumber(raw: string, defaultCountry?: CountryCode): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = parsePhoneNumberFromString(trimmed, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

/** True if `raw` parses to a real, possible phone number for the given
 * (or embedded "+"-prefixed) country. */
export function isValidPhoneInput(raw: string, defaultCountry?: CountryCode): boolean {
  return normalizePhoneNumber(raw, defaultCountry) !== null;
}

/** "+1 415-329-8390" — international display format for an already-valid
 * number, for read-only contexts (e.g. a contact's saved phone list).
 * Gracefully returns the input unchanged when it can't be parsed, so it's
 * always safe to call on a stored value that may not be a normalized E.164
 * string (e.g. a legacy raw-string fallback — see normalizePhoneNumber's
 * own doc comment on why a write path might still have stored one). */
export function formatPhoneInternational(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatInternational() : e164;
}

/**
 * Recovers the one specific, unambiguous shape of phone number Excel (and
 * some other copy/paste sources) is known to mangle: a full NANP (US/
 * Canada) number typed/copied as "+1 415 555 1234" comes out as
 * "1 415 555 1234" or "14155551234" — the leading "+" gets silently
 * dropped by whatever stripped it (Excel's formula-character handling,
 * a bare paste with no country context, etc.). That's recoverable with
 * certainty because E.164 NANP numbers are always exactly 11 digits
 * starting with "1" — there is no other country code this could be.
 * Deliberately NOT "assume every number starting with 1 is American" (a
 * 9- or 10-digit number starting with 1 is left alone and still flagged
 * for review, never guessed) — only the exact 11-digit shape, which has no
 * other valid interpretation, gets the "+" restored before handing off to
 * normalizePhoneNumber. Originally established in bulk-contact-validation.ts;
 * moved here (this module's own header comment already claims to be the
 * canonical single source of truth for phone handling) so lead creation can
 * reuse the identical, already-reviewed heuristic instead of duplicating it.
 */
export function recoverExcelMangledNanp(raw: string): string | null {
  if (raw.startsWith("+")) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * True when `raw` carries its own embedded "+"-prefixed calling code and
 * that calling code does NOT match `selectedCountry`'s — e.g. the agent has
 * "United States (+1)" chosen in the country selector but pastes in
 * "+44 20 7946 0958" (a UK number). libphonenumber-js's own parser silently
 * ignores the selected-country hint whenever the input already has a "+"
 * (the embedded code always wins), so left unchecked the number would save
 * successfully as a valid GB number while the UI still visually shows "+1"
 * selected — a real, silent mismatch, not just a cosmetic one. Compares
 * calling codes (not the resolved ISO country) specifically so numbering
 * plans shared by several countries — NANP's +1 covering US/Canada/many
 * Caribbean nations being the main case in this app's market — never
 * false-positive against each other. Returns false (no mismatch) for a
 * number with no embedded "+", since there's nothing to compare against;
 * that case is exactly what defaultCountry-based parsing already handles.
 */
export function phoneCountryMismatch(raw: string, selectedCountry: CountryCode): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("+")) return false;
  const parsed = parsePhoneNumberFromString(trimmed);
  if (!parsed || !parsed.countryCallingCode) return false;
  return parsed.countryCallingCode !== getCountryCallingCode(selectedCountry);
}

/** Normalizes a phone number, attempting the unambiguous Excel-mangled-NANP
 * recovery above when the plain parse fails — the combined "try normally,
 * then try the one safe recovery" step every write path that wants this
 * behavior should call, rather than each re-implementing the two-step
 * sequence itself. Still returns null (never a guess) when neither
 * succeeds. */
export function normalizePhoneNumberWithRecovery(raw: string, defaultCountry?: CountryCode): string | null {
  const direct = normalizePhoneNumber(raw, defaultCountry);
  if (direct) return direct;
  const recovered = recoverExcelMangledNanp(raw.trim());
  return recovered ? normalizePhoneNumber(recovered, defaultCountry) : null;
}
