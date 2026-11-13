// How the application connects to PostgreSQL over TLS — and whether it can
// prove it is talking to the real server.
//
//   DATABASE_SSL_MODE    "disable": do NOT use TLS for this connection. Only for the PostgreSQL
//                        container on the private Docker Compose network of the self-hosted
//                        deployment (docs/DEPLOYMENT_OVHCLOUD_CLOUDFLARE.md), which does not offer
//                        TLS. It is deliberately an explicit opt-in that must pass three checks, so
//                        it can never weaken a connection to an unintended host by accident:
//                          1. the value is exactly "disable" (anything else is refused, never
//                             guessed at);
//                          2. DATABASE_SSL_CA and DATABASE_SSL_VERIFY are not also set (a
//                             contradictory configuration is refused, not resolved silently);
//                          3. the host in DATABASE_URL is on a short, EXACT allow-list (see
//                             PLAINTEXT_ALLOWED_HOSTS below) and the URL carries no host= /
//                             hostaddr= query parameter that would make the driver connect
//                             somewhere else. Everything else is refused.
//                        This is a typo/misconfiguration guard, NOT proof of a private network:
//                        a name matching the list could still be made to resolve elsewhere by
//                        the container's DNS, hosts file or network. Keeping PostgreSQL on an
//                        internal Docker network that nothing else can join (compose.yaml:
//                        `internal: true`, no published ports) is a separate, required control.
//   DATABASE_SSL_CA      A PEM certificate (chain) for the database's certificate
//                        authority — for Aiven, the project CA certificate from the
//                        service's Overview page. When set, the server certificate
//                        AND host name are verified against it.
//   DATABASE_SSL_VERIFY  "system": verify against Node's built-in trust store
//                        (right for a provider whose CA is publicly trusted).
//   (none of these)      Encrypted but NOT identity-verified — the historical
//                        behaviour, kept as the default so a deployment does not
//                        break the moment this ships. A network attacker who can
//                        intercept the connection could impersonate the database.
//
// Use "disable" for the local Docker database and CA/system verification for a remote managed one.
//
// Nothing here ever returns or logs the certificate, host name or connection string.
export type DatabaseSsl = false | { rejectUnauthorized: boolean; ca?: string };
export type DatabaseTlsMode = "disabled" | "verified_ca" | "verified_system" | "unverified";

/** Vercel/.env values often carry the PEM with literal "\n" sequences. */
function normalizePem(raw: string): string {
  return raw.replace(/\\n/g, "\n").trim();
}

function sslModeSetting(env: NodeJS.ProcessEnv): string {
  return env.DATABASE_SSL_MODE?.trim().toLowerCase() ?? "";
}

/**
 * The ONLY hosts for which DATABASE_SSL_MODE=disable is accepted. An exact allow-list, deliberately not a pattern:
 *
 *  - `db`         the PostgreSQL service in compose.yaml - the one real use of plaintext in this project.
 *  - `localhost`, `127.0.0.1`, `::1`
 *                 loopback, for a developer running a non-TLS PostgreSQL on their own machine: the traffic never leaves the host.
 *
 * Deliberately NOT accepted (none is needed by compose.yaml, CI or the tests, and none identifies a private network by its name):
 *  - other single-label names (`postgres`, `database`, ...): any name can be defined to point anywhere by a hosts file, a search
 *    domain or a proxy; only the one name this project's compose file defines is trusted;
 *  - `*.internal` and `host.docker.internal`: `.internal` is an ordinary DNS suffix anyone can resolve to anything, and
 *    `host.docker.internal` is the Docker HOST - a different, wider trust boundary than the database container;
 *  - private-range IP addresses (10/8, 172.16/12, 192.168/16, fc00::/7): they may be any machine on a shared LAN or VPC, not the
 *    local database container (compose reaches `db` by name, never by address);
 *  - anything with a trailing dot, whitespace, a port, brackets around a name, or any other form not written exactly as above.
 *
 * No DNS lookup is done: resolving a name would only show what it points to at this instant and would add a network dependency.
 * To use plaintext against another host, change this list in a reviewed commit.
 */
const PLAINTEXT_ALLOWED_HOSTS: ReadonlySet<string> = new Set(["db", "localhost", "127.0.0.1", "::1"]);

/**
 * Whether `rawHost` - the hostname as `new URL(...).hostname` reports it - is on PLAINTEXT_ALLOWED_HOSTS.
 * Hostnames are case-insensitive (`DB` is `db`); non-special URL schemes such as postgresql:// keep the case they were written in,
 * so the comparison lower-cases. An IPv6 literal arrives in brackets (`[::1]`); the brackets are removed only for something that
 * contains a colon, so `[db]` is not a way to write `db`. Nothing is trimmed: a host with surrounding whitespace is malformed.
 */
export function isAllowedPlaintextDatabaseHost(rawHost: string): boolean {
  if (typeof rawHost !== "string") return false;
  let host = rawHost.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]") && host.includes(":")) host = host.slice(1, -1);
  return PLAINTEXT_ALLOWED_HOSTS.has(host);
}

/**
 * The host the driver will actually connect to, or null when it cannot be determined with certainty. The `pg` driver lets a
 * `host=` (or libpq's `hostaddr=`) query parameter OVERRIDE the host in the URL's authority, so a URL like
 * `postgresql://u:p@db/x?host=attacker.example` names `db` here but connects to attacker.example. Such a URL is refused outright
 * (null) rather than validated by its authority alone.
 */
function databaseHost(env: NodeJS.ProcessEnv): string | null {
  const url = env.DATABASE_URL?.trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    for (const key of parsed.searchParams.keys()) {
      const name = key.toLowerCase();
      if (name === "host" || name === "hostaddr") return null;
    }
    return parsed.hostname;
  } catch {
    return null; // never echo the value — it carries credentials
  }
}

export function getDatabaseTlsMode(env: NodeJS.ProcessEnv = process.env): DatabaseTlsMode {
  if (sslModeSetting(env) === "disable") return "disabled";
  const ca = env.DATABASE_SSL_CA?.trim();
  if (ca && /-----BEGIN CERTIFICATE-----/.test(normalizePem(ca))) return "verified_ca";
  if (env.DATABASE_SSL_VERIFY?.trim().toLowerCase() === "system") return "verified_system";
  return "unverified";
}

export function resolveDatabaseSsl(env: NodeJS.ProcessEnv = process.env): DatabaseSsl {
  const requested = sslModeSetting(env);
  if (requested) {
    if (requested !== "disable") {
      throw new Error('DATABASE_SSL_MODE must be "disable" (or unset); any other value is refused so TLS settings are never guessed.');
    }
    if (env.DATABASE_SSL_CA?.trim() || env.DATABASE_SSL_VERIFY?.trim()) {
      throw new Error("DATABASE_SSL_MODE=disable conflicts with DATABASE_SSL_CA / DATABASE_SSL_VERIFY. Remove one: disable TLS only for the local Docker database, verify TLS for a remote one.");
    }
    const host = databaseHost(env);
    if (host === null || !isAllowedPlaintextDatabaseHost(host)) {
      throw new Error("DATABASE_SSL_MODE=disable is only allowed when DATABASE_URL is a valid URL whose host is exactly one of: db, localhost, 127.0.0.1, ::1 (and it sets no host= / hostaddr= parameter). Refusing to send an unencrypted connection to any other host.");
    }
    return false;
  }

  const mode = getDatabaseTlsMode(env);
  if (mode === "verified_ca") return { rejectUnauthorized: true, ca: normalizePem(env.DATABASE_SSL_CA!) };
  if (mode === "verified_system") return { rejectUnauthorized: true };
  // A DATABASE_SSL_CA that is set but is not a PEM certificate must not be silently ignored.
  if (env.DATABASE_SSL_CA?.trim()) throw new Error("DATABASE_SSL_CA is set but is not a PEM certificate (expected -----BEGIN CERTIFICATE-----)");
  return { rejectUnauthorized: false };
}
