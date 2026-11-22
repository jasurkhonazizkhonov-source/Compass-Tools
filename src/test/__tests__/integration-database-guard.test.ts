import { describe, it, expect, vi } from "vitest";
import {
  describeNonLoopbackAddress,
  verifyConfiguredTargets,
  verifyConnectedTarget,
  type VerifyClient,
  type VerifyClientFactory,
} from "../integration-database-guard";

// The LIVE half of the database safety gate (the static half is disposable-database.test.ts). A fake connection stands in for the driver, so every outcome
// below is decided WITHOUT a database. These tests prove the gate's DECISIONS; they do not prove network isolation - that comes from how CI starts its
// database (a loopback-only listener, asserted by a workflow step and pinned by ci-database-isolation.test.ts) and cannot be shown by a unit test.

const URL_OK = "postgresql://tester:s3cret-pw@127.0.0.1:5432/compass_test?sslmode=require";
const ADMIN_OK = "postgresql://tester:s3cret-pw@127.0.0.1:5432/postgres?sslmode=require";

type Behaviour = { rows?: Array<{ db: string; addr: string | null }>; connectError?: Error; queryError?: Error };
function fakeFactory(behaviour: Behaviour): { factory: VerifyClientFactory; created: Array<Parameters<VerifyClientFactory>[0]>; ended: () => number } {
  const created: Array<Parameters<VerifyClientFactory>[0]> = [];
  let ended = 0;
  const factory: VerifyClientFactory = (config) => {
    created.push(config);
    const client: VerifyClient = {
      connect: async () => {
        if (behaviour.connectError) throw behaviour.connectError;
      },
      query: async () => {
        if (behaviour.queryError) throw behaviour.queryError;
        return { rows: behaviour.rows ?? [] };
      },
      end: async () => {
        ended++;
      },
    };
    return client;
  };
  return { factory, created, ended: () => ended };
}
const answer = (addr: string | null, db = "compass_test") => ({ rows: [{ db, addr }] });
/** A server that is exactly what the URL asks for: it answers with the database named in the connection string, from the given address. */
function honestServer(addr: string | null): { factory: VerifyClientFactory; created: Array<Parameters<VerifyClientFactory>[0]> } {
  const created: Array<Parameters<VerifyClientFactory>[0]> = [];
  const factory: VerifyClientFactory = (config) => {
    created.push(config);
    const database = new URL(config.connectionString).pathname.slice(1);
    return { connect: async () => undefined, query: async () => ({ rows: [{ db: database, addr }] }), end: async () => undefined };
  };
  return { factory, created };
}
const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a refusal, but the guard accepted");
};

describe("the server's own answer: loopback is accepted", () => {
  it.each([
    ["IPv4 loopback with a prefix length (how inet_server_addr()::text prints it)", "127.0.0.1/32"],
    ["IPv4 loopback without a prefix", "127.0.0.1"],
    ["IPv6 loopback", "::1/128"],
    ["IPv6 loopback without a prefix", "::1"],
    ["a local Unix-socket connection (the server reports no address)", null],
  ])("%s", async (_label, addr) => {
    const { factory, ended } = fakeFactory(answer(addr));
    await expect(verifyConnectedTarget(URL_OK, "compass_test", factory)).resolves.toBeUndefined();
    expect(ended()).toBe(1); // the one verification connection is always closed
  });
});

describe("the server's own answer: everything that is not loopback is refused, and the address itself is never printed", () => {
  it.each([
    ["a Docker bridge address (a container reached through a published port - the CI failure)", "172.17.0.2/32", "private IPv4"],
    ["a Docker user-defined network", "172.20.0.5/32", "private IPv4"],
    ["10.0.0.0/8", "10.1.2.3/32", "private IPv4"],
    ["192.168.0.0/16", "192.168.0.5/32", "private IPv4"],
    ["a public IPv4 address (an SSH tunnel to a remote server, a managed database)", "203.0.113.9/32", "public IPv4"],
    ["a link-local IPv4 address", "169.254.10.10/32", "link-local"],
    ["a CGNAT address", "100.64.1.2/32", "CGNAT"],
    ["the rest of 127/8 (only 127.0.0.1 is accepted)", "127.0.0.2/32", "loopback-range"],
    ["an IPv6 unique-local address", "fd00::5/128", "unique-local"],
    ["an IPv6 link-local address", "fe80::1/128", "link-local"],
    ["an IPv4-mapped IPv6 loopback (not accepted: ambiguous between parsers)", "::ffff:127.0.0.1/128", "IPv4-mapped"],
    ["a public IPv6 address", "2001:db8::10/128", "IPv6 address other than"],
    ["a name instead of an address", "localhost", "not a recognisable IP"],
    ["an empty string", "", "not a recognisable IP"],
  ])("%s", async (_label, addr, kind) => {
    const { factory, ended } = fakeFactory(answer(addr));
    const message = await refusal(verifyConnectedTarget(URL_OK, "compass_test", factory));
    expect(message).toMatch(/^Database tests refused: the server answered from a non-loopback address/);
    expect(message).toContain(kind);
    expect(message.endsWith("Nothing was run.")).toBe(true);
    if (addr) expect(message).not.toContain(addr.replace(/\/\d+$/, "")); // the address is not echoed, only its kind
    expect(ended()).toBe(1);
  });

  it("describeNonLoopbackAddress distinguishes the kinds and is total", () => {
    expect(describeNonLoopbackAddress("172.16.0.1/32")).toContain("private");
    expect(describeNonLoopbackAddress("172.15.0.1/32")).toContain("public"); // just outside 172.16.0.0/12
    expect(describeNonLoopbackAddress("172.32.0.1/32")).toContain("public"); // just outside
    expect(describeNonLoopbackAddress("8.8.8.8")).toContain("public");
    expect(describeNonLoopbackAddress("garbage")).toContain("not a recognisable");
  });
});

describe("the database the server answered with", () => {
  it.each(["postgres", "production", "compass_tools", "Compass_Test", "compass_test2", "compass_test ", ""])("%j on a loopback address is refused", async (db) => {
    const { factory } = fakeFactory(answer("127.0.0.1/32", db));
    expect(await refusal(verifyConnectedTarget(URL_OK, "compass_test", factory))).toContain("the connected database is not compass_test");
  });
  it("the admin check expects exactly the maintenance database", async () => {
    const ok = fakeFactory(answer("127.0.0.1/32", "postgres"));
    await expect(verifyConnectedTarget(ADMIN_OK, "postgres", ok.factory)).resolves.toBeUndefined();
    const wrong = fakeFactory(answer("127.0.0.1/32", "compass_test"));
    expect(await refusal(verifyConnectedTarget(ADMIN_OK, "postgres", wrong.factory))).toContain("the connected database is not postgres");
  });
});

describe("a missing, malformed or surprising answer fails closed", () => {
  it.each([
    ["no row at all", { rows: [] }],
    ["a row without a database", { rows: [{ db: undefined as unknown as string, addr: "127.0.0.1/32" }] }],
    ["an unreachable server", { connectError: new Error("connect ECONNREFUSED 10.9.8.7:5432 for user tester password s3cret-pw") }],
    ["a query error", { queryError: new Error("permission denied for relation pg_catalog host=10.9.8.7") }],
  ])("%s", async (_label, behaviour) => {
    const { factory, ended } = fakeFactory(behaviour as Behaviour);
    const message = await refusal(verifyConnectedTarget(URL_OK, "compass_test", factory));
    expect(message).toMatch(/^Database tests refused: /);
    for (const secret of ["10.9.8.7", "s3cret-pw", "tester", "127.0.0.1", "ECONNREFUSED", "pg_catalog"]) expect(message).not.toContain(secret); // nothing from the driver's message is repeated
    expect(ended()).toBe(1);
  });
});

describe("how the verification connection is made", () => {
  it("the connection string handed to the driver carries no sslmode (TLS is requested explicitly), a short timeout, and the same host and port as configured", async () => {
    const { factory, created } = fakeFactory(answer("127.0.0.1/32"));
    await verifyConnectedTarget(URL_OK, "compass_test", factory);
    expect(created).toHaveLength(1);
    expect(created[0].connectionString).not.toContain("sslmode");
    expect(new URL(created[0].connectionString).host).toBe("127.0.0.1:5432");
    expect(created[0].ssl).toEqual({ rejectUnauthorized: false }); // the identity of the target is established by the checks above, not by the self-signed certificate
    expect(created[0].connectionTimeoutMillis).toBeLessThanOrEqual(10_000);
  });
});

describe("the whole decision for one environment (verifyConfiguredTargets)", () => {
  const env = (extra: Record<string, string | undefined> = {}) => ({ INTEGRATION_DATABASE_URL: URL_OK, INTEGRATION_ADMIN_DATABASE_URL: ADMIN_OK, ...extra });

  it("nothing configured: nothing is checked and no connection is made (the database-backed files skip themselves)", async () => {
    const { factory, created } = fakeFactory(answer("172.17.0.2/32"));
    await verifyConfiguredTargets({}, factory);
    await verifyConfiguredTargets({ INTEGRATION_DATABASE_URL: "   " }, factory);
    expect(created).toHaveLength(0);
  });

  it("the intended CI configuration (loopback literal, loopback answer) is accepted for both the test database and the admin database", async () => {
    const { factory, created } = honestServer("127.0.0.1/32");
    await verifyConfiguredTargets(env(), factory);
    expect(created.map((c) => new URL(c.connectionString).pathname.slice(1))).toEqual(["compass_test", "postgres"]);
  });

  it("the CI failure, reproduced: a loopback URL whose server answers from a container address is refused before any test file is loaded", async () => {
    const { factory } = fakeFactory(answer("172.17.0.2/32"));
    expect(await refusal(verifyConfiguredTargets(env(), factory))).toContain("non-loopback address");
  });

  it.each([
    ["a host NAME that resolves to loopback (no lookup is ever made: the literal is what counts)", "postgresql://u:p@localhost:5432/compass_test?sslmode=require"],
    ["a public-DNS name that happens to resolve to 127.0.0.1", "postgresql://u:p@localtest.me:5432/compass_test?sslmode=require"],
    ["an external managed database", "postgresql://u:p@db-prod.example.com:5432/compass_test?sslmode=require"],
    ["a private network address", "postgresql://u:p@10.0.0.5:5432/compass_test?sslmode=require"],
    ["a Docker service name", "postgresql://u:p@db:5432/compass_test?sslmode=require"],
    ["the Docker bridge gateway", "postgresql://u:p@172.17.0.1:5432/compass_test?sslmode=require"],
    ["a decimal / hex / octal spelling of loopback", "postgresql://u:p@2130706433:5432/compass_test?sslmode=require"],
    ["a second host smuggled in through host=", "postgresql://u:p@127.0.0.1:5432/compass_test?sslmode=require&host=db-prod.example.com"],
    ["a hostaddr override", "postgresql://u:p@127.0.0.1:5432/compass_test?hostaddr=203.0.113.9"],
    ["an extra @ that makes the host ambiguous", "postgresql://u:p@evil.example.com@127.0.0.1:5432/compass_test?sslmode=require"],
    ["a database that is not on the approved list", "postgresql://u:p@127.0.0.1:5432/production?sslmode=require"],
    ["a look-alike database name", "postgresql://u:p@127.0.0.1:5432/compass_test_prod?sslmode=require"],
    ["no explicit port", "postgresql://u:p@127.0.0.1/compass_test?sslmode=require"],
    ["no explicit user", "postgresql://127.0.0.1:5432/compass_test?sslmode=require"],
    ["sslmode=disable", "postgresql://u:p@127.0.0.1:5432/compass_test?sslmode=disable"],
    ["not a URL at all", "not-a-url"],
    ["whitespace inside", "postgresql://u:p@127.0.0.1:5432/compass_test ?sslmode=require"],
  ])("static refusal, with no connection attempted: %s", async (_label, url) => {
    const { factory, created } = fakeFactory(answer("127.0.0.1/32"));
    const message = await refusal(verifyConfiguredTargets({ INTEGRATION_DATABASE_URL: url }, factory));
    expect(message).toMatch(/INTEGRATION_DATABASE_URL refused: /);
    expect(created).toHaveLength(0); // refused before a client exists
    for (const leak of ["db-prod.example.com", "203.0.113.9", "10.0.0.5", "localtest.me"]) expect(message).not.toContain(leak);
  });

  it("the admin URL can never stand alone, can only be the maintenance database, and must be the same host and port as the test database", async () => {
    const { factory, created } = fakeFactory(answer("127.0.0.1/32", "postgres"));
    expect(await refusal(verifyConfiguredTargets({ INTEGRATION_ADMIN_DATABASE_URL: ADMIN_OK }, factory))).toContain("INTEGRATION_DATABASE_URL must also be configured");
    expect(await refusal(verifyConfiguredTargets(env({ INTEGRATION_ADMIN_DATABASE_URL: "postgresql://tester:p@127.0.0.1:5432/compass_test?sslmode=require" }), factory))).toContain("exactly postgres");
    expect(await refusal(verifyConfiguredTargets(env({ INTEGRATION_ADMIN_DATABASE_URL: "postgresql://tester:p@127.0.0.1:5433/postgres?sslmode=require" }), factory))).toContain("same host and port");
    expect(await refusal(verifyConfiguredTargets(env({ INTEGRATION_ADMIN_DATABASE_URL: "postgresql://tester:p@[::1]:5432/postgres?sslmode=require" }), factory))).toContain("same host and port");
    expect(created).toHaveLength(0);
  });

  it("DATABASE_URL, .env values and PG* variables are never read: a production-looking DATABASE_URL changes nothing", async () => {
    const { factory, created } = honestServer("127.0.0.1/32");
    await verifyConfiguredTargets({ DATABASE_URL: "postgresql://u:p@prod-db.example.com:5432/app", PGHOST: "prod-db.example.com", PGDATABASE: "app" }, factory);
    expect(created).toHaveLength(0);
    const spy = vi.fn(factory);
    await verifyConfiguredTargets(env({ DATABASE_URL: "postgresql://u:p@prod-db.example.com:5432/app", PGHOST: "prod-db.example.com" }), spy);
    for (const call of spy.mock.calls) expect(call[0].connectionString).not.toContain("prod-db.example.com");
  });
});
