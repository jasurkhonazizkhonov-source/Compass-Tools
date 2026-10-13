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
    expect(service("app")).toMatch(/networks:\s*\[data, web\]/);
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
