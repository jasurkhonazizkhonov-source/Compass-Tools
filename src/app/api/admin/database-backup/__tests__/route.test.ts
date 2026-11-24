// @vitest-environment node
import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// The per-account rate limiter reads and writes a PostgreSQL counter; these tests are not about it (see server/security/__tests__/rate-limit-coverage.test.ts), so it always allows here.
vi.mock("@/server/security/rate-limit", () => ({ checkAccountRateLimit: vi.fn(async () => ({ allowed: true })), describeWait: (s: number) => `${s} seconds`, RATE_LIMITS: new Proxy({}, { get: () => ({ windowMs: 1000, maxAttempts: 1 }) }) }));

import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

// The download route, with the real staging code and real files: authorisation FIRST, an exact id, a streamed body, the right headers, an audit row, and removal after a complete read.
const getCurrentAccount = vi.fn();
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: () => getCurrentAccount() }));
const auditCreate = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { auditLog: { create: (...a: unknown[]) => auditCreate(...a) } } }));

const root = mkdtempSync(path.join(tmpdir(), "backup-route-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ID = "compass-20261124T101530Z-3fa9c2d1";
const SHA = "c".repeat(64);
let dir: string;
let body: Buffer;

const account = (role: string, sessionCreatedAt: Date | null = new Date(), status = "ACTIVE") => ({ id: "acct-1", role, status, companyId: "c1", sessionCreatedAt });
const call = async (id: string) => {
  const { GET } = await import("../[id]/route");
  return GET(new Request(`https://crm.example.test/api/admin/database-backup/${encodeURIComponent(id)}`), { params: Promise.resolve({ id }) });
};
const stage = (id = ID, createdAt = new Date()) => {
  body = randomBytes(300_000);
  writeFileSync(path.join(dir, `${id}.dump`), body);
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, fileName: `${id}.dump`, sizeBytes: body.length, createdAt: createdAt.toISOString(), sha256: SHA, format: "PostgreSQL custom format", pgDumpVersion: "17.11", serverVersion: "17.11" }));
};
const waitFor = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
};

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(path.join(root, "stage-"));
  vi.stubEnv("BACKUP_STAGING_DIR", dir);
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("APP_ENV", "");
  getCurrentAccount.mockResolvedValue(account("ADMIN"));
  auditCreate.mockResolvedValue({});
  stage();
});
afterEach(() => vi.unstubAllEnvs());

describe("authorisation comes first, and is the same whatever the id", () => {
  it("no session: 401 and nothing about the file", async () => {
    getCurrentAccount.mockResolvedValue(null);
    const res = await call(ID);
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).not.toMatch(/compass-2026|\.dump/);
  });

  it("an inactive account: 401", async () => {
    getCurrentAccount.mockResolvedValue(account("ADMIN", new Date(), "INACTIVE"));
    expect((await call(ID)).status).toBe(401);
  });

  it.each(["MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"])("a %s: 403, identical for an id that exists and one that does not, and no audit row", async (role) => {
    getCurrentAccount.mockResolvedValue(account(role));
    const real = await call(ID);
    const fake = await call("compass-20990101T000000Z-deadbeef");
    expect([real.status, fake.status]).toEqual([403, 403]);
    expect(await real.text()).toBe(await fake.text());
    expect(auditCreate).not.toHaveBeenCalled();
    expect(existsSync(path.join(dir, `${ID}.dump`))).toBe(true);
  });

  it("an Admin whose sign-in is older than the step-up window: 403", async () => {
    getCurrentAccount.mockResolvedValue(account("ADMIN", new Date(Date.now() - 3 * 60 * 60_000)));
    const res = await call(ID);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/recent sign-in/);
    expect(auditCreate).not.toHaveBeenCalled();
  });
});

describe("the id", () => {
  it.each(["../../../etc/passwd", "..\\..\\windows\\win.ini", `${ID}.dump`, `${ID}/../${ID}`, "compass-20261124T101530Z-ffffffff", "", "x".repeat(500), "%2e%2e%2f"])("%j is a 404, never a file read", async (id) => {
    const res = await call(id);
    expect(res.status).toBe(404);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("an expired backup is a 404", async () => {
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(path.join(root, "stage-"));
    vi.stubEnv("BACKUP_STAGING_DIR", dir);
    stage(ID, new Date(Date.now() - 3 * 60 * 60_000));
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    utimesSync(path.join(dir, `${ID}.dump`), old, old);
    expect((await call(ID)).status).toBe(404);
  });
});

describe("the download", () => {
  it("an Admin gets the exact bytes as an attachment with the right headers, and the download is audited without a path or data", async () => {
    const res = await call(ID);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${ID}.dump"`);
    expect(res.headers.get("content-length")).toBe(String(body.length));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-backup-sha256")).toBe(SHA);
    const received = Buffer.from(await res.arrayBuffer());
    expect(received.equals(body)).toBe(true);
    const row = auditCreate.mock.calls[0][0].data;
    expect(row).toMatchObject({ actorId: "acct-1", action: "DATABASE_BACKUP_DOWNLOADED", entityType: "DatabaseBackup", entityId: ID, metadata: { sizeBytes: body.length } });
    expect(JSON.stringify(row)).not.toMatch(/[\\/]/);
  });

  it("the staged file and its record are removed after a COMPLETE download", async () => {
    const res = await call(ID);
    await res.arrayBuffer();
    expect(await waitFor(() => readdirSync(dir).length === 0)).toBe(true);
  });

  it("a download that is cancelled halfway keeps the file, so it can be tried again", async () => {
    const res = await call(ID);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(path.join(dir, `${ID}.dump`))).toBe(true);
    expect(readFileSync(path.join(dir, `${ID}.dump`)).equals(body)).toBe(true);
  });

  it("a failure to write the audit row does not stop the download", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    auditCreate.mockRejectedValue(new Error("audit down"));
    const res = await call(ID);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    spy.mockRestore();
  });
});
