import { describe, it, expect, vi, beforeEach } from "vitest";

// (1) Which sign-in failures are captured by signInWithGoogle, and what identity each one carries; (2) the Administrator-only actions on the log: inspect and
// delete (exactly the selected rows, audited, company-scoped). Fake database; nothing leaves the process.

const record = vi.fn(async (input: Record<string, unknown>) => void input);
vi.mock("@/server/auth/failed-sign-in", () => ({ recordFailedSignIn: (input: Record<string, unknown>) => record(input) }));
let verified: { email: string; name: string } | null;
vi.mock("@/server/auth/verify-google-token", () => ({ verifyGoogleIdToken: vi.fn(async () => verified), verifyGoogleIdTokenForSignIn: vi.fn(async () => verified) }));
// The browser binding cookie has its own tests (google-login-binding.test.ts); here it is a stub, since this file is about which failures are recorded.
vi.mock("@/server/auth/google-login-binding", () => ({ readBindingNonce: vi.fn(async () => "nonce"), clearBinding: vi.fn(async () => {}), ensureBindingNonce: vi.fn(async () => "nonce") }));
let bootstrap: { outcome: string; account?: { id: string } };
vi.mock("@/server/auth/initial-admin-bootstrap", () => ({ bootstrapInitialAdminIfEligible: vi.fn(async () => bootstrap) }));
let authz: { ok: boolean; reason?: string; account?: { id: string } };
vi.mock("@/server/auth/google-authorization", () => ({ authorizeGoogleUser: vi.fn(async () => authz) }));
const establishSession = vi.fn(async () => {});
vi.mock("@/server/auth/establish-session", () => ({ establishSession: (...a: unknown[]) => establishSession(...(a as [])) }));

let actor: { id: string; role: string; companyId: string } | null;
vi.mock("@/lib/dev-session", () => ({ getCurrentAccount: vi.fn(async () => actor) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
type Row = { id: string; companyId: string | null };
let rows: Row[];
const audits: Array<Record<string, unknown>> = [];
const deleteMany = vi.fn(async ({ where }: { where: { id: { in: string[] }; OR: Array<{ companyId: string | null }> } }) => {
  const mine = where.OR.map((o) => o.companyId);
  const hit = rows.filter((r) => where.id.in.includes(r.id) && mine.includes(r.companyId));
  rows = rows.filter((r) => !hit.includes(r));
  return { count: hit.length };
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    failedSignInEvent: {
      deleteMany: (...a: unknown[]) => deleteMany(...(a as [never])),
      findFirst: vi.fn(async ({ where }: { where: { id: string; OR: Array<{ companyId: string | null }> } }) => {
        const mine = where.OR.map((o) => o.companyId);
        return rows.find((r) => r.id === where.id && mine.includes(r.companyId)) ?? null;
      }),
    },
    auditLog: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => void audits.push(data)) },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  audits.length = 0;
  verified = { email: "sarah@example.com", name: "Sarah Wilson" };
  bootstrap = { outcome: "not_applicable" };
  authz = { ok: false, reason: "UNKNOWN_EMAIL" };
  actor = { id: "admin-1", role: "ADMIN", companyId: "company-1" };
  rows = [
    { id: "a", companyId: "company-1" },
    { id: "b", companyId: "company-1" },
    { id: "c", companyId: null },
    { id: "d", companyId: "company-2" },
  ];
});

describe("which failures are captured by Google sign-in", () => {
  it("token not verified: recorded with NO identity (nothing is read from the unverified credential)", async () => {
    verified = null;
    const { signInWithGoogle } = await import("../google-auth");
    expect(await signInWithGoogle("bad-token")).toEqual({ ok: false, reason: "GOOGLE_VERIFICATION_FAILED" });
    expect(record).toHaveBeenCalledTimes(1);
    const arg = record.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toMatchObject({ method: "GOOGLE_OAUTH", reasonCode: "GOOGLE_VERIFICATION_FAILED", credential: "bad-token" });
    expect(arg.verifiedEmail).toBeUndefined();
    expect(arg.verifiedFullName).toBeUndefined();
  });

  it("verified Google identity with no CRM account: UNKNOWN_ACCOUNT with the VERIFIED email and name", async () => {
    const { signInWithGoogle } = await import("../google-auth");
    expect(await signInWithGoogle("t")).toEqual({ ok: false, reason: "ACCESS_DENIED" });
    expect(record.mock.calls[0][0]).toMatchObject({ reasonCode: "UNKNOWN_ACCOUNT", verifiedEmail: "sarah@example.com", verifiedFullName: "Sarah Wilson" });
  });

  it("verified identity whose account is disabled: ACCOUNT_DISABLED", async () => {
    authz = { ok: false, reason: "ACCOUNT_DISABLED" };
    const { signInWithGoogle } = await import("../google-auth");
    await signInWithGoogle("t");
    expect(record.mock.calls[0][0]).toMatchObject({ reasonCode: "ACCOUNT_DISABLED" });
  });

  it("initial-admin paths: NOT_INITIALIZED and BOOTSTRAP_EMAIL_MISMATCH", async () => {
    const { signInWithGoogle } = await import("../google-auth");
    bootstrap = { outcome: "not_initialized" };
    await signInWithGoogle("t1");
    bootstrap = { outcome: "email_mismatch" };
    await signInWithGoogle("t2");
    expect(record.mock.calls.map((c) => (c[0] as { reasonCode: string }).reasonCode)).toEqual(["NOT_INITIALIZED", "BOOTSTRAP_EMAIL_MISMATCH"]);
  });

  it("a SUCCESSFUL sign-in records nothing (successful sign-ins keep their own history)", async () => {
    authz = { ok: true, account: { id: "acct-1" } };
    const { signInWithGoogle } = await import("../google-auth");
    expect(await signInWithGoogle("t")).toEqual({ ok: true });
    expect(record).not.toHaveBeenCalled();
    expect(establishSession).toHaveBeenCalled();
  });

  it("an ordinary server error AFTER identity was verified (database hiccup) is not recorded as a failed authentication", async () => {
    const mod = await import("@/server/auth/google-authorization");
    (mod.authorizeGoogleUser as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { signInWithGoogle } = await import("../google-auth");
    expect(await signInWithGoogle("t")).toEqual({ ok: false, reason: "SERVER_ERROR" });
    expect(record).not.toHaveBeenCalled();
  });
});

describe("Administrator-only actions", () => {
  it.each(["MANAGER", "TRAVEL_AGENT", "TICKETING_AGENT", "FLIGHT_EXPERT", "MARKETING_AGENT"])("a %s is refused for inspect and delete, and nothing is deleted or audited", async (role) => {
    actor = { id: "u", role, companyId: "company-1" };
    const { inspectFailedSignIn, deleteFailedSignInEvents } = await import("../failed-signins");
    await expect(inspectFailedSignIn("a")).rejects.toThrow(/not authorized/i);
    await expect(deleteFailedSignInEvents(["a"])).rejects.toThrow(/not authorized/i);
    expect(deleteMany).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
    expect(rows).toHaveLength(4);
  });

  it("no signed-in user is refused", async () => {
    actor = null;
    const { deleteFailedSignInEvents } = await import("../failed-signins");
    await expect(deleteFailedSignInEvents(["a"])).rejects.toThrow(/not authorized/i);
  });

  it("deletes EXACTLY the selected rows, nothing else, and audits who and how many - with no personal data in the audit entry", async () => {
    const { deleteFailedSignInEvents } = await import("../failed-signins");
    expect(await deleteFailedSignInEvents(["a"])).toEqual({ ok: true, deleted: 1, requested: 1 });
    expect(rows.map((r) => r.id)).toEqual(["b", "c", "d"]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: "admin-1", action: "FAILED_SIGNINS_DELETED", metadata: { requested: 1, deleted: 1 } });
    expect(JSON.stringify(audits[0])).not.toMatch(/@|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it("another company's events are untouched even when their ids are sent; events with no company are deletable by an Administrator", async () => {
    const { deleteFailedSignInEvents } = await import("../failed-signins");
    expect(await deleteFailedSignInEvents(["d", "c"])).toEqual({ ok: true, deleted: 1, requested: 2 });
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "d"]);
  });

  it("inspect cannot read another company's event", async () => {
    const { inspectFailedSignIn } = await import("../failed-signins");
    expect(await inspectFailedSignIn("a")).toMatchObject({ id: "a" });
    expect(await inspectFailedSignIn("d")).toBeNull();
  });

  it("an empty, malformed, oversized or non-array selection deletes nothing", async () => {
    const { deleteFailedSignInEvents } = await import("../failed-signins");
    expect(await deleteFailedSignInEvents([])).toMatchObject({ ok: false });
    expect(await deleteFailedSignInEvents([1, null, ""] as never)).toMatchObject({ ok: false });
    expect(await deleteFailedSignInEvents("a" as never)).toMatchObject({ ok: false });
    expect(await deleteFailedSignInEvents(Array.from({ length: 201 }, (_, i) => `id-${i}`))).toMatchObject({ ok: false, error: expect.stringMatching(/at most 200/) });
    expect(deleteMany).not.toHaveBeenCalled();
    expect(rows).toHaveLength(4);
  });

  it("the same id twice counts once", async () => {
    const { deleteFailedSignInEvents } = await import("../failed-signins");
    expect(await deleteFailedSignInEvents(["a", "a", "a"])).toEqual({ ok: true, deleted: 1, requested: 1 });
  });
});
