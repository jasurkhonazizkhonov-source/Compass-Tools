import { describe, it, expect } from "vitest";
import { getDatabaseTlsMode, resolveDatabaseSsl } from "../db-tls";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
const PEM = "-----BEGIN CERTIFICATE-----\nMIIBFAKEFORTESTONLY\n-----END CERTIFICATE-----";

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
