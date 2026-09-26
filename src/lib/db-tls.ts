// How the application connects to PostgreSQL over TLS — and whether it can
// prove it is talking to the real server.
//
//   DATABASE_SSL_CA      A PEM certificate (chain) for the database's certificate
//                        authority — for Aiven, the project CA certificate from the
//                        service's Overview page. When set, the server certificate
//                        AND host name are verified against it.
//   DATABASE_SSL_VERIFY  "system": verify against Node's built-in trust store
//                        (right for a provider whose CA is publicly trusted).
//   (neither)            Encrypted but NOT identity-verified — the historical
//                        behaviour, kept as the default so a deployment does not
//                        break the moment this ships. A network attacker who can
//                        intercept the connection could impersonate the database.
//
// Nothing here ever returns or logs the certificate or connection string.
export type DatabaseSsl = { rejectUnauthorized: boolean; ca?: string };
export type DatabaseTlsMode = "verified_ca" | "verified_system" | "unverified";

/** Vercel/.env values often carry the PEM with literal "\n" sequences. */
function normalizePem(raw: string): string {
  return raw.replace(/\\n/g, "\n").trim();
}

export function getDatabaseTlsMode(env: NodeJS.ProcessEnv = process.env): DatabaseTlsMode {
  const ca = env.DATABASE_SSL_CA?.trim();
  if (ca && /-----BEGIN CERTIFICATE-----/.test(normalizePem(ca))) return "verified_ca";
  if (env.DATABASE_SSL_VERIFY?.trim().toLowerCase() === "system") return "verified_system";
  return "unverified";
}

export function resolveDatabaseSsl(env: NodeJS.ProcessEnv = process.env): DatabaseSsl {
  const mode = getDatabaseTlsMode(env);
  if (mode === "verified_ca") return { rejectUnauthorized: true, ca: normalizePem(env.DATABASE_SSL_CA!) };
  if (mode === "verified_system") return { rejectUnauthorized: true };
  // A DATABASE_SSL_CA that is set but is not a PEM certificate must not be silently ignored.
  if (env.DATABASE_SSL_CA?.trim()) throw new Error("DATABASE_SSL_CA is set but is not a PEM certificate (expected -----BEGIN CERTIFICATE-----)");
  return { rejectUnauthorized: false };
}
