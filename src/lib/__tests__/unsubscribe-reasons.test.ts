import { describe, it, expect } from "vitest";
import { MAX_UNSUBSCRIBE_REASON_LENGTH, UNSUBSCRIBE_REASONS, normalizeUnsubscribeReason, unsubscribeReasonLabel } from "../unsubscribe-reasons";

describe("normalizeUnsubscribeReason", () => {
  it("nothing provided → nothing to store (the reason is optional)", () => {
    expect(normalizeUnsubscribeReason({})).toEqual({ ok: true, category: null, text: null });
    expect(normalizeUnsubscribeReason({ category: "", text: "   \n  " })).toEqual({ ok: true, category: null, text: null });
    expect(normalizeUnsubscribeReason({ category: null, text: null })).toEqual({ ok: true, category: null, text: null });
  });

  it("accepts each predefined category on its own", () => {
    for (const r of UNSUBSCRIBE_REASONS) expect(normalizeUnsubscribeReason({ category: r.value })).toEqual({ ok: true, category: r.value, text: null });
  });

  it("accepts a free-text explanation, with or without a category", () => {
    expect(normalizeUnsubscribeReason({ text: "  I receive too many emails.  " })).toEqual({ ok: true, category: null, text: "I receive too many emails." });
    expect(normalizeUnsubscribeReason({ category: "OTHER", text: "Moved abroad" })).toEqual({ ok: true, category: "OTHER", text: "Moved abroad" });
  });

  it("drops an unknown or tampered category instead of storing it", () => {
    expect(normalizeUnsubscribeReason({ category: "DROP TABLE" })).toEqual({ ok: true, category: null, text: null });
    expect(normalizeUnsubscribeReason({ category: { $ne: 1 }, text: "x" })).toEqual({ ok: true, category: null, text: "x" });
  });

  it("enforces the maximum length: exactly the limit is fine, one more is refused (never silently truncated)", () => {
    const max = "a".repeat(MAX_UNSUBSCRIBE_REASON_LENGTH);
    expect(normalizeUnsubscribeReason({ text: max })).toMatchObject({ ok: true, text: max });
    const over = normalizeUnsubscribeReason({ text: max + "a" });
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.error).toMatch(/under 1000 characters/);
  });

  it("keeps plain-text semantics: markup stays literal characters, newlines are kept and normalised, control characters are removed", () => {
    const result = normalizeUnsubscribeReason({ text: 'Line one\r\nLine <b>two</b>\u0000\u0007 <script>alert(1)</script>' });
    expect(result).toEqual({ ok: true, category: null, text: "Line one\nLine <b>two</b><script>alert(1)</script>" });
  });

  it("ignores non-string input", () => {
    expect(normalizeUnsubscribeReason({ text: 42 as unknown as string })).toEqual({ ok: true, category: null, text: null });
    expect(normalizeUnsubscribeReason({ text: ["a"] as unknown as string })).toEqual({ ok: true, category: null, text: null });
  });
});

describe("unsubscribeReasonLabel", () => {
  it("maps a category to its wording and unknown/empty to null", () => {
    expect(unsubscribeReasonLabel("TOO_MANY_EMAILS")).toBe("I receive too many emails");
    expect(unsubscribeReasonLabel("NOPE")).toBeNull();
    expect(unsubscribeReasonLabel(null)).toBeNull();
  });
});
