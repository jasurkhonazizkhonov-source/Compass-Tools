import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { EMAIL_TOKENS } from "../design-system";

// Email text must stay readable on the white / off-white card: WCAG AA is 4.5:1 for normal text. The labels, captions and footers used
// #9ca3af (about 2.5:1), which is what this guards against coming back.
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("email text contrast", () => {
  it("every text token meets 4.5:1 on white and on the off-white footer", () => {
    for (const key of ["text", "textMuted", "textSubtle", "textFaint"] as const) {
      expect(ratio(EMAIL_TOKENS[key], "#ffffff"), key).toBeGreaterThanOrEqual(4.5);
      expect(ratio(EMAIL_TOKENS[key], "#f9fafb"), `${key} on #f9fafb`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("no template sets text to the old 2.5:1 grey", () => {
    for (const f of ["templates.ts", "design-system.ts"]) {
      const code = readFileSync(path.resolve(__dirname, "..", f), "utf-8");
      expect(code, f).not.toMatch(/color:\s*#9ca3af/i);
    }
  });
});
