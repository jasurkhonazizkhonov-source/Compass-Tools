// Pass 12 §41 — the ONE shared helper every customer-facing template
// routes its greeting through. Contact.firstName/lastName are both
// required, non-nullable schema columns today (see prisma/schema.prisma),
// so an actually-missing name should never occur in practice — but this
// stays defensive against a blank/whitespace-only value, a future
// nullable migration, or a test fixture, so a customer can never receive
// a broken "Hello, undefined" / "Hello, " greeting.

/** "John Smith" / "John" / "Smith" / "" — never "undefined undefined" or
 * a stray leading/trailing space. */
export function formatCustomerFullName(firstName: string | null | undefined, lastName?: string | null | undefined): string {
  const first = firstName?.trim() || "";
  const last = lastName?.trim() || "";
  if (first && last) return `${first} ${last}`;
  return first || last;
}

/** "Hello, John Smith" — falls back to a neutral "Hello" (no dangling
 * comma/name) when neither name part is available. Used by the New
 * Flight Option email's greeting (§8), which is customer-facing full-name
 * by design. */
export function customerGreeting(firstName: string | null | undefined, lastName?: string | null | undefined): string {
  const name = formatCustomerFullName(firstName, lastName);
  return name ? `Hello, ${name}` : "Hello";
}

/** "Hi John" — falls back to a neutral "Hi there" when the first name is
 * unavailable. Used by templates that only ever received a first name
 * historically (booking confirmation, cancellation) — kept as its own
 * function rather than always requiring a last name, since some call
 * sites genuinely never had one wired through. */
export function firstNameGreeting(firstName: string | null | undefined): string {
  const first = firstName?.trim();
  return first ? `Hi ${first}` : "Hi there";
}
