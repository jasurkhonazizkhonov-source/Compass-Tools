import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The per-account rate limiter reads and writes a PostgreSQL counter; these tests are not about it (see server/security/__tests__/rate-limit-coverage.test.ts), so it always allows here.
vi.mock("@/server/security/rate-limit", () => ({ checkAccountRateLimit: vi.fn(async () => ({ allowed: true })), describeWait: (s: number) => `${s} seconds`, RATE_LIMITS: new Proxy({}, { get: () => ({ windowMs: 1000, maxAttempts: 1 }) }) }));


// The Database Backup Server Actions: Admin-only on the SERVER (whatever the UI shows), a recent sign-in to create one, every outcome audited without any secret, and the
// backup module itself replaced by a stub so no database or PostgreSQL tool is involved.
const getCurrentAccount = vi.fn();
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: () => getCurrentAccount() }));
const auditCreate = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { auditLog: { create: (...a: unknown[]) => auditCreate(...a) } } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const createBackup = vi.fn();
const listStagedBackups = vi.fn();
const getBackupCapability = vi.fn();
const deleteStagedBackup = vi.fn();
class FakeBackupError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
vi.mock("@/server/backup/database-backup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/backup/database-backup")>()),
  BackupError: FakeBackupError,
  createBackup: (...a: unknown[]) => createBackup(...a),
  listStagedBackups: (...a: unknown[]) => listStagedBackups(...a),
  getBackupCapability: (...a: unknown[]) => getBackupCapability(...a),
  deleteStagedBackup: (...a: unknown[]) => deleteStagedBackup(...a),
}));

const ID = "compass-20261124T101530Z-3fa9c2d1";
const info = { id: ID, fileName: `${ID}.dump`, sizeBytes: 123456, createdAt: new Date("2026-11-24T10:15:30Z"), expiresAt: new Date("2026-11-24T11:15:30Z"), sha256: "a".repeat(64), format: "PostgreSQL custom format", pgDumpVersion: "17.11", serverVersion: "17.11" };
const account = (role: string, sessionCreatedAt: Date | null = new Date()) => ({ id: "acct-1", role, status: "ACTIVE", companyId: "c1", sessionCreatedAt });
const SECRETS = ["postgresql://", "PGPASSWORD", "password"];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("APP_ENV", "");
  getCurrentAccount.mockResolvedValue(account("ADMIN"));
  createBackup.mockResolvedValue(info);
  listStagedBackups.mockResolvedValue([info]);
  getBackupCapability.mockResolvedValue({ available: true, pgDumpVersion: "17.11", serverVersion: "17.11" });
  deleteStagedBackup.mockResolvedValue(true);
  auditCreate.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());

describe("every Database Backup action is Admin-only, on the server", () => {
  it.each(["MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"])("a %s is refused by all three, and nothing runs", async (role) => {
    getCurrentAccount.mockResolvedValue(account(role));
    const a = await import("../database-backup");
    await expect(a.getDatabaseBackupStatus()).rejects.toThrow("Not available.");
    await expect(a.createDatabaseBackup()).rejects.toThrow("Not available.");
    await expect(a.deleteDatabaseBackup(ID)).rejects.toThrow("Not available.");
    expect(createBackup).not.toHaveBeenCalled();
    expect(listStagedBackups).not.toHaveBeenCalled();
    expect(deleteStagedBackup).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it("a signed-out caller is refused by all three", async () => {
    getCurrentAccount.mockResolvedValue(null);
    const a = await import("../database-backup");
    await expect(a.getDatabaseBackupStatus()).rejects.toThrow("Not available.");
    await expect(a.createDatabaseBackup()).rejects.toThrow("Not available.");
    await expect(a.deleteDatabaseBackup(ID)).rejects.toThrow("Not available.");
    expect(createBackup).not.toHaveBeenCalled();
  });
});

describe("createDatabaseBackup", () => {
  it("an Admin who signed in recently gets the backup, with dates as text, and the creation is audited WITHOUT any secret or path", async () => {
    const { createDatabaseBackup } = await import("../database-backup");
    const result = await createDatabaseBackup();
    expect(result).toEqual({
      ok: true,
      backup: { id: ID, fileName: `${ID}.dump`, sizeBytes: 123456, createdAt: "2026-11-24T10:15:30.000Z", expiresAt: "2026-11-24T11:15:30.000Z", sha256: "a".repeat(64), format: "PostgreSQL custom format", pgDumpVersion: "17.11", serverVersion: "17.11" },
    });
    const row = auditCreate.mock.calls[0][0].data;
    expect(row).toMatchObject({ actorId: "acct-1", action: "DATABASE_BACKUP_CREATED", entityType: "DatabaseBackup", entityId: ID });
    expect(row.metadata).toEqual({ sizeBytes: 123456, sha256: "a".repeat(64), pgDumpVersion: "17.11", serverVersion: "17.11" });
    for (const s of SECRETS) expect(JSON.stringify(row)).not.toContain(s);
  });

  it("an Admin whose sign-in is older than the step-up window is told to sign in again; nothing runs and the denial is audited", async () => {
    getCurrentAccount.mockResolvedValue(account("ADMIN", new Date(Date.now() - 3 * 60 * 60_000)));
    const { createDatabaseBackup } = await import("../database-backup");
    const result = await createDatabaseBackup();
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/sign-in within the last \d+ minutes/);
    expect(createBackup).not.toHaveBeenCalled();
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({ action: "DATABASE_BACKUP_DENIED", entityId: "none" });
  });

  it("a refusal from the backup module is shown as its own safe message and audited by code only", async () => {
    createBackup.mockRejectedValue(new FakeBackupError("INSUFFICIENT_DISK", "Not enough free disk space for a backup: about 900 MB are needed and 100 MB are free."));
    const { createDatabaseBackup } = await import("../database-backup");
    expect(await createDatabaseBackup()).toEqual({ ok: false, error: "Not enough free disk space for a backup: about 900 MB are needed and 100 MB are free." });
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({ action: "DATABASE_BACKUP_FAILED", metadata: { code: "INSUFFICIENT_DISK" } });
  });

  it("an unexpected error becomes one generic message: no error text, no connection string, reaches the browser or the audit log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    createBackup.mockRejectedValue(new Error("connect ECONNREFUSED postgresql://user:hunter2@db:5432/x"));
    const { createDatabaseBackup } = await import("../database-backup");
    const result = await createDatabaseBackup();
    spy.mockRestore();
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toMatch(/hunter2|postgresql:\/\/|ECONNREFUSED/);
    expect(JSON.stringify(auditCreate.mock.calls)).not.toMatch(/hunter2|postgresql:\/\/|ECONNREFUSED/);
    expect(auditCreate.mock.calls[0][0].data.metadata).toEqual({ code: "UNEXPECTED" });
  });

  it("a failure to WRITE the audit row never turns a finished backup into a failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    auditCreate.mockRejectedValue(new Error("audit db down"));
    const { createDatabaseBackup } = await import("../database-backup");
    expect(await createDatabaseBackup()).toMatchObject({ ok: true });
    spy.mockRestore();
  });
});

describe("status and delete", () => {
  it("the status says whether a backup can be made and lists the staged ones, never a path", async () => {
    const { getDatabaseBackupStatus } = await import("../database-backup");
    const status = await getDatabaseBackupStatus();
    expect(status.capability).toMatchObject({ available: true });
    expect(status.backups).toHaveLength(1);
    expect(status.format).toMatch(/custom format/);
    expect(status.excludedData).toBe("PaymentMethodCvv");
    expect(JSON.stringify(status)).not.toMatch(/[\\/]var[\\/]|[A-Za-z]:\\/);
  });

  it("a tool that is missing is passed through as 'not available' with its reason", async () => {
    getBackupCapability.mockResolvedValue({ available: false, code: "TOOL_MISSING", reason: "The PostgreSQL backup tool (pg_dump) is not installed in this environment." });
    const { getDatabaseBackupStatus } = await import("../database-backup");
    expect((await getDatabaseBackupStatus()).capability).toMatchObject({ available: false, code: "TOOL_MISSING" });
  });

  it("delete removes a valid id and audits it; an id that is not one of ours is refused before the file system is touched", async () => {
    const { deleteDatabaseBackup } = await import("../database-backup");
    expect(await deleteDatabaseBackup(ID)).toEqual({ ok: true });
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({ action: "DATABASE_BACKUP_DELETED", entityId: ID });
    deleteStagedBackup.mockClear();
    for (const bad of ["../../etc/passwd", "..\\x", `${ID}.dump`, "", "x".repeat(300)]) {
      expect(await deleteDatabaseBackup(bad), bad).toMatchObject({ ok: false });
    }
    expect(deleteStagedBackup).not.toHaveBeenCalled();
  });

  it("deleting a backup that is already gone says so, and records nothing", async () => {
    deleteStagedBackup.mockResolvedValue(false);
    const { deleteDatabaseBackup } = await import("../database-backup");
    expect(await deleteDatabaseBackup(ID)).toMatchObject({ ok: false });
    expect(auditCreate).not.toHaveBeenCalled();
  });
});
