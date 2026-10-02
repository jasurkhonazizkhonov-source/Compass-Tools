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

  it("the Prisma schema's PaymentMethod model has no cvv/cvc/cid/security_code VALUE field under any name", () => {
    const schema = readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf-8");
    const modelMatch = /model PaymentMethod \{([\s\S]*?)\n\}/.exec(schema);
    expect(modelMatch).not.toBeNull();
    // CVV recollection follow-up: PaymentMethod now has one relation array
    // field, `cvvRecollectionRequests CvvRecollectionRequest[]` — a
    // relation POINTER to a separate request-tracking model, not a value
    // column, so it's stripped before this check the same way the file
    // header already treats explanatory comments as out of scope. The
    // model it points to is independently verified immediately below to
    // hold no actual CVV value column either — this isn't a blind
    // exception, it's backed by its own assertion.
    const body = modelMatch![1].replace(/^\s*cvvRecollectionRequests\s+CvvRecollectionRequest\[\].*$/m, "");
    expect(body).not.toMatch(/cvv/i);
    expect(body).not.toMatch(/cvc/i);
    expect(body).not.toMatch(/\bcid\b/i);
    expect(body).not.toMatch(/security_?code/i);
  });

  it("no Prisma model anywhere defines a cvv/cvc/cid/security_code column (the only place this could ever be persisted)", () => {
    const schema = readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf-8");
    const modelBlocks = schema.match(/model \w+ \{[\s\S]*?\n\}/g) ?? [];
    for (const block of modelBlocks) {
      expect(block).not.toMatch(/^\s*cvv\b/im);
      expect(block).not.toMatch(/^\s*cvc\b/im);
      expect(block).not.toMatch(/^\s*security_?code\b/im);
    }
  });

  // The security code is TRANSIENT input only: the customer types it into the
  // booking form, it travels once with "Finish Booking", the server format-
  // checks it and drops it. It is never stored, cached, logged, e-mailed or
  // returned (and Reveal can never show it, because nothing keeps it). That
  // handling is confined to exactly these four files; any other mention in
  // executable source is a regression to investigate.
  const TRANSIENT_CODE_FILES = [
    path.join("src", "components", "booking", "card-payment-section.tsx"), // the input
    path.join("src", "components", "booking", "booking-flow.tsx"), // validation + the one submit payload + clearing
    path.join("src", "lib", "card-validation.ts"), // isValidCvvFormat (format check only)
    path.join("src", "server", "actions", "booking.ts"), // schema key, format check, discard
  ];
  const executableCode = (file: string) =>
    readFileSync(file, "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // \r?\n: on a Windows checkout files have CRLF, and a stray \r would stop the comment strip matching.
      .split(/\r?\n/)
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
      .join("\n");

  it("security-code handling exists ONLY in the four files that take it as transient input — nowhere else in executable source", () => {
    // The System Health sanitizer lists the security-code words in its
    // DEFENSIVE key deny-list (so such a key can never be stored in an
    // incident). It handles no value; it only refuses to.
    const DEFENSIVE_DENY_LIST = path.join("src", "server", "system", "health-events.ts");
    const allowed = new Set([DEFENSIVE_DENY_LIST, ...TRANSIENT_CODE_FILES]);
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      if (file.includes(`${path.sep}__integration__${path.sep}`)) continue;
      if (allowed.has(path.relative(ROOT, file))) continue;
      if (/cvv|\bcvc\b|security_?code|\bcid\b/i.test(executableCode(file))) offenders.push(path.relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it("the server action touches the security code in exactly three ways — a schema key, a format check, and the discard — and never hands it to the database, the vault, a log or an e-mail", () => {
    const code = executableCode(path.join(ROOT, "src", "server", "actions", "booking.ts"));
    const lines = code.split("\n").filter((l) => /cvv/i.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const ok =
        /^\s*cvv: z\.string\(\)/.test(line) || // the schema key
        /isValidCvvFormat/.test(line) || // the format check (also its import)
        /\(card as \{ cvv\?: string \}\)\.cvv = undefined/.test(line) || // the discard
        /card\.cvv !== undefined/.test(line); // the guard around the format check
      expect(ok, line.trim()).toBe(true);
    }
    // the only identifier it could be passed through is `card`, and none of the
    // calls that persist, encrypt, log or send receive the whole card object
    expect(code).not.toMatch(/store\([^)]*card\b[^.]/);
    expect(code).not.toMatch(/console\.\w+\([^)]*\bcvv\b/i);
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
