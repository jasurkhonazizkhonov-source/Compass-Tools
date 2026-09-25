/**
 * Production/development environment detection used by security-sensitive
 * code paths (card vault selection, privileged step-up authentication).
 *
 * `APP_ENV` takes precedence when set — an explicit escape hatch for a
 * deployment that runs a production-mode build (NODE_ENV=production, set
 * automatically by `next build`/`next start`) but should still be treated
 * as non-production for these guards. It is how an owner DELIBERATELY accepts
 * the application-level card vault on a real deployment (docs/DEPLOYMENT.md
 * §5c). When `APP_ENV` is unset, this falls back to `NODE_ENV`, so a real
 * production deploy is caught automatically even if nobody remembers to set
 * `APP_ENV` — fail closed by default, not fail open.
 */
export function isProductionEnvironment(): boolean {
  const appEnv = process.env.APP_ENV;
  if (appEnv) return appEnv === "production";
  return process.env.NODE_ENV === "production";
}
