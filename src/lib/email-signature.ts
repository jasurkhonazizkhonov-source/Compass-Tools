// Resolves a company's raw signature template against a specific person's
// info at send time — never baked into a stored per-user copy, so an admin
// editing the template immediately changes what every future email shows.
// Plain, safe token substitution (no template engine/eval — the template
// is admin-authored trusted content, but the substituted VALUES — a
// person's name/phone — are still escaped for HTML contexts by the caller
// when building HTML email bodies, same discipline already used elsewhere
// in src/server/email/templates.ts).

export const SIGNATURE_VARIABLES = ["{{first_name}}", "{{last_name}}", "{{phone_number}}"] as const;

export type SignatureValues = {
  firstName: string;
  lastName: string;
  phone: string;
};

/** Splits a full name the same simple way the rest of the app already does
 * (first token = first name, remainder = last name) — used when only a
 * single fullName field is available (e.g. Account.fullName). */
export function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const [firstName, ...rest] = fullName.trim().split(/\s+/);
  return { firstName: firstName ?? "", lastName: rest.join(" ") };
}

/** Replaces every supported {{variable}} token with the given values.
 * Unknown tokens are left as-is (never silently dropped — visible in a
 * preview/sent email is safer than invisible data loss for a typo'd
 * variable name). */
export function resolveSignature(template: string, values: SignatureValues): string {
  return template
    .replaceAll("{{first_name}}", values.firstName)
    .replaceAll("{{last_name}}", values.lastName)
    .replaceAll("{{phone_number}}", values.phone);
}
