import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

// Source-level guards for accessibility defects found by axe-core / keyboard audits of the running app (each one was a real finding):
//  - a Radix Select trigger is role=combobox, which does NOT take its name from its content, so it needs aria-label / an id a <Label htmlFor> points at
//  - the dark theme's text-on-tint warning colour measured 1.63:1
//  - every layout with repeated navigation offers a skip link
const SRC = path.resolve(__dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "generated" || name === "ui") continue;
      walk(p, out);
    } else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("Select triggers are named", () => {
  it("every <SelectTrigger> in the app has an aria-label or an id (for a Label htmlFor)", () => {
    const missing: string[] = [];
    for (const file of walk(SRC)) {
      const code = readFileSync(file, "utf-8");
      for (const m of code.matchAll(/<SelectTrigger\b[^>]*>/g)) {
        if (!/aria-label(?:ledby)?=|\bid=/.test(m[0])) missing.push(`${path.relative(SRC, file)}: ${m[0].slice(0, 70)}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("dark theme warning text", () => {
  it("--warning-foreground is light (not near-black) in every dark token block", () => {
    const css = readFileSync(path.join(SRC, "app", "globals.css"), "utf-8");
    const values = [...css.matchAll(/--warning-foreground:\s*oklch\(([\d.]+)\s/g)].map((m) => parseFloat(m[1]));
    expect(values.length).toBeGreaterThanOrEqual(4);
    // two light blocks (dark text on a light amber tint) and two dark blocks (light text on a dark amber tint)
    expect(values.filter((l) => l >= 0.8).length).toBeGreaterThanOrEqual(2);
    expect(values.filter((l) => l <= 0.25).length).toBeGreaterThanOrEqual(2);
  });
});

describe("skip link", () => {
  it.each([
    ["app/(crm)/layout.tsx"],
    ["app/(marketing)/layout.tsx"],
  ])("%s renders a SkipLink and a focusable #main-content target", (file) => {
    const code = readFileSync(path.join(SRC, ...file.split("/")), "utf-8");
    expect(code).toMatch(/<SkipLink \/>/);
    expect(code).toMatch(/<main id="main-content" tabIndex=\{-1\}/);
  });
});

describe("payment recording form", () => {
  it("its amount / note fields are named and the row wraps instead of squeezing the amount to nothing", () => {
    const code = readFileSync(path.join(SRC, "components", "bookings", "charge-customer-panel.tsx"), "utf-8");
    expect(code).toMatch(/<Input aria-label="Amount"/);
    expect(code).toMatch(/<Textarea aria-label="Reference note"/);
    expect(code).toMatch(/flex flex-wrap items-end gap-2/);
    expect(code).toMatch(/min-w-\[9rem\]/);
  });
});
