import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Which operations are rate limited, in what order: the limiter must run AFTER the caller is authorised (an outsider can never spend an authorised person's allowance) and
// BEFORE the work it protects. Read from the source, so a refactor that moves or drops a limiter fails here. The limiter's behaviour itself (shared counter, failures-only,
// per-account keys) is proven against a real database in rate-limit-failures-only.integration.test.ts; the sign-in limit's behaviour in sign-in-rate-limit.test.ts.
const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf-8").replace(/\r\n/g, "\n");

type Case = { file: string[]; fn: string; limiter: string; after: string; before: string };
const CASES: Case[] = [
  { file: ["src", "server", "actions", "database-backup.ts"], fn: "export async function createDatabaseBackup", limiter: '"DATABASE_BACKUP_CREATE"', after: "requireRecentLogin(", before: "createBackup()" },
  { file: ["src", "server", "actions", "database-backup.ts"], fn: "export async function deleteDatabaseBackup", limiter: '"DATABASE_BACKUP_DELETE"', after: "isValidBackupId(", before: "deleteStagedBackup(" },
  { file: ["src", "app", "api", "admin", "database-backup", "[id]", "route.ts"], fn: "export async function GET", limiter: '"DATABASE_BACKUP_DOWNLOAD"', after: "requireRecentLogin(", before: "resolveStagedBackup(" },
  { file: ["src", "server", "actions", "sequences.ts"], fn: "async function enrollLeadsCore", limiter: '"SEQUENCE_ENROLL"', after: "assertSequenceAccess(", before: "classifyLeadsForEnrollment(" },
  { file: ["src", "server", "actions", "sequences.ts"], fn: "export async function retryEnrollmentNow", limiter: '"SEQUENCE_RECOVERY"', after: "loadForRecovery(", before: "recoveryGmailCheck(" },
  { file: ["src", "server", "actions", "sequences.ts"], fn: "export async function resolveUncertainDelivery", limiter: '"SEQUENCE_RECOVERY"', after: "loadForRecovery(", before: "assertTransition(" },
  { file: ["src", "server", "actions", "sequence-enroll-contacts.ts"], fn: "export async function enrollContactsBatch", limiter: '"ENROLL_ALL_CONTACTS_BATCH"', after: "authorize(", before: "prisma.contact.findMany(" },
  { file: ["src", "server", "actions", "bulk-selection.ts"], fn: "export async function bulkEnrollInSequence", limiter: '"BULK_ACTION"', after: "canBulkEnrollInSequence(", before: "prisma.sequence.findFirst(" },
  { file: ["src", "server", "actions", "bulk-selection.ts"], fn: "export async function bulkDeleteRecords", limiter: '"BULK_ACTION"', after: "canBulkDeleteLeadsAndContacts(", before: "prisma.lead.findMany(" },
  { file: ["src", "server", "actions", "gmail-connect.ts"], fn: "export async function startGmailConnect", limiter: '"GMAIL_CONNECT"', after: "getCurrentAccount()", before: "randomBytes(" },
  { file: ["src", "app", "api", "auth", "gmail", "callback", "route.ts"], fn: "export async function GET", limiter: '"GMAIL_CONNECT"', after: "session.role = current.role", before: "getToken(" },
];

describe.each(CASES)("$fn ($limiter)", ({ file, fn, limiter, after, before }) => {
  const src = read(...file);
  const start = src.indexOf(fn);
  const body = start < 0 ? "" : src.slice(start);
  it("is rate limited per account, after authorization and before the work", () => {
    expect(start, `${fn} not found`).toBeGreaterThanOrEqual(0);
    const limiterAt = body.indexOf(limiter);
    const afterAt = body.indexOf(after);
    const beforeAt = body.indexOf(before, afterAt);
    expect(limiterAt, "limiter present").toBeGreaterThan(-1);
    expect(afterAt, `${after} present`).toBeGreaterThan(-1);
    expect(limiterAt, "after authorization").toBeGreaterThan(afterAt);
    expect(beforeAt, `${before} present after authorization`).toBeGreaterThan(-1);
    expect(limiterAt, "before the work").toBeLessThan(beforeAt);
  });
  it("uses the ACCOUNT-keyed limiter (never the client IP, so a shared office is unaffected)", () => {
    const callAt = body.indexOf("checkAccountRateLimit(");
    expect(callAt).toBeGreaterThan(-1);
    expect(body.slice(callAt, callAt + 80)).not.toMatch(/getClientIp|headers\(\)/);
  });
});

describe("the limits themselves", () => {
  const src = read("src", "server", "security", "rate-limit.ts");
  it.each(["SIGN_IN_FAILURES", "GMAIL_CONNECT", "DATABASE_BACKUP_CREATE", "DATABASE_BACKUP_DOWNLOAD", "DATABASE_BACKUP_DELETE", "SEQUENCE_ENROLL", "ENROLL_ALL_CONTACTS_BATCH", "BULK_ACTION", "SEQUENCE_RECOVERY"])("%s is defined with a window and a ceiling", (name) => {
    expect(src).toMatch(new RegExp(`${name}: \\{ windowMs: [\\d* ]+, maxAttempts: \\d+ \\} satisfies RateLimitConfig`));
  });

  it("every one of these limits is large enough for real use: an Admin can enrol 150,000 contacts, a shared office can fail 15 sign-ins, a person can back up a few times", () => {
    const get = (name: string) => Number(new RegExp(`${name}: \\{ windowMs: [\\d* ]+, maxAttempts: (\\d+) \\}`).exec(src)?.[1]);
    expect(get("ENROLL_ALL_CONTACTS_BATCH") * 100).toBeGreaterThanOrEqual(100_000); // 100 contacts per batch
    expect(get("SIGN_IN_FAILURES")).toBeGreaterThanOrEqual(10);
    expect(get("DATABASE_BACKUP_CREATE")).toBeGreaterThanOrEqual(3);
    expect(get("SEQUENCE_ENROLL")).toBeGreaterThanOrEqual(100);
  });

  it("the failed-sign-in limit is a failures-only limit: signInWithGoogle peeks first and records only refusals", () => {
    const action = read("src", "server", "actions", "google-auth.ts");
    const fn = action.slice(action.indexOf("export async function signInWithGoogle("));
    expect(fn.indexOf("peekPublicRateLimitFromRequest(")).toBeGreaterThan(-1);
    expect(fn.indexOf("peekPublicRateLimitFromRequest(")).toBeLessThan(fn.indexOf("signInWithGoogleChecked(idToken)"));
    expect(fn).toMatch(/result\.reason !== "SERVER_ERROR" && result\.reason !== "RATE_LIMITED"\) await recordPublicRateLimitUse/);
  });
});

describe("responses a client can act on", () => {
  it("the backup download answers 429 with Retry-After (exact seconds) and no file data", () => {
    const route = read("src", "app", "api", "admin", "database-backup", "[id]", "route.ts");
    expect(route).toMatch(/status: 429, headers: \{ "Cache-Control": "no-store", "Retry-After": String\(limited\.retryAfterSeconds\) \}/);
  });
});
