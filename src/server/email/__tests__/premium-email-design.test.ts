import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { buildMarketingCampaignEmail, buildSequenceEmail } from "../templates";
import { buttonColors, contrastRatio, escapeAttr, isSafeHref, promoteLoneLinksToButtons, renderButton, summarizeForPreheader } from "../design-system";
import type { ResolvedCompanyBranding } from "@/lib/company-config";

// The premium visual system: four message types share one visual language
// (tokens, typography, button, footer) and differ on purpose — marketing is a
// branded editorial layout, a one-to-one message is quiet correspondence, a
// sequence is the same plus the automated-send footer. These tests pin the
// differences, the compliance lines, the safety of author content, and the
// absence of anything that must never reach a customer.

const COMPANY: ResolvedCompanyBranding = {
  id: "co-1",
  name: "Meridian Air Charter",
  website: "https://meridian.example.com",
  phone: "+1 555 010 0100",
  brandColor: "#1c3a5e",
  logoEmailUrl: "https://meridian.example.com/logo-email.png",
  logoWebUrl: "https://meridian.example.com/logo-web.png",
  logoIconUrl: "https://meridian.example.com/logo-icon.png",
  signatureTemplate: "Kind regards,\n{{first_name}} {{last_name}}\n{{phone_number}}",
};
const AGENT = { fullName: "Jane Doe", email: "jane@meridian.example.com", phone: "555-1212" };
const UNSUB = "https://app.example.com/api/public/unsubscribe?token=tok_123";
const SEQ_UNSUB = "https://app.example.com/api/public/sequence-unsubscribe?enrollment=enr-9";

const marketing = (over: Partial<Parameters<typeof buildMarketingCampaignEmail>[0]> = {}) =>
  buildMarketingCampaignEmail({ subject: "A quieter way to reach Lisbon", htmlContent: "<p>Our winter schedule is now open.</p>", unsubscribeUrl: UNSUB, company: COMPANY, ...over });
const personal = (over: Partial<Parameters<typeof buildSequenceEmail>[0]> = {}) =>
  buildSequenceEmail({ subject: "Your Lisbon itinerary", bodyText: "Hello Jordan,\n\nHere is the itinerary we discussed.", agent: AGENT, company: COMPANY, ...over });
const sequence = (over: Partial<Parameters<typeof buildSequenceEmail>[0]> = {}) => personal({ unsubscribeUrl: SEQ_UNSUB, ...over });

describe("marketing email — branded editorial layout", () => {
  it("renders a complete HTML5 document with a viewport meta, logo header, brand accent and a dark hero carrying the subject as the title", () => {
    const { html, subject } = marketing();
    expect(subject).toBe("A quieter way to reach Lisbon");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1" />');
    expect(html).toContain(COMPANY.logoEmailUrl!);
    expect(html).toContain(COMPANY.brandColor);
    expect(html).toMatch(/<h1 class="ct-hero-title"[^>]*>A quieter way to reach Lisbon<\/h1>/);
    expect(html).toContain("#0f1b2d"); // hero ink band
  });

  it("is bounded (640px, table-layout fixed) and ships the mobile rules (stacking buttons, smaller hero title)", () => {
    const { html } = marketing();
    expect(html).toContain("max-width:640px");
    expect(html).toContain("table-layout:fixed;");
    expect(html).toContain("@media only screen and (max-width: 480px)");
    expect(html).toContain(".ct-hero-title");
  });

  it("keeps the unsubscribe link, the company name and contact line, and never invents a legal/registration line", () => {
    const { html } = marketing();
    expect(html).toContain(`href="${UNSUB}"`);
    expect(html).toContain("Unsubscribe");
    expect(html).toContain("You're receiving this because you subscribed to updates from Meridian Air Charter.");
    expect(html).toContain("meridian.example.com");
    expect(html).toContain("+1 555 010 0100");
    expect(html).not.toMatch(/registered in|company number|VAT/i);
  });

  it("the author's HTML is inserted as written; the [TEST] marker stays in the subject but not in the hero title", () => {
    const { html, subject } = marketing({ subject: "[TEST] Winter schedule", htmlContent: "<h2>Heading</h2><p>Body <strong>text</strong> and a <a href=\"https://x.example.com/a\">link</a>.</p>" });
    expect(subject).toBe("[TEST] Winter schedule");
    expect(html).toContain("<h2>Heading</h2>");
    expect(html).toContain("Body <strong>text</strong> and a <a href=\"https://x.example.com/a\">link</a>.");
    expect(html).toMatch(/<h1 class="ct-hero-title"[^>]*>Winter schedule<\/h1>/);
  });

  it("escapes the subject in the hero (a hostile subject cannot inject markup)", () => {
    const { html } = marketing({ subject: `<script>alert(1)</script> "Offer"` });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("derives the inbox preview line from the campaign's own words, not the chrome", () => {
    const { html } = marketing({ htmlContent: "<h2>Winter</h2><p>Our winter schedule is now open &amp; seats are limited.</p>" });
    expect(html).toMatch(/display:none[^>]*>Winter Our winter schedule is now open &amp; seats are limited\./);
    const explicit = marketing({ preheader: "Custom preview" }).html;
    expect(explicit).toContain("Custom preview");
  });

  it("a paragraph holding only a short link becomes a bulletproof button; links in prose stay links", () => {
    const { html } = marketing({ htmlContent: `<p>Details are below.</p><p><a target="_blank" rel="noopener" href="https://meridian.example.com/winter">View the winter schedule</a></p><p>Or read <a href="https://meridian.example.com/faq">our FAQ</a> first.</p>` });
    expect(html).toContain('class="ct-btn-link"');
    expect(html).toContain('href="https://meridian.example.com/winter"');
    expect(html).toContain(">View the winter schedule</a>");
    expect(html).toContain('Or read <a href="https://meridian.example.com/faq">our FAQ</a> first.');
    expect((html.match(/class="ct-btn-link"/g) ?? []).length).toBe(1);
  });

  it("long content stays inside the card: wrapping rules, image max-width, no fixed-width overflow", () => {
    const long = "Supercalifragilistic".repeat(40);
    const { html } = marketing({ subject: long, htmlContent: `<p>${long}</p><img src="https://x.example.com/huge.jpg" width="2400" />` });
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).toContain("img { max-width: 100%; height: auto; }");
    expect(html).toContain("word-wrap: break-word");
  });
});

describe("one-to-one email (Lead / Contact composer, Get in Touch) — quiet correspondence", () => {
  it("has the subtle branded header, the agent's own words and a refined signature, and NO hero and NO unsubscribe", () => {
    const { html } = personal();
    expect(html).toContain(COMPANY.logoEmailUrl!);
    expect(html).toContain("Hello Jordan,");
    expect(html).toContain("Here is the itinerary we discussed.");
    expect(html).not.toContain('class="ct-hero-title"');
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("Unsubscribe");
    expect(html).not.toContain("You are receiving this message");
    expect(html).toContain("max-width:620px");
  });

  it("resolves the signature template against the sending agent and shows their e-mail, the company and its contact line", () => {
    const { html } = personal();
    expect(html).toContain("Kind regards,");
    expect(html).toContain("Jane Doe");
    expect(html).toContain("555-1212");
    expect(html).toContain('href="mailto:jane@meridian.example.com"');
    expect(html).toContain("Meridian Air Charter");
    expect(html).toContain("border-left:3px solid #1c3a5e");
  });

  it("preserves plain-text structure: paragraphs, single line breaks, escaping and linkified URLs", () => {
    const { html } = personal({ bodyText: "Line one\nLine two\n\nUse <b>this</b>: https://example.com/quote/abc" });
    expect(html).toContain("Line one<br/>Line two");
    expect(html).toContain("&lt;b&gt;this&lt;/b&gt;");
    expect(html).toContain('<a href="https://example.com/quote/abc"');
  });

  it("falls back to the company's own name and phone when there is no personal sender", () => {
    const { html } = personal({ agent: undefined });
    expect(html).toContain("Meridian Air Charter");
    expect(html).toContain("+1 555 010 0100");
    expect(html).not.toContain("mailto:");
  });
});

describe("sequence email — automated correspondence", () => {
  it("is the personal layout plus the automated-send footer and a working one-click unsubscribe", () => {
    const { html } = sequence();
    expect(html).not.toContain('class="ct-hero-title"');
    expect(html).toContain(COMPANY.logoEmailUrl!);
    expect(html).toContain(`href="${SEQ_UNSUB}"`);
    expect(html).toContain("Unsubscribe");
    expect(html).toContain("You are receiving this message following your travel enquiry with Meridian Air Charter.");
  });

  it("is distinguishable from a one-to-one email of the same body", () => {
    expect(sequence().html).not.toBe(personal().html);
    expect(personal().html).not.toContain(SEQ_UNSUB);
  });

  it("an explicit variant overrides the default inference", () => {
    expect(personal({ variant: "personal", unsubscribeUrl: SEQ_UNSUB }).html).not.toContain("Unsubscribe");
  });
});

describe("shared guarantees across every premium variant", () => {
  const all = () => [marketing().html, personal().html, sequence().html];

  it("never names the CRM product or the separate Business Flights Travel system", () => {
    for (const html of all()) {
      expect(html).not.toMatch(/Compass Tools|CRM|Business Flights/i);
    }
  });

  it("carries no payment, booking or IP data — the builders do not even accept such fields", () => {
    for (const html of all()) {
      expect(html).not.toMatch(/\b(?:\d[ -]?){13,19}\b/); // no card-number-like digit run
      expect(html).not.toMatch(/cvv|cvc|encryptedPan|ipAddress|bookingReference/i);
    }
  });

  it("uses only web-safe fonts, tables, inline styles — no scripts, no web fonts, no background images, no external stylesheets", () => {
    for (const html of all()) {
      expect(html).not.toMatch(/<script|<link |@import|@font-face|url\(/i);
      expect(html).toContain('role="presentation"');
    }
  });

  it("a company name with quotes and markup cannot break the logo alt attribute or inject HTML", () => {
    const hostile = { ...COMPANY, name: `Evil "Air" <b>Co</b>` };
    for (const html of [marketing({ company: hostile }).html, personal({ company: hostile }).html]) {
      expect(html).toContain('alt="Evil &quot;Air&quot; &lt;b&gt;Co&lt;/b&gt;"');
      expect(html).not.toContain("<b>Co</b>");
    }
  });

  it("without a logo the company name renders as the masthead instead of a broken image", () => {
    const noLogo = { ...COMPANY, logoEmailUrl: null };
    for (const html of [marketing({ company: noLogo }).html, personal({ company: noLogo }).html]) {
      expect(html).not.toContain("<img");
      expect(html).toContain("Meridian Air Charter");
    }
  });

  it("an invalid brand colour falls back to the neutral ink rather than emitting broken CSS", () => {
    const { html } = marketing({ company: { ...COMPANY, brandColor: "not-a-colour" }, htmlContent: `<p><a href="https://x.example.com/go">Go now</a></p>` });
    expect(html).not.toContain("not-a-colour;");
    expect(html).toContain("#0f1b2d");
  });

  it("very long customer-style content (name, route, notes) does not throw", () => {
    const body = ["Dear " + "Alexandria-Montgomery-Featherstonehaugh".repeat(5), "Route: " + "Ouagadougou → Ulaanbaatar → ".repeat(20), "https://example.com/" + "a".repeat(400)].join("\n\n");
    expect(() => personal({ bodyText: body, subject: "x".repeat(300) })).not.toThrow();
    expect(personal({ bodyText: body }).html).toContain("overflow-wrap:anywhere");
  });
});

describe("design-system helpers", () => {
  it("buttonColors picks a readable label colour for dark, light and invalid brand colours", () => {
    for (const brand of ["#1c3a5e", "#0f766e", "#7c2d12", "#fde68a", "#ffffff", "#111", "garbage"]) {
      const { background, text } = buttonColors(brand);
      expect(contrastRatio(background, text)!, brand).toBeGreaterThanOrEqual(4.5);
    }
    expect(buttonColors("#1c3a5e").text).toBe("#ffffff");
    expect(buttonColors("#fde68a").text).toBe("#0f1b2d");
  });

  it("renderButton escapes label and href and supports the outlined secondary tone", () => {
    const primary = renderButton({ href: 'https://x.example.com/?a=1&b="2"', label: "Book <now>", brandColor: "#1c3a5e" });
    expect(primary).toContain("Book &lt;now&gt;");
    expect(primary).toContain("&quot;2&quot;");
    expect(primary).toContain("background:#1c3a5e");
    const secondary = renderButton({ href: "https://x.example.com", label: "Details", brandColor: "#1c3a5e", tone: "secondary" });
    expect(secondary).toContain("border:1px solid #1c3a5e");
  });

  it("promoteLoneLinksToButtons only promotes safe, short, non-URL, lone links", () => {
    const brand = "#1c3a5e";
    const lone = (href: string, text: string) => `<p><a href="${href}">${text}</a></p>`;
    expect(promoteLoneLinksToButtons(lone("https://a.example.com", "Explore"), brand)).toContain("ct-btn-link");
    expect(promoteLoneLinksToButtons(lone("mailto:a@example.com", "Email the desk"), brand)).toContain("ct-btn-link");
    for (const unsafe of [lone("javascript:alert(1)", "Click"), lone("/relative", "Click"), lone("https://a.example.com", "https://a.example.com"), lone("https://a.example.com", "a".repeat(41)), lone("https://a.example.com", "a@b.com"), `<p>Read <a href="https://a.example.com">more</a> here</p>`]) {
      expect(promoteLoneLinksToButtons(unsafe, brand), unsafe).toBe(unsafe);
    }
  });

  it("isSafeHref / escapeAttr", () => {
    expect(isSafeHref("https://a.example.com")).toBe(true);
    expect(isSafeHref(" mailto:a@b.com")).toBe(true);
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,x")).toBe(false);
    expect(escapeAttr(`a"b'c<d>&`)).toBe("a&quot;b&#39;c&lt;d&gt;&amp;");
  });

  it("summarizeForPreheader strips markup and styles, decodes entities, and truncates with an ellipsis", () => {
    expect(summarizeForPreheader("<style>p{}</style><h1>Hi</h1><p>A&nbsp;&amp;&nbsp;B</p>")).toBe("Hi A & B");
    const long = summarizeForPreheader(`<p>${"word ".repeat(100)}</p>`);
    expect(long.length).toBeLessThanOrEqual(140);
    expect(long.endsWith("…")).toBe(true);
    expect(summarizeForPreheader("<img src='x'>")).toBe("");
  });
});

describe("branding boundary", () => {
  it("no hardcoded Business Flights Travel (or CRM product) branding anywhere in the email source", () => {
    const dir = path.join(process.cwd(), "src", "server", "email");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(path.join(dir, file), "utf-8");
      expect(src, file).not.toMatch(/Business Flights/i);
    }
  });
});
