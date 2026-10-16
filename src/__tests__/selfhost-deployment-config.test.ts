import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import path from "path";

// Guards for the self-hosted deployment files (Dockerfile, compose.yaml, .dockerignore, deploy/*, the CVV job). They check the safety
// properties that matter, as text, so a future edit cannot quietly publish the database, unpin an image, open the card vault, put a
// secret in a build argument, or widen the CVV job. They do not replace running the stack: deploy/ci-smoke.sh (CI) does that.
const ROOT = path.resolve(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf-8").replace(/\r\n/g, "\n");
const compose = read("compose.yaml");
const dockerfile = read("Dockerfile");
const dockerignore = read(".dockerignore");
const envExample = read(".env.example");

/** The text of one service under `services:` (2-space-indented key to the next one). */
function service(name: string): string {
  const servicesBlock = compose.slice(compose.indexOf("\nservices:\n"), compose.indexOf("\nnetworks:\n"));
  const parts = servicesBlock.split(/^  ([a-z][a-z0-9-]*):\n/m);
  const i = parts.indexOf(name);
  if (i < 0) throw new Error(`service ${name} not found`);
  return parts[i + 1];
}
const uncommented = (s: string) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
/** Source without full-line comments (`//` or `#`), so a rule is checked against what actually runs, not against prose that mentions it. */
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|#)/.test(l)).join("\n");

describe("compose.yaml: nothing is exposed on the host", () => {
  it("no service publishes a port", () => {
    expect(uncommented(compose)).not.toMatch(/^\s+ports:/m);
  });

  it("the database is on the internal network only, and that network has no route out", () => {
    expect(service("db")).toMatch(/networks:\s*\[data\]/);
    expect(service("db")).not.toMatch(/web/);
    expect(compose).toMatch(/\n  data:\n    internal: true/);
  });

  it("the app is reachable by other containers only (expose, not ports) and cloudflared is on the same network as the app", () => {
    expect(service("app")).toMatch(/expose:\s*\n\s+- "3000"/);
    // data (database), web (cloudflared) and website_api (the website's backend only; reached as http://compass-crm:3000)
    expect(service("app")).toMatch(/networks:\s*\n\s+data: \{\}\n\s+web: \{\}\n\s+website_api:\s*\n\s+aliases: \[compass-crm\]/);
    expect(service("cloudflared")).toMatch(/networks:\s*\[web\]/);
  });

  it("TRUSTED_PROXY is cloudflare for the app (safe only because no port is published)", () => {
    expect(service("app")).toMatch(/TRUSTED_PROXY: cloudflare/);
  });

  it("every container drops all capabilities and cannot gain privileges", () => {
    for (const name of ["app", "cloudflared", "cvv-cleanup", "tools"]) {
      const block = service(name);
      expect(block, name).toContain("*hardening");
    }
    expect(compose).toMatch(/x-hardening:[\s\S]*no-new-privileges:true[\s\S]*cap_drop:\s*\n\s+- ALL/);
  });
});

describe("images are pinned", () => {
  it("every third-party image is pinned by version AND digest", () => {
    for (const line of compose.split("\n").filter((l) => /^\s+image: (postgres|cloudflare)/.test(l))) {
      expect(line).toMatch(/image: [a-z/]+:\d[\w.-]*@sha256:[0-9a-f]{64}$/);
    }
    expect(dockerfile).toMatch(/ARG NODE_IMAGE=node:\d+\.\d+\.\d+-bookworm-slim@sha256:[0-9a-f]{64}/);
  });

  it("nothing uses a floating tag", () => {
    const refs = [...compose.matchAll(/^\s+image: (\S+)/gm)].map((m) => m[1]).concat([...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]));
    for (const ref of refs) expect(ref, ref).not.toMatch(/:(latest|lts|current)(@|$)/);
  });
});

describe("secrets stay out of the repository, the image and the build", () => {
  it("the only build argument is the public APP_BASE_URL; no ARG/ENV carries a secret", () => {
    expect([...dockerfile.matchAll(/^ARG (\w+)/gm)].map((m) => m[1]).sort()).toEqual(["APP_BASE_URL", "NODE_IMAGE"]);
    expect(dockerfile).not.toMatch(/^\s*(ENV|ARG)\s+\w*(SECRET|PASSWORD|TOKEN|_KEY|DATABASE_URL)\w*/im);
    expect(compose).toMatch(/build:[\s\S]*args:\s*\n\s+(#.*\n\s+)?APP_BASE_URL:/);
    expect(uncommented(compose.slice(compose.indexOf("args:"), compose.indexOf("restart:", compose.indexOf("args:"))))).not.toMatch(/SECRET|PASSWORD|TOKEN|KEY/);
  });

  it("compose.yaml contains no secret value — only ${VARIABLE} references", () => {
    expect(compose).not.toMatch(/(PASSWORD|SECRET|TOKEN|KEY)[A-Z_]*:\s*["']?[A-Za-z0-9+/=_-]{20,}/);
    expect(compose).not.toMatch(/postgres(ql)?:\/\/[^$\s]*:[^$@\s]+@/); // a URL with a literal password
  });

  it("each secret reaches only the containers that need it", () => {
    expect(service("cloudflared")).toMatch(/TUNNEL_TOKEN/);
    for (const name of ["app", "cvv-cleanup", "tools", "db"]) expect(service(name), name).not.toMatch(/TUNNEL_TOKEN/);
    expect(service("cloudflared")).not.toMatch(/DATABASE_URL|CARD_ENCRYPTION|CRON_SECRET|GOOGLE_CLIENT_SECRET/);
    expect(service("cvv-cleanup")).not.toMatch(/CARD_ENCRYPTION|GOOGLE_CLIENT_SECRET|DATABASE_URL|POSTGRES_PASSWORD/);
    expect(service("db")).not.toMatch(/CARD_ENCRYPTION|CRON_SECRET|GOOGLE_CLIENT_SECRET|TUNNEL_TOKEN/);
  });

  it(".dockerignore keeps environment files and key material out of the build context", () => {
    for (const pattern of ["**/.env", "**/.env.*", "!**/.env.example", "**/*.pem", "**/*.key", "backups", ".git", "node_modules", ".next"]) expect(dockerignore, pattern).toContain(pattern);
    // ...without excluding anything the build needs
    for (const needed of ["prisma", "src", "public", "scripts", "package.json", "package-lock.json", "next.config.ts"]) expect(dockerignore.split("\n"), needed).not.toContain(needed);
    expect(dockerignore.split("\n")).not.toContain("scripts"); // the helper scripts are copied into the image
  });

  it("the Dockerfile fails the build if an environment file reaches the image", () => {
    expect(dockerfile).toMatch(/find \/app -maxdepth 2[^\n]*\.env/);
  });

  it(".env.example holds placeholders only and the git ignore rules protect real files", () => {
    // every secret-bearing variable is empty or an obvious "replace-with-…" placeholder - never a real-looking value
    for (const m of envExample.matchAll(/^(POSTGRES_PASSWORD|TUNNEL_TOKEN|CARD_ENCRYPTION_KEY|IP_ENCRYPTION_KEY|IP_HASH_KEY|GMAIL_TOKEN_ENCRYPTION_KEY|CRON_SECRET|GOOGLE_CLIENT_SECRET)="([^"]*)"/gm)) {
      expect(m[2] === "" || /^(replace-with|your-)/.test(m[2]), `${m[1]} must be empty or a placeholder`).toBe(true);
    }
    const ignore = read(".gitignore");
    expect(ignore).toMatch(/^\.env\*$/m);
    expect(ignore).toMatch(/^!\.env\.example$/m);
    expect(ignore).toMatch(/\*\.dump/);
  });
});

describe("owner decisions are not made by the deployment files", () => {
  it("the card vault stays closed and no card-number retention is configured", () => {
    // Passed through from .env (empty = closed / disabled)...
    expect(service("app")).toMatch(/CARD_VAULT_MODE: \$\{CARD_VAULT_MODE:-\}/);
    expect(service("app")).toMatch(/CARD_RETENTION_DAYS: \$\{CARD_RETENTION_DAYS:-\}/);
    // ...and never set to a value by any file in the repository
    for (const text of [compose, uncommented(envExample)]) {
      expect(text).not.toMatch(/CARD_VAULT_MODE[:=]\s*"?application-encryption-risk-accepted/);
      expect(text).not.toMatch(/^\s*CARD_RETENTION_DAYS[:=]\s*"?\d/m);
    }
  });

  it("there is no configurable CVV retention anywhere in the deployment", () => {
    for (const file of ["compose.yaml", ".env.example", "scripts/cvv-cleanup-scheduler.mjs", "src/app/api/cron/cvv-cleanup/route.ts"]) {
      expect(read(file), file).not.toMatch(/CVV_RETENTION|CVV_TTL|CVV_EXPIR[A-Z_]*\s*=/);
    }
  });

  it("database TLS is disabled only for the compose database, and a remote setting is not passed alongside it", () => {
    for (const name of ["app", "tools"]) {
      expect(service(name), name).toMatch(/DATABASE_SSL_MODE: disable/);
      expect(service(name), name).not.toMatch(/DATABASE_SSL_CA|DATABASE_SSL_VERIFY/);
      expect(service(name), name).toMatch(/@db:5432\//);
    }
  });
});

describe("the daily CVV cleanup job", () => {
  const scheduler = read("scripts", "cvv-cleanup-scheduler.mjs");

  it("calls only the dedicated endpoint, by POST, over the internal address, with the bearer secret", () => {
    expect(scheduler).toContain("/api/cron/cvv-cleanup");
    expect(scheduler).toMatch(/method: "POST"/);
    expect(scheduler).toMatch(/authorization: `Bearer \$\{SECRET\}`/);
    expect(code(scheduler)).not.toMatch(/\/api\/cron\/(tasks|sequences|leads)/);
    expect(service("cvv-cleanup")).toMatch(/CRON_TARGET_URL: http:\/\/app:3000/);
  });

  it("never logs or interpolates the secret into output, URLs or errors", () => {
    // the secret's VALUE is interpolated exactly once - into the Authorization header - and nowhere else
    const body = code(scheduler);
    expect(body.match(/\$\{SECRET\}/g)).toHaveLength(1);
    expect(body).toMatch(/authorization: `Bearer \$\{SECRET\}`/);
    expect(body).not.toMatch(/JSON\.stringify\([^)]*\bSECRET\b/);
    expect(body).not.toMatch(/(console\.\w+|log)\(\s*[^)]*[,(]\s*SECRET\s*[,)]/); // the variable itself is never handed to a logger
  });

  it("retries a failure and catches up after a restart; it neither deletes data itself nor sets a retention", () => {
    expect(scheduler).toMatch(/RETRY_DELAYS_MS = \[0, 60_000, 300_000, 900_000\]/);
    expect(scheduler).toMatch(/catch-up/);
    expect(scheduler).not.toMatch(/DELETE|deleteMany|prisma|pg\b/);
  });

  it("is a separate container that does not inherit the web server's health check", () => {
    expect(service("cvv-cleanup")).toMatch(/healthcheck:\s*\n\s+disable: true/);
    expect(service("cvv-cleanup")).toMatch(/command: \["node", "scripts\/cvv-cleanup-scheduler.mjs"\]/);
  });

  it("the Vercel cron configuration is untouched", () => {
    expect(JSON.parse(read("vercel.json")).crons).toEqual([{ path: "/api/cron/tasks", schedule: "0 3 * * *" }]);
  });
});

describe("operational scripts keep their safety rules", () => {
  const deploy = read("deploy", "deploy.sh");
  const backup = read("deploy", "backup-db.sh");
  const restore = read("deploy", "restore-db.sh");

  it("deploy: refuses a dirty checkout, only fast-forwards, only deploys commits on origin/main, and never migrates implicitly", () => {
    expect(deploy).toContain("git status --porcelain");
    expect(deploy).toContain("--ff-only");
    expect(deploy).toContain("merge-base --is-ancestor");
    expect(deploy).toMatch(/--migrate\) MIGRATE=1/);
    expect(deploy).toMatch(/migrate deploy/);
    expect(deploy).not.toMatch(/migrate reset|db push|migrate dev|DROP (DATABASE|TABLE)|git reset|git clean|--force|push -f/);
  });

  it("backup: excludes the CVV table's data, verifies it, restricts permissions and refuses an unencrypted copy when encryption is requested", () => {
    expect(backup).toContain('--exclude-table-data="\\"PaymentMethodCvv\\""');
    expect(backup).toMatch(/TABLE DATA public[^\n]*PaymentMethodCvv/);
    expect(backup).toContain("umask 077");
    expect(backup).toContain("chmod 700");
    expect(backup).toMatch(/BACKUP_AGE_RECIPIENT[\s\S]*Refusing to write an unencrypted backup/);
  });

  it("restore: the default is a harmless test restore and replacing the live database needs the typed database name and a safety backup", () => {
    expect(restore).toContain('MODE="${2:---verify}"');
    expect(restore).toMatch(/Type the database name/);
    expect(restore).toMatch(/Safety backup of the CURRENT database/);
  });

  it("scripts do not print secrets or source the environment file on the host", () => {
    for (const file of ["common.sh", "deploy.sh", "backup-db.sh", "restore-db.sh", "rollback.sh", "verify.sh"]) {
      const text = code(read("deploy", file));
      expect(text, file).not.toMatch(/source\s+\.?\/?\.env|\.\s+\.env|cat\s+\.env|echo\s+.*\$\{?(POSTGRES_PASSWORD|TUNNEL_TOKEN|CRON_SECRET|CARD_ENCRYPTION)/);
    }
    expect(read("deploy", "common.sh")).toMatch(/600\|400/);
  });
});

describe("the app image", () => {
  it("runs as a non-root user in production mode with a health check, and the default stage is the runner", () => {
    const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
    expect(runner).toMatch(/^USER node$/m);
    expect(runner).toMatch(/NODE_ENV=production/);
    expect(runner).toMatch(/^HEALTHCHECK /m);
    expect(runner).toMatch(/CMD \["node", "server\.js"\]/);
    expect(dockerfile.lastIndexOf("FROM ")).toBeGreaterThan(dockerfile.indexOf("AS tools")); // runner is last = default target
  });

  it("installs from the lockfile and requires a public https origin at build time", () => {
    expect(dockerfile).toMatch(/RUN npm ci$/m);
    expect(dockerfile).not.toMatch(/npm install|--legacy-peer-deps|--force/);
    expect(dockerfile).toMatch(/https:\/\/\*\) ;;/);
  });

  it("copies sharp's complete native packages, and the files it copies exist", () => {
    expect(dockerfile).toMatch(/COPY --from=deps [^\n]*\/app\/node_modules\/@img/);
    for (const f of ["scripts/healthcheck.mjs", "scripts/cvv-cleanup-scheduler.mjs"]) expect(existsSync(path.join(ROOT, f)), f).toBe(true);
    expect(dockerfile).toContain("scripts/healthcheck.mjs");
    expect(dockerfile).toContain("scripts/cvv-cleanup-scheduler.mjs");
  });

  it("the standalone output switch is off unless the Docker build asks for it", async () => {
    const saved = process.env.NEXT_OUTPUT;
    try {
      delete process.env.NEXT_OUTPUT;
      const { default: vi } = await import("vitest").then((m) => ({ default: m.vi }));
      vi.resetModules();
      const normal = (await import("../../next.config")).default as { output?: string; outputFileTracingRoot?: string };
      expect(normal.output).toBeUndefined();
      expect(normal.outputFileTracingRoot).toBeUndefined();
      process.env.NEXT_OUTPUT = "standalone";
      vi.resetModules();
      const docker = (await import("../../next.config")).default as { output?: string; outputFileTracingRoot?: string };
      expect(docker.output).toBe("standalone");
      expect(docker.outputFileTracingRoot).toBe(process.cwd());
    } finally {
      if (saved === undefined) delete process.env.NEXT_OUTPUT;
      else process.env.NEXT_OUTPUT = saved;
    }
  });
});

describe("Lead document storage: a persistent, private bind mount on the VPS", () => {
  const app = service("app");
  const tools = service("tools");

  it("the app mounts a HOST directory (not a named volume), refuses to auto-create it, at the path the application expects", () => {
    expect(app).toMatch(/- type: bind\n\s+source: \$\{UPLOADS_HOST_DIR:-\/srv\/compass-tools\/uploads\}\n\s+target: \/var\/lib\/compass-tools\/uploads\n\s+bind:\n\s+create_host_path: false/);
    expect(app).toMatch(/UPLOAD_STORAGE_DIR: \/var\/lib\/compass-tools\/uploads/);
    expect(uncommented(compose)).not.toMatch(/^volumes:\n(\s+\w+:.*\n)*\s+uploads/m); // no named uploads volume
  });

  it("only the app writes; the maintenance container is read-only; the database and the other containers never see the uploads", () => {
    expect(tools).toMatch(/target: \/var\/lib\/compass-tools\/uploads\n\s+read_only: true/);
    for (const name of ["db", "cloudflared", "cvv-cleanup"]) expect(service(name), name).not.toMatch(/compass-tools\/uploads|UPLOADS_HOST_DIR/);
  });

  it("the mount point is owned by the non-root image user (uid/gid 1000), and the app never needs to run as root", () => {
    expect(dockerfile).toMatch(/\/var\/lib\/compass-tools\/uploads/);
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(app).not.toMatch(/^\s+user:\s*["']?0|privileged:\s*true/m);
  });

  it("nothing serves the directory: it is not under public/, not copied into the image and not excluded from or added to the build by accident", () => {
    expect(existsSync(path.join(ROOT, "public", "uploads"))).toBe(false);
    expect(dockerignore).toMatch(/uploads/);
    expect(read(".gitignore")).toMatch(/\.local-uploads/);
    expect(uncommented(compose)).not.toMatch(/\/var\/lib\/compass-tools\/uploads:\/(usr|var\/www|public)/);
  });

  it("no cloud-storage credential is passed to any container or documented in .env.example", () => {
    for (const name of ["app", "db", "cloudflared", "cvv-cleanup", "tools"]) expect(service(name), name).not.toMatch(/R2_|S3_|AWS_/);
    expect(envExample).not.toMatch(/R2_|S3_|AWS_/);
  });

  it(".env.example documents the storage settings without a real value", () => {
    for (const name of ["UPLOAD_STORAGE_DIR", "UPLOAD_MIN_FREE_MB", "UPLOADS_HOST_DIR", "MAX_LEAD_ATTACHMENT_SIZE_MB"]) expect(envExample, name).toContain(name);
  });
});

describe("upload operations scripts", () => {
  const backupUploads = read("deploy", "backup-uploads.sh");
  const restoreUploads = read("deploy", "restore-uploads.sh");
  const usage = read("deploy", "uploads-usage.sh");
  const verify = read("deploy", "verify.sh");
  const smoke = read("deploy", "ci-smoke.sh");
  const reconcile = read("scripts", "attachments-reconcile.ts");

  it("the backup reads inside the container as the app user, verifies the archive, checks disk space, keeps it private and can encrypt it", () => {
    expect(backupUploads).toContain("in_uploads_container tar");
    expect(backupUploads).toContain("gzip -t");
    expect(backupUploads).toContain("[0-9a-f]{64}");
    expect(backupUploads).toContain("--exclude=./.tmp");
    expect(backupUploads).toMatch(/Not enough free space/);
    expect(backupUploads).toContain("umask 077");
    expect(backupUploads).toContain("chmod 700");
    expect(backupUploads).toMatch(/BACKUP_AGE_RECIPIENT[\s\S]*Refusing to write an unencrypted backup/);
    expect(code(backupUploads)).not.toMatch(/\bsudo\b\s+(rm|tar|chown)|docker compose down|\brm -rf\b/);
  });

  it("the restore defaults to a harmless check, rejects unexpected archive entries, asks for a typed confirmation and never deletes the old files", () => {
    expect(restoreUploads).toContain('MODE="${2:---check}"');
    expect(restoreUploads).toContain("[0-9a-f]{64}");
    expect(restoreUploads).toMatch(/Type RESTORE/);
    expect(restoreUploads).toContain(".before-restore-");
    expect(restoreUploads).toContain("--no-same-owner");
    expect(code(restoreUploads)).not.toMatch(/\brm -rf\b|\brm -r\b/); // the removal is only SUGGESTED in an echoed message
  });

  it("the usage report is read-only and never prints a file name", () => {
    expect(code(usage).replace(/--rm\b/g, "")).not.toMatch(/(^|[\s;|&(])rm\s|\bdelete\b|DELETE|UPDATE|INSERT|(^|[\s;|&(])mv\s|\s-delete\b|\s-exec\b/i);
    expect(usage).not.toMatch(/fileName|"name"/);
  });

  it("deploy, verify and the CI smoke test cover the upload directory", () => {
    expect(read("deploy", "deploy.sh")).toContain("check_uploads_dir");
    expect(read("deploy", "common.sh")).toMatch(/1000:1000/);
    expect(verify).toContain("uploadStorage=");
    expect(verify).toMatch(/PROBE_OK/);
    expect(smoke).toContain("UPLOADS_HOST_DIR");
    expect(smoke).toMatch(/force-recreate/);
    expect(smoke).toMatch(/uploadStorage/);
  });

  it("the daily backup unit saves the documents as well as the database", () => {
    const unit = read("deploy", "systemd", "compass-tools-backup.service");
    expect(unit).toContain("deploy/backup-db.sh");
    expect(unit).toContain("deploy/backup-uploads.sh");
    expect(unit.indexOf("backup-db.sh")).toBeLessThan(unit.indexOf("backup-uploads.sh")); // the database first
  });

  it("the reconcile report never modifies or deletes anything", () => {
    const body = code(reconcile);
    expect(body).not.toMatch(/\b(unlink|rm|rmdir|rename|writeFile|appendFile|truncate|copyFile|mkdir|chmod|chown)\w*\s*\(/);
    expect(body.replace(/searchParams\.delete\(/g, "")).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\s*\(|\$executeRaw|\b(INSERT|UPDATE|DELETE)\s/);
    expect(body).not.toMatch(/fileName|originalName/); // customers' file names are never printed
  });
});

describe("daily maintenance (stale upload sweep) is an opt-in timer, not something the repository switches on", () => {
  const script = read("deploy", "run-daily-maintenance.sh");
  const service = read("deploy", "systemd", "compass-tools-maintenance.service");
  const timer = read("deploy", "systemd", "compass-tools-maintenance.timer");

  it("calls the app's own cron endpoint from inside the container, so the secret never leaves it", () => {
    expect(script).toContain("dc exec -T app node");
    expect(script).toContain("/api/cron/tasks");
    expect(script).toContain("process.env.CRON_SECRET");
    expect(script).toContain("127.0.0.1");
    expect(code(script)).not.toMatch(/\$\{?CRON_SECRET|cat\s+\.env|source\s+\.?\/?\.env|curl|wget/); // never read or echoed on the host
    expect(code(script)).not.toMatch(/\brm\b|DELETE|docker compose (down|stop)/);
  });

  it("the units schedule it daily, after the backup, and nothing in the repository enables them", () => {
    expect(service).toContain("deploy/run-daily-maintenance.sh");
    expect(service).toMatch(/Type=oneshot/);
    expect(timer).toMatch(/OnCalendar=\*-\*-\* 03:30:00 UTC/);
    expect(timer).toMatch(/Persistent=true/);
    for (const text of [read("deploy", "deploy.sh"), read("deploy", "common.sh"), read("deploy", "ci-smoke.sh"), compose]) {
      expect(code(text)).not.toMatch(/systemctl|compass-tools-maintenance/);
    }
  });

  it("the CI workflow only checks code: no deploy step, no repository secret, and it also covers feature branches", () => {
    const ci = read(".github", "workflows", "ci.yml");
    expect(ci).toMatch(/branches: \[main, "feature\/\*\*"\]/);
    expect(code(ci)).not.toMatch(/\$\{\{\s*secrets\.|\bssh |\bscp |rsync |docker push|docker login/i); // comments excluded
    expect(ci).toMatch(/shellcheck -x -S warning deploy\/\*\.sh/);
  });
});
