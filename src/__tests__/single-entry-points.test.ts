import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// UI inventory guard (2026-11-24). Every user action below was traced to the screens that offer it and to the server function behind it. Each has ONE implementation of its button/dialog,
// shared by every screen that needs it, and ONE server function. This test pins that, so a second copy of a button or dialog (which drifts: different permission check, different
// confirmation, different message) cannot be added by accident. When a new entry point is genuinely needed, USE the shared component and extend the list here on purpose.

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "__integration__" || name === "generated" || name === "node_modules") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// Comments are removed first: a function NAMED in a comment is documentation, not a caller.
const withoutComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const FILES = walk(SRC).map((p) => ({ path: relative(SRC, p).split(sep).join("/"), text: withoutComments(readFileSync(p, "utf8")) }));

/** Files (other than the server module that defines it) that CALL the server action `name(`. */
function callers(name: string, definedIn: string): string[] {
  const call = new RegExp(`\\b${name}\\s*\\(`);
  return FILES.filter((f) => f.path !== definedIn && call.test(f.text)).map((f) => f.path).sort();
}

/** Files whose JSX text or string literals contain exactly this label. */
function showing(label: string): string[] {
  return FILES.filter((f) => f.path.endsWith(".tsx") && f.text.includes(label)).map((f) => f.path).sort();
}

describe("one component and one server function behind each action", () => {
  it.each([
    ["unenrollLead", "server/actions/sequences.ts", ["components/leads/unenroll-sequence-button.tsx"]],
    ["retryEnrollmentNow", "server/actions/sequences.ts", ["components/sequences/enrollment-recovery-actions.tsx"]],
    ["resolveUncertainDelivery", "server/actions/sequences.ts", ["components/sequences/enrollment-recovery-actions.tsx"]],
    ["bulkEnrollInSequence", "server/actions/bulk-selection.ts", ["components/crm/bulk-enroll-dialog.tsx"]],
    ["createDatabaseBackup", "server/actions/database-backup.ts", ["components/database-backup/database-backup-panel.tsx"]],
    ["deleteDatabaseBackup", "server/actions/database-backup.ts", ["components/database-backup/database-backup-panel.tsx"]],
    ["createSequence", "server/actions/sequences.ts", ["components/sequences/new-sequence-dialog.tsx"]],
  ])("%s is called from exactly one screen component", (name, definedIn, expected) => {
    expect(callers(name, definedIn)).toEqual(expected);
  });

  it("Connect / Reconnect Gmail has two entry points on purpose - the account menu (anywhere) and the notice on a lead (returns to that lead) - and both call the one server action", () => {
    expect(callers("startGmailConnect", "server/actions/gmail-connect.ts")).toEqual(["components/layout/account-menu.tsx", "components/sequences/gmail-problem-notice.tsx"]);
  });

  it("every Unenroll button is the shared UnenrollSequenceButton (the lead card, the sequence's enrollment table and a failed enrollment's recovery row all render it)", () => {
    const users = FILES.filter((f) => f.text.includes("<UnenrollSequenceButton")).map((f) => f.path).sort();
    expect(users).toEqual(["components/leads/active-sequences.tsx", "components/sequences/enrollment-recovery-actions.tsx", "components/sequences/sequence-enrollments-table.tsx"]);
  });
});

describe("one place defines each label", () => {
  it.each([
    ["New Campaign", ["app/(crm)/subscriptions/page.tsx"]], // the single way to create a campaign
    ["Add Bulk Subscribers", ["components/subscriptions/subscriber-list.tsx"]], // one button, on the subscriber list, opening the one dialog (separate from New Campaign)
    ["New Sequence", ["components/sequences/new-sequence-dialog.tsx"]],
    ["Enroll All Contacts", ["components/sequences/enroll-all-contacts-dialog.tsx"]],
    ["Enroll Leads", ["components/sequences/enroll-leads-dialog.tsx"]],
    ["Download Database Backup", ["components/database-backup/database-backup-panel.tsx"]],
    ["Retry now", ["components/sequences/enrollment-recovery-actions.tsx"]],
  ])("\"%s\"", (label, expected) => {
    expect(showing(label)).toEqual(expected);
  });
});
