// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";

// REAL-DATABASE proof of the CRM session lifecycle:
//   • sign-in records the latest successful sign-in (time, FULL IP, approximate location) from the trusted request path only,
//     readable by an Administrator only, never leaking through ordinary Account reads, and never touching the Admin-ASSIGNED Location;
//   • single active device — a newer sign-in atomically replaces the older session (also when sign-ins race), and the old browser
//     is told why with a fixed, non-sensitive message and a hash-only revocation record;
//   • the 24-hour lifetime is absolute (no sliding renewal), enforced by getCurrentAccount and the proxy;
//   • "Sign out all users" ends every session in the company, is audited, never leaves state that blocks a later sign-in.
// Runs only when INTEGRATION_DATABASE_URL points at a DISPOSABLE PostgreSQL with this repo's migrations applied.

const URL_UNDER_TEST = process.env.INTEGRATION_DATABASE_URL;
const enabled = !!URL_UNDER_TEST;
if (enabled) {
  process.env.DATABASE_URL = URL_UNDER_TEST;
  process.env.APP_ENV = "test";
  process.env.DATABASE_POOL_MAX = "10"; // real concurrency for the race test (the app default of 2 would mostly serialise it)
  process.env.CARD_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.IP_HASH_KEY ??= randomBytes(32).toString("base64");
}

// ---- the request seams: cookie jar + request headers ---------------------------------------------------------------------------
const jar = new Map<string, string>();
const issuedTokens: string[] = [];
let requestHeaders = new Headers();
let production = true;
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => {
      jar.set(name, value);
      issuedTokens.push(value);
    },
    delete: (name: string) => void jar.delete(name),
  })),
  headers: vi.fn(async () => requestHeaders),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${to}` });
  },
}));
vi.mock("@/lib/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/env")>()), isProductionEnvironment: () => production }));

const TAG = `ses-${Date.now()}`;
const mail = (n: string) => `${n.toLowerCase()}-${TAG}@example.test`;
const HOUR = 60 * 60 * 1000;
const COOKIE = "compass_dev_account";

const PC_HEADERS = { "x-vercel-forwarded-for": "203.0.113.9", "x-vercel-ip-city": "Frankfurt", "x-vercel-ip-country": "DE", "x-vercel-ip-country-region": "HE", "x-vercel-ip-timezone": "Europe/Berlin" };
const PHONE_HEADERS = { "x-vercel-forwarded-for": "198.51.100.44", "x-vercel-ip-city": "Toronto", "x-vercel-ip-country": "CA", "x-vercel-ip-country-region": "ON", "x-vercel-ip-timezone": "America/Toronto" };

describe.skipIf(!enabled)("session lifecycle — real PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let establishSession: typeof import("@/server/auth/establish-session").establishSession;
  let getCurrentAccount: typeof import("@/lib/dev-session").getCurrentAccount;
  let heartbeat: typeof import("../dev-session").heartbeat;
  let signOut: typeof import("../dev-session").signOut;
  let signOutAllUsers: typeof import("../session-admin").signOutAllUsers;
  let getAccountSignInDetails: typeof import("@/server/queries/accounts").getAccountSignInDetails;
  let proxy: typeof import("@/proxy").proxy;
  let hashSessionToken: typeof import("@/lib/session-token").hashSessionToken;

  const companyId = `co-${TAG}`;
  const otherCompanyId = `co2-${TAG}`;
  let adminId = "";
  let agentId = "";
  let colleagueId = "";
  let outsiderId = "";
  const accountIds: string[] = [];

  const signInAs = async (accountId: string, hdrs: Record<string, string> = PC_HEADERS) => {
    requestHeaders = new Headers(hdrs);
    jar.delete(COOKIE);
    await establishSession(accountId, requestHeaders);
    return jar.get(COOKIE)!;
  };
  // What each "browser" holds is just its own cookie value; a request is made by presenting one.
  const asBrowser = (token: string | null) => {
    if (token === null) jar.delete(COOKIE);
    else jar.set(COOKIE, token);
  };
  const row = (id: string) => prisma.account.findUniqueOrThrow({ where: { id }, select: { id: true, sessionCreatedAt: true, lastSignInAt: true, location: true, updatedAt: true } });
  const raw = async (id: string) =>
    (await prisma.$queryRaw<{ activeSessionId: string | null; sessionCreatedAt: Date | null; lastSignInAt: Date | null; lastSignInIp: string | null; lastSignInCity: string | null; lastSignInRegion: string | null; lastSignInCountry: string | null; lastSignInCountryCode: string | null; lastSignInTimeZone: string | null }[]>`
      SELECT "activeSessionId","sessionCreatedAt","lastSignInAt","lastSignInIp","lastSignInCity","lastSignInRegion","lastSignInCountry","lastSignInCountryCode","lastSignInTimeZone" FROM "Account" WHERE "id" = ${id}`)[0];
  const setSessionAge = (id: string, ageMs: number) =>
    prisma.$executeRaw`UPDATE "Account" SET "sessionCreatedAt" = ${new Date(Date.now() - ageMs)} WHERE "id" = ${id}`;
  const proxyStatus = async (token: string | null, path = "/dashboard") => {
    const req = new NextRequest(`http://localhost${path}`, { headers: token ? { cookie: `${COOKIE}=${token}` } : {} });
    const res = await proxy(req);
    return { status: res.status, location: res.headers.get("location"), passedThrough: res.headers.get("x-middleware-next") === "1" };
  };

  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "vercel";
    ({ prisma } = await import("@/lib/prisma"));
    ({ establishSession } = await import("@/server/auth/establish-session"));
    ({ getCurrentAccount } = await import("@/lib/dev-session"));
    ({ heartbeat, signOut } = await import("../dev-session"));
    ({ signOutAllUsers } = await import("../session-admin"));
    ({ getAccountSignInDetails } = await import("@/server/queries/accounts"));
    ({ proxy } = await import("@/proxy"));
    ({ hashSessionToken } = await import("@/lib/session-token"));
    for (const id of [companyId, otherCompanyId]) await prisma.company.create({ data: { id, name: `Co ${id}`, signatureTemplate: "Regards" } });
    const mk = async (n: string, role: "ADMIN" | "TRAVEL_AGENT", company = companyId) => {
      const a = await prisma.account.create({ data: { fullName: n, email: mail(n), role, status: "ACTIVE", companyId: company, location: `Assigned ${n} desk` } });
      accountIds.push(a.id);
      return a.id;
    };
    adminId = await mk("Admin", "ADMIN");
    agentId = await mk("Agent", "TRAVEL_AGENT");
    colleagueId = await mk("Colleague", "TRAVEL_AGENT");
    outsiderId = await mk("Outsider", "TRAVEL_AGENT", otherCompanyId);
  });
  beforeEach(async () => {
    production = true;
    requestHeaders = new Headers(PC_HEADERS);
    issuedTokens.length = 0;
    jar.clear();
    process.env.TRUSTED_PROXY = "vercel";
    // a clean slate for the accounts under test
    await prisma.$executeRaw`UPDATE "Account" SET "activeSessionId" = NULL, "sessionCreatedAt" = NULL, "lastSignInAt" = NULL, "lastSignInIp" = NULL, "lastSignInCity" = NULL, "lastSignInRegion" = NULL, "lastSignInCountry" = NULL, "lastSignInCountryCode" = NULL, "lastSignInTimeZone" = NULL WHERE "id" = ANY(${accountIds})`;
    await prisma.revokedSession.deleteMany({ where: { accountId: { in: accountIds } } });
  });
  afterAll(async () => {
    if (!enabled) return;
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: accountIds } }, { entityId: { in: [companyId, otherCompanyId] } }] } }).catch(() => undefined);
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.company.deleteMany({ where: { id: { in: [companyId, otherCompanyId] } } });
    await prisma.$disconnect();
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  describe("Last Sign In — what a successful sign-in records", () => {
    it("stores the time, the FULL IP and the approximate location, from the trusted proxy headers", async () => {
      const before = Date.now();
      await signInAs(agentId, PC_HEADERS);
      const r = await raw(agentId);
      expect(r.lastSignInIp).toBe("203.0.113.9");
      expect(r.lastSignInCity).toBe("Frankfurt");
      expect(r.lastSignInCountryCode).toBe("DE");
      expect(r.lastSignInCountry).toBeTruthy();
      expect(r.lastSignInTimeZone).toBe("Europe/Berlin");
      expect(r.lastSignInAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(r.lastSignInAt!.getTime()).toBe(r.sessionCreatedAt!.getTime()); // both are the moment the session was established
    });

    it("records NO IP and NO location when the request did not arrive through a trusted proxy (forged headers are ignored)", async () => {
      process.env.TRUSTED_PROXY = "none";
      await signInAs(agentId, { ...PC_HEADERS, "x-forwarded-for": "198.51.100.77" });
      const r = await raw(agentId);
      expect(r.lastSignInAt).not.toBeNull(); // the sign-in itself is still recorded
      expect([r.lastSignInIp, r.lastSignInCity, r.lastSignInRegion, r.lastSignInCountry, r.lastSignInCountryCode, r.lastSignInTimeZone]).toEqual([null, null, null, null, null, null]);
    });

    it("an IP with no geo headers is stored with no location (never fabricated); the Users query gives the neutral null", async () => {
      await signInAs(agentId, { "x-vercel-forwarded-for": "203.0.113.50" });
      const r = await raw(agentId);
      expect(r.lastSignInIp).toBe("203.0.113.50");
      expect([r.lastSignInCity, r.lastSignInRegion, r.lastSignInCountry, r.lastSignInCountryCode]).toEqual([null, null, null, null]);
      const admin = { role: "ADMIN" as const, companyId };
      expect((await getAccountSignInDetails(admin)).get(agentId)).toMatchObject({ ip: "203.0.113.50", location: null });
    });

    it("the newest sign-in REPLACES the older metadata completely (including a location that is no longer known)", async () => {
      await signInAs(agentId, PC_HEADERS);
      await signInAs(agentId, { "x-vercel-forwarded-for": "198.51.100.44" }); // new device, no geo
      const r = await raw(agentId);
      expect(r.lastSignInIp).toBe("198.51.100.44");
      expect([r.lastSignInCity, r.lastSignInRegion, r.lastSignInCountry, r.lastSignInCountryCode, r.lastSignInTimeZone]).toEqual([null, null, null, null, null]);
    });

    it("the Admin-ASSIGNED Location is a different field and is never changed by a sign-in", async () => {
      const before = await row(agentId);
      await signInAs(agentId, PHONE_HEADERS);
      await signInAs(agentId, PC_HEADERS);
      const after = await row(agentId);
      expect(after.location).toBe(before.location);
      expect(after.location).toBe("Assigned Agent desk");
      expect((await raw(agentId)).lastSignInCity).toBe("Frankfurt"); // …while the sign-in location is its own
    });

    it("activity (heartbeat, page loads, sign-out of someone else) never rewrites the last sign-in", async () => {
      await signInAs(agentId, PC_HEADERS);
      const first = await raw(agentId);
      await new Promise((r) => setTimeout(r, 30));
      requestHeaders = new Headers(PHONE_HEADERS); // activity from somewhere else
      expect((await getCurrentAccount())?.id).toBe(agentId);
      await heartbeat();
      const after = await raw(agentId);
      expect(after.lastSignInAt!.getTime()).toBe(first.lastSignInAt!.getTime());
      expect(after.lastSignInIp).toBe("203.0.113.9");
      expect(after.sessionCreatedAt!.getTime()).toBe(first.sessionCreatedAt!.getTime());
    });

    it("a failed sign-in (one that never reaches session establishment) leaves the previous record untouched", async () => {
      await signInAs(agentId, PC_HEADERS);
      const first = await raw(agentId);
      // A denied / failed attempt does not call establishSession at all (see google-auth.ts: it runs only after verification AND
      // authorization succeeded). Nothing else writes these columns:
      await prisma.account.update({ where: { id: agentId }, data: { fullName: "Agent" } }); // an unrelated write
      const after = await raw(agentId);
      expect(after.lastSignInIp).toBe(first.lastSignInIp);
      expect(after.lastSignInAt!.getTime()).toBe(first.lastSignInAt!.getTime());
      expect(after.activeSessionId).toBe(first.activeSessionId);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  describe("Administrator-only exposure of the sign-in IP and location", () => {
    it("the Users query returns the full IP and location for an Admin of that company", async () => {
      await signInAs(agentId, PC_HEADERS);
      const details = await getAccountSignInDetails({ role: "ADMIN", companyId });
      expect(details.get(agentId)).toMatchObject({ ip: "203.0.113.9", location: expect.stringContaining("Frankfurt") });
      expect(details.get(agentId)!.lastSignInAt).toBeInstanceOf(Date);
    });

    it("every other role — and a missing viewer — gets NOTHING, even if the page forgot to gate itself", async () => {
      await signInAs(agentId, PC_HEADERS);
      for (const role of ["MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"] as const) {
        expect((await getAccountSignInDetails({ role, companyId })).size, role).toBe(0);
      }
      expect((await getAccountSignInDetails(null)).size).toBe(0);
      expect((await getAccountSignInDetails(undefined)).size).toBe(0);
    });

    it("an Admin of ANOTHER company cannot read this company's sign-in data", async () => {
      await signInAs(agentId, PC_HEADERS);
      const details = await getAccountSignInDetails({ role: "ADMIN", companyId: otherCompanyId });
      expect(details.has(agentId)).toBe(false);
      expect(details.has(outsiderId)).toBe(true);
    });

    it("ordinary Account reads never carry the IP, the location or the session token (global omit)", async () => {
      await signInAs(agentId, PC_HEADERS);
      const viaFind = await prisma.account.findUniqueOrThrow({ where: { id: agentId } });
      const viaMany = await prisma.account.findMany({ where: { companyId } });
      const viaInclude = await prisma.auditLog.findMany({ where: { actorId: agentId }, include: { actor: true }, take: 1 });
      const hidden = ["activeSessionId", "lastSignInIp", "lastSignInCity", "lastSignInRegion", "lastSignInCountry", "lastSignInCountryCode", "lastSignInTimeZone"];
      for (const rowData of [viaFind, ...viaMany, ...viaInclude.map((a) => a.actor!).filter(Boolean)]) {
        for (const key of hidden) expect(rowData, key).not.toHaveProperty(key);
      }
      const text = JSON.stringify([viaFind, viaMany]);
      expect(text).not.toContain("203.0.113.9");
      expect(text).not.toContain("Frankfurt");
      // …yet the session lookup by token still works (omit shapes the RESULT, not the where clause)
      asBrowser(jar.get(COOKIE)!);
      expect((await getCurrentAccount())?.id).toBe(agentId);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  describe("single active device", () => {
    it("PC → phone → PC: only the newest session works; each older browser is refused and told why (hash-only record)", async () => {
      const pc1 = await signInAs(agentId, PC_HEADERS);
      asBrowser(pc1);
      expect((await getCurrentAccount())?.id).toBe(agentId);

      const phone = await signInAs(agentId, PHONE_HEADERS);
      asBrowser(pc1);
      expect(await getCurrentAccount(), "the PC session is replaced the moment the phone signs in").toBeNull();
      asBrowser(phone);
      expect((await getCurrentAccount())?.id).toBe(agentId);

      const pc2 = await signInAs(agentId, PC_HEADERS);
      asBrowser(phone);
      expect(await getCurrentAccount()).toBeNull();
      asBrowser(pc1);
      expect(await getCurrentAccount()).toBeNull();
      asBrowser(pc2);
      expect((await getCurrentAccount())?.id).toBe(agentId);

      // the proxy tells each superseded browser why, and clears its cookie
      for (const stale of [pc1, phone]) {
        const r = await proxyStatus(stale);
        expect(r.status).toBe(307);
        expect(r.location).toBe("http://localhost/login?reason=superseded");
      }
      const live = await proxyStatus(pc2);
      expect(live.passedThrough).toBe(true);

      const records = await prisma.revokedSession.findMany({ where: { accountId: agentId } });
      expect(records.map((r) => r.tokenHash).sort()).toEqual([hashSessionToken(pc1), hashSessionToken(phone)].sort());
      expect(records.every((r) => r.reason === "SUPERSEDED")).toBe(true);
      expect(JSON.stringify(records)).not.toContain(pc1);
      expect(JSON.stringify(records)).not.toContain(phone);
    });

    it("the superseded browser's message reveals nothing about the new device", async () => {
      const first = await signInAs(agentId, PC_HEADERS);
      await signInAs(agentId, PHONE_HEADERS);
      const { SESSION_END_MESSAGES } = await import("@/lib/session-token");
      const r = await proxyStatus(first);
      expect(r.location).not.toMatch(/198\.51\.100|Toronto|CA\b/);
      expect(SESSION_END_MESSAGES.superseded).toContain("signed in on another device");
    });

    it.each([1, 2, 3, 4, 5])("near-simultaneous sign-ins never leave two valid sessions: exactly one token works, every other is revoked (round %i)", async () => {
      const N = 8;
      const results = await Promise.all(
        Array.from({ length: N }, async (_, i) => {
          const h = new Headers({ "x-vercel-forwarded-for": `203.0.113.${100 + i}` });
          const before = issuedTokens.length;
          await establishSession(agentId, h);
          return before;
        })
      );
      void results;
      const tokens = [...new Set(issuedTokens)];
      expect(tokens).toHaveLength(N);

      const valid: string[] = [];
      for (const t of tokens) {
        asBrowser(t);
        if ((await getCurrentAccount())?.id === agentId) valid.push(t);
      }
      expect(valid, "exactly one session is valid").toHaveLength(1);

      const stored = await raw(agentId);
      expect(stored.activeSessionId).toBe(valid[0]);
      // the metadata is a coherent set from ONE of the sign-ins, not a mix
      expect(stored.lastSignInIp).toMatch(/^203\.0\.113\.10\d$/);

      const revoked = (await prisma.revokedSession.findMany({ where: { accountId: agentId } })).map((r) => r.tokenHash);
      for (const t of tokens.filter((x) => x !== valid[0])) expect(revoked, "every losing token is recorded as revoked").toContain(hashSessionToken(t));
      expect(revoked).not.toContain(hashSessionToken(valid[0]));
    });

    it("signing in on a device never disturbs ANOTHER account's session", async () => {
      const agentToken = await signInAs(agentId, PC_HEADERS);
      const colleagueToken = await signInAs(colleagueId, PHONE_HEADERS);
      asBrowser(agentToken);
      expect((await getCurrentAccount())?.id).toBe(agentId);
      asBrowser(colleagueToken);
      expect((await getCurrentAccount())?.id).toBe(colleagueId);
    });

    it("signing out ends the session without recording it as 'another device'", async () => {
      const t = await signInAs(agentId, PC_HEADERS);
      asBrowser(t);
      await expect(signOut()).rejects.toMatchObject({ digest: "NEXT_REDIRECT;/login" });
      asBrowser(t);
      expect(await getCurrentAccount()).toBeNull();
      expect(await prisma.revokedSession.count({ where: { accountId: agentId } })).toBe(0);
      const r = await proxyStatus(t);
      expect(r.location).toBe("http://localhost/login"); // plain sign-in, no misleading reason
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  describe("24-hour ABSOLUTE session lifetime", () => {
    it("valid just inside 24 hours (page access AND the proxy), rejected at 24 hours and after", async () => {
      const t = await signInAs(agentId, PC_HEADERS);
      asBrowser(t);

      await setSessionAge(agentId, 24 * HOUR - 60_000);
      expect((await getCurrentAccount())?.id).toBe(agentId);
      expect((await proxyStatus(t)).passedThrough).toBe(true);

      await setSessionAge(agentId, 24 * HOUR);
      expect(await getCurrentAccount()).toBeNull();
      const expired = await proxyStatus(t);
      expect(expired.status).toBe(307);
      expect(expired.location).toBe("http://localhost/login?reason=expired");

      await setSessionAge(agentId, 24 * HOUR + 60_000);
      expect(await getCurrentAccount()).toBeNull();
      expect((await proxyStatus(t)).location).toBe("http://localhost/login?reason=expired");
    });

    it("no sliding renewal: heartbeats, page loads and proxy passes never move the start of the window", async () => {
      const t = await signInAs(agentId, PC_HEADERS);
      asBrowser(t);
      await setSessionAge(agentId, 23 * HOUR);
      const start = (await raw(agentId)).sessionCreatedAt!.getTime();
      for (let i = 0; i < 3; i++) {
        expect((await getCurrentAccount())?.id).toBe(agentId);
        await prisma.account.update({ where: { id: agentId }, data: { lastSeenAt: new Date(Date.now() - 60_000) } }); // let the heartbeat write
        await heartbeat();
        expect((await proxyStatus(t)).passedThrough).toBe(true);
      }
      expect((await raw(agentId)).sessionCreatedAt!.getTime()).toBe(start);
    });

    it("a new sign-in starts a brand-new 24 hours, even when the old session had expired", async () => {
      const old = await signInAs(agentId, PC_HEADERS);
      await setSessionAge(agentId, 25 * HOUR);
      asBrowser(old);
      expect(await getCurrentAccount()).toBeNull();

      const fresh = await signInAs(agentId, PHONE_HEADERS);
      asBrowser(fresh);
      expect((await getCurrentAccount())?.id).toBe(agentId);
      expect(Date.now() - (await raw(agentId)).sessionCreatedAt!.getTime()).toBeLessThan(60_000);
      expect((await proxyStatus(fresh)).passedThrough).toBe(true);
    });

    it("protected routes redirect to login with no valid session at all (missing / garbage cookie)", async () => {
      expect((await proxyStatus(null)).status).toBe(307);
      expect((await proxyStatus("x".repeat(43))).location).toBe("http://localhost/login"); // plausible but unknown token: plain sign-in
      expect((await proxyStatus("not a token")).status).toBe(307);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  describe("a deactivated account has no session on ANY path", () => {
    it("even if the token is still stored, getCurrentAccount and the proxy refuse an inactive account", async () => {
      const t = await signInAs(agentId, PC_HEADERS);
      asBrowser(t);
      expect((await getCurrentAccount())?.id).toBe(agentId);
      await prisma.$executeRaw`UPDATE "Account" SET "status" = 'INACTIVE' WHERE "id" = ${agentId}`;
      try {
        expect(await getCurrentAccount()).toBeNull();
        const r = await proxyStatus(t);
        expect(r.status).toBe(307);
        expect(r.location).toBe("http://localhost/login");
      } finally {
        await prisma.$executeRaw`UPDATE "Account" SET "status" = 'ACTIVE' WHERE "id" = ${agentId}`;
      }
    });

    it("an Admin removing a user ends that user's session in the same transaction (and leaves everyone else's alone)", async () => {
      const victim = await signInAs(agentId, PHONE_HEADERS);
      const bystander = await signInAs(colleagueId, PC_HEADERS);
      const adminToken = await signInAs(adminId, PC_HEADERS);
      asBrowser(adminToken);
      const { setAccountStatus } = await import("../accounts");
      await setAccountStatus(agentId, "INACTIVE");
      try {
        const r = await raw(agentId);
        expect([r.activeSessionId, r.sessionCreatedAt]).toEqual([null, null]);
        asBrowser(victim);
        expect(await getCurrentAccount()).toBeNull();
        asBrowser(bystander);
        expect((await getCurrentAccount())?.id).toBe(colleagueId);
        asBrowser(adminToken);
        expect((await getCurrentAccount())?.id).toBe(adminId);
      } finally {
        await prisma.$executeRaw`UPDATE "Account" SET "status" = 'ACTIVE' WHERE "id" = ${agentId}`;
      }
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  describe("Sign out all users", () => {
    const adminActsAs = async (ageMs = 30_000) => {
      const t = await signInAs(adminId, PC_HEADERS);
      if (ageMs !== 0) await setSessionAge(adminId, ageMs);
      asBrowser(t);
      return t;
    };
    const run = async () => {
      try {
        return { redirected: null as string | null, result: await signOutAllUsers() };
      } catch (err) {
        const digest = (err as { digest?: string }).digest ?? "";
        if (digest.startsWith("NEXT_REDIRECT;")) return { redirected: digest.slice("NEXT_REDIRECT;".length), result: null };
        throw err;
      }
    };

    it("ends every session in the company (the Admin's own included), redirects to login, is audited with a count only", async () => {
      const agentToken = await signInAs(agentId, PHONE_HEADERS);
      const colleagueToken = await signInAs(colleagueId, PC_HEADERS);
      const outsiderToken = await signInAs(outsiderId, PC_HEADERS);
      const adminToken = await adminActsAs();

      const out = await run();
      expect(out.redirected).toBe("/login?reason=signed-out-all");

      for (const id of [adminId, agentId, colleagueId]) {
        const r = await raw(id);
        expect([r.activeSessionId, r.sessionCreatedAt], String(id)).toEqual([null, null]);
      }
      // another company is untouched
      asBrowser(outsiderToken);
      expect((await getCurrentAccount())?.id).toBe(outsiderId);

      for (const t of [agentToken, colleagueToken, adminToken]) {
        asBrowser(t);
        expect(await getCurrentAccount()).toBeNull();
        const p = await proxyStatus(t);
        expect(p.location).toBe("http://localhost/login?reason=signed-out-all");
      }

      const revoked = await prisma.revokedSession.findMany({ where: { accountId: { in: [adminId, agentId, colleagueId] } } });
      expect(revoked.map((r) => r.tokenHash).sort()).toEqual([adminToken, agentToken, colleagueToken].map(hashSessionToken).sort());
      expect(revoked.every((r) => r.reason === "SIGNED_OUT_ALL")).toBe(true);
      expect(JSON.stringify(revoked)).not.toContain(agentToken);

      const audit = await prisma.auditLog.findMany({ where: { action: "SESSIONS_SIGNED_OUT_ALL", actorId: adminId }, orderBy: { createdAt: "desc" }, take: 1 });
      expect(audit[0]).toMatchObject({ entityType: "Company", entityId: companyId });
      expect(audit[0].metadata).toEqual({ sessionsEnded: 3 });
      expect(JSON.stringify(audit)).not.toContain(adminToken);
    });

    it("leaves NO state that blocks signing in again: everyone, including the Admin, can sign in immediately and gets a full session", async () => {
      await signInAs(agentId, PHONE_HEADERS);
      await adminActsAs();
      await run();

      const agentAgain = await signInAs(agentId, PC_HEADERS);
      asBrowser(agentAgain);
      expect((await getCurrentAccount())?.id).toBe(agentId);
      expect((await proxyStatus(agentAgain)).passedThrough).toBe(true);
      const adminAgain = await signInAs(adminId, PC_HEADERS);
      asBrowser(adminAgain);
      expect((await getCurrentAccount())?.id).toBe(adminId);
      // and it stays valid across later requests — it is not a persistent "everyone is signed out" flag
      expect((await proxyStatus(adminAgain)).passedThrough).toBe(true);
      expect((await raw(agentId)).lastSignInIp).toBe("203.0.113.9");
    });

    it("is distinct from single-device replacement and from 24-hour expiry (its own reason, its own message)", async () => {
      const old = await signInAs(colleagueId, PC_HEADERS);
      await adminActsAs();
      await run();
      expect((await proxyStatus(old)).location).toContain("reason=signed-out-all");
      expect((await proxyStatus(old)).location).not.toContain("superseded");
      expect((await proxyStatus(old)).location).not.toContain("expired");
    });

    it("only an Administrator can do it: anyone else is refused with a returned message and nothing changes", async () => {
      const agentToken = await signInAs(agentId, PC_HEADERS);
      const colleagueToken = await signInAs(colleagueId, PHONE_HEADERS);
      asBrowser(agentToken);
      const r = await run();
      expect(r.redirected).toBeNull();
      expect(r.result).toEqual({ error: expect.stringMatching(/Only Administrators/) });
      asBrowser(colleagueToken);
      expect((await getCurrentAccount())?.id).toBe(colleagueId);
      asBrowser(agentToken);
      expect((await getCurrentAccount())?.id).toBe(agentId);
      expect(await prisma.auditLog.count({ where: { action: "SESSIONS_SIGNED_OUT_ALL", actorId: agentId } })).toBe(0);

      asBrowser(null); // no session at all
      expect((await run()).result).toEqual({ error: expect.stringMatching(/Only Administrators/) });
    });

    it("an Admin whose own sign-in is older than 15 minutes is asked to sign in again first; the refusal is audited and nothing changes", async () => {
      const agentToken = await signInAs(agentId, PHONE_HEADERS);
      await adminActsAs(16 * 60 * 1000);
      const r = await run();
      expect(r.redirected).toBeNull();
      expect(r.result).toEqual({ error: expect.stringMatching(/sign-in within the last 15 minutes/) });
      asBrowser(agentToken);
      expect((await getCurrentAccount())?.id).toBe(agentId);
      const denied = await prisma.auditLog.findMany({ where: { action: "SESSIONS_SIGN_OUT_ALL_DENIED", actorId: adminId } });
      expect(denied.length).toBeGreaterThan(0);
      expect(denied[0].metadata).toMatchObject({ reason: "RECENT_LOGIN_REQUIRED" });
    });

    it("with no one else signed in it still works (zero other sessions) and reports its own", async () => {
      await adminActsAs();
      const out = await run();
      expect(out.redirected).toBe("/login?reason=signed-out-all");
      const audit = await prisma.auditLog.findFirst({ where: { action: "SESSIONS_SIGNED_OUT_ALL", actorId: adminId }, orderBy: { createdAt: "desc" } });
      expect(audit!.metadata).toEqual({ sessionsEnded: 1 });
    });
  });
});
