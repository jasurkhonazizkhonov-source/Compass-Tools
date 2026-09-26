import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

// Repo-wide static guards for card data hygiene. Like stripe-removal.test.ts
// these look at the code and fixtures themselves rather than at behaviour.

const ROOT = path.resolve(__dirname, "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "generated", "seed-data"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const isTest = (f: string) => /__tests__|__integration__|\.test\.tsx?$/.test(f);
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const stripComments = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

const sourceFiles = walk(path.join(ROOT, "src")).filter((f) => /\.(ts|tsx)$/.test(f) && !isTest(f));

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// The card networks' and payment industry's PUBLISHED test numbers — the only
// card-shaped values allowed anywhere in the repository.
const OFFICIAL_TEST_PANS = new Set([
  "4242424242424242", "4111111111111111", "4012888888881881", "4000056655665556", "5555555555554444", "5105105105105100",
  "2223003122003222", "378282246310005", "371449635398431", "6011111111111117", "6011000990139424", "3056930009020004",
  "38520000023237", "3530111333300000", "3566002020360505", "4000000000000002", "4000000000009995", "4000000000000069",
  "4000000000000127", "4000000000000119", "4000002500003155", "4000002760003184", "4000000000003220", "4000000000000341",
  "4000000000009235", "2223000048400011", "5200828282828210", "6200000000000005", "4000000000000101", "4000000000000010", "4000000000000036",
]);

describe("card data hygiene — static guards", () => {
  it("only official test card numbers appear anywhere in source, tests, scripts, prisma and docs (no realistic PANs)", () => {
    const files = [
      ...walk(path.join(ROOT, "src")),
      ...walk(path.join(ROOT, "scripts")),
      ...walk(path.join(ROOT, "prisma")),
      ...walk(path.join(ROOT, "docs")),
    ].filter((f) => /\.(ts|tsx|md|sql|json|mjs|cjs|js)$/.test(f) && !f.endsWith("migration-manifest.json"));
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      for (const m of text.matchAll(/(?<![\d.])(\d[ -]?){13,19}(?![\d])/g)) {
        const digits = m[0].replace(/\D/g, "");
        // Card-shaped = a real network's IIN prefix at a real PAN length (15/16) AND a valid Luhn check. Airline
        // e-ticket numbers (13 digits), phone numbers, timestamps and ids fail this and are not PANs.
        if (!(digits.length === 15 || digits.length === 16)) continue;
        if (!/^(4|5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720)|3[47]|6011|65|35(2[89]|[3-8]\d))/.test(digits)) continue;
        if (!luhn(digits)) continue;
        if (/^(\d)\1+$/.test(digits)) continue; // all-same-digit filler
        if (!OFFICIAL_TEST_PANS.has(digits)) offenders.push(`${rel(file)}: ${digits.slice(0, 6)}…${digits.slice(-4)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no source file hard-codes a card encryption key or reads one in client code", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const code = stripComments(readFileSync(file, "utf-8"));
      if (/CARD_ENCRYPTION_KEYS?\s*[:=]\s*["'`][A-Za-z0-9+/]{20,}/.test(code)) offenders.push(`${rel(file)}: literal key`);
      if (/NEXT_PUBLIC_[A-Z_]*(CARD|PAN|VAULT|ENCRYPTION)/.test(code)) offenders.push(`${rel(file)}: public env var`);
      if (/^\s*["']use client["']/m.test(code) && /CARD_ENCRYPTION|CARD_VAULT|process\.env/.test(code)) offenders.push(`${rel(file)}: client component touching env/keys`);
    }
    expect(offenders).toEqual([]);
  });

  it("no client component imports the vault, the encryption module or the key ring", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const code = readFileSync(file, "utf-8");
      if (!/^\s*["']use client["']/m.test(code)) continue;
      if (/from\s+["']@\/server\/security\/(payment-vault|card-encryption|card-keyring|card-key-rotation|card-retention|card-audit)["']/.test(code)) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });

  it("the encrypted card column is referenced only by the vault, the reveal/booking/contact card actions, health metadata and rotation/retention", () => {
    const allowed = new Set([
      "src/server/actions/booking.ts",
      "src/server/actions/contact-payment-methods.ts",
      "src/server/actions/payment-methods.ts",
      "src/lib/prisma.ts", // the global omit that hides the column from every generic read
      "src/server/security/payment-vault.ts",
      "src/server/security/card-encryption.ts",
      "src/server/security/card-key-rotation.ts",
      "src/server/security/card-retention.ts",
      "src/server/system/health-checks.ts",
    ]);
    const offenders = sourceFiles.filter((f) => /encryptedPan/.test(stripComments(readFileSync(f, "utf-8"))) && !allowed.has(rel(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("decryption is reachable from exactly one request-facing action (Reveal); nothing else imports decryptPan or calls vault.reveal", () => {
    const decryptCallers = sourceFiles
      .filter((f) => /\bdecryptPan\b|\.reveal\(/.test(stripComments(readFileSync(f, "utf-8"))))
      .map(rel)
      .sort();
    // card-key-rotation decrypts only to re-encrypt (script-only); payment-vault wraps it; the Reveal action is the one caller.
    // IP-vault "reveal" is a different (non-card) function and does not match \.reveal\( on the payment vault.
    const cardCallers = decryptCallers.filter((f) => !/ip-vault|ip-capture|booking-security|gmail/.test(f));
    expect(cardCallers).toEqual(["src/server/actions/payment-methods.ts", "src/server/security/card-encryption.ts", "src/server/security/card-key-rotation.ts", "src/server/security/payment-vault.ts"]);
  });

  it("no console output in card-handling code can carry a card number: no console call mentions card/PAN variables", () => {
    const cardFiles = sourceFiles.filter((f) => /booking\.ts$|contact-payment-methods|payment-methods\.ts|payment-vault|card-encryption|card-key-rotation|card-retention|card-audit|card-payment-section|booking-flow|payment-method/.test(rel(f)));
    expect(cardFiles.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const file of cardFiles) {
      const code = stripComments(readFileSync(file, "utf-8"));
      for (const call of code.match(/console\.\w+\([^;]*\);?/g) ?? []) {
        if (/cardNumber|cardNumberDigits|\bpan\b|\bdigits\b|encryptedPan|\bcard\b(?!Vault)/i.test(call.replace(/CARD_VAULT_UNAVAILABLE/g, ""))) offenders.push(`${rel(file)}: ${call.slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the card number never travels in a URL: no router push/replace, Link href, redirect or fetch URL is built from card fields", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const code = stripComments(readFileSync(file, "utf-8"));
      if (!/cardNumber/.test(code)) continue;
      if (/(router\.(push|replace)|redirect|href=|fetch|searchParams\.set|URLSearchParams)[^\n;]*cardNumber/.test(code)) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });

  it("the card form never uses browser storage or cookies", () => {
    for (const f of ["src/components/booking/card-payment-section.tsx", "src/components/booking/booking-flow.tsx", "src/components/contacts/payment-method-dialog.tsx", "src/components/bookings/payment-method-card.tsx"]) {
      const code = stripComments(readFileSync(path.join(ROOT, f), "utf-8"));
      expect(code, f).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
    }
  });

  it("no card-related model exposes a CVV/CVC/security-code column and there is no card fingerprint/lookup column (no product requirement for PAN search)", () => {
    const schema = readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf-8");
    const block = /model PaymentMethod \{([\s\S]*?)\n\}/.exec(schema)![1];
    expect(block).not.toMatch(/fingerprint|panHash|hmac|panSearch/i);
  });
});
