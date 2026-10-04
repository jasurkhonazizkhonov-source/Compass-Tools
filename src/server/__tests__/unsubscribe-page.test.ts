import { describe, it, expect } from "vitest";
import { maskEmail, renderUnsubscribePage, unsubscribeResponse, type UnsubscribePageState } from "../unsubscribe-page";

// The premium public unsubscribe page: every state renders as one deliberate Compass Tools page, is
// self-contained and script-free, escapes everything dynamic, and never exposes a token, an id or a
// full address.

const confirm = (over: Partial<Extract<UnsubscribePageState, { kind: "confirm" }>> = {}): UnsubscribePageState => ({
  kind: "confirm",
  action: "/api/public/unsubscribe",
  tokenField: { name: "token", value: "tok_secret_123" },
  maskedEmail: "j***@example.com",
  askReason: true,
  ...over,
});
const ALL: UnsubscribePageState[] = [
  confirm(),
  { kind: "done", maskedEmail: "j***@example.com", thanked: true },
  { kind: "already", maskedEmail: "j***@example.com" },
  { kind: "invalid" },
  { kind: "missing" },
  { kind: "rate-limited" },
  { kind: "error" },
  { kind: "done", variant: "sequence" },
  confirm({ variant: "sequence", askReason: false }),
];

describe("maskEmail", () => {
  it("never reveals the full address", () => {
    expect(maskEmail("jane.doe@example.com")).toBe("j***@example.com");
    expect(maskEmail("a@b.co")).toBe("a***@b.co");
    expect(maskEmail("not-an-email")).toBe("your email address");
    expect(maskEmail("@x.com")).toBe("your email address");
  });
});

describe("every state renders the same premium shell", () => {
  it.each(ALL.map((s, i) => [`${s.kind}#${i}`, s] as const))("%s: a complete, responsive, accessible, Compass Tools–branded, script-free document", (_name, state) => {
    const { html } = renderUnsubscribePage(state);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<main");
    expect(html).toMatch(/<h1 id="page-title">/);
    expect(html).toContain("Compass Tools");
    expect(html).toContain("@media (max-width:480px)");
    expect(html).toContain("noindex");
    expect(html).not.toMatch(/<script|javascript:|onerror=|onclick=|<link |@import|https?:\/\/(?!www\.w3\.org)/i);
    expect(html).not.toMatch(/Business Flights/i);
  });

  it("uses the product's design language (navy ink, gold accent, serif headline) — not the old bare box", () => {
    const { html } = renderUnsubscribePage({ kind: "invalid" });
    expect(html).toContain("#1c3a5e");
    expect(html).toContain("#d4a24e");
    expect(html).toContain("Georgia");
    expect(html).not.toContain("max-width:420px;text-align:center");
  });
});

describe("states and wording", () => {
  it("initial state: explains the action, shows the masked address and names no sender or agency, offers the optional reason, never changes anything until confirmed", () => {
    const { html, status } = renderUnsubscribePage(confirm());
    expect(status).toBe(200);
    expect(html).toContain("Unsubscribe from marketing emails");
    expect(html).toContain("j***@example.com");
    expect(html).toContain("from this sender");
    expect(html).not.toMatch(/Business Flights|Meridian|Travel Agency/i);
    expect(html).toContain("<form method=\"post\" action=\"/api/public/unsubscribe\">");
    expect(html).toContain("Why are you unsubscribing?");
    expect(html).toContain("(Optional)");
    for (const label of ["I receive too many emails", "The emails aren't relevant to me", "I'm no longer interested", "The information wasn't useful", "Other"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('<textarea id="comment" name="comment" maxlength="1000"');
    expect(html).toContain("Nothing changes until you confirm");
    expect(html).toContain("aren't affected"); // transactional / personal mail is not implied to stop
    // No option is preselected — answering is optional.
    expect(html).not.toMatch(/<input type="radio"[^>]*checked/);
  });

  it("the token appears only as the hidden form field — nowhere in visible copy — and the address is masked", () => {
    const { html } = renderUnsubscribePage(confirm());
    expect(html.match(/tok_secret_123/g)).toHaveLength(1);
    expect(html).toContain('<input type="hidden" name="token" value="tok_secret_123">');
    expect(html).not.toContain("jane.doe@example.com");
  });

  it("done: a strong confirmation that does not imply transactional email stops, and thanks only if feedback was given", () => {
    const thanked = renderUnsubscribePage({ kind: "done", maskedEmail: "j***@example.com", thanked: true });
    expect(thanked.status).toBe(200);
    expect(thanked.html).toContain("You're unsubscribed");
    expect(thanked.html).toContain("will no longer receive marketing emails");
    expect(thanked.html).toContain("Thank you for your feedback");
    expect(thanked.html).toContain("quotes or bookings are separate");
    expect(renderUnsubscribePage({ kind: "done", maskedEmail: "j***@example.com" }).html).not.toContain("Thank you for your feedback");
  });

  it("already unsubscribed: says so, with no form to submit", () => {
    const { html, status } = renderUnsubscribePage({ kind: "already", maskedEmail: "j***@example.com" });
    expect(status).toBe(200);
    expect(html).toContain("already unsubscribed");
    expect(html).not.toContain("<form");
  });

  it("invalid / missing / rate-limited / error carry the right HTTP statuses and reveal nothing internal", () => {
    expect(renderUnsubscribePage({ kind: "invalid" }).status).toBe(404);
    expect(renderUnsubscribePage({ kind: "missing" }).status).toBe(400);
    expect(renderUnsubscribePage({ kind: "rate-limited" }).status).toBe(429);
    expect(renderUnsubscribePage({ kind: "error" }).status).toBe(500);
    for (const kind of ["invalid", "missing", "rate-limited", "error"] as const) {
      const { html } = renderUnsubscribePage({ kind });
      expect(html).not.toMatch(/token|database|prisma|stack|undefined|null/i);
      expect(html).not.toContain("<form");
    }
  });

  it("the sequence variant is about automated emails and never offers the marketing reason form", () => {
    const { html } = renderUnsubscribePage(confirm({ variant: "sequence", askReason: false }));
    expect(html).toContain("automated");
    expect(html).not.toContain("Why are you unsubscribing?");
    expect(html).not.toContain("<textarea");
  });
});

describe("escaping and the validation re-render", () => {
  it("escapes the masked address and any echoed draft — markup never executes", () => {
    const evil = '<img src=x onerror=alert(1)> "quoted" & <script>alert(2)</script>';
    const { html } = renderUnsubscribePage(confirm({ maskedEmail: evil, draft: { category: '"><script>x</script>', text: evil } }));
    expect(html).not.toMatch(/<img src=x|<script>alert|onerror=alert\(1\)>/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toMatch(/checked/); // a tampered category is not marked checked
  });

  it("a validation problem re-renders the form with an alert, a 400, and the customer's text preserved", () => {
    const { html, status } = renderUnsubscribePage(confirm({ error: "Please keep your comment under 1000 characters.", draft: { category: "NOT_USEFUL", text: "my long comment" } }));
    expect(status).toBe(400);
    expect(html).toContain('role="alert"');
    expect(html).toContain("under 1000 characters");
    expect(html).toContain(">my long comment</textarea>");
    expect(html).toMatch(/value="NOT_USEFUL" checked/);
  });
});

describe("unsubscribeResponse hardening headers", () => {
  it("is never cached or indexed, does not leak the token via Referer, cannot be framed or run script, and posts only to itself", () => {
    const res = unsubscribeResponse(confirm());
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("script-src");
  });

  it("extra headers (Retry-After) are applied", () => {
    expect(unsubscribeResponse({ kind: "rate-limited" }, { "Retry-After": "60" }).headers.get("Retry-After")).toBe("60");
  });
});
