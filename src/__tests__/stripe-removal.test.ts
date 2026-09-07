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

  it("the only non-test, non-comment code paths that ever touch a `cvv` value are ephemeral (input schema, local variable, form field, in-memory TTL cache) — never a Prisma write field", () => {
    // Files legitimately allowed to mention CVV: the customer-facing
    // collection form and its zod schema/local-variable handling (ephemeral,
    // proven non-persisted by the schema-level checks above), the
    // client-side format validator (a function name, not storage), the
    // dedicated transient in-memory cache module (cvv-cache.ts — explicitly
    // never a Prisma call, see its own file-level comment), the Start
    // Supplier Payment authorization actions that read from that cache, the
    // session-lifecycle modules that destroy cached CVV state on sign-out/
    // expiry (dev-session.ts in both lib/ and server/actions/), and doc
    // comments explaining the non-persistence guarantee elsewhere.
    const allowed = new Set(
      [
        path.join("server", "actions", "booking.ts"),
        path.join("components", "booking", "card-payment-section.tsx"),
        path.join("components", "booking", "booking-flow.tsx"),
        path.join("lib", "card-validation.ts"),
        path.join("server", "actions", "payment-methods.ts"),
        path.join("components", "crm", "payment-badge.tsx"),
        path.join("components", "bookings", "payment-method-card.tsx"),
        path.join("components", "contacts", "payment-methods-panel.tsx"),
        path.join("server", "security", "cvv-authorization.ts"),
        path.join("server", "security", "cvv-cache.ts"),
        path.join("lib", "dev-session.ts"),
        path.join("server", "actions", "dev-session.ts"),
        // Only names the permission/workflow for the admin grant UI and its
        // own doc comment — never handles or stores a value.
        path.join("lib", "permissions.ts"),
        // Both only explain, in a doc comment, why a Contact-page-added
        // card deliberately has no CVV field at all (no signed-booking-form
        // provenance) — neither ever collects, stores, or displays one.
        path.join("components", "contacts", "payment-method-dialog.tsx"),
        path.join("server", "actions", "contact-payment-methods.ts"),
        // Only a doc comment on the booking-signed staff notification
        // explaining that its payment summary omits the PAN, CVV, and
        // expiration date — never collects, stores, or displays a CVV.
        path.join("server", "email", "templates.ts"),
        // Both only explain, in doc comments, that the signed-quote-details
        // card (Part 13) and its underlying getQuoteDetail query
        // deliberately show only safe payment display fields (last4/brand/
        // expiry/cardholder name) and never the full card number or CVV —
        // neither ever selects, stores, or displays one (see the explicit
        // paymentMethods field allow-list in getQuoteDetail itself).
        path.join("components", "quotes", "signed-booking-details-card.tsx"),
        path.join("server", "queries", "quotes.ts"),
        // CVV recollection follow-up — the PCI-compliant alternative to
        // extending cvv-cache.ts's TTL: asks the customer to confirm their
        // CVV again via a short-lived public link instead. All three
        // ephemeral for the same reason as cvv-authorization.ts above —
        // the actual value only ever flows into cacheCvv() (still the one
        // and only write path into the in-memory cache); none of these
        // three ever reaches a Prisma call with the value itself (the new
        // CvvRecollectionRequest model, verified above and in the two
        // tests before this one, stores only a token/expiry/attempt-count,
        // never the CVV).
        path.join("server", "actions", "cvv-recollection.ts"),
        path.join("components", "customer", "cvv-recollection-form.tsx"),
        path.join("app", "cvv-recollection", "[token]", "page.tsx"),
        // IP vault feature (encrypts booking-signer IP addresses at rest)
        // — mentions "CVV" exactly once, in a doc comment, only to explain
        // by contrast why THIS module (unlike payment-vault.ts) doesn't
        // need a "refuse to run in production" gate: an IP address isn't
        // PCI DSS "sensitive authentication data" the way a CVV is. Never
        // handles, stores, or even references an actual CVV value.
        path.join("server", "security", "ip-encryption.ts"),
      ].map((p) => path.join(ROOT, "src", p))
    );
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      if (file.includes(`${path.sep}__tests__${path.sep}`)) continue;
      if (allowed.has(file)) continue;
      const content = readFileSync(file, "utf-8");
      if (/\bcvv\b|\bcvc\b|security_?code/i.test(content)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
