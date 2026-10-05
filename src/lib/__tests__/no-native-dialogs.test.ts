import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Regression guard: the CRM asks for confirmation and input in its OWN modal (components/crm/confirm-dialog.tsx and
// input-dialog.tsx), never in the browser's window.confirm / alert / prompt. Those native dialogs cannot be styled or made
// accessible consistently, block the page, are not testable, and — for a destructive action — show a bare "OK". Anything new
// that reintroduces one fails here.

/**
 * Removes // and block comments, so prose that merely MENTIONS window.confirm does not trigger the guard. With `blankStrings`,
 * the contents of string literals are also blanked, so a sentence such as "use --confirm (and ...)" inside a message is never
 * mistaken for a call.
 */
export function stripComments(source: string, blankStrings = false): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  const keep = (ch: string) => (blankStrings && quote !== null && ch !== "\n" && ch !== quote ? " " : ch);
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (quote) {
      out += keep(c);
      if (c === "\\") {
        out += keep(source[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
    i++;
  }
  return out;
}

const QUALIFIED = /\b(?:window|globalThis|self|top|parent)\s*(?:\.|\?\.)\s*(?:confirm|alert|prompt)\s*\(|\b(?:window|globalThis|self)\s*\[\s*["'](?:confirm|alert|prompt)["']\s*\]/;
const BARE = /(?<![.\w$])(?:confirm|alert|prompt)\s*\(/;

export function findNativeDialogCalls(source: string): string[] {
  // window.confirm(...) is looked for in the code as written (including the window["confirm"] form); a bare confirm(...) only
  // outside string contents.
  const code = stripComments(source).split("\n");
  const codeNoStrings = stripComments(source, true).split("\n");
  const hits: string[] = [];
  code.forEach((line, idx) => {
    if (QUALIFIED.test(line) || BARE.test(codeNoStrings[idx] ?? "")) hits.push(`${idx + 1}: ${line.trim()}`);
  });
  return hits;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "__integration__" || e.name === "generated" || e.name === "node_modules") continue;
      sourceFiles(p, out);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

describe("no native browser dialogs (window.confirm / alert / prompt)", () => {
  it("the scanner itself: catches the real call shapes, ignores comments and prose", () => {
    expect(findNativeDialogCalls(`if (!window.confirm("Sure?")) return;`)).toHaveLength(1);
    expect(findNativeDialogCalls(`const url = window.prompt("URL");`)).toHaveLength(1);
    expect(findNativeDialogCalls(`window.alert("x")`)).toHaveLength(1);
    expect(findNativeDialogCalls(`globalThis.confirm("x")`)).toHaveLength(1);
    expect(findNativeDialogCalls(`window["confirm"]("x")`)).toHaveLength(1);
    expect(findNativeDialogCalls(`if (confirm("Sure?")) go();`)).toHaveLength(1);
    expect(findNativeDialogCalls(`alert('hi')`)).toHaveLength(1);
    expect(findNativeDialogCalls(`// window.confirm("x") was replaced\nconst a = 1;`)).toHaveLength(0);
    expect(findNativeDialogCalls(`/* window.prompt("x") */ const a = 1;`)).toHaveLength(0);
    expect(findNativeDialogCalls(`const a = " // not a comment "; window.confirm("x")`)).toHaveLength(1);
    // prose and ordinary names that merely contain the word are fine
    expect(findNativeDialogCalls("const m = `use --confirm (and optionally --ids)`;")).toHaveLength(0);
    expect(findNativeDialogCalls(`setConfirming(true); handleConfirm(); onConfirm(); cancelConfirmation(); await confirmCancellation(id);`)).toHaveLength(0);
    expect(findNativeDialogCalls(`dialog.confirm(); user.alert(); toast.prompt()`)).toHaveLength(0);
  });

  it("the application source contains zero native dialog calls", () => {
    const root = path.join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const file of sourceFiles(root)) {
      for (const hit of findNativeDialogCalls(fs.readFileSync(file, "utf8"))) {
        offenders.push(`${path.relative(process.cwd(), file).split(path.sep).join("/")}:${hit}`);
      }
    }
    expect(offenders, `Use ConfirmDialog / InputDialog instead:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the scan really covers the tree (sanity: it reads the shared dialog components)", () => {
    const files = sourceFiles(path.join(process.cwd(), "src")).map((f) => path.relative(process.cwd(), f).split(path.sep).join("/"));
    expect(files).toContain("src/components/crm/confirm-dialog.tsx");
    expect(files).toContain("src/components/crm/input-dialog.tsx");
    expect(files.length).toBeGreaterThan(300);
  });
});
