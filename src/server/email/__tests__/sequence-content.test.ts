import { describe, it, expect } from "vitest";
import { analyzeStepContent, MAX_STEP_HTML_CHARS, personalizeStepHtml, renderStepBodyHtml, sanitizeAndStyleStepHtml, sanitizeStepHtml } from "../sequence-content";
import type { SequenceVariableContext } from "@/lib/sequence-variables";

// What the server does with a step written in the visual editor: it is cleaned, styled for email clients, personalised without ever letting a customer's name inject markup,
// and judged before saving. The same functions run when a step is saved, previewed and sent.
const CTX: SequenceVariableContext = {
  contactFirstName: "Sarah", contactLastName: "Mitchell", contactPhone: "(555) 214-7890", contactEmail: "sarah@example.com",
  departureCity: "New York", departureAirport: "JFK", arrivalCity: "London", arrivalAirport: "LHR", departureDate: "Sep 12, 2026", returnDate: "Sep 20, 2026",
  tripType: "Round Trip", cabinClass: "Business", senderFirstName: "Alex", senderLastName: "Rivera", senderPhone: "(800) 555-0199", senderEmail: "alex@example.com", companyName: "Example Travel Co",
};
const BRAND = "#1c3a5e";

describe("cleaning", () => {
  it("removes scripts, event handlers, javascript: links, forms, iframes and CSS that can fetch - and keeps the formatting people actually use", () => {
    const dirty =
      '<p style="text-align:center;color:#c00" onclick="steal()">Hi <strong>there</strong><script>alert(1)</script></p>' +
      '<a href="javascript:alert(1)">bad</a><a href="https://example.com/x">good</a>' +
      '<iframe src="https://evil.example"></iframe><form action="https://evil.example"><input></form>' +
      '<div style="background:url(https://evil.example/x.png);color:#111">styled</div><img src="https://cdn.example/a.png" alt="A" onerror="x()">';
    const clean = sanitizeStepHtml(dirty);
    expect(clean).not.toMatch(/script|onclick|onerror|javascript:|iframe|<form|<input|url\(/i);
    expect(clean).toContain("text-align:center");
    expect(clean).toContain("<strong>there</strong>");
    expect(clean).toContain('href="https://example.com/x"');
    expect(clean).toContain('src="https://cdn.example/a.png"');
  });

  it("is idempotent: cleaning the cleaned output changes nothing (safe to apply at save, preview and send)", () => {
    const once = sanitizeStepHtml('<h2 style="color:#123456">T</h2><p>a <a href="https://x.example" target="_blank">b</a></p><ul><li>one</li></ul>');
    expect(sanitizeStepHtml(once)).toBe(once);
    const styled = sanitizeAndStyleStepHtml(once, BRAND);
    expect(sanitizeAndStyleStepHtml(styled, BRAND)).toBe(styled);
  });

  it("keeps the editor's own blocks (call-to-action button, spacer) marked, so they come back as blocks when a step is reopened", () => {
    const html =
      '<table data-compass-block="button" role="presentation" align="center" cellpadding="0" cellspacing="0"><tbody><tr><td bgcolor="#1d4ed8" style="border-radius:6px"><a href="https://example.com/book" style="display:inline-block;padding:12px 28px;color:#ffffff;text-decoration:none">Book now</a></td></tr></tbody></table>' +
      '<div data-compass-block="spacer" style="height:24px;line-height:24px;font-size:1px">&nbsp;</div>';
    const clean = sanitizeStepHtml(html);
    expect(clean).toContain('data-compass-block="button"');
    expect(clean).toContain('data-compass-block="spacer"');
    expect(clean).toContain('bgcolor="#1d4ed8"');
    expect(clean).toContain("padding:12px 28px");
  });
});

describe("email-safe inline styling", () => {
  it("adds inline styles to every element the editor produces (email clients ignore <style> blocks)", () => {
    const html = sanitizeAndStyleStepHtml("<h1>Title</h1><p>Body <a href=\"https://x.example\">link</a></p><ul><li>a</li></ul><blockquote>q</blockquote><hr>", BRAND);
    expect(html).toMatch(/<h1 style="[^"]*font-size:26px/);
    expect(html).toMatch(/<p style="[^"]*line-height:1\.75/);
    expect(html).toMatch(/<a href="https:\/\/x\.example" style="[^"]*color:#1c3a5e/); // the brand colour
    expect(html).toMatch(/<li style="[^"]*margin:0 0 6px/);
    expect(html).toMatch(/<hr style="[^"]*border-top/);
    expect(html).toMatch(/<blockquote style="[^"]*border-left/);
  });

  it("what the author chose always wins over the defaults (colour, alignment, size)", () => {
    const html = sanitizeAndStyleStepHtml('<p style="color:#ff0000;text-align:right;font-size:20px">x</p>', BRAND);
    expect(html).toContain("color:#ff0000");
    expect(html).toContain("text-align:right");
    expect(html).toContain("font-size:20px");
    expect(html).not.toContain("color:#4b5563"); // the default body colour was replaced, not added
  });

  it("images get width/height ATTRIBUTES as well as CSS (Outlook ignores CSS sizes), keep their shape on a phone (height:auto, max-width:100%), and a height is only written when the author set one", () => {
    const html = sanitizeAndStyleStepHtml('<img src="https://cdn.example/a.png" alt="Beach" width="320" height="240" style="width:320px">', BRAND);
    expect(html).toContain('width="320"');
    expect(html).toContain('height="240"');
    expect(html).toMatch(/max-width:100%/);
    expect(html).toMatch(/height:auto/);
    const noHeight = sanitizeAndStyleStepHtml('<img src="https://cdn.example/a.png" alt="Beach" style="width:320px">', BRAND);
    expect(noHeight).toContain('width="320"');
    expect(noHeight).not.toMatch(/\sheight="/);
    expect(html).toContain('alt="Beach"');
    expect(html).toContain("border:0");
  });

  it("empty paragraphs (the editor leaves one after a button or divider) are not sent as blank gaps, but a paragraph with a picture or text is kept", () => {
    const html = sanitizeAndStyleStepHtml('<p>Hello</p><p></p><p><img src="https://cdn.example/a.png" alt="x"></p><p>  </p><p>Bye</p>', BRAND);
    expect(html.match(/<p /g)?.length).toBe(3);
    expect(html).toContain("Hello");
    expect(html).toContain("<img");
    expect(html).toContain("Bye");
  });

  it("an invalid brand colour falls back to a safe default rather than being written into a style", () => {
    expect(sanitizeAndStyleStepHtml('<a href="https://x.example">x</a>', "red;background:url(x)")).toContain("color:#1d4ed8");
  });
});

describe("personalization", () => {
  it("fills the known tokens from the recipient's data, case-insensitively and with spaces allowed", () => {
    expect(personalizeStepHtml("<p>Hi {{contact_first_name}}, {{ Arrival_City }} from {{departure_airport}}</p>", CTX)).toBe("<p>Hi Sarah, London from JFK</p>");
  });

  it("a customer's own data can NEVER inject markup: values are HTML-escaped before the cleaner runs", () => {
    const hostile: SequenceVariableContext = { ...CTX, contactFirstName: '<script>alert(1)</script><img src=x onerror=alert(2)>"' };
    const out = renderStepBodyHtml("<p>Hi {{contact_first_name}}</p>", hostile, BRAND);
    expect(out).not.toMatch(/<script|<img\b/i); // no tag was created from the customer's data
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&lt;img src=x onerror=alert(2)&gt;"); // it is shown as harmless text
  });

  it("an unknown token is left exactly as written (and the analysis warns about it)", () => {
    expect(personalizeStepHtml("<p>{{nope}}</p>", CTX)).toBe("<p>{{nope}}</p>");
  });

  it("a missing value becomes nothing, never the word 'undefined' or the raw token", () => {
    expect(personalizeStepHtml("<p>[{{return_date}}]</p>", { ...CTX, returnDate: "" })).toBe("<p>[]</p>");
  });

  it("the full render is personalised, cleaned and styled in one go", () => {
    const out = renderStepBodyHtml('<p>Hi {{contact_first_name}} <a href="javascript:x">bad</a></p>', CTX, BRAND);
    expect(out).toContain("Hi Sarah");
    expect(out).not.toContain("javascript:");
    expect(out).toMatch(/<p style=/);
  });
});

describe("analysis before saving", () => {
  const html = (body: string, subject = "Hello") => analyzeStepContent({ subject, body, format: "HTML" });
  const codes = (list: { code: string }[]) => list.map((i) => i.code);

  it("a good step has no errors and no warnings", () => {
    const a = html('<p>Hi {{contact_first_name}}</p><p><a href="https://example.com/trip">See your trip</a></p><img src="https://cdn.example/a.png" alt="Beach">');
    expect(a.ok).toBe(true);
    expect(a.errors).toEqual([]);
    expect(a.warnings).toEqual([]);
    expect(a).toMatchObject({ linkCount: 1, imageCount: 1 });
  });

  it("blocks saving: empty subject, empty content, a link with no address, an unsafe link", () => {
    expect(codes(html("<p>x</p>", "  ").errors)).toContain("subject-empty");
    expect(codes(html("   ").errors)).toContain("body-empty");
    expect(codes(html("<p></p>").errors)).toContain("body-empty");
    expect(codes(html('<p><a href="">x</a></p>').errors)).toContain("link-empty");
    expect(codes(html('<p><a href="#">x</a></p>').errors)).toContain("link-empty");
    expect(codes(html('<p><a href="javascript:alert(1)">x</a></p>').errors)).toContain("link-unsafe");
    expect(codes(html('<p><a href="data:text/html,hi">x</a></p>').errors)).toContain("link-unsafe");
    expect(codes(html('<p><a href="file:///etc/passwd">x</a></p>').errors)).toContain("link-unsafe");
  });

  it("allows web, email and phone links", () => {
    const a = html('<p><a href="https://x.example">a</a> <a href="mailto:agent@example.com">b</a> <a href="tel:+15551234567">c</a></p>');
    expect(a.errors).toEqual([]);
  });

  it("blocks images that recipients could never see: a local path, a relative address, an inline blob, plain http, or none at all", () => {
    for (const src of ["C:\\Users\\me\\Pictures\\a.png", "/uploads/a.png", "a.png", "data:image/png;base64,AAAA", "http://cdn.example/a.png", "blob:https://crm/abc", "file:///a.png"]) {
      expect(codes(html(`<p>x</p><img src="${src}" alt="a">`).errors), src).toContain("image-not-public");
    }
    expect(codes(html("<p>x</p><img alt=\"a\">").errors)).toContain("image-missing");
  });

  it("warns (without blocking) about a missing description, an http:// link, a variable inside a link, an unknown variable and a very large email", () => {
    expect(codes(html('<p>x</p><img src="https://cdn.example/a.png">').warnings)).toContain("image-alt");
    expect(codes(html('<p><a href="http://x.example">x</a></p>').warnings)).toContain("link-insecure");
    expect(codes(html('<p><a href="https://x.example/?n={{contact_first_name}}">x</a></p>').warnings)).toContain("link-variable");
    expect(codes(html("<p>{{foo_bar}}</p>").warnings)).toContain("unknown-variable");
    expect(codes(analyzeStepContent({ subject: "{{nope}}", body: "<p>x</p>", format: "HTML" }).warnings)).toContain("unknown-variable");
    const big = html(`<p>${"x".repeat(80_000)}</p>`);
    expect(big.ok).toBe(true);
    expect(codes(big.warnings)).toContain("large");
  });

  it("an email over Gmail's clipping size cannot be saved", () => {
    const tooBig = html(`<p>${"x".repeat(MAX_STEP_HTML_CHARS + 1)}</p>`);
    expect(tooBig.ok).toBe(false);
    expect(codes(tooBig.errors)).toContain("too-large");
  });

  it("a script in pasted content is reported as removed rather than silently dropped", () => {
    expect(codes(html("<p>x</p><script>alert(1)</script>").warnings)).toContain("script-removed");
  });

  it("plain-text steps get only the checks that apply: variables and http:// links; their content is untouched", () => {
    const a = analyzeStepContent({ subject: "Hi", body: "Hello {{contact_first_name}}, see http://x.example and {{zzz}}", format: "TEXT" });
    expect(a.ok).toBe(true);
    expect(codes(a.warnings).sort()).toEqual(["link-insecure", "unknown-variable"]);
    expect(analyzeStepContent({ subject: "Hi", body: "", format: "TEXT" }).ok).toBe(false);
  });
});
