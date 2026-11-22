import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "fs";
import os from "os";
import path from "path";

// The release-branch path of deploy/deploy.sh (deploy/release-policy.sh): which branch names, which commits and which CI answers are accepted - and that the
// default main-only path and every existing safeguard are untouched. Nothing here deploys, builds, migrates or contacts GitHub: the policy functions are
// run in bash against a throw-away git repository, and deploy.sh is only run as far as its argument checks (a stub `docker` stands in for the real one).

const ROOT = path.resolve(__dirname, "..", "..").replace(/\\/g, "/");
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
const hasGit = spawnSync("git", ["--version"]).status === 0;
const d = describe.skipIf(!hasBash || !hasGit);

const bash = (script: string, cwd = ROOT, env: Record<string, string> = {}) => {
  const r = spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};
const policy = (script: string, cwd = ROOT) => bash(`source "${ROOT}/deploy/release-policy.sh"; ${script}`, cwd);
const GIT = `git -c user.name=t -c user.email=t@example.test`;

const SHA_A = "a".repeat(40);
const checks = (rows: Array<{ name: string; status?: string; conclusion?: string | null; started_at?: string; app?: { slug: string } }>) =>
  JSON.stringify({
    total_count: rows.length,
    check_runs: rows.map((r) => ({ status: "completed", conclusion: "success", started_at: "2026-11-22T10:00:00Z", app: { slug: "github-actions" }, ...r })),
  });
const REQUIRED = [
  "Static checks (types, lint, schema, scripts, secret hygiene)",
  "Unit + real-database integration tests",
  "Docker image + Compose smoke test (plaintext private database)",
];
const allGreen = () => checks(REQUIRED.map((name) => ({ name })));

d("release branch names and commit ids", () => {
  it.each(["release/compass-tools-2026-11-22", "release/v1.2.3", "release/a", "release/Hotfix_1-2"])("accepts %s", (b) => {
    expect(policy(`release_branch_name_ok '${b}'`).status).toBe(0);
  });
  it.each([
    "main", "master", "review/crm-verification-2026-11-13", "feature/x", "release", "release/", "releases/x", "xrelease/x", "release/../main", "release/a..b", "release/.hidden",
    "release/x.lock", "release/a b", "release/a;rm -rf", "release/$(id)", "release/`id`", "origin/release/x", "refs/heads/release/x", "release/x/y", "",
  ])("refuses %j", (b) => {
    expect(policy(`release_branch_name_ok "$1"`.replace('"$1"', JSON.stringify(b))).status).not.toBe(0);
  });
  it("accepts only a full lower-case 40-character commit id", () => {
    expect(policy(`full_sha_ok ${SHA_A}`).status).toBe(0);
    for (const bad of ["abc1234", "HEAD", "main", "latest", "v1.0.0", "A".repeat(40), "a".repeat(39), "a".repeat(41), `${"a".repeat(39)}g`, "release/x", ""]) {
      expect(policy(`full_sha_ok ${JSON.stringify(bad)}`).status, bad).not.toBe(0);
    }
  });
});

d("the commit must belong to the fetched release branch", () => {
  let repo: string;
  const sh = (script: string) => bash(script, repo);
  let tip = "";
  let parent = "";
  let stranger = "";
  let mainTip = "";

  beforeAll(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), "release-policy-")).replace(/\\/g, "/");
    sh(`git init -q . && ${GIT} commit -q --allow-empty -m base`);
    mainTip = sh("git rev-parse HEAD").out.trim();
    sh(`${GIT} commit -q --allow-empty -m parent`);
    parent = sh("git rev-parse HEAD").out.trim();
    sh(`${GIT} commit -q --allow-empty -m tip`);
    tip = sh("git rev-parse HEAD").out.trim();
    sh(`git checkout -q -b elsewhere ${mainTip} && ${GIT} commit -q --allow-empty -m stranger`);
    stranger = sh("git rev-parse HEAD").out.trim();
    // stand-ins for what `git fetch` leaves behind
    sh(`git update-ref refs/remotes/origin/main ${mainTip}; git update-ref refs/remotes/origin/release/r1 ${tip}`);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  const ok = (branch: string, sha: string) => policy(`release_target_ok ${JSON.stringify(branch)} ${sha}`, repo).status === 0;

  it("accepts the tip and any ancestor of origin/<release branch>", () => {
    expect(ok("release/r1", tip)).toBe(true);
    expect(ok("release/r1", parent)).toBe(true);
  });
  it("refuses a commit that is not on that branch (even though it exists in the repository)", () => {
    expect(ok("release/r1", stranger)).toBe(false);
  });
  it("refuses an unknown release branch, an unknown commit, and never falls back to main", () => {
    expect(ok("release/nope", tip)).toBe(false);
    expect(ok("release/r1", "f".repeat(40))).toBe(false);
    expect(ok("main", tip)).toBe(false); // there is no refs/remotes/origin/main-as-release lookup that would accept it: main is a different namespace
  });
  it("a commit that is only on main is not accepted as a release commit unless it is also an ancestor of the release branch", () => {
    expect(ok("release/r1", mainTip)).toBe(true); // an ancestor of the release tip: it IS part of that branch's history
    sh(`git update-ref refs/remotes/origin/release/r2 ${stranger}`);
    expect(ok("release/r2", tip)).toBe(false); // r2 does not contain tip
  });
});

d("the CI verdict (every required check green for the exact commit)", () => {
  const verdict = (json: string) => bash(`source "${ROOT}/deploy/release-policy.sh"; release_ci_verdict`, ROOT, { JSON_IN: json }).status;
  const run = (json: string) => {
    const r = spawnSync("bash", ["-c", `source "${ROOT}/deploy/release-policy.sh"; release_ci_verdict`], { cwd: ROOT, input: json, encoding: "utf8" });
    return { status: r.status, err: r.stderr ?? "" };
  };
  void verdict;

  it("passes only when all three required checks are completed + success", () => {
    expect(run(allGreen()).status).toBe(0);
  });
  it("the report-only dependency audit is not required (and extra checks are ignored)", () => {
    expect(run(checks([...REQUIRED.map((name) => ({ name })), { name: "Dependency audit (report only)", conclusion: "failure" }])).status).toBe(0);
  });
  it("a same-named check reported by another app (or with no app) is not CI and does not count", () => {
    expect(run(checks(REQUIRED.map((name, i) => ({ name, app: i === 0 ? { slug: "some-other-app" } : { slug: "github-actions" } })))).status).toBe(1);
    const noApp = JSON.parse(allGreen());
    delete noApp.check_runs[2].app;
    expect(run(JSON.stringify(noApp)).status).toBe(1);
  });
  it.each([
    ["a required check failed", checks(REQUIRED.map((name, i) => ({ name, conclusion: i === 1 ? "failure" : "success" })))],
    ["a required check is still running", checks(REQUIRED.map((name, i) => ({ name, status: i === 2 ? "in_progress" : "completed", conclusion: i === 2 ? null : "success" })))],
    ["a required check was skipped", checks(REQUIRED.map((name, i) => ({ name, conclusion: i === 0 ? "skipped" : "success" })))],
    ["a required check was cancelled", checks(REQUIRED.map((name, i) => ({ name, conclusion: i === 0 ? "cancelled" : "success" })))],
    ["a required check is missing", checks(REQUIRED.slice(0, 2).map((name) => ({ name })))],
    ["there are no check runs at all", checks([])],
  ])("refuses when %s", (_label, json) => {
    expect(run(json).status).toBe(1);
  });
  it("uses the NEWEST run of a check: a later green re-run beats an earlier red one, and a later red run beats an earlier green one", () => {
    const rerun = checks([
      ...REQUIRED.slice(1).map((name) => ({ name })),
      { name: REQUIRED[0], conclusion: "failure", started_at: "2026-11-22T09:00:00Z" },
      { name: REQUIRED[0], conclusion: "success", started_at: "2026-11-22T11:00:00Z" },
    ]);
    expect(run(rerun).status).toBe(0);
    const regress = checks([
      ...REQUIRED.slice(1).map((name) => ({ name })),
      { name: REQUIRED[0], conclusion: "success", started_at: "2026-11-22T09:00:00Z" },
      { name: REQUIRED[0], conclusion: "failure", started_at: "2026-11-22T11:00:00Z" },
    ]);
    expect(run(regress).status).toBe(1);
  });
  it("garbage, an error object or an empty answer never counts as success (fails closed)", () => {
    for (const bad of ["", "not json", "{}", '{"message":"Not Found"}', "[]", "null"]) expect(run(bad).status, bad).not.toBe(0);
  });
  it("says which check is not green, and never prints anything beyond names and states", () => {
    const r = run(checks(REQUIRED.map((name, i) => ({ name, conclusion: i === 1 ? "failure" : "success" }))));
    expect(r.err).toContain("not green: Unit + real-database integration tests");
    expect(r.err).not.toMatch(/token|secret|password/i);
  });
  it("the required names match the required jobs of .github/workflows/ci.yml exactly (the dependency audit is the only job that is not required)", () => {
    const ci = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");
    const jobNames = [...ci.matchAll(/^ {4}name: (.+)$/gm)].map((m) => m[1].trim());
    const required = jobNames.filter((n) => !/report only/i.test(n));
    expect([...required].sort()).toEqual([...REQUIRED].sort());
    const script = readFileSync(path.join(ROOT, "deploy", "release-policy.sh"), "utf8");
    for (const n of required) expect(script).toContain(n);
  });
});

d("the GitHub repository is taken from the fetch URL only", () => {
  const repoOf = (url: string) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "release-policy-url-")).replace(/\\/g, "/");
    try {
      bash(`git init -q . && git remote add origin ${JSON.stringify(url)}`, dir);
      return policy("release_github_repo", dir).out;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  it("parses the https and ssh forms of a github.com URL, with and without .git", () => {
    expect(repoOf("https://github.com/owner/Repo-Name.git")).toBe("owner/Repo-Name");
    expect(repoOf("https://github.com/owner/repo")).toBe("owner/repo");
    expect(repoOf("git@github.com:owner/repo.git")).toBe("owner/repo");
  });
  it("returns nothing for any other host (so the CI answer cannot be read and the deployment is refused)", () => {
    expect(repoOf("https://git.example.com/owner/repo.git")).toBe("");
    expect(repoOf("https://github.com.evil.example/owner/repo.git")).toBe("");
  });
});

d("deploy.sh: release-branch mode refuses everything unsafe before it touches anything", () => {
  let stub: string;
  beforeAll(() => {
    stub = mkdtempSync(path.join(os.tmpdir(), "release-stub-")).replace(/\\/g, "/");
    mkdirSync(stub, { recursive: true });
    writeFileSync(path.join(stub, "docker"), "#!/usr/bin/env bash\necho 'docker must not be used by these checks' >&2\nexit 99\n");
    chmodSync(path.join(stub, "docker"), 0o755);
  });
  afterAll(() => rmSync(stub, { recursive: true, force: true }));
  const deploy = (args: string) => bash(`bash "${ROOT}/deploy/deploy.sh" ${args} </dev/null`, ROOT, { PATH: `${stub}${path.delimiter}${process.env.PATH ?? ""}`.replace(/\\/g, "/") });

  it.each([
    ["--release-branch main --ref " + SHA_A, /must be exactly release\/<name>/],
    ["--release-branch review/crm-verification-2026-11-13 --ref " + SHA_A, /must be exactly release\/<name>/],
    ["--release-branch release/x", /needs --ref/],
    ["--release-branch release/x --ref origin/release/x", /FULL 40-character/],
    ["--release-branch release/x --ref abc1234", /FULL 40-character/],
    ["--release-branch release/x --ref HEAD", /FULL 40-character/],
    ["--ci-attested", /only applies together with --release-branch/],
    ["--ci-attested --ref " + SHA_A, /only applies together with --release-branch/],
  ])("deploy.sh %s is refused with a clear message", (args, message) => {
    const r = deploy(args);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(message);
    expect(r.err).not.toMatch(/docker must not be used/);
  });
  it("an unknown option is still refused", () => {
    expect(deploy("--whatever").status).toBe(1);
  });
});

d("deploy.sh: the default path and every safeguard are unchanged", () => {
  const text = readFileSync(path.join(ROOT, "deploy", "deploy.sh"), "utf8").replace(/\r\n/g, "\n");
  const code = text.replace(/^[ \t]*#.*$/gm, "").replace(/\n\s*\n/g, "\n"); // comments and blank lines removed: only what the script can execute is asserted on
  it("still defaults to origin/main and still requires a main ancestor outside release-branch mode", () => {
    expect(text).toMatch(/REF="origin\/main"/);
    expect(text).toMatch(/else\n\s+git merge-base --is-ancestor "\$TARGET" origin\/main \|\| die/);
  });
  it("release-branch mode: validates the name and the full commit id, fetches that branch, checks ancestry and CI, and deploys detached - and never touches main", () => {
    const start = code.indexOf('if [ -n "$RELEASE_BRANCH" ]; then\n  git fetch');
    const end = code.indexOf("\nelse\n  git merge-base", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = code.slice(start, end);
    expect(block).toContain("release_target_ok");
    expect(block).toContain("release_ci_green");
    expect(block).toContain("--ci-attested");
    expect(block).not.toMatch(/checkout|merge --ff|origin\/main/); // this branch of the script never switches to or fast-forwards main
    expect(block).not.toMatch(/\bmain\b[^"]*(fetch|checkout|merge)/);
    expect(text).toContain("release_branch_name_ok");
    expect(text).toContain("full_sha_ok");
    // the checkout of a non-main ref is the detached one
    expect(text).toMatch(/git checkout --quiet --detach "\$TARGET"/);
  });
  it("the existing protections are still all there, in the same order: clean checkout, backup before migrate, migrate gate, verify", () => {
    for (const needle of ["git status --porcelain", "--ff-only", "--migrate) MIGRATE=1", "backup-db.sh", "migrate deploy", "verify.sh", "APP_VERSION"]) expect(text).toContain(needle);
    expect(code.indexOf("git status --porcelain")).toBeLessThan(code.indexOf("release_target_ok"));
    expect(code.indexOf("release_ci_green")).toBeLessThan(code.indexOf("dc build app tools"));
    expect(code.indexOf("backup-db.sh")).toBeLessThan(code.indexOf("prisma migrate deploy"));
    expect(code).not.toMatch(/migrate reset|db push|migrate dev|DROP (DATABASE|TABLE)|git reset|git clean|--force|push -f/);
  });
  it("nothing in the policy file deploys, builds, migrates or restarts anything", () => {
    const policyText = readFileSync(path.join(ROOT, "deploy", "release-policy.sh"), "utf8");
    const noChecksList = policyText.replace(/^\s*#.*$/gm, "").replace(/RELEASE_REQUIRED_CHECKS=\([\s\S]*?\n\)/, "");
    expect(noChecksList).not.toMatch(/docker|compose|migrate|prisma|systemctl|rm -rf|git (checkout|merge(?!-base)|reset|push|clean|stash|commit)/);
  });
  it("no GitHub token is read, sent or stored by the policy", () => {
    const policyText = readFileSync(path.join(ROOT, "deploy", "release-policy.sh"), "utf8").replace(/^\s*#.*$/gm, "");
    expect(policyText).not.toMatch(/Authorization|GITHUB_TOKEN|GH_TOKEN|\.netrc|Bearer/i);
  });
});
