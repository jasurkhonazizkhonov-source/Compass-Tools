// Split out of gmail-connect.ts (a "use server" file) because Next.js only
// allows async function exports from "use server" files — a plain string
// constant export there breaks the entire module's exports at runtime
// ("A 'use server' file can only export async functions"). Shared by
// gmail-connect.ts (sets the cookie) and the OAuth callback route handler
// (reads/clears it).
export const GMAIL_OAUTH_STATE_COOKIE = "gmail_oauth_state";
