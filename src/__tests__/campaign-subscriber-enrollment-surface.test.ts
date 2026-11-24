import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import path from "path";

// Whole-application guards for three things that must stay single and where they belong (checked against the source, because the repository has no browser tests):
//   1. ONE "New Campaign" entry point (the builder) - no older campaign-creation button, form or route.
//   2. ONE bulk subscriber import entry point ("Add Bulk Subscribers") - no separate "Import Contacts" / CSV subscriber import.
//   3. The sequence enrollment status and its Unenroll button live ONLY in the existing Sequences areas (the lead page's Sequences tab, the sequence's own enrollments table) -
//      never as a banner or panel in the main Lead / Contact layout, and never duplicated.
const ROOT = path.resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf-8").replace(/\r\n/g, "\n");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (["__tests__", "__integration__", "generated", "node_modules"].includes(entry)) continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\./.test(entry)) out.push(full);
  }
  return out;
}
const files = walk(path.join(ROOT, "src")).map((f) => ({ rel: path.relative(ROOT, f).split(path.sep).join("/"), text: readFileSync(f, "utf-8").replace(/\r\n/g, "\n") }));
const filesWith = (re: RegExp) => files.filter((f) => re.test(f.text)).map((f) => f.rel);

describe("campaigns: one New Campaign entry point, the latest builder", () => {
  it("the label 'New Campaign' is rendered in exactly one place: the Subscriptions page link to the builder", () => {
    expect(filesWith(/>\s*New Campaign\s*</)).toEqual(["src/app/(crm)/subscriptions/page.tsx"]);
    expect(read("src/app/(crm)/subscriptions/page.tsx")).toContain('href="/subscriptions/campaigns/builder">New Campaign<');
  });

  it("only the builder creates campaigns from the UI: no 'new' route, no other link to a blank builder, and the old form is never rendered without a saved campaign", () => {
    expect(existsSync(path.join(ROOT, "src/app/(crm)/subscriptions/campaigns/new"))).toBe(false);
    const blankBuilderLinks = files.filter((f) => /campaigns\/builder["'`]/.test(f.text)).map((f) => f.rel); // a link to the builder WITHOUT ?id=
    expect(blankBuilderLinks).toEqual(["src/app/(crm)/subscriptions/page.tsx"]);
    const formUsers = files.filter((f) => /<CampaignForm\b/.test(f.text));
    expect(formUsers.map((f) => f.rel)).toEqual(["src/app/(crm)/subscriptions/campaigns/[id]/page.tsx"]);
    expect(formUsers[0].text).toMatch(/<CampaignForm\s+campaignId=\{campaign\.id\}/); // an edit view of an existing campaign, never a create form
  });

  it("the builder page is limited to the people who may view subscriptions, and the actions it calls re-check marketing access on the server", () => {
    expect(read("src/app/(crm)/subscriptions/campaigns/builder/page.tsx")).toMatch(/if \(!canViewSubscriptions\(current\?\.role\)\) notFound\(\);/);
    for (const file of ["src/server/actions/campaign-delivery.ts", "src/server/actions/marketing-campaigns.ts"]) {
      const text = read(file);
      const fns = text.split(/\n(?=export async function )/).slice(1);
      expect(fns.length, file).toBeGreaterThan(3);
      for (const fn of fns) {
        const name = /^export async function (\w+)/.exec(fn)![1];
        // pause / cancel go through `transition`, which asserts access itself
        expect(/assertMarketingAccess\(/.test(fn) || /\btransition\(/.test(fn), `${file}: ${name} must check marketing access`).toBe(true);
      }
    }
  });
});

describe("subscribers: one bulk import entry point, no separate Import Contacts", () => {
  it("no 'Import Contacts' / CSV subscriber import wording or component exists in the application", () => {
    expect(filesWith(/Import Contacts|Import contacts|Import subscribers|Import Subscribers|SubscriberImportPanel/)).toEqual([]);
    expect(existsSync(path.join(ROOT, "src/components/subscriptions/subscriber-import-panel.tsx"))).toBe(false);
  });

  it("'Add Bulk Subscribers' is one button and the bulk dialog is mounted once", () => {
    // the button label is rendered in one place (the other file only names the feature in its doc comment)
    expect(filesWith(/Add Bulk Subscribers\s*<\/Button>|<\/Button>[^<]*Add Bulk Subscribers|Add Bulk Subscribers\n\s*<\/Button>/)).toEqual(["src/components/subscriptions/subscriber-list.tsx"]);
    expect(files.filter((f) => /<BulkSubscriberDialog\b/.test(f.text)).map((f) => f.rel)).toEqual(["src/components/subscriptions/subscriber-list.tsx"]);
    // the two server actions behind it check marketing access
    const actions = read("src/server/actions/subscribers.ts");
    for (const name of ["previewBulkSubscribers", "createBulkSubscribers"]) {
      const body = actions.split(new RegExp(`(?=export async function ${name}\\b)`))[1];
      expect(body, name).toBeDefined();
      expect(body.slice(0, 600), name).toMatch(/assertMarketingAccess\(/);
    }
  });

  it("the CRM contact bulk import (sidebar 'Bulk Contacts') is a different feature and is still there", () => {
    expect(existsSync(path.join(ROOT, "src/app/(crm)/contacts/bulk-import/page.tsx"))).toBe(true);
    expect(read("src/components/layout/sidebar.tsx")).toContain('"/contacts/bulk-import"');
  });
});

describe("sequences: enrollment status and Unenroll stay in the Sequences areas", () => {
  it("the Unenroll button and the active-enrollment card are rendered only from the lead's Sequences panel and the sequence's enrollments table", () => {
    // The three places are all Sequences areas: an ACTIVE enrollment's card on the lead, an ACTIVE row of the sequence's table, and the shared recovery actions, which
    // give a FAILED enrollment its Retry and its ONE Unenroll (so a failed enrollment never shows two).
    expect(files.filter((f) => /<UnenrollSequenceButton\b/.test(f.text)).map((f) => f.rel).sort()).toEqual([
      "src/components/leads/active-sequences.tsx",
      "src/components/sequences/enrollment-recovery-actions.tsx",
      "src/components/sequences/sequence-enrollments-table.tsx",
    ]);
    expect(files.filter((f) => /<ActiveSequenceCard\b/.test(f.text)).map((f) => f.rel).sort()).toEqual(["src/components/leads/lead-sequences-panel.tsx"]);
    expect(files.filter((f) => /<LeadSequencesPanel\b/.test(f.text)).map((f) => f.rel)).toEqual(["src/app/(crm)/leads/[id]/page.tsx"]);
  });

  it("on the lead page the sequences panel sits inside the 'sequences' tab of the existing tabbed card, and nothing about enrollment is rendered outside it", () => {
    const page = read("src/app/(crm)/leads/[id]/page.tsx");
    const inTab = /<TabsContent value="sequences"[^>]*>\s*<LeadSequencesPanel[\s\S]*?<\/TabsContent>/.test(page);
    expect(inTab).toBe(true);
    const outside = page.replace(/<TabsContent value="sequences"[\s\S]*?<\/TabsContent>/, "");
    expect(outside).not.toMatch(/ActiveSequenceCard|UnenrollSequenceButton|Enrolled |enrolled in|is enrolled/);
    // the page's two-column structure is unchanged
    expect(page).toContain('grid grid-cols-1 gap-5 lg:grid-cols-[360px_1fr]');
  });

  it("the contact page has no enrollment banner or panel of its own (contacts are enrolled from the list, through their most recent lead)", () => {
    const page = read("src/app/(crm)/contacts/[id]/page.tsx");
    expect(page).not.toMatch(/Sequence|enroll/i);
  });

  it("success feedback after enrolling is a toast (it takes no space in the page), and the apply dialog adds no page-level banner", () => {
    const dialog = read("src/components/sequences/apply-sequence-dialog.tsx");
    expect(dialog).toMatch(/toast\.success\(`"\$\{result\.sequenceName\}" started/);
    // the only alerts are the dialog's own error lines, rendered inside <DialogContent>; there is nothing outside it
    const outsideDialog = dialog.split("<Dialog ")[0];
    expect(outsideDialog).not.toMatch(/role="alert"|role="status"|<Alert\b/);
  });
});

describe("lead page: enrollment cannot move the navigation menu (regression for the removed 'Active sequence' block)", () => {
  // Until commit 75df7b7 the lead page rendered <LeadActiveSequencesNotice> between the header and the two-column grid whenever the lead had an ACTIVE enrollment: a bordered
  // card in the normal flow that pushed the grid, and with it the Notes / Tasks / Quotes / Booking / Sequences / Activity / Files menu, down the page. A lead that was not enrolled
  // (or had been unenrolled) had the menu higher up. The release deployed before 75df7b7 still shows it. These checks keep it from coming back in any form.
  const page = read("src/app/(crm)/leads/[id]/page.tsx");
  const root = page.indexOf('<div className="space-y-5">');
  const grid = page.indexOf('<div className="grid grid-cols-1 gap-5 lg:grid-cols-[360px_1fr]">');

  it("the tabbed card (the Notes / Tasks / Quotes / Booking / Sequences / Activity / Files menu) is the FIRST thing in the right-hand column: nothing sits between the left column and it", () => {
    expect(root).toBeGreaterThan(0);
    expect(grid).toBeGreaterThan(root);
    // closing tag of the left column, then straight into the card that holds <Tabs>; the removed notice used to sit exactly here
    expect(page).toMatch(/<\/div>\s*<Card className="shadow-none">\s*<CardContent className="pt-2">\s*<Tabs defaultValue="notes">/);
    // and nothing about sequences or enrollment sits between the top of the page and the grid
    expect(page.slice(root, grid)).not.toMatch(/sequence|enroll/i);
  });

  it("enrollment state does not appear in any condition that renders something in the page flow outside the Sequences tab: the only uses are the tab's count and its panel", () => {
    const uses = [...page.matchAll(/^.*\b(enrollments|enrollment)\b.*$/gm)].map((m) => m[0].trim());
    for (const line of uses) {
      expect(/TabsTrigger value="sequences"|<LeadSequencesPanel|enrollments=\{enrollments\}|const enrollments =|getApplicableSequences|lead\.enrollments\.map|sequence table/.test(line) || /^\/\//.test(line) || /^\/?\*/.test(line), `unexpected use of enrollment state: ${line}`).toBe(true);
    }
  });

  it("no component renders an enrollment block as a bordered region meant for a page's main flow (the removed test id and heading are gone everywhere)", () => {
    expect(filesWith(/active-sequences-notice|active-sequences-heading|LeadActiveSequencesNotice/)).toEqual([]);
  });
});
