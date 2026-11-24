// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import { emailEditorExtensions } from "../extensions";
import { sanitizeStepHtml, sanitizeAndStyleStepHtml } from "@/server/email/sequence-content";

// The visual editor's HTML has to survive three trips: out of the editor, through the SERVER's allow-list (which decides what is stored and sent), and back into the editor when a
// step is reopened - with nothing lost and nothing unsafe added. These tests run the real editor and the real sanitiser against each other.
const editors: Editor[] = [];
function editor(content: string): Editor {
  const e = new Editor({ element: document.createElement("div"), extensions: emailEditorExtensions(), content });
  editors.push(e);
  return e;
}
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
});
const trip = (html: string) => editor(sanitizeStepHtml(editor(html).getHTML())).getHTML();

describe("text formatting", () => {
  it("bold, italic, underline, strikethrough, colour, highlight, size and alignment all come out as inline styles or tags that survive the server", () => {
    const e = editor("<p>Plain</p>");
    e.chain().focus().selectAll().toggleBold().toggleItalic().toggleUnderline().toggleStrike().setColor("#b91c1c").setBackgroundColor("#fef08a").setFontSize("18px").setTextAlign("center").run();
    const html = sanitizeStepHtml(e.getHTML());
    expect(html).toMatch(/<strong>/);
    expect(html).toMatch(/<em>/);
    expect(html).toMatch(/<u>/);
    expect(html).toMatch(/<s>/);
    // a browser (and jsdom) writes colours it was given as hex back as rgb(): both mean the same colour to an email client
    expect(html).toMatch(/[^-]color:\s*(#b91c1c|rgb\(185,\s*28,\s*28\))/);
    expect(html).toMatch(/background-color:\s*(#fef08a|rgb\(254,\s*240,\s*138\))/);
    expect(html).toMatch(/font-size:\s*18px/);
    expect(html).toMatch(/text-align:\s*center/);
  });

  it("headings 1 to 3 and lists survive, and a heading can be aligned", () => {
    const html = trip('<h1>One</h1><h2 style="text-align:right">Two</h2><h3>Three</h3><ul><li><p>a</p></li></ul><ol><li><p>b</p></li></ol>');
    expect(html).toMatch(/<h1>One<\/h1>/);
    expect(html).toMatch(/<h2 style="text-align:\s*right;?">Two<\/h2>/);
    expect(html).toMatch(/<h3>Three<\/h3>/);
    expect(html).toMatch(/<ul><li><p>a<\/p><\/li><\/ul>/);
    expect(html).toMatch(/<ol><li><p>b<\/p><\/li><\/ol>/);
  });

  it("line spacing is kept", () => {
    const e = editor("<p>x</p>");
    e.chain().focus().selectAll().setLineHeight("2").run();
    expect(sanitizeStepHtml(e.getHTML())).toMatch(/line-height:\s*2/);
  });
});

describe("images", () => {
  it("keep their address, description, width and height - and the size is both an attribute (Outlook) and CSS", () => {
    const html = trip('<p><img src="https://cdn.example/a.png" alt="Beach at sunset" width="320" height="240"></p>');
    expect(html).toContain('src="https://cdn.example/a.png"');
    expect(html).toContain('alt="Beach at sunset"');
    expect(html).toContain('width="320"');
    expect(html).toContain('height="240"');
    expect(html).toMatch(/width:\s*320px/);
  });

  it("can be linked (the picture is wrapped in a link) and aligned (by its paragraph)", () => {
    const html = trip('<p style="text-align:center"><a href="https://example.com/offer"><img src="https://cdn.example/a.png" alt="Offer" width="200"></a></p>');
    expect(html).toContain('href="https://example.com/offer"');
    expect(html).toMatch(/<a [^>]*><img /); // the picture sits inside the link
    expect(html).toMatch(/text-align:\s*center/);
  });

  it("a size that is not a plain number is dropped rather than written into a style", () => {
    const html = editor('<p><img src="https://cdn.example/a.png" alt="x" width="100%;position:fixed"></p>').getHTML();
    expect(html).not.toMatch(/position/);
    expect(html).not.toMatch(/width="100%/);
  });

  it("an embedded (base64) picture is refused by the editor: recipients' mail programs would not show it reliably", () => {
    const html = editor('<p><img src="data:image/png;base64,AAAA" alt="x"></p>').getHTML();
    expect(html).not.toContain("data:image");
  });
});

describe("call-to-action button", () => {
  const BUTTON = { type: "ctaButton", attrs: { href: "https://example.com/book", label: "Book your flight", align: "center", bg: "#1d4ed8", color: "#ffffff" } };

  it("is a table with a coloured cell around a link, marked as the editor's own block", () => {
    const e = editor("<p>Hi</p>");
    e.commands.insertContentAt(e.state.doc.content.size, BUTTON);
    const html = e.getHTML();
    expect(html).toContain('data-compass-block="button"');
    expect(html).toContain('bgcolor="#1d4ed8"');
    expect(html).toContain('href="https://example.com/book"');
    expect(html).toContain("Book your flight");
    expect(html).toMatch(/padding:\s*12px 28px/);
    expect(html).toContain('align="center"');
  });

  it("survives the server and comes back as the SAME button when the step is reopened", () => {
    const e = editor("<p>Hi</p>");
    e.commands.insertContentAt(e.state.doc.content.size, { ...BUTTON, attrs: { ...BUTTON.attrs, align: "left", bg: "#15803d", color: "#ffffff", label: "See offer" } });
    const reopened = editor(sanitizeStepHtml(e.getHTML()));
    const node = reopened.getJSON().content?.find((n) => n.type === "ctaButton");
    expect(node?.attrs).toMatchObject({ href: "https://example.com/book", label: "See offer", align: "left", bg: "#15803d", color: "#ffffff" });
  });

  it("a colour that is not a plain hex value falls back to the default instead of reaching a style attribute", () => {
    const e = editor("<p>Hi</p>");
    e.commands.insertContentAt(e.state.doc.content.size, { ...BUTTON, attrs: { ...BUTTON.attrs, bg: "red;background:url(https://evil.example)", color: "expression(alert(1))" } });
    const html = e.getHTML();
    expect(html).not.toMatch(/evil|expression/);
    expect(html).toContain("#1d4ed8");
  });
});

describe("spacer and divider", () => {
  it("a spacer is a fixed-height div that survives the server, limited to 8-80 pixels", () => {
    const e = editor("<p>a</p>");
    e.commands.insertContentAt(e.state.doc.content.size, { type: "spacer", attrs: { height: 40 } });
    e.commands.insertContentAt(e.state.doc.content.size, { type: "spacer", attrs: { height: 5000 } });
    const html = sanitizeStepHtml(e.getHTML());
    expect(html).toContain('data-compass-block="spacer"');
    expect(html).toMatch(/height:\s*40px/);
    expect(html).toMatch(/height:\s*80px/); // clamped
    expect(html).not.toContain("5000");
    const reopened = editor(html).getJSON().content?.filter((n) => n.type === "spacer");
    expect(reopened?.map((n) => n.attrs?.height)).toEqual([40, 80]);
  });

  it("a divider is a horizontal rule", () => {
    const e = editor("<p>a</p>");
    e.chain().focus().setHorizontalRule().run();
    expect(sanitizeStepHtml(e.getHTML())).toMatch(/<hr\s*\/?>/);
  });
});

describe("safety", () => {
  it("a javascript: link is refused by the editor itself, and a pasted script or event handler never reaches the output", () => {
    const html = editor('<p><a href="javascript:alert(1)" onclick="x()">bad</a><script>alert(1)</script><img src="https://x.example/a.png" alt="a" onerror="y()"></p>').getHTML();
    expect(html).not.toMatch(/javascript:|onclick|onerror|<script/i);
  });

  it("the complete trip is stable: out of the editor, through the server, back in and out again gives the same HTML", () => {
    const e = editor("<p>Hi</p>");
    e.chain().focus().selectAll().toggleBold().setColor("#1d4ed8").run();
    e.commands.insertContentAt(e.state.doc.content.size, { type: "ctaButton", attrs: { href: "https://example.com/a", label: "Go", align: "center", bg: "#1d4ed8", color: "#ffffff" } });
    e.commands.insertContentAt(e.state.doc.content.size, { type: "spacer", attrs: { height: 24 } });
    const first = sanitizeStepHtml(e.getHTML());
    const second = sanitizeStepHtml(editor(first).getHTML());
    expect(second).toBe(first);
  });

  it("what is stored can be styled for email clients without losing the editor's blocks", () => {
    const e = editor("<p>Hi</p>");
    e.commands.insertContentAt(e.state.doc.content.size, { type: "ctaButton", attrs: { href: "https://example.com/a", label: "Go", align: "center", bg: "#1d4ed8", color: "#ffffff" } });
    const styled = sanitizeAndStyleStepHtml(sanitizeStepHtml(e.getHTML()), "#1c3a5e");
    expect(styled).toContain('data-compass-block="button"');
    expect(styled).toMatch(/padding:\s*12px 28px/);
    expect(styled).toMatch(/<a href="https:\/\/example\.com\/a" style="[^"]*padding:\s*12px 28px/);
    expect(styled).not.toMatch(/<p style="[^"]*">\s*<\/p>\s*$/); // the editor's trailing empty paragraph is not sent as a blank gap
  });
});
