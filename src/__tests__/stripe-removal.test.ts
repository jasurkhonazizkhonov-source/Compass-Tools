import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

// Repo-wide static verification that Stripe has been fully removed, per the
// project spec's explicit requirement to prove this before completion. This
// walks real source/config files on disk rather than mocking anything —
// it's the one test in this suite that's about the state of the repository
// itself, not the behavior of a function.

const ROOT = path.resolve(__dirname, "..", "..");
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".prisma", ".env", ".json", ".yml", ".yaml"];

function sourceFiles(): string[] {
  return walk(path.join(ROOT, "src"))
    .concat(walk(path.join(ROOT, "prisma")))
    .filter((f) => SOURCE_EXTENSIONS.some((ext) => f.endsWith(ext)))
    .filter((f) => !f.includes(`${path.sep}generated${path.sep}`)) // Prisma-generated client output, not hand-written code
    .filter((f) => !f.includes(`${path.sep}__tests__${path.sep}`)); // this file (and other test files) legitimately need to name the forbidden terms as literal strings to assert against
}

describe("Stripe removal — repo-wide verification", () => {
  it("package.json has no Stripe dependency of any kind", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const stripeDeps = Object.keys(allDeps).filter((name) => name.toLowerCase().includes("stripe"));
    expect(stripeDeps).toEqual([]);
  });

  it("no Stripe API key / secret / webhook-secret env vars are referenced anywhere in source", () => {
    const forbidden = ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_PUBLIC_KEY", "STRIPE_WEBHOOK_SECRET"];
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const content = readFileSync(file, "utf-8");
      for (const term of forbidden) {
        if (content.includes(term)) offenders.push(`${file}: ${term}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no code imports the Stripe SDK, Stripe.js, or the React Stripe bindings", () => {
    const forbidden = ["from \"stripe\"", "from 'stripe'", "@stripe/stripe-js", "@stripe/react-stripe-js"];
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx") && !file.endsWith(".js") && !file.endsWith(".jsx")) continue;
      const content = readFileSync(file, "utf-8");
      for (const term of forbidden) {
        if (content.includes(term)) offenders.push(`${file}: ${term}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the Stripe webhook route, Stripe client module, and Stripe payment-section component no longer exist", () => {
    const forbiddenPaths = [
      path.join(ROOT, "src", "app", "api", "webhooks", "stripe", "route.ts"),
      path.join(ROOT, "src", "lib", "stripe.ts"),
      path.join(ROOT, "src", "server", "actions", "stripe-payments.ts"),
      path.join(ROOT, "src", "components", "booking", "stripe-payment-section.tsx"),
    ];
    for (const p of forbiddenPaths) {
      expect(() => statSync(p)).toThrow();
    }
  });

  it("no external payment-provider surface exists: no provider module, webhook route, provider env var, CSP host or provider-named schema field", () => {
    for (const parts of [
      ["src", "server", "payments"],
      ["src", "app", "api", "webhooks"],
      ["src", "server", "actions", "payment-setup.ts"],
      ["src", "components", "payments"],
    ]) {
      expect(() => statSync(path.join(ROOT, ...parts))).toThrow();
    }
    const providers = /stripe|paypal|adyen|braintree|authorize\.net|square(?:up)?\.com|PAYMENT_PROVIDER/i;
    const nextConfig = readFileSync(path.join(ROOT, "next.config.ts"), "utf-8");
    expect(nextConfig).not.toMatch(providers);
    expect(nextConfig).not.toMatch(/js\.stripe\.com|frame-src[^;]*payment/i);
    const schemaCode = readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf-8")
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(schemaCode).not.toMatch(/providerCustomerId|providerPaymentMethodId|PaymentWebhookEvent|PaymentVaultStatus/);
    const envExample = readFileSync(path.join(ROOT, ".env.example"), "utf-8");
    expect(envExample.split(/\r?\n/).filter((l) => !l.trim().startsWith("#")).join("\n")).not.toMatch(providers);
  });

  it("the CRM's own payment architecture is present and must not be removed again (vault, customer card entry, masked display + Reveal, manual payment recording, contact payment methods)", () => {
    const required = [
      ["src", "server", "security", "payment-vault.ts"],
      ["src", "server", "security", "card-encryption.ts"],
      ["src", "server", "security", "card-vault-status.ts"],
      ["src", "server", "actions", "payment-methods.ts"],
      ["src", "server", "actions", "contact-payment-methods.ts"],
      ["src", "components", "booking", "card-payment-section.tsx"],
      ["src", "components", "bookings", "payment-method-card.tsx"],
      ["src", "components", "bookings", "charge-customer-panel.tsx"],
      ["docs", "PAYMENT_ARCHITECTURE.md"],
    ];
    for (const parts of required) {
      expect(() => statSync(path.join(ROOT, ...parts)), parts.join("/")).not.toThrow();
    }
    const schema = readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf-8");
    expect(schema).toMatch(/model PaymentMethod \{[\s\S]*?encryptedPan\s+String\b/);
    expect(schema).toMatch(/model PaymentCharge \{/);
    const actions = readFileSync(path.join(ROOT, "src", "server", "actions", "payment-methods.ts"), "utf-8");
    for (const fn of ["revealPaymentMethod", "confirmPaymentReceived"]) expect(actions).toContain(`export async function ${fn}`);
  });

  it("the Prisma schema has no payment_intent / setup_intent fields, and no field/model literally named or prefixed with Stripe (explanatory prose comments contrasting Stripe's tokenization model are expected and fine)", () => {
    const schema = readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf-8");
    expect(schema).not.toMatch(/payment_intent/i);
    expect(schema).not.toMatch(/setup_intent/i);
    // Strip comment lines before checking for an actual Stripe-prefixed
    // field/model/enum name — only code lines matter here.
    const codeOnly = schema
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(codeOnly).not.toMatch(/\bstripe\w*/i);
  });

  // POLICY (narrowed 2026-10-06 at the owner's explicit request; see docs/CARD_VAULT_SECURITY.md §19):
  //   The security code (CVV/CVC) is NEVER stored in plaintext or in any ordinary application data. It exists ONLY as a card-vault
  //   envelope in the dedicated, short-lived PaymentMethodCvv table — destroyed no later than 24 hours after the Booking Form was
  //   signed — and is readable only through the dedicated Admin-only reveal action. Every guard below still fails if the code
  //   appears anywhere else; they now describe exactly where it may be, instead of "nowhere".
  const schemaText = () => readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf-8");
  const stripSchemaComments = (block: string) => block.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  it("the Prisma schema's PaymentMethod model has no cvv/cvc/cid/security_code VALUE field under any name — only two relation pointers", () => {
    const modelMatch = /model PaymentMethod \{([\s\S]*?)\n\}/.exec(schemaText());
    expect(modelMatch).not.toBeNull();
    // Two relation POINTERS to separate models (a request-tracking model and the dedicated PaymentMethodCvv). A Prisma relation
    // field is virtual — it is not a column of the PaymentMethod table (proved against a real database in
    // booking-cvv.integration.test.ts) — and each target model is verified independently below. Nothing else may mention a code.
    const body = stripSchemaComments(modelMatch![1])
      .replace(/^\s*cvvRecollectionRequests\s+CvvRecollectionRequest\[\].*$/m, "")
      .replace(/^\s*retainedSecurityCode\s+PaymentMethodCvv\?.*$/m, "");
    expect(body).not.toMatch(/cvv/i);
    expect(body).not.toMatch(/cvc/i);
    expect(body).not.toMatch(/\bcid\b/i);
    expect(body).not.toMatch(/security_?code/i);
  });

  it("the ONLY model that can hold a security code is PaymentMethodCvv, and it holds it only as ciphertext in `encryptedCvv`", () => {
    const schema = schemaText();
    const modelBlocks = schema.match(/model \w+ \{[\s\S]*?\n\}/g) ?? [];
    for (const block of modelBlocks) {
      // (as before) no model has a column whose NAME is a security code
      expect(block).not.toMatch(/^\s*cvv\b/im);
      expect(block).not.toMatch(/^\s*cvc\b/im);
      expect(block).not.toMatch(/^\s*security_?code\b/im);
    }
    const holders = modelBlocks.filter((b) => /\bencryptedCvv\b/.test(stripSchemaComments(b)));
    expect(holders).toHaveLength(1);
    expect(holders[0]).toMatch(/^model PaymentMethodCvv \{/);
    // its complete column set: nothing that could carry a plaintext or a second copy
    const columns = stripSchemaComments(holders[0])
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("model ") && l !== "}" && !l.startsWith("@@"))
      .map((l) => l.split(/\s+/)[0]);
    expect(columns).toEqual(["paymentMethodId", "paymentMethod", "encryptedCvv", "signedAt", "expiresAt", "destroyedAt", "destroyedReason", "createdAt"]);
    expect(holders[0]).toMatch(/encryptedCvv\s+String\?/);
  });

  it("the migration lets the database itself refuse a plaintext value and a retention longer than 24 hours", () => {
    const dir = readdirSync(path.join(ROOT, "prisma", "migrations")).find((d) => d.endsWith("booking_cvv_temporary_retention"));
    expect(dir).toBeDefined();
    const sql = readFileSync(path.join(ROOT, "prisma", "migrations", dir!, "migration.sql"), "utf-8");
    // (the rollback note in the leading comments legitimately says DROP TABLE)
    const code = sql.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(sql).toMatch(/CREATE TABLE "PaymentMethodCvv"/);
    expect(sql).toMatch(/PaymentMethodCvv_encryptedCvv_envelope[\s\S]*cv2\\\./);
    expect(sql).toMatch(/"expiresAt" = "signedAt" \+ INTERVAL '24 hours'/);
    expect(sql).toMatch(/ON DELETE CASCADE/);
    // additive only: it touches no existing table
    expect(code).not.toMatch(/ALTER TABLE "(?!PaymentMethodCvv")/);
    expect(code).not.toMatch(/DROP |DELETE FROM|UPDATE "/i);
  });

  // The security code is first TRANSIENT input: the customer types it into the booking form, it travels once with "Finish
  // Booking" and the server format-checks it. It is then encrypted straight away and held ONLY in PaymentMethodCvv (RETENTION
  // files below). Every executable mention of the code in source must be in one of these two groups; any other file is a regression.
  const TRANSIENT_CODE_FILES = [
    path.join("src", "components", "booking", "card-payment-section.tsx"), // the input
    path.join("src", "components", "booking", "booking-flow.tsx"), // validation + the one submit payload + clearing
    path.join("src", "lib", "card-validation.ts"), // isValidCvvFormat (format check only)
    path.join("src", "server", "actions", "booking.ts"), // schema key, format check, hand-off to the encrypting retention module, discard
  ];
  const RETENTION_FILES = [
    path.join("src", "server", "security", "booking-cvv.ts"), // creation prep, destroy, 24h cleanup
    path.join("src", "server", "actions", "booking-cvv.ts"), // the ONLY reveal / explicit destroy
    path.join("src", "server", "queries", "booking-cvv.ts"), // existence + expiry for the Admin UI — never the value
    path.join("src", "server", "security", "card-encryption.ts"), // encryptCvv / decryptCvv (own AAD domain)
    path.join("src", "server", "security", "payment-vault.ts"), // getCvvVault (fail-closed gate)
    path.join("src", "server", "security", "card-audit.ts"), // CVV_* audit action names
    path.join("src", "server", "security", "rate-limit.ts"), // CVV_REVEAL bucket
    path.join("src", "lib", "permissions.ts"), // canRevealBookingCvv
    path.join("src", "lib", "prisma.ts"), // secondary defence: global omit of the ciphertext column
    path.join("src", "components", "bookings", "cvv-reveal.tsx"), // Admin-only reveal / destroy UI
    path.join("src", "components", "bookings", "payment-method-card.tsx"), // renders CvvReveal only when the server passes `cvv`
    path.join("src", "app", "(crm)", "bookings", "[id]", "page.tsx"), // asks for existence/expiry states (Admin-only)
    path.join("src", "app", "api", "cron", "tasks", "route.ts"), // daily 24h cleanup
    path.join("src", "server", "actions", "payment-methods.ts"), // destroy when the payment is recorded as charged / cancelled
    path.join("src", "server", "actions", "contact-payment-methods.ts"), // destroy when the card is removed
  ];
  const executableCode = (file: string) =>
    readFileSync(file, "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // \r?\n: on a Windows checkout files have CRLF, and a stray \r would stop the comment strip matching.
      .split(/\r?\n/)
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
      .join("\n");

  it("security-code handling exists ONLY in the files that take it as input or implement the protected retention — nowhere else in executable source", () => {
    // The System Health sanitizer lists the security-code words in its
    // DEFENSIVE key deny-list (so such a key can never be stored in an
    // incident). It handles no value; it only refuses to.
    const DEFENSIVE_DENY_LIST = path.join("src", "server", "system", "health-events.ts");
    const allowed = new Set([DEFENSIVE_DENY_LIST, ...TRANSIENT_CODE_FILES, ...RETENTION_FILES]);
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      if (file.includes(`${path.sep}__integration__${path.sep}`)) continue;
      if (allowed.has(path.relative(ROOT, file))) continue;
      if (/cvv|\bcvc\b|security_?code|\bcid\b/i.test(executableCode(file))) offenders.push(path.relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it("the ciphertext column and the decrypt call are touched only where they must be", () => {
    const withToken = (re: RegExp) =>
      sourceFiles()
        .filter((f) => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.includes(`${path.sep}__integration__${path.sep}`))
        .filter((f) => re.test(executableCode(f)))
        .map((f) => path.relative(ROOT, f))
        .sort();
    // the encrypted value is read/written in: creation + cleanup module, the reveal action, and the one create in submitBooking (+ the omit config and the schema)
    expect(withToken(/\bencryptedCvv\b/)).toEqual(
      [
        path.join("src", "lib", "prisma.ts"),
        path.join("src", "server", "actions", "booking-cvv.ts"),
        path.join("src", "server", "actions", "booking.ts"),
        path.join("src", "server", "security", "booking-cvv.ts"),
      ].sort()
    );
    expect(withToken(/\bdecryptCvv\b/)).toEqual([path.join("src", "server", "security", "card-encryption.ts"), path.join("src", "server", "security", "payment-vault.ts")].sort());
    // the only code that can turn a stored envelope back into the value
    expect(withToken(/getCvvVault\(\)\.reveal/)).toEqual([path.join("src", "server", "actions", "booking-cvv.ts")]);
    // the reveal action is called from exactly one component
    expect(withToken(/\brevealBookingCvv\b/)).toEqual([path.join("src", "components", "bookings", "cvv-reveal.tsx"), path.join("src", "server", "actions", "booking-cvv.ts")].sort());
  });

  it("the server action takes the security code in exactly these ways — a schema key, a format check, and a hand-off to the encrypting retention module — and never to the database, a log or an e-mail in plaintext", () => {
    const code = executableCode(path.join(ROOT, "src", "server", "actions", "booking.ts"));
    const lines = code.split("\n").filter((l) => /cvv/i.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const ok =
        /^\s*cvv: z\.string\(\)/.test(line) || // the schema key
        /isValidCvvFormat/.test(line) || // the format check (also its import)
        /const submittedCvv = card\.cvv;/.test(line) || // read once, after the format check
        /\(card as \{ cvv\?: string \}\)\.cvv = undefined/.test(line) || // the discard from the parsed input
        /card\.cvv !== undefined/.test(line) || // the guard around the format check
        /pendingCvvs/.test(line) || // the short-lived holder until the signing time is fixed
        /pending\.cvv/.test(line) || // handed to prepareCvvForStorage, then cleared
        /prepareCvvForStorage|PreparedCvv/.test(line) || // the encrypting module (import / call)
        /retainedCvv|cvvNotRetained|retainedSecurityCode|encryptedCvv|BOOKING_CVV_NOT_RETAINED|CVV\/CVC|submittedCvv/.test(line); // the encrypted create / its bookkeeping
      expect(ok, line.trim()).toBe(true);
    }
    // the plaintext only ever reaches the encrypting function; never a vault.store, a log, a response or an e-mail
    expect(code).not.toMatch(/store\([^)]*card\b[^.]/);
    expect(code).not.toMatch(/console\.\w+\([^)]*\bcvv\b/i);
    expect(code).not.toMatch(/pending\.cvv[^;\n]*(JSON|log|send|email)/i);
    // the data written for the retained code is the ENCRYPTED value only
    expect(code).toMatch(/encryptedCvv: retainedCvv\.get\(c\.id\)!\.encryptedCvv/);
  });

  it("no retention file ever logs, e-mails, stores in a browser or puts the code in a URL", () => {
    for (const rel of RETENTION_FILES) {
      const code = executableCode(path.join(ROOT, rel));
      for (const line of code.split("\n").filter((l) => /cvv|cvc|securitycode/i.test(l))) {
        expect(line, `${rel}: ${line.trim()}`).not.toMatch(/localStorage|sessionStorage|cookie\b|indexedDB|searchParams|router\.(push|replace)|URLSearchParams|sendEmail|sendMail|nodemailer/);
        // a log line may name a fixed tag, never interpolate a value
        if (/console\./.test(line)) expect(line, `${rel}: ${line.trim()}`).toMatch(/\[booking\] CVV_[A-Z_]+ \(\$\{[^}]*\}\)/);
      }
    }
    // the Admin component keeps the value in component state only
    const ui = executableCode(path.join(ROOT, "src", "components", "bookings", "cvv-reveal.tsx"));
    expect(ui).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB|console\./);
  });

  it("the form keeps the security code in React state only — never in browser storage, a cookie, a URL or a console call", () => {
    for (const rel of [TRANSIENT_CODE_FILES[0], TRANSIENT_CODE_FILES[1]]) {
      const code = executableCode(path.join(ROOT, rel));
      for (const line of code.split("\n").filter((l) => /cvv/i.test(l))) {
        expect(line, line.trim()).not.toMatch(/localStorage|sessionStorage|cookie|indexedDB|console\.|searchParams|router\.(push|replace)|URLSearchParams|fetch\(|JSON\.stringify/);
      }
    }
    // and the flow clears it after every definitive answer
    const flow = executableCode(path.join(ROOT, TRANSIENT_CODE_FILES[1]));
    expect((flow.match(/cvv: ""/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("the removed CVV modules, routes and email template no longer exist", () => {
    const removed = [
      ["src", "server", "security", "cvv-cache.ts"],
      ["src", "server", "security", "cvv-authorization.ts"],
      ["src", "server", "actions", "cvv-recollection.ts"],
      ["src", "components", "customer", "cvv-recollection-form.tsx"],
      ["src", "app", "cvv-recollection"],
    ];
    for (const parts of removed) {
      expect(() => statSync(path.join(ROOT, ...parts))).toThrow();
    }
  });
});
