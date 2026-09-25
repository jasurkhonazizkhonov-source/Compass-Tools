/**
 * Production/development environment detection used by security-sensitive
 * code paths (card vault selection, privileged step-up authentication).
 *
 * `APP_ENV` takes precedence when set — an explicit escape hatch for a
 * deployment that runs a production-mode build (NODE_ENV=production, set
 * automatically by `next build`/`next start`) but should still be treated
 * as non-production for these guards (e.g. a self-hosted staging box). It does
 * NOT apply to a Vercel production deployment (see below). When
 * `APP_ENV` is unset, this falls back to `NODE_ENV`, so a real production
 * deploy is caught automatically even if nobody remembers to set `APP_ENV`
 * — fail closed by default, not fail open.
 */
export function isProductionEnvironment(): boolean {
  // A real Vercel production deployment is production, full stop. APP_ENV must
  // never be able to relabel it as "staging" to switch off the production
  // guards (the card vault refusing to store cards, privileged step-up). Only
  // a deployment that is not Vercel-production can use APP_ENV to opt out.
  if (process.env.VERCEL_ENV === "production") return true;
  const appEnv = process.env.APP_ENV;
  if (appEnv) return appEnv === "production";
  return process.env.NODE_ENV === "production";
}
