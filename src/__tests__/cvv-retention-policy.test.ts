import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// The CVV/CVC retention policy is a business rule, not an implementation detail: exactly 24 elapsed hours from Booking Form signing,
// with NO weekend / Monday / business-day behaviour, no renewal and no configuration. These guards keep the code and the
// documentation honest about it.
const ROOT = path.resolve(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf-8");
const stripComments = (code: string) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const RETENTION_CODE = [
  ["src", "server", "security", "booking-cvv.ts"],
  ["src", "server", "actions", "booking-cvv.ts"],
  ["src", "server", "queries", "booking-cvv.ts"],
  ["src", "components", "bookings", "cvv-reveal.tsx"],
];

describe("the retention code has no weekend, Monday, business-day, renewal or configuration behaviour", () => {
  it("no executable reference to days of the week, weekends, holidays, business days, extension or renewal", () => {
    for (const parts of RETENTION_CODE) {
      const code = stripComments(read(...parts));
      expect(code, parts.join("/")).not.toMatch(/weekend|weekday|business[ _-]?day|holiday|monday|friday|saturday|sunday|getUTCDay|getDay\(|extend|renew|snooze/i);
    }
  });

  it("the window is a single literal constant and nothing reads it (or anything like it) from the environment", () => {
    const code = stripComments(read("src", "server", "security", "booking-cvv.ts"));
    expect(code).toMatch(/export const CVV_RETENTION_MS = 24 \* 60 \* 60 \* 1000;/);
    expect(code).not.toMatch(/process\.env/);
    for (const parts of RETENTION_CODE) expect(stripComments(read(...parts)), parts.join("/")).not.toMatch(/process\.env\.\w*(CVV|RETENTION)/i);
    // and no other module in the app defines or reads a CVV retention setting
    expect(read(".env.example")).not.toMatch(/CVV/i);
  });

  it("the expiry is only ever written when the record is created — no update path touches expiresAt or signedAt", () => {
    for (const parts of RETENTION_CODE) {
      const code = stripComments(read(...parts));
      // writes in the retention modules: updateMany (destroy: ciphertext/destroyedAt/reason only), deleteMany, and the one nested create in booking.ts
      for (const m of code.matchAll(/paymentMethodCvv\.(update|updateMany|upsert)\(\s*\{[\s\S]*?\}\s*\)/g)) {
        expect(m[0], parts.join("/")).not.toMatch(/expiresAt|signedAt/);
      }
    }
    const booking = stripComments(read("src", "server", "actions", "booking.ts"));
    expect(booking).not.toMatch(/paymentMethodCvv\.(update|updateMany|upsert)/);
  });
});

describe("the documentation states the policy, the consequence and the limits — and never claims compliance", () => {
  const doc = read("docs", "CARD_VAULT_SECURITY.md");

  it("documents the Friday-to-Monday consequence and the example", () => {
    expect(doc).toMatch(/signed \*\*Friday at 5:00 PM\*\* has its CVV\/CVC expire \*\*Saturday at 5:00 PM\*\*/);
    expect(doc).toMatch(/may therefore be unavailable for a Monday manual charge/);
    expect(doc).toMatch(/no weekend extension or Admin renewal mechanism/);
    expect(doc).toMatch(/\*\*no\*\* weekend exception, \*\*no\*\* Monday exception, \*\*no\*\* business-day calculation/);
  });

  it("distinguishes the card-number reveal from the CVV/CVC reveal", () => {
    expect(doc).toMatch(/Reveal Card Information and Reveal CVV\/CVC are separate capabilities/);
    expect(doc).toMatch(/Permission to reveal the card number does not by itself grant CVV\/CVC access/);
  });

  it("says infrastructure copies are not erased and are not verified", () => {
    expect(doc).toMatch(/does \*\*not\*\* erase historical copies/);
    for (const term of ["WAL", "replicas", "snapshots", "point-in-time-recovery", "disaster-recovery"]) expect(doc).toContain(term);
    expect(doc).toMatch(/REQUIRES MANUAL ACTION/);
  });

  it("states the compliance position and never calls the system PCI compliant", () => {
    expect(doc).toMatch(/does not establish PCI DSS compliance/);
    expect(doc).toMatch(/REQUIRES PCI\/QSA\/ACQUIRER REVIEW/);
    // every mention of "PCI compliant / certified" must be a negation
    for (const m of doc.matchAll(/.{0,40}\bPCI(?: DSS)?[- ](?:compliant|certified)\b.{0,10}/gi)) {
      expect(m[0], m[0]).toMatch(/\b(not|never|nor|no)\b/i);
    }
  });
});
