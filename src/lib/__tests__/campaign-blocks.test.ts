import { describe, it, expect } from "vitest";
import {
  DESIGN_TEMPLATES, SAMPLE_RECIPIENT, emptyDesign, escapeHtml, hasErrors, newBlock, parseStoredDesign, personalizeHtml, personalizeText, renderDesignToHtml, unknownTokens,
  validateCampaignUrl, validateDesign, type CampaignDesign,
} from "../campaign-blocks";
import { sanitizeCampaignHtml } from "@/server/email/sanitize-campaign-html";

const design = (blocks: CampaignDesign["blocks"]): CampaignDesign => ({ version: 1, accent: "#1d4ed8", blocks });

describe("validateCampaignUrl - buttons, linked images, image sources", () => {
  it("accepts absolute http(s) URLs and returns the normalised form", () => {
    expect(validateCampaignUrl("https://example.com/path?a=1#x")).toEqual({ ok: true, url: "https://example.com/path?a=1#x" });
    expect(validateCampaignUrl("  http://example.com  ")).toMatchObject({ ok: true });
  });
  it.each([
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html;base64,AAAA", "vbscript:x", "file:///etc/passwd", "mailto:a@b.com", "tel:+1555",
    "ftp://example.com", "//example.com", "/relative/path", "example.com", "https://", "https://localhost", "https://user:pw@example.com", "https://exa mple.com",
    "https://example.com/\"onmouseover=\"x", "https://example.com/<script>", "", "   ", `https://example.com/${"a".repeat(2100)}`, "https://example.com/\u0000",
  ])("refuses %j", (bad) => {
    expect(validateCampaignUrl(bad).ok).toBe(false);
  });
});

describe("personalization with fallbacks", () => {
  it("uses the recipient's value, else the fallback, else nothing - never the literal token", () => {
    const t = "Hi {{firstName|there}}, {{ lastName }}! ({{fullName|Friend}})";
    expect(personalizeText(t, { firstName: "Ada", lastName: "Lovelace" })).toBe("Hi Ada, Lovelace! (Ada Lovelace)");
    expect(personalizeText(t, { firstName: null, lastName: "" })).toBe("Hi there, ! (Friend)");
    expect(personalizeText(t, {})).not.toMatch(/\{\{/);
  });
  it("escapes the recipient's data in HTML so a hostile name cannot inject markup", () => {
    const out = personalizeHtml("<p>Hello {{firstName|there}}</p>", { firstName: '<img src=x onerror="alert(1)">' });
    expect(out).toBe("<p>Hello &lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>");
    expect(out).not.toContain("<img");
  });
  it("an unknown field is reported, and resolves to nothing rather than to the token", () => {
    expect(unknownTokens("Hello {{nickname}} {{firstName}}")).toEqual(["nickname"]);
    expect(personalizeText("Hello {{nickname}}!", { firstName: "A" })).toBe("Hello !");
  });
  it("email is a field too", () => {
    expect(personalizeText("{{email}}", SAMPLE_RECIPIENT)).toBe("alex.morgan@example.com");
  });
});

describe("renderDesignToHtml - email-safe output", () => {
  const full = design([
    { id: "h", type: "heading", text: "Hello {{firstName|there}}", level: 1, align: "center" },
    { id: "t", type: "text", text: "Line one\nline two\n\nSecond paragraph <b>not bold</b>", align: "left" },
    { id: "i", type: "image", src: "https://img.example.com/a.png", alt: "A \"quoted\" alt", href: "https://example.com", widthPercent: 80 },
    { id: "b", type: "button", label: "Go", url: "https://example.com/go", align: "center", color: "#ff0000" },
    { id: "d", type: "divider" },
    { id: "s", type: "spacer", height: 9999 },
  ]);

  it("produces table-based buttons, inline styles and no scripts or event handlers", () => {
    const html = renderDesignToHtml(full);
    expect(html).toContain('role="presentation"');
    expect(html).toMatch(/<a href="https:\/\/example\.com\/go"[^>]*style="[^"]*background|bgcolor="#ff0000"/);
    expect(html).not.toMatch(/<script|onerror|onclick|javascript:/i);
  });

  it("escapes author text (markup typed as text stays text) but keeps {{tokens}}", () => {
    const html = renderDesignToHtml(full);
    expect(html).toContain("&lt;b&gt;not bold&lt;/b&gt;");
    expect(html).toContain("{{firstName|there}}");
    expect(html).toContain("A &quot;quoted&quot; alt");
  });

  it("caps spacer height and survives the real sanitizer unchanged in substance (nothing the design needs is stripped)", () => {
    const html = renderDesignToHtml(full);
    expect(html).toContain("height:120px");
    const cleaned = sanitizeCampaignHtml(html);
    expect(cleaned).toContain("Hello {{firstName|there}}");
    expect(cleaned).toContain('href="https://example.com/go"');
    expect(cleaned).toContain("<img");
    expect(cleaned).toContain("<table");
    expect(sanitizeCampaignHtml(cleaned)).toBe(cleaned); // idempotent: safe to apply at save and again at send
  });

  it("a hostile button colour or image address cannot break out of its attribute", () => {
    const html = renderDesignToHtml(design([
      { id: "b", type: "button", label: "x", url: 'https://e.com/"onmouseover="alert(1)', align: "left", color: 'red;" onmouseover="x' },
      { id: "i", type: "image", src: 'https://e.com/a.png" onerror="alert(1)', alt: "", href: "", widthPercent: 100 },
    ]));
    expect(html).not.toMatch(/"\s*onmouseover=|"\s*onerror=/i);
  });

  it("is a body fragment only: it never contains the shell or an unsubscribe link of its own (the shell adds the mandatory one)", () => {
    expect(renderDesignToHtml(full)).not.toMatch(/<html|<body|unsubscribe/i);
  });
});

describe("validateDesign", () => {
  const ok = design([{ id: "h", type: "heading", text: "Hi", level: 1, align: "left" }, { id: "b", type: "button", label: "Go", url: "https://example.com", align: "left", color: "#1d4ed8" }]);

  it("a complete design passes", () => {
    expect(validateDesign(ok, "Subject")).toEqual([]);
  });
  it("requires a subject, at least one block and a hex accent", () => {
    expect(validateDesign(ok, "  ").map((i) => i.message)).toContain("Add a subject line.");
    expect(validateDesign(design([]), "S").map((i) => i.message)).toContain("Add at least one block.");
    expect(validateDesign({ ...ok, accent: "blue" }, "S").some((i) => /accent colour/.test(i.message))).toBe(true);
  });
  it("flags every problem on the block it belongs to", () => {
    const issues = validateDesign(
      design([
        { id: "b1", type: "button", label: "", url: "javascript:alert(1)", align: "left", color: "#1d4ed8" },
        { id: "i1", type: "image", src: "", alt: "", href: "ftp://x.com", widthPercent: 100 },
        { id: "t1", type: "text", text: "Hello {{nickname}} [[Offer]]", align: "left" },
      ]),
      "S"
    );
    const forBlock = (id: string) => issues.filter((i) => i.blockId === id).map((i) => i.message).join(" | ");
    expect(forBlock("b1")).toMatch(/label/);
    expect(forBlock("b1")).toMatch(/http/);
    expect(forBlock("i1")).toMatch(/Image address/);
    expect(forBlock("i1")).toMatch(/Image link/);
    expect(forBlock("t1")).toMatch(/nickname/);
    expect(forBlock("t1")).toMatch(/placeholder/);
    expect(hasErrors(issues)).toBe(true);
  });
  it("missing alt text and an http image are warnings, not errors", () => {
    const issues = validateDesign(design([{ id: "i", type: "image", src: "http://img.example.com/a.png", alt: "", href: "", widthPercent: 100 }]), "S");
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
    expect(hasErrors(issues)).toBe(false);
  });
  it("rejects malformed designs, duplicate ids and unknown block types without throwing", () => {
    expect(hasErrors(validateDesign(null, "S"))).toBe(true);
    expect(hasErrors(validateDesign({ version: 2, blocks: [] }, "S"))).toBe(true);
    expect(hasErrors(validateDesign(design([{ id: "x", type: "divider" }, { id: "x", type: "divider" }]), "S"))).toBe(true);
    expect(hasErrors(validateDesign({ version: 1, accent: "#1d4ed8", blocks: [{ id: "q", type: "video" }] }, "S"))).toBe(true);
    expect(hasErrors(validateDesign({ version: 1, accent: "#1d4ed8", blocks: [null] }, "S"))).toBe(true);
  });
  it("warns when the message is large enough for Gmail to clip it (the unsubscribe link would be hidden)", () => {
    const big = design([{ id: "t", type: "text", text: "word ".repeat(1000), align: "left" }, ...Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, type: "text" as const, text: "word ".repeat(1000), align: "left" as const }))]);
    expect(validateDesign(big, "S").some((i) => i.severity === "warning" && /clips/.test(i.message))).toBe(true);
  });
  it("limits the number of blocks", () => {
    const many = design(Array.from({ length: 61 }, (_, i) => ({ id: `d${i}`, type: "divider" as const })));
    expect(validateDesign(many, "S").some((i) => /at most 60/.test(i.message))).toBe(true);
  });
});

describe("templates and helpers", () => {
  it("every starter template is a valid shape (it only needs links before it can be queued)", () => {
    for (const t of DESIGN_TEMPLATES) {
      const d = t.design();
      expect(parseStoredDesign(d)).not.toBeNull();
      const errors = validateDesign(d, "Subject").filter((i) => i.severity === "error");
      // the only blocking problems are the empty button link and the empty image source the author has to fill in
      expect(errors.every((e) => /Button link|Image address/.test(e.message)), t.name).toBe(true);
    }
  });
  it("newBlock creates every type with fresh ids", () => {
    const types = ["heading", "text", "image", "button", "divider", "spacer"] as const;
    const blocks = types.map((t) => newBlock(t));
    expect(new Set(blocks.map((b) => b.id)).size).toBe(types.length);
    expect(blocks.map((b) => b.type)).toEqual([...types]);
    expect(emptyDesign().blocks).toEqual([]);
  });
  it("parseStoredDesign refuses anything that is not a version-1 design", () => {
    expect(parseStoredDesign(null)).toBeNull();
    expect(parseStoredDesign("x")).toBeNull();
    expect(parseStoredDesign({ version: 1, blocks: [] })).toBeNull();
    expect(parseStoredDesign(emptyDesign())).not.toBeNull();
  });
  it("escapeHtml escapes the five dangerous characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});
