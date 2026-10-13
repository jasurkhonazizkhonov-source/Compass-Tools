import { describe, it, expect } from "vitest";
import { getDatabaseTlsMode, isAllowedPlaintextDatabaseHost, resolveDatabaseSsl } from "../db-tls";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
const PEM = "-----BEGIN CERTIFICATE-----\nMIIBFAKEFORTESTONLY\n-----END CERTIFICATE-----";
const DOCKER_URL = "postgresql://compass:secret@db:5432/compass";
const REMOTE_URL = "postgresql://avnadmin:secret@pg-example-project.aivencloud.com:12345/defaultdb?sslmode=require";
const disable = (databaseUrl: string | undefined, extra: Record<string, string> = {}) =>
  env({ DATABASE_SSL_MODE: "disable", ...(databaseUrl === undefined ? {} : { DATABASE_URL: databaseUrl }), ...extra });
const errorOf = (e: NodeJS.ProcessEnv): string => {
  try {
    resolveDatabaseSsl(e);
  } catch (err) {
    return (err as Error).message;
  }
  return "";
};

describe("database TLS mode", () => {
  it("defaults to encrypted-but-unverified (the historical behaviour) and says so", () => {
    expect(getDatabaseTlsMode(env({}))).toBe("unverified");
    expect(resolveDatabaseSsl(env({}))).toEqual({ rejectUnauthorized: false });
  });

  it("verifies the server certificate and host name against DATABASE_SSL_CA", () => {
    expect(getDatabaseTlsMode(env({ DATABASE_SSL_CA: PEM }))).toBe("verified_ca");
    expect(resolveDatabaseSsl(env({ DATABASE_SSL_CA: PEM }))).toEqual({ rejectUnauthorized: true, ca: PEM });
  });

  it("accepts the PEM with literal \\n sequences (how it is usually pasted into an env var)", () => {
    const escaped = PEM.replace(/\n/g, "\\n");
    expect(resolveDatabaseSsl(env({ DATABASE_SSL_CA: escaped }))).toEqual({ rejectUnauthorized: true, ca: PEM });
  });

  it("DATABASE_SSL_VERIFY=system verifies against Node's trust store", () => {
    expect(resolveDatabaseSsl(env({ DATABASE_SSL_VERIFY: "system" }))).toEqual({ rejectUnauthorized: true });
    expect(getDatabaseTlsMode(env({ DATABASE_SSL_VERIFY: " System " }))).toBe("verified_system");
    expect(getDatabaseTlsMode(env({ DATABASE_SSL_VERIFY: "true" }))).toBe("unverified");
  });

  it("a DATABASE_SSL_CA that is not a PEM certificate is refused loudly, never silently ignored (which would leave verification off)", () => {
    expect(() => resolveDatabaseSsl(env({ DATABASE_SSL_CA: "not a certificate" }))).toThrow(/not a PEM certificate/);
  });

  it("never echoes the certificate or connection string in the mode", () => {
    expect(JSON.stringify(getDatabaseTlsMode(env({ DATABASE_SSL_CA: PEM })))).not.toContain("MIIB");
  });
});

describe("verified modes are unaffected by the allow-list (it only governs DATABASE_SSL_MODE=disable)", () => {
  it("a verified CA or system trust works for any host, public or not, and never consults the host allow-list", () => {
    for (const url of [REMOTE_URL, DOCKER_URL, "postgresql://u:p@203.0.113.9:5432/db", "postgresql://u:p@10.0.0.5:5432/db", undefined]) {
      const base: Record<string, string> = url === undefined ? {} : { DATABASE_URL: url };
      expect(resolveDatabaseSsl(env({ ...base, DATABASE_SSL_CA: PEM })), String(url)).toEqual({ rejectUnauthorized: true, ca: PEM });
      expect(resolveDatabaseSsl(env({ ...base, DATABASE_SSL_VERIFY: "system" })), String(url)).toEqual({ rejectUnauthorized: true });
      expect(resolveDatabaseSsl(env(base)), String(url)).toEqual({ rejectUnauthorized: false });
    }
  });

  it("an empty or whitespace DATABASE_SSL_MODE is the same as unset (Compose passes unset optional variables as empty)", () => {
    expect(resolveDatabaseSsl(env({ DATABASE_SSL_MODE: "", DATABASE_URL: REMOTE_URL }))).toEqual({ rejectUnauthorized: false });
    expect(resolveDatabaseSsl(env({ DATABASE_SSL_MODE: "  ", DATABASE_URL: REMOTE_URL, DATABASE_SSL_CA: PEM }))).toEqual({ rejectUnauthorized: true, ca: PEM });
    expect(getDatabaseTlsMode(env({ DATABASE_SSL_MODE: "  " }))).toBe("unverified");
  });

  it("is never the default: without the explicit setting even the allow-listed host still gets TLS", () => {
    expect(resolveDatabaseSsl(env({ DATABASE_URL: DOCKER_URL }))).toEqual({ rejectUnauthorized: false });
  });

  it("the URL's own sslmode parameter does not change anything (the app strips it and decides from DATABASE_SSL_MODE alone)", () => {
    expect(resolveDatabaseSsl(env({ DATABASE_URL: `${DOCKER_URL}?sslmode=disable` }))).toEqual({ rejectUnauthorized: false });
  });
});

describe("DATABASE_SSL_MODE=disable: accepted only for the exact allow-listed hosts", () => {
  it("turns TLS off for the compose service `db`, and reports the mode as disabled", () => {
    const e = disable(DOCKER_URL);
    expect(resolveDatabaseSsl(e)).toBe(false);
    expect(getDatabaseTlsMode(e)).toBe("disabled");
  });

  it("is case-insensitive for the host (DB is db) and for the one accepted mode value", () => {
    expect(resolveDatabaseSsl(disable("postgresql://compass:secret@DB:5432/compass"))).toBe(false);
    expect(resolveDatabaseSsl(disable("postgresql://compass:secret@Db/compass"))).toBe(false);
    expect(resolveDatabaseSsl(env({ DATABASE_SSL_MODE: " Disable ", DATABASE_URL: DOCKER_URL }))).toBe(false);
  });

  it("accepts the deliberately retained loopback hosts (a developer's own non-TLS PostgreSQL)", () => {
    for (const host of ["localhost", "LOCALHOST", "127.0.0.1", "[::1]"]) {
      expect(resolveDatabaseSsl(disable(`postgresql://u:p@${host}:5432/db`)), host).toBe(false);
    }
  });

  it("recognises the loopback IPv6 address however the URL spells it (the URL parser normalises it to [::1])", () => {
    for (const host of ["[::1]", "[0:0:0:0:0:0:0:1]", "[0000:0000:0000:0000:0000:0000:0000:0001]", "[::0001]"]) {
      expect(resolveDatabaseSsl(disable(`postgresql://u:p@${host}:5432/db`)), host).toBe(false);
    }
  });

  it("refuses an IPv6 address that merely resembles loopback", () => {
    for (const host of ["[::2]", "[::]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[fe80::1]", "[fd12:3456:789a::1]", "[2001:db8::1]", "[2606:4700:4700::1111]"]) {
      expect(() => resolveDatabaseSsl(disable(`postgresql://u:p@${host}:5432/db`)), host).toThrow(/exactly one of/);
    }
  });

  it("refuses single-label names other than `db`, including the common `postgres`", () => {
    for (const host of ["postgres", "postgresql", "database", "pg", "mydb", "dbserver", "db1", "db-1"]) {
      expect(() => resolveDatabaseSsl(disable(`postgresql://u:p@${host}:5432/db`)), host).toThrow(/exactly one of/);
    }
  });

  it("refuses `.internal` names and host.docker.internal (the Docker HOST is a different trust boundary)", () => {
    for (const host of ["host.docker.internal", "anything.internal", "db.internal", "pg.prod.internal", "gateway.docker.internal"]) {
      expect(() => resolveDatabaseSsl(disable(`postgresql://u:p@${host}:5432/db`)), host).toThrow(/exactly one of/);
    }
  });

  it("refuses names that only look like the allowed ones", () => {
    for (const host of ["db.", "db.example.com", "db.localhost", "localhost.", "localhost.example.com", "mylocalhost", "xdb", "db_", "localhost6", "ip6-localhost"]) {
      expect(() => resolveDatabaseSsl(disable(`postgresql://u:p@${host}:5432/db`)), host).toThrow(/exactly one of/);
    }
  });

  it("refuses public hostnames and a managed PostgreSQL host", () => {
    for (const url of [REMOTE_URL, "postgresql://u:p@example.com:5432/db", "postgresql://u:p@pg.neon.tech/db", "postgresql://u:p@mydb.abc123.us-east-1.rds.amazonaws.com:5432/db"]) {
      expect(() => resolveDatabaseSsl(disable(url)), url).toThrow(/exactly one of/);
    }
  });

  it("refuses public IPv4 addresses, and private-range ones (any LAN or VPC machine is not the database container)", () => {
    for (const host of ["203.0.113.9", "8.8.8.8", "1.1.1.1", "10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.20", "169.254.169.254", "127.0.0.2", "127.8.9.10", "0.0.0.0"]) {
      expect(() => resolveDatabaseSsl(disable(`postgresql://u:p@${host}:5432/db`)), host).toThrow(/exactly one of/);
    }
  });

  it("refuses malformed or non-canonical IPv4 forms (even ones an OS resolver would read as loopback)", () => {
    for (const host of ["127.0.0", "127.0.0.1.1", "127.1", "0x7f.0.0.1", "0177.0.0.1", "2130706433", "999.1.1.1", "256.0.0.1", "1.2.3", "127.0.0.01"]) {
      expect(() => resolveDatabaseSsl(disable(`postgresql://u:p@${host}:5432/db`)), host).toThrow(/exactly one of/);
    }
  });

  it("refuses a host that the URL itself marks as userinfo, a list of hosts, or an encoded name", () => {
    for (const url of [
      "postgresql://db:5432@example.com/db", // `db:5432` is the user name and password; the host is example.com
      "postgresql://u:p@db@example.com/db",
      "postgresql://u:p@db,example.com/db", // multi-host form
      "postgresql://u:p@db,db/db",
      "postgresql://u:p@%64%62/db", // percent-encoded `db`: not the literal allow-listed name
      "postgresql://u:p@db%2Eexample.com/db",
    ]) {
      expect(() => resolveDatabaseSsl(disable(url)), url).toThrow(/exactly one of/);
    }
  });

  it("refuses a URL whose host= or hostaddr= parameter would make the driver connect somewhere other than the validated host", () => {
    // `pg` lets these parameters override the host in the URL, so `db` here would be a lie.
    for (const url of [
      `${DOCKER_URL}?host=attacker.example`,
      `${DOCKER_URL}?hostaddr=203.0.113.9`,
      `${DOCKER_URL}?HOST=attacker.example`,
      `${DOCKER_URL}?sslmode=disable&host=127.0.0.1`,
      "postgresql://u:p@localhost/db?host=db",
      "postgresql://u:p@/db?host=db",
    ]) {
      expect(() => resolveDatabaseSsl(disable(url)), url).toThrow(/exactly one of/);
    }
  });

  it("refuses an empty, missing or malformed DATABASE_URL (the host cannot be checked)", () => {
    for (const url of [undefined, "", "   ", "db", "db:5432", "//db/compass", "/var/run/postgresql", "not a url", "postgresql://", "postgresql:///compass", "postgresql://:5432/db", "postgresql://u:p@:5432/db"]) {
      expect(() => resolveDatabaseSsl(disable(url)), String(url)).toThrow(/exactly one of/);
    }
  });

  it("a configuration error never reveals the credentials, the database host or the connection URL", () => {
    const sensitive = [
      "postgresql://leaky-user:leaky-pass-123@pg-leaky-host.aivencloud.com:12345/leaky_db?sslmode=require",
      "postgresql://leaky-user:leaky-pass-123@db:5432/leaky_db?host=leaky-host.example",
      "not a url with leaky-pass-123",
    ];
    for (const url of sensitive) {
      const message = errorOf(disable(url));
      expect(message, url).not.toBe("");
      for (const secret of ["leaky-user", "leaky-pass-123", "leaky-host", "leaky_db", "aivencloud", url]) expect(message, url).not.toContain(secret);
    }
    // the same holds for the mode and conflict errors
    expect(errorOf(env({ DATABASE_SSL_MODE: "require", DATABASE_URL: sensitive[0] }))).not.toContain("leaky");
    expect(errorOf(disable(sensitive[1], { DATABASE_SSL_CA: PEM }))).not.toMatch(/leaky|MIIB/);
  });

  it("names the permitted hosts in the error so the fix is obvious", () => {
    expect(errorOf(disable(REMOTE_URL))).toMatch(/db, localhost, 127\.0\.0\.1, ::1/);
  });
});

describe("DATABASE_SSL_MODE=disable cannot be combined with verification, and other values are refused", () => {
  it("refuses a contradictory configuration instead of picking a side, even for an allow-listed host", () => {
    expect(() => resolveDatabaseSsl(disable(DOCKER_URL, { DATABASE_SSL_CA: PEM }))).toThrow(/conflicts/);
    expect(() => resolveDatabaseSsl(disable(DOCKER_URL, { DATABASE_SSL_VERIFY: "system" }))).toThrow(/conflicts/);
    expect(() => resolveDatabaseSsl(disable(DOCKER_URL, { DATABASE_SSL_VERIFY: "true" }))).toThrow(/conflicts/);
    expect(() => resolveDatabaseSsl(disable(DOCKER_URL, { DATABASE_SSL_CA: "not a certificate" }))).toThrow(/conflicts/);
  });

  it("the conflict is reported before the host is examined, and a conflicting remote configuration is still an error (never silently TLS-off)", () => {
    expect(() => resolveDatabaseSsl(disable(REMOTE_URL, { DATABASE_SSL_CA: PEM }))).toThrow(/conflicts/);
  });

  it("refuses every other value (a typo must never silently weaken or change TLS)", () => {
    for (const bad of ["off", "false", "0", "no", "require", "verify-full", "disabled", "true", "allow", "prefer"]) {
      expect(() => resolveDatabaseSsl(env({ DATABASE_SSL_MODE: bad, DATABASE_URL: DOCKER_URL })), bad).toThrow(/must be "disable"/);
    }
  });
});

describe("isAllowedPlaintextDatabaseHost: the exact allow-list", () => {
  it.each(["db", "DB", "Db", "dB", "localhost", "LocalHost", "127.0.0.1", "::1", "[::1]"])("%s is allowed", (host) => {
    expect(isAllowedPlaintextDatabaseHost(host)).toBe(true);
  });

  it.each([
    "postgres",
    "host.docker.internal",
    "anything.internal",
    "db.internal",
    "example.com",
    "pg-x.aivencloud.com",
    "db.example.com",
    "db.localhost",
    "8.8.8.8",
    "203.0.113.9",
    "10.0.0.5",
    "172.16.0.1",
    "192.168.1.20",
    "127.0.0.2",
    "2001:db8::1",
    "2606:4700:4700::1111",
    "fe80::1",
    "fd12:3456:789a::1",
    "::2",
    "::",
    "::1%lo",
    "[::1",
    "::1]",
    "[[::1]]",
    "[db]",
    "[localhost]",
    "[127.0.0.1]",
    " db",
    "db ",
    "\tdb",
    "db\n",
    "db.",
    "d b",
    "db:5432",
    "db/",
    "db\u0000",
    "",
    "[]",
    "[:]",
    "127.0.0",
    "127.0.0.1.1",
    "127.1",
    "999.1.1.1",
  ])("%j is rejected", (host) => {
    expect(isAllowedPlaintextDatabaseHost(host)).toBe(false);
  });

  it("rejects non-string input rather than throwing", () => {
    expect(isAllowedPlaintextDatabaseHost(undefined as unknown as string)).toBe(false);
    expect(isAllowedPlaintextDatabaseHost(null as unknown as string)).toBe(false);
    expect(isAllowedPlaintextDatabaseHost(5432 as unknown as string)).toBe(false);
  });
});
