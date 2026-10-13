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
    "app/api/attachments/[id]/upload/route.ts", // the caller's OWN pending upload + leadVisibilityWhere
    "server/attachments/cleanup.ts", // system jobs: stale PENDING sweep, key collection before a cascade delete
  ]);

  it("no other module reads or writes the attachment table", () => {
    const offenders = ALL.filter((f) => /prisma\.attachment\./.test(strip(readFileSync(f, "utf-8")))).map((f) => path.relative(SRC, f).replace(/\\/g, "/")).filter((f) => !AUDITED.has(f));
    expect(offenders).toEqual([]);
  });

  it("every lookup in the actions, the route and the queries goes through the visibility rule", () => {
    for (const f of ["server/actions/lead-attachments.ts", "app/api/attachments/[id]/file/route.ts", "app/api/attachments/[id]/upload/route.ts"]) {
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
      expect(raw, path.relative(SRC, f)).not.toMatch(/server\/storage|@aws-sdk|R2_SECRET|R2_ACCESS|UPLOAD_STORAGE_DIR/);
    }
  });

  it("no R2 setting is exposed as a NEXT_PUBLIC_ variable", () => {
    for (const f of ALL) expect(readFileSync(f, "utf-8"), path.relative(SRC, f)).not.toMatch(/NEXT_PUBLIC_R2|NEXT_PUBLIC_.*BUCKET|NEXT_PUBLIC_UPLOAD/);
  });

  it("the R2 secret is read only inside the LEGACY R2 module", () => {
    const readers = ALL.filter((f) => /R2_SECRET_ACCESS_KEY/.test(strip(readFileSync(f, "utf-8")))).map((f) => path.relative(SRC, f).replace(/\\/g, "/"));
    expect(readers).toEqual(["server/storage/legacy-r2.ts"]);
  });

  it("the upload directory setting is read in exactly one place, and is never exposed", () => {
    const readers = ALL.filter((f) => /UPLOAD_STORAGE_DIR/.test(strip(readFileSync(f, "utf-8")))).map((f) => path.relative(SRC, f).replace(/\\/g, "/"));
    expect(readers).toEqual(["server/storage/local.ts"]);
  });

  it("only the storage module touches the filesystem: the actions, routes, queries and cleanup never build or open a path", () => {
    const feature = ALL.filter((f) => {
      const rel = path.relative(SRC, f).replace(/\\/g, "/");
      return /^app\/api\/attachments\//.test(rel) || /^server\/attachments\//.test(rel) || rel === "server/actions/lead-attachments.ts" || rel === "server/queries/lead-attachments.ts" || rel === "components/leads/lead-files-panel.tsx";
    });
    expect(feature.length).toBeGreaterThanOrEqual(6);
    for (const f of feature) {
      expect(strip(readFileSync(f, "utf-8")), path.relative(SRC, f)).not.toMatch(/from ["'](node:)?(fs|fs\/promises|path)["']|require\(["'](node:)?(fs|path)["']\)|process\.cwd\(\)/);
    }
  });

  it("uploaded files are never served from a public directory or a static rewrite", () => {
    const root = path.resolve(SRC, "..");
    const publicDir = path.join(root, "public");
    const listing = readdirSync(publicDir, { recursive: true }).map(String);
    expect(listing.filter((p) => /upload|attachment/i.test(p))).toEqual([]);
    const next = readFileSync(path.join(root, "next.config.ts"), "utf-8");
    expect(strip(next)).not.toMatch(/rewrites|UPLOAD_STORAGE_DIR|local-uploads|\/var\/lib\/compass-tools/);
    expect(readFileSync(path.join(root, ".gitignore"), "utf-8")).toMatch(/\.local-uploads/);
  });

  it("the download route streams local files from the storage module and never redirects to them or builds a URL", () => {
    const code = strip(read("app", "api", "attachments", "[id]", "file", "route.ts"));
    expect(code).toContain("localStorage.openRead(row.storageKey)");
    expect(code).toMatch(/row\.storageProvider === "R2"/);
    // the only redirect is the legacy R2 signed link
    expect([...code.matchAll(/status: 302/g)]).toHaveLength(1);
    expect(code.indexOf("status: 302")).toBeLessThan(code.indexOf("localStorage.openRead"));
  });

  it("no console.log / debugger in the feature", () => {
    const files = ALL.filter((f) => /attachments|lead-files-panel|contact-documents-panel|storage[\\/]/.test(f));
    expect(files.length).toBeGreaterThan(6);
    for (const f of files) expect(strip(readFileSync(f, "utf-8")), path.relative(SRC, f)).not.toMatch(/console\.log|debugger/);
  });

  it("the storage modules log neither keys, paths, the bucket nor credentials", () => {
    for (const file of ["legacy-r2.ts", "local.ts"]) {
      const code = strip(read("server", "storage", file));
      const calls = [...code.matchAll(/console\.error\(([^)]*)\)/g)];
      expect(calls.length, file).toBeGreaterThan(0);
      for (const m of calls) expect(m[1], file).not.toMatch(/key|bucket|secret|endpoint|url|path|root|message|err\.message/i);
    }
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

describe("downloads from the local disk are served defensively", () => {
  const route = read("app", "api", "attachments", "[id]", "file", "route.ts");

  it("forces the type, disables sniffing and caching, and restricts embedding and loading", () => {
    expect(route).toMatch(/"Content-Type": type\.mime/);
    expect(route).toMatch(/"X-Content-Type-Options": "nosniff"/);
    expect(route).toMatch(/"Cache-Control": "private, no-store"/);
    expect(route).toMatch(/"Cross-Origin-Resource-Policy": "same-origin"/);
    expect(route).toMatch(/default-src 'none'/);
    expect(route).toMatch(/frame-ancestors 'none'/);
  });

  it("never puts a path or storage key in a header", () => {
    const headers = route.slice(route.indexOf("Content-Type"), route.indexOf("Content-Security-Policy"));
    expect(headers).not.toMatch(/storageKey|pathForKey|UPLOAD_STORAGE_DIR/);
  });
});
