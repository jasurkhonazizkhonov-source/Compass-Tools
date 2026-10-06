import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// Every <Switch> in the app needs an accessible name: a bare switch is announced as just "switch" (the Users page alone has one per
// account), and a neighbouring <span> or <Label> without htmlFor does not name it. Source-level guard so a new Switch can't ship unnamed.
const SRC = path.resolve(__dirname, "..", "..");
const FILES = [
  ["components", "accounts", "account-row-editor.tsx"],
  ["components", "accounts", "new-account-dialog.tsx"],
  ["components", "leads", "travel-request-card.tsx"],
  ["components", "leads", "new-lead-dialog.tsx"],
  ["components", "sequences", "sequence-active-toggle.tsx"],
];

describe("every Switch has an accessible name", () => {
  for (const f of FILES) {
    it(f.join("/"), () => {
      const code = readFileSync(path.join(SRC, ...f), "utf-8");
      const tags = [...code.matchAll(/<Switch\b[\s\S]*?\/>/g)].map((m) => m[0]);
      expect(tags.length, "expected at least one Switch").toBeGreaterThan(0);
      for (const tag of tags) {
        // either aria-label / aria-labelledby, or an id that a <Label htmlFor> in the same file points at
        const id = /\bid="([^"]+)"/.exec(tag)?.[1];
        const named = /aria-label(?:ledby)?=/.test(tag) || (id !== undefined && code.includes(`htmlFor="${id}"`));
        expect(named, tag.replace(/\s+/g, " ").slice(0, 90)).toBe(true);
      }
    });
  }
});
