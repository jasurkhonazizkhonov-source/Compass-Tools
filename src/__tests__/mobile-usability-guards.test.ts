import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

// Regression guards for the mobile defects found by inspecting the rendered app at 320-768 px on a touch-emulated browser (2026-11-23). The repository has no browser test
// tooling, so these check the source for the exact patterns that caused each defect. Each one names the defect it prevents.
const ROOT = path.resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf-8").replace(/\r\n/g, "\n");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "generated" || entry === "node_modules") continue;
      tsxFiles(full, out);
    } else if (/\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

describe("controls that appear only on hover must also appear on touch devices", () => {
  // Defect: Tailwind's `hover:` / `group-hover:` variants only apply where the primary input can hover, so a control hidden with `opacity-0 group-hover:opacity-*` was
  // permanently invisible on a phone: the lead and contact field edit pencils, the note Edit / Delete buttons, the Users-table edit pencils.
  it("every opacity-0 + group-hover:opacity-* className also has a [@media(hover:none)]:opacity-* escape", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(path.join(ROOT, "src"))) {
      const text = readFileSync(file, "utf-8");
      for (const m of text.matchAll(/className="([^"]*)"/g)) {
        const cls = m[1];
        if (/(^|\s)opacity-0(\s|$)/.test(cls) && /group-hover:opacity-/.test(cls) && !/\[@media\(hover:none\)\]:opacity-/.test(cls)) {
          offenders.push(`${path.relative(ROOT, file)}: ${cls.slice(0, 90)}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the three components that hit it keep the escape (the guard above would pass vacuously if these were rewritten)", () => {
    expect(read("src/components/crm/inline-edit-field.tsx")).toMatch(/\[@media\(hover:none\)\]:opacity-100/);
    expect(read("src/components/crm/notes-panel.tsx")).toMatch(/\[@media\(hover:none\)\]:opacity-100/);
    expect(read("src/components/accounts/account-row-editor.tsx")).toMatch(/\[@media\(hover:none\)\]:opacity-50/);
  });
});

describe("wide tables keep their row actions reachable", () => {
  // Defect: on a phone these tables scroll sideways inside their container and the Inspect / Delete / Remove / Unenroll actions sat 500-900 px to the right.
  const STICKY = /sticky right-0 z-10 bg-card/;
  const cases: Array<[string, string]> = [
    ["src/components/failed-signins/failed-signins-view.tsx", "Inspect"],
    ["src/components/subscriptions/subscriber-list.tsx", "Remove"],
    ["src/app/(crm)/sequences/page.tsx", "Row actions"],
  ];
  for (const [file, what] of cases) {
    it(`${file}: the ${what} column is pinned to the right edge (header and cells)`, () => {
      const text = read(file);
      const sticky = text.match(new RegExp(STICKY.source, "g")) ?? [];
      expect(sticky.length, "a sticky header and a sticky cell").toBeGreaterThanOrEqual(2);
      expect(text).toMatch(/className="group[ "]|className="group hover/); // rows are `group` so the pinned cell can follow the row's hover colour
    });
  }

  // Not pinned on purpose: the enrollments table's Actions cell holds Unenroll PLUS the recovery buttons and, after a failed retry, a whole Gmail problem notice. Pinned at the right edge of a
  // 254 px phone container (320 px screen) it covered most of the table and the lead's name (found on re-inspection, 2026-11-23). It scrolls with the table like every other column.
  it("the sequence enrollments table does not pin its variable-width Actions cell", () => {
    expect(read("src/components/sequences/sequence-enrollments-table.tsx")).not.toMatch(/sticky right-0/);
  });

  it("Inspect and Delete are separated by a gap (they used to touch)", () => {
    const text = read("src/components/failed-signins/failed-signins-view.tsx");
    expect(text).toMatch(/flex items-center justify-end gap-1/);
  });
});

describe("other defects", () => {
  it("company logo status badge wraps instead of running past the card on a phone", () => {
    const text = read("src/components/company/company-logo-panel.tsx");
    expect(text).toMatch(/flex flex-wrap items-center gap-4/);
    expect(text).toMatch(/h-auto gap-1 whitespace-normal/);
  });

  it("the dashboard task rows' icon-only link has an accessible name and a tap target larger than its 14 px icon", () => {
    const text = read("src/app/(crm)/dashboard/page.tsx");
    expect(text).toMatch(/aria-label=\{`Open the lead for task: \$\{t\.title\}`\}/);
    expect(text).toMatch(/className="-m-2 inline-flex p-2"/);
  });

  it("the search palette sits near the top on a phone (so results stay above the on-screen keyboard) and a third of the way down from sm up", () => {
    expect(read("src/components/ui/command.tsx")).toMatch(/"top-3 translate-y-0[^"]*sm:top-1\/3"/);
  });

  it("the shared checkbox keeps its enlarged invisible hit area (row-selection checkboxes are 16 px)", () => {
    expect(read("src/components/ui/checkbox.tsx")).toMatch(/after:absolute after:-inset-x-3 after:-inset-y-2/);
  });
});
