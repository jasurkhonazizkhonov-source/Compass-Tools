// Split out of gmail-connect.ts (a "use server" file) because Next.js only
// allows async function exports from "use server" files — a plain string
// constant export there breaks the entire module's exports at runtime
// ("A 'use server' file can only export async functions"). Shared by
// gmail-connect.ts (sets the cookie) and the OAuth callback route handler
// (reads/clears it).
export const GMAIL_OAUTH_STATE_COOKIE = "gmail_oauth_state";

/** Where to send the user after the consent flow: set by "Connect Gmail" when it is started from a Lead, read and cleared by the callback. */
export const GMAIL_RETURN_COOKIE = "gmail_return_to";

/**
 * The ONLY place a return target is accepted: a lead page of this application ("/leads/<id>"). Anything else - another path, an absolute or
 * protocol-relative URL, a query string, dots, encoded characters - is ignored and the user lands on their normal route, so this can never be used as an open
 * redirect. Used both when the cookie is written and again when it is read (the cookie is not trusted).
 */
export function safeGmailReturnPath(value: string | null | undefined): string | null {
  return typeof value === "string" && /^\/leads\/[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}
