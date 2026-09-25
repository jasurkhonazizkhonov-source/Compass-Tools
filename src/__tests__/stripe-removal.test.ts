import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

// Repo-wide static guards for the payment architecture. History: the original
// native Stripe integration was removed; card capture is now delegated to a
// PCI-compliant provider (Stripe, through the adapter boundary in
// src/server/payments/) via the provider's hosted fields. These tests walk real
// source/config files on disk (nothing mocked) and pin the properties that must
// never regress: no SDK dependency, provider secrets confined to the adapter
// boundary, the removed legacy modules stay removed, and Compass Tools never
// handles a card security code or stores card credentials.

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

describe("Payment provider boundary — repo-wide verification", () => {
  it("package.json has no payment SDK dependency (the adapter uses the provider's REST API; the browser library is loaded from the provider's own domain)", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const stripeDeps = Object.keys(allDeps).filter((name) => name.toLowerCase().includes("stripe"));
    expect(stripeDeps).toEqual([]);
  });

  it("provider credential env vars are referenced ONLY inside the payments boundary (and the Admin health check that reports Configured/Missing for them) — never in a route, action, component or client bundle", () => {
    const forbidden = ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY", "STRIPE_PUBLIC_KEY", "STRIPE_WEBHOOK_SECRET"];
    const allowed = [path.join("src", "server", "payments") + path.sep, path.join("src", "server", "system", "health-checks.ts")];
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (allowed.some((a) => path.relative(ROOT, file).startsWith(a))) continue;
      // Real-database integration tests are tests like any other: they set fake keys to drive the readiness checks.
      if (file.includes(`${path.sep}__integration__${path.sep}`)) continue;
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

  it("no file outside src/server and src/lib reads a provider/payment credential from the environment (so none can reach a client bundle)", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      const rel = path.relative(ROOT, file);
      if (rel.startsWith(path.join("src", "server") + path.sep) || rel.startsWith(path.join("src", "lib") + path.sep)) continue;
      const content = readFileSync(file, "utf-8");
      if (/process\.env\.(STRIPE|PAYMENT)_/.test(content) || /NEXT_PUBLIC_[A-Z_]*(STRIPE|PAYMENT)/.test(content)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("the provider's browser library is loaded ONLY by the dedicated loader, from the provider's own domain", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      const rel = path.relative(ROOT, file);
      if (rel === path.join("src", "components", "payments", "stripe-js.ts")) continue;
      if (readFileSync(file, "utf-8").includes("js.stripe.com")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("the legacy Stripe webhook route, Stripe client module, and Stripe payment-section component no longer exist", () => {
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
    // Comment lines may (and do) EXPLAIN that no security code is stored; only code lines count.
    const body = modelMatch![1]
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n")
      .replace(/^\s*cvvRecollectionRequests\s+CvvRecollectionRequest\[\].*$/m, "");
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

  it("no CVV/CVC/security-code handling exists anywhere in executable source — Compass Tools never collects, caches or stores one", () => {
    // Comments may still EXPLAIN the rule (several files do), but no
    // executable line — identifier, string, JSX text, schema field — may
    // mention a card security code. There is no allow-list of code files:
    // the previous in-memory CVV cache and everything built on it was
    // removed, so any new hit is a regression to investigate, not to
    // allow-list.
    // The ONE allowed exception: the System Health sanitizer lists the security-
    // code words in its DEFENSIVE key deny-list (so such a key can never be
    // stored in an incident). It handles no value; it only refuses to.
    const DEFENSIVE_DENY_LIST = path.join("src", "server", "system", "health-events.ts");
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      if (file.includes(`${path.sep}__integration__${path.sep}`)) continue;
      if (path.relative(ROOT, file) === DEFENSIVE_DENY_LIST) continue;
      const code = readFileSync(file, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
        .join("\n");
      if (/cvv|\bcvc\b|security_?code|\bcid\b/i.test(code)) offenders.push(path.relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it("the removed CVV modules, routes and email template no longer exist", () => {
    const removed = [
      ["src", "server", "security", "cvv-cache.ts"],
      ["src", "server", "security", "cvv-authorization.ts"],
      ["src", "server", "actions", "cvv-recollection.ts"],
      ["src", "components", "customer", "cvv-recollection-form.tsx"],
      ["src", "app", "cvv-recollection"],
      // The development card vault and its reveal workflow: card numbers are
      // held only by the payment provider now.
      ["src", "server", "security", "payment-vault.ts"],
      ["src", "server", "security", "card-encryption.ts"],
    ];
    for (const parts of removed) {
      expect(() => statSync(path.join(ROOT, ...parts))).toThrow();
    }
  });

  it("the unused legacy CvvRecollectionRequest table is not referenced by ANY code (no route, action, UI, job or health check treats it as a feature)", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      if (path.relative(ROOT, file) === path.join("src", "__tests__", "stripe-removal.test.ts")) continue;
      if (/cvvRecollectionRequest/i.test(readFileSync(file, "utf-8"))) offenders.push(path.relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
    // ...and the table itself has no column that could hold a security code (checked by the schema test above).
  });

  it("no executable source reads or writes the legacy encryptedPan column, and no action can reveal a card number", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      if (file.includes(`${path.sep}__integration__${path.sep}`)) continue;
      const code = readFileSync(file, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
        .join("\n");
      if (/encryptedPan|revealPaymentMethod|getPaymentVault|decryptPan|encryptPan/.test(code)) offenders.push(path.relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it("no payment-related server file logs or serializes a raw request/body/headers object (structured-redaction rule: log safe tags, never payloads)", () => {
    const offenders: string[] = [];
    const dirs = [path.join(ROOT, "src", "server", "payments"), path.join(ROOT, "src", "app", "api", "webhooks")];
    for (const dir of dirs) {
      for (const file of walk(dir)) {
        if (!file.endsWith(".ts") || file.includes(`${path.sep}__tests__${path.sep}`)) continue;
        const code = readFileSync(file, "utf-8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .split("\n")
          .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
          .join("\n");
        // console.* with an interpolated body/payload/headers/err.message, or JSON.stringify of the raw event/body.
        if (/console\.(log|error|warn|info)\([^)]*(rawBody|\bbody\b|payload|headers|\.message|event\.data)/.test(code)) offenders.push(path.relative(ROOT, file));
        if (/JSON\.stringify\((rawBody|body|event|req\b|request)/.test(code)) offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
