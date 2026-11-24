import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// The sequence email builder and the marketing campaign builder share ONE editor component (the rich-text editor) and nothing else: their data models, workflows, permissions and sending
// code stay separate. Source-level guards so a refactor cannot quietly merge them or add a second editor.
const ROOT = path.resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf-8").replace(/\r\n/g, "\n");
const imports = (p: string) => [...read(p).matchAll(/from "([^"]+)"/g)].map((m) => m[1]);

describe("sequence builder vs campaign builder", () => {
  const SEQUENCE_SIDE = ["src/components/sequences/step-editor.tsx", "src/server/actions/sequence-step-content.ts", "src/server/email/sequence-content.ts", "src/server/actions/sequences.ts"];

  it.each(SEQUENCE_SIDE)("%s does not import the campaign builder, its blocks, or any marketing code", (file) => {
    for (const spec of imports(file)) {
      expect(spec, `${file} imports ${spec}`).not.toMatch(/campaign-builder|campaign-blocks|campaign-form|marketing-campaigns|server\/marketing|subscriptions\/campaign/);
    }
  });

  it("the campaign builder side does not import sequence code", () => {
    for (const file of ["src/components/subscriptions/campaign-builder.tsx", "src/components/subscriptions/campaign-form.tsx", "src/server/marketing/campaign-worker.ts"]) {
      for (const spec of imports(file)) expect(spec, `${file} imports ${spec}`).not.toMatch(/components\/sequences|sequence-content|sequence-step|due-sequence-steps|actions\/sequences/);
    }
  });

  it("there is exactly ONE visual editor component, and both sides use it", () => {
    expect(read("src/components/sequences/step-editor.tsx")).toContain('from "@/components/subscriptions/rich-text-editor"');
    expect(read("src/components/subscriptions/campaign-form.tsx")).toContain('from "@/components/subscriptions/rich-text-editor"');
    // no other file builds a TipTap editor
    const users = ["src/components/sequences/step-editor.tsx", "src/components/subscriptions/campaign-form.tsx", "src/components/subscriptions/campaign-builder.tsx"].filter((f) => /useEditor\(/.test(read(f)));
    expect(users).toEqual([]);
  });

  it("the sequence email is cleaned with the campaign allow-list (one set of rules), never its own", () => {
    expect(read("src/server/email/sequence-content.ts")).toContain("campaignSanitizeOptions");
    expect(read("src/server/email/sequence-content.ts")).not.toMatch(/allowedTags:\s*\[/);
  });
});
