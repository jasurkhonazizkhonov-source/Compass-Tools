/**
 * Which environment this process is running in, decided so that a production
 * deployment can always be recognised as production and can never be
 * relabelled as something else by a generic environment variable.
 *
 * Precedence (first match wins):
 *   1. `APP_ENV=production`  → production. APP_ENV may only make the process
 *      STRICTER; every other APP_ENV value ("staging", "development", "test", …)
 *      is ignored here and cannot relax anything.
 *   2. `VERCEL_ENV` (set by Vercel itself, not by the project) →
 *      "production" | "preview". Both are treated as production-class: a preview
 *      deployment can run against real data, so it gets production rules.
 *   3. `NODE_ENV=production` → production (a `next build`/`next start` process).
 *   4. `NODE_ENV=test` → test.
 *   5. Otherwise → development.
 *
 * Consequence: setting `APP_ENV=staging` on a real deployment does NOTHING.
 * Whether the card vault may run in production-class environments is decided
 * by its own explicit configuration (see card-vault-status.ts), never by this
 * label.
 */
export type AppEnvironment = "production" | "preview" | "development" | "test";

export function getAppEnvironment(): AppEnvironment {
  if (process.env.APP_ENV?.trim().toLowerCase() === "production") return "production";
  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv === "production") return "production";
  if (vercelEnv === "preview") return "preview";
  if (process.env.NODE_ENV === "production") return "production";
  if (process.env.NODE_ENV === "test") return "test";
  return "development";
}

/** Production-class: a real production build, a Vercel production deployment
 *  or a Vercel preview deployment. Security guards fail closed here. */
export function isProductionEnvironment(): boolean {
  const env = getAppEnvironment();
  return env === "production" || env === "preview";
}
