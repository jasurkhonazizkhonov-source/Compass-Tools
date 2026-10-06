import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { encryptCvv, decryptCvv, encryptPan, decryptPan, CardVaultError } from "../card-encryption";

// The temporarily retained security code (CVV/CVC): its encryption (same ring and envelope as the card number, its OWN AAD) and the
// creation / destruction rules of server/security/booking-cvv.ts. Real AES-256-GCM, real key ring. SYNTHETIC codes only.
const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");
const CODE = "482";
const HOUR = 3_600_000;

const prismaMock = {
  paymentMethodCvv: {
    updateMany: vi.fn<(a: unknown) => Promise<{ count: number }>>(async () => ({ count: 1 })),
    deleteMany: vi.fn<(a: unknown) => Promise<{ count: number }>>(async () => ({ count: 2 })),
  },
};
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
const auditCardEvent = vi.fn<(p: unknown) => Promise<void>>(async () => {});
vi.mock("@/server/security/card-audit", () => ({ auditCardEvent: (p: unknown) => auditCardEvent(p) }));

beforeEach(() => {
  vi.stubEnv("CARD_ENCRYPTION_KEY", KEY_A);
  vi.stubEnv("CARD_ENCRYPTION_KEYS", "");
  vi.stubEnv("CARD_ENCRYPTION_KEY_ID", "");
  vi.stubEnv("APP_ENV", "test");
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof CardVaultError ? e.code : `non-vault:${String(e)}`;
  }
  return "no-error";
};

describe("encryptCvv / decryptCvv — same ring and envelope as the card number, but their own AAD", () => {
  it("round-trips a 3-digit and a 4-digit code through a versioned envelope that contains neither", () => {
    for (const code of [CODE, "7391"]) {
      const ref = encryptCvv(code, "pm-1");
      expect(ref).toMatch(/^cv2\.v1\.[A-Za-z0-9_-]{20,}$/);
      expect(ref).not.toContain(code);
      expect(decryptCvv(ref, "pm-1")).toBe(code);
    }
  });

  it("is bound to its card: another card id cannot decrypt it (authentication fails)", () => {
    const ref = encryptCvv(CODE, "pm-1");
    expect(codeOf(() => decryptCvv(ref, "pm-2"))).toBe("AUTH_FAILED");
  });

  it("a CVV envelope is never a card number, and a card-number envelope is never a CVV — the AAD domains differ", () => {
    const cvvRef = encryptCvv(CODE, "pm-1");
    expect(codeOf(() => decryptPan(cvvRef, "pm-1"))).toBe("AUTH_FAILED");
    const panRef = encryptPan("4242424242424242", "pm-1");
    expect(codeOf(() => decryptCvv(panRef, "pm-1"))).toBe("AUTH_FAILED");
  });

  it("every encryption is fresh (random IV) and a tampered envelope is refused", () => {
    expect(encryptCvv(CODE, "pm-1")).not.toBe(encryptCvv(CODE, "pm-1"));
    const ref = encryptCvv(CODE, "pm-1");
    const [prefix, id, payload] = ref.split(".");
    const flipped = payload.slice(0, -2) + (payload.endsWith("AA") ? "BB" : "AA");
    expect(codeOf(() => decryptCvv(`${prefix}.${id}.${flipped}`, "pm-1"))).toBe("AUTH_FAILED");
  });

  it("only a well-formed code can be encrypted, and only a versioned envelope decrypts (never a legacy blob or the purged tombstone)", () => {
    for (const bad of ["", "12", "12345", "abc", "12 3", "1234567890123456"]) expect(codeOf(() => encryptCvv(bad, "pm-1")), bad).toBe("INVALID_INPUT");
    expect(codeOf(() => encryptCvv(CODE, ""))).toBe("INVALID_INPUT");
    expect(codeOf(() => decryptCvv("cv2.purged", "pm-1"))).toBe("MALFORMED");
    expect(codeOf(() => decryptCvv("Zm9vYmFy", "pm-1"))).toBe("MALFORMED");
    expect(codeOf(() => decryptCvv("not an envelope", "pm-1"))).toBe("MALFORMED");
  });

  it("fails closed with no key, and follows the key ring: an old key still decrypts after rotation, a missing one does not", () => {
    const ref = encryptCvv(CODE, "pm-1"); // under v1 = KEY_A
    vi.stubEnv("CARD_ENCRYPTION_KEYS", `v1:${KEY_A},v2:${KEY_B}`);
    vi.stubEnv("CARD_ENCRYPTION_KEY_ID", "v2");
    expect(decryptCvv(ref, "pm-1")).toBe(CODE);
    const fresh = encryptCvv(CODE, "pm-1");
    expect(fresh).toMatch(/^cv2\.v2\./);
    vi.stubEnv("CARD_ENCRYPTION_KEYS", `v2:${KEY_B}`);
    vi.stubEnv("CARD_ENCRYPTION_KEY", "");
    expect(codeOf(() => decryptCvv(ref, "pm-1"))).toBe("KEY_UNKNOWN");
    vi.stubEnv("CARD_ENCRYPTION_KEYS", "");
    vi.stubEnv("CARD_ENCRYPTION_KEY_ID", "");
    expect(codeOf(() => encryptCvv(CODE, "pm-1"))).toBe("NOT_CONFIGURED");
  });

  it("an error never carries the code or the ciphertext", () => {
    const ref = encryptCvv(CODE, "pm-1");
    try {
      decryptCvv(ref, "pm-2");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(CODE);
      expect(String((e as Error).message)).not.toContain(ref);
    }
  });
});

describe("the retention window is a fixed 24 hours from signing", () => {
  it("exactly signedAt + 24 h; not configurable by any environment variable", async () => {
    const m = await import("../booking-cvv");
    expect(m.CVV_RETENTION_MS).toBe(24 * HOUR);
    for (const name of ["CVV_RETENTION_HOURS", "CVV_RETENTION_MS", "CARD_CVV_RETENTION_HOURS"]) vi.stubEnv(name, "168");
    vi.resetModules();
    const again = await import("../booking-cvv");
    expect(again.CVV_RETENTION_MS).toBe(24 * HOUR);
    const signed = new Date("2026-10-06T10:00:00.000Z");
    expect(again.cvvExpiryFor(signed).toISOString()).toBe("2026-10-07T10:00:00.000Z");
  });

  it("expired exactly AT expiresAt, not after", async () => {
    const { isCvvExpired } = await import("../booking-cvv");
    const exp = new Date("2026-10-07T10:00:00.000Z");
    expect(isCvvExpired(exp, new Date(exp.getTime() - 1))).toBe(false);
    expect(isCvvExpired(exp, exp)).toBe(true);
    expect(isCvvExpired(exp, new Date(exp.getTime() + 1))).toBe(true);
  });
});

describe("prepareCvvForStorage — creation-time enforcement", () => {
  it("encrypts a code for a valid signing time and returns the exact 24-hour expiry; the result holds ciphertext only", async () => {
    const { prepareCvvForStorage } = await import("../booking-cvv");
    const now = new Date("2026-10-06T10:00:00.000Z");
    const prepared = await prepareCvvForStorage(CODE, "pm-1", now, now);
    expect(prepared).not.toBeNull();
    expect(prepared!.signedAt).toEqual(now);
    expect(prepared!.expiresAt.toISOString()).toBe("2026-10-07T10:00:00.000Z");
    expect(JSON.stringify(prepared)).not.toContain(`"${CODE}"`);
    expect(decryptCvv(prepared!.encryptedCvv, "pm-1")).toBe(CODE);
  });

  it("creates nothing without a code, for an invalid or future signing time, or when the window is already over", async () => {
    const { prepareCvvForStorage } = await import("../booking-cvv");
    const now = new Date("2026-10-06T10:00:00.000Z");
    expect(await prepareCvvForStorage(undefined, "pm-1", now, now)).toBeNull();
    expect(await prepareCvvForStorage("", "pm-1", now, now)).toBeNull();
    expect(await prepareCvvForStorage(CODE, "pm-1", new Date("nope"), now)).toBeNull();
    expect(await prepareCvvForStorage(CODE, "pm-1", new Date(now.getTime() + 10 * 60_000), now)).toBeNull(); // signed "in the future"
    expect(await prepareCvvForStorage(CODE, "pm-1", new Date(now.getTime() - 24 * HOUR), now)).toBeNull(); // would already be expired
    expect(await prepareCvvForStorage(CODE, "pm-1", new Date(now.getTime() - 25 * HOUR), now)).toBeNull();
    expect(await prepareCvvForStorage(CODE, "pm-1", new Date(now.getTime() - 24 * HOUR + 1000), now)).not.toBeNull(); // a second left is still valid
  });

  it("when the vault is unavailable it stores nothing, never throws, and logs a fixed tag without the code", async () => {
    vi.stubEnv("CARD_ENCRYPTION_KEY", "");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { prepareCvvForStorage } = await import("../booking-cvv");
    const now = new Date();
    expect(await prepareCvvForStorage(CODE, "pm-1", now, now)).toBeNull();
    const logged = JSON.stringify(spy.mock.calls);
    spy.mockRestore();
    expect(logged).toMatch(/CVV_NOT_RETAINED/);
    expect(logged).not.toContain(CODE);
  });
});

describe("destroyCvv / destroyExpiredCvvs", () => {
  it("destroying sets the ciphertext to NULL with a fixed reason and audits without the code; it only touches a live record and never the expiry", async () => {
    const { destroyCvv } = await import("../booking-cvv");
    expect(await destroyCvv("pm-1", "PAYMENT_CONFIRMED", "admin-1")).toBe(true);
    const arg = prismaMock.paymentMethodCvv.updateMany.mock.calls[0][0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(arg.where).toEqual({ paymentMethodId: "pm-1", encryptedCvv: { not: null } });
    expect(arg.data).toMatchObject({ encryptedCvv: null, destroyedReason: "PAYMENT_CONFIRMED" });
    expect(arg.data).not.toHaveProperty("expiresAt");
    expect(arg.data).not.toHaveProperty("signedAt");
    expect(auditCardEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "CVV_DESTROYED", entityId: "pm-1", reason: "PAYMENT_CONFIRMED" }));
    expect(JSON.stringify(auditCardEvent.mock.calls)).not.toMatch(/cv2\./);
  });

  it("is idempotent: with nothing left to destroy it reports false and writes no audit row; a database failure never throws into the payment flow", async () => {
    const { destroyCvv } = await import("../booking-cvv");
    prismaMock.paymentMethodCvv.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await destroyCvv("pm-1", "ADMIN_DESTROYED")).toBe(false);
    expect(auditCardEvent).not.toHaveBeenCalled();
    prismaMock.paymentMethodCvv.updateMany.mockRejectedValueOnce(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(destroyCvv("pm-1", "PAYMENT_CANCELLED")).resolves.toBe(false);
    spy.mockRestore();
  });

  it("the expiry cleanup deletes only records whose window has ended, reports the count, and is safe to repeat", async () => {
    const { destroyExpiredCvvs } = await import("../booking-cvv");
    const now = new Date("2026-10-06T10:00:00.000Z");
    expect(await destroyExpiredCvvs(now)).toEqual({ deleted: 2 });
    expect(prismaMock.paymentMethodCvv.deleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lte: now } } });
    prismaMock.paymentMethodCvv.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect(await destroyExpiredCvvs(now)).toEqual({ deleted: 0 });
    prismaMock.paymentMethodCvv.deleteMany.mockRejectedValueOnce(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await destroyExpiredCvvs(now)).toEqual({ deleted: 0 }); // never throws into the cron run
    spy.mockRestore();
  });
});

// ── The business rule, stated as tests ────────────────────────────────────────────────────────────────────────────────────────
// Retention is exactly 24 ELAPSED hours from the moment the Booking Form was signed. It does not pause, extend or reset for a
// weekend, a Monday, a holiday, a reveal, a payment attempt, an edit, a reopen or a reassignment, and there is no business-day
// calculation, no configurable window and no renewal. A form signed on Friday at 5:00 PM therefore expires on Saturday at 5:00 PM —
// it is NOT available on Monday for a manual charge. That is the deliberate tradeoff (docs/CARD_VAULT_SECURITY.md section 19).
describe("Friday-to-Monday: exactly 24 elapsed hours, no weekend or Monday behaviour", () => {
  const FRI_1700 = new Date("2026-10-09T17:00:00.000Z"); // a Friday (synthetic)
  const at = (iso: string) => new Date(iso);

  it("signed Friday 17:00 → expires Saturday 17:00", async () => {
    const { cvvExpiryFor } = await import("../booking-cvv");
    expect(FRI_1700.getUTCDay()).toBe(5); // Friday
    const expires = cvvExpiryFor(FRI_1700);
    expect(expires.toISOString()).toBe("2026-10-10T17:00:00.000Z");
    expect(expires.getUTCDay()).toBe(6); // Saturday
  });

  it("available until Saturday 16:59:59.999, expired at 17:00:00 and at every later moment — Sunday and Monday included", async () => {
    const { cvvExpiryFor, isCvvExpired } = await import("../booking-cvv");
    const expires = cvvExpiryFor(FRI_1700);
    const expectations: Array<[string, boolean]> = [
      ["2026-10-09T17:00:01.000Z", false], // Friday, just signed
      ["2026-10-09T23:59:59.000Z", false],
      ["2026-10-10T09:00:00.000Z", false], // Saturday morning
      ["2026-10-10T16:59:00.000Z", false], // Saturday 16:59 — still permitted
      ["2026-10-10T16:59:59.999Z", false],
      ["2026-10-10T17:00:00.000Z", true], //  Saturday 17:00 — expired
      ["2026-10-10T17:01:00.000Z", true], //  Saturday 17:01
      ["2026-10-11T12:00:00.000Z", true], //  Sunday
      ["2026-10-12T08:00:00.000Z", true], //  Monday morning — gone
      ["2026-10-12T17:00:00.000Z", true], //  Monday at the old "business" time — still gone
      ["2026-10-13T09:00:00.000Z", true], //  Tuesday
    ];
    for (const [iso, expired] of expectations) expect(isCvvExpired(expires, at(iso)), iso).toBe(expired);
  });

  it("every day of the week behaves the same: +24h exactly, never a business-day or weekend adjustment", async () => {
    const { cvvExpiryFor } = await import("../booking-cvv");
    for (let day = 0; day < 14; day++) {
      const signed = new Date(FRI_1700.getTime() + day * 24 * HOUR - 3 * HOUR); // 14:00 on 14 consecutive days (a full fortnight)
      expect(cvvExpiryFor(signed).getTime() - signed.getTime(), signed.toISOString()).toBe(24 * HOUR);
    }
  });

  it("it is ELAPSED time, not wall-clock time: across a daylight-saving change it is still exactly 24 hours (86,400,000 ms)", async () => {
    const { cvvExpiryFor } = await import("../booking-cvv");
    // US clocks fall back on Sunday 2026-11-01: 25 wall-clock hours pass between 17:00 PDT Saturday and 17:00 PST Sunday.
    const signed = new Date("2026-11-01T00:00:00.000Z"); // Saturday 17:00 PDT (UTC-7)
    expect(cvvExpiryFor(signed).toISOString()).toBe("2026-11-02T00:00:00.000Z"); // = Sunday 16:00 PST, not 17:00
  });

  it("nothing is configurable or renewable: no environment variable moves it, and the module exports no extension / renewal / business-day helper", async () => {
    for (const name of ["CVV_RETENTION_HOURS", "CVV_RETENTION_DAYS", "CARD_CVV_RETENTION_HOURS", "CVV_WEEKEND_EXTENSION", "CVV_BUSINESS_DAYS"]) vi.stubEnv(name, "72");
    vi.resetModules();
    const m = await import("../booking-cvv");
    expect(m.CVV_RETENTION_MS).toBe(24 * HOUR);
    expect(m.cvvExpiryFor(FRI_1700).toISOString()).toBe("2026-10-10T17:00:00.000Z");
    expect(Object.keys(m).sort()).toEqual(["CVV_RETENTION_MS", "cvvExpiryFor", "destroyCvv", "destroyExpiredCvvs", "isCvvExpired", "prepareCvvForStorage"]);
  });

  it("a Friday signing creates a record whose expiry is Saturday 17:00 — and a form 'signed' after the window would be refused at creation", async () => {
    const { prepareCvvForStorage } = await import("../booking-cvv");
    const prepared = await prepareCvvForStorage(CODE, "pm-fri", FRI_1700, FRI_1700);
    expect(prepared!.expiresAt.toISOString()).toBe("2026-10-10T17:00:00.000Z");
    // the same signing time, evaluated on Monday, is already over: no record is created
    expect(await prepareCvvForStorage(CODE, "pm-fri", FRI_1700, at("2026-10-12T09:00:00.000Z"))).toBeNull();
  });
});
