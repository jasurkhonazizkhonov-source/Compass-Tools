import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

// Source-level guards for the Lead-document security properties, so a later edit can't quietly remove one:
//  - no read of the attachment table without a lead-visibility rule (IDOR), outside the audited system jobs
//  - every server action starts from an authenticated, ACTIVE account
//  - storage credentials / SDK / object keys stay out of client code and out of the browser's environment
//  - no debug logging in the feature
const SRC = path.resolve(__dirname, "..", "..", "..");
const read = (...p: string[]) => readFileSync(path.join(SRC, ...p), "utf-8");
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").split(/\r?\n/).map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (["__tests__", "__integration__", "generated", "node_modules"].includes(name)) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const ALL = walk(SRC);

describe("attachment reads are always scoped by lead visibility", () => {
  // Files allowed to touch prisma.attachment, and why.
  const AUDITED = new Set([
    "server/queries/lead-attachments.ts", // visibleAttachmentWhere() — the one read path for lists
    "server/actions/lead-attachments.ts", // every query carries leadVisibilityWhere + company
    "app/api/attachments/[id]/file/route.ts", // visibleAttachmentWhere()
    "server/attachments/cleanup.ts", // system jobs: stale PENDING sweep, key collection before a cascade delete
  ]);

  it("no other module reads or writes the attachment table", () => {
    const offenders = ALL.filter((f) => /prisma\.attachment\./.test(strip(readFileSync(f, "utf-8")))).map((f) => path.relative(SRC, f).replace(/\\/g, "/")).filter((f) => !AUDITED.has(f));
    expect(offenders).toEqual([]);
  });

  it("every lookup in the actions, the route and the queries goes through the visibility rule", () => {
    for (const f of ["server/actions/lead-attachments.ts", "app/api/attachments/[id]/file/route.ts"]) {
      const code = strip(read(...f.split("/")));
      const finds = [...code.matchAll(/prisma\.attachment\.(findFirst|findMany|findUnique)\(/g)];
      expect(finds.length, f).toBeGreaterThan(0);
      for (const m of finds) {
        const window = code.slice(m.index!, m.index! + 600);
        expect(/leadVisibilityWhere|visibleAttachmentWhere/.test(window), `${f}: ${window.slice(0, 80)}`).toBe(true);
      }
    }
    const q = strip(read("server", "queries", "lead-attachments.ts"));
    expect(q).toContain("leadVisibilityWhere(viewer)");
    expect(q).toMatch(/companyId: viewer\.companyId/);
    expect(q).toMatch(/status: "READY"/);
  });

  it("the metadata queries never select the object key", () => {
    expect(strip(read("server", "queries", "lead-attachments.ts"))).not.toMatch(/storageKey:\s*true/);
  });
});

describe("server actions", () => {
  const code = strip(read("server", "actions", "lead-attachments.ts"));
  const exported = [...code.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);

  it("exports exactly the five operations", () => {
    expect(exported.sort()).toEqual(["abandonLeadAttachmentUpload", "completeLeadAttachmentUpload", "deleteLeadAttachment", "requestLeadAttachmentUpload", "updateLeadAttachmentDescription"]);
  });

  it.each(["abandonLeadAttachmentUpload", "completeLeadAttachmentUpload", "deleteLeadAttachment", "requestLeadAttachmentUpload", "updateLeadAttachmentDescription"])("%s authenticates an ACTIVE account first", (fn) => {
    const start = code.indexOf(`export async function ${fn}(`);
    const body = code.slice(start, start + 500);
    expect(body).toContain("await activeActor()");
  });

  it("edit and delete require the Admin/Manager permission before touching anything", () => {
    for (const fn of ["updateLeadAttachmentDescription", "deleteLeadAttachment"]) {
      const start = code.indexOf(`export async function ${fn}(`);
      const body = code.slice(start, start + 900);
      expect(body, fn).toContain("canManageLeadAttachments(actor.role)");
    }
  });
});

describe("credentials and storage never reach the browser", () => {
  it("no client component imports the storage module or the AWS SDK", () => {
    for (const f of ALL) {
      const raw = readFileSync(f, "utf-8");
      if (!/^\s*["']use client["']/.test(raw)) continue;
      expect(raw, path.relative(SRC, f)).not.toMatch(/server\/storage\/r2|@aws-sdk|R2_SECRET|R2_ACCESS/);
    }
  });

  it("no R2 setting is exposed as a NEXT_PUBLIC_ variable", () => {
    for (const f of ALL) expect(readFileSync(f, "utf-8"), path.relative(SRC, f)).not.toMatch(/NEXT_PUBLIC_R2|NEXT_PUBLIC_.*BUCKET/);
  });

  it("the R2 secret is read only inside the storage module", () => {
    const readers = ALL.filter((f) => /R2_SECRET_ACCESS_KEY/.test(strip(readFileSync(f, "utf-8")))).map((f) => path.relative(SRC, f).replace(/\\/g, "/"));
    expect(readers).toEqual(["server/storage/r2.ts"]);
  });

  it("no console.log / debugger in the feature", () => {
    const files = ALL.filter((f) => /attachments|lead-files-panel|contact-documents-panel|storage[\\/]r2/.test(f));
    expect(files.length).toBeGreaterThan(6);
    for (const f of files) expect(strip(readFileSync(f, "utf-8")), path.relative(SRC, f)).not.toMatch(/console\.log|debugger/);
  });

  it("the storage module logs neither keys nor the bucket nor credentials", () => {
    const code = strip(read("server", "storage", "r2.ts"));
    for (const m of code.matchAll(/console\.error\(([^)]*)\)/g)) expect(m[1]).not.toMatch(/key|bucket|secret|endpoint|url/i);
  });
});

describe("lead and contact deletion clean up stored files", () => {
  it("deleteLead and deleteContact collect the keys before the cascade and purge afterwards", () => {
    for (const [file, fn] of [["leads.ts", "deleteLead"], ["contacts.ts", "deleteContact"]] as const) {
      const code = strip(read("server", "actions", file));
      const start = code.indexOf(`export async function ${fn}(`);
      const body = code.slice(start, start + 2500);
      const collect = body.indexOf("storageKeysForLeads");
      const del = body.search(/prisma\.(lead|contact)\.delete\(/);
      const purge = body.indexOf("purgeStorageObjects");
      expect(collect, fn).toBeGreaterThan(-1);
      expect(collect, fn).toBeLessThan(del);
      expect(purge, fn).toBeGreaterThan(del);
    }
  });
});
