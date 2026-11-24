import { describe, it, expect } from "vitest";
import { draftDiffers, htmlToPlainText, parseStepDraft, stepDraftKey, textToHtml } from "../sequence-step-draft";

describe("textToHtml (converting an older plain-text step for the visual editor)", () => {
  it("keeps paragraphs, single line breaks and typed web addresses exactly as the plain-text email showed them", () => {
    const html = textToHtml("Hi {{contact_first_name}},\n\nI wanted to follow up on your trip.\nSee https://example.com/trip.\n\nThanks");
    expect(html).toBe('<p>Hi {{contact_first_name}},</p><p>I wanted to follow up on your trip.<br>See <a href="https://example.com/trip">https://example.com/trip</a>.</p><p>Thanks</p>');
  });

  it("escapes everything: markup typed in a plain-text step is shown as text, never run", () => {
    expect(textToHtml('<script>alert(1)</script> & "quotes"')).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;</p>");
  });

  it("ignores blank lines and gives an empty string for nothing", () => {
    expect(textToHtml("\n\n   \n\n")).toBe("");
    expect(textToHtml("a\n\n\n\nb")).toBe("<p>a</p><p>b</p>");
  });
});

describe("htmlToPlainText (the one-line summary of a collapsed step)", () => {
  it("is the visible words with spacing between blocks, entities decoded, and no markup", () => {
    expect(htmlToPlainText("<h1>Hello</h1><p>World &amp; <strong>friends</strong></p><ul><li>one</li><li>two</li></ul>")).toBe("Hello World & friends one two");
  });
  it("is shortened with an ellipsis", () => {
    const out = htmlToPlainText(`<p>${"word ".repeat(100)}</p>`, 50);
    expect(out.length).toBe(50);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("drafts kept in the browser", () => {
  const draft = { subject: "S", body: "<p>B</p>", bodyFormat: "HTML" as const, delayDays: 2, savedAt: 1 };

  it("is keyed by step, or by sequence for a step that does not exist yet", () => {
    expect(stepDraftKey("step-1", "seq-1")).toBe("compass:step-draft:step-1");
    expect(stepDraftKey(null, "seq-1")).toBe("compass:step-draft:new:seq-1");
  });

  it("reads back what was stored, and refuses anything that is not exactly a draft", () => {
    expect(parseStepDraft(JSON.stringify(draft))).toEqual(draft);
    for (const bad of [null, "", "not json", "[]", '{"subject":1,"body":"x","savedAt":1}', JSON.stringify({ ...draft, savedAt: "yesterday" }), JSON.stringify({ ...draft, body: "x".repeat(200_001) })]) {
      expect(parseStepDraft(bad as string | null), String(bad).slice(0, 30)).toBeNull();
    }
    expect(parseStepDraft(JSON.stringify({ ...draft, bodyFormat: "SOMETHING" }))?.bodyFormat).toBe("TEXT");
    expect(parseStepDraft(JSON.stringify({ ...draft, delayDays: -3 }))?.delayDays).toBe(0);
  });

  it("is only worth restoring when it differs from what is saved", () => {
    expect(draftDiffers(draft, { subject: "S", body: "<p>B</p>", bodyFormat: "HTML", delayDays: 2 })).toBe(false);
    expect(draftDiffers(draft, { subject: "S2", body: "<p>B</p>", bodyFormat: "HTML", delayDays: 2 })).toBe(true);
    expect(draftDiffers(draft, { subject: "S", body: "<p>B</p>", bodyFormat: "TEXT", delayDays: 2 })).toBe(true);
    expect(draftDiffers(draft, { subject: "S", body: "<p>B</p>", bodyFormat: "HTML", delayDays: 3 })).toBe(true);
  });
});
