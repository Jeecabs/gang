import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseDiff, recommendedReviewerCount } from "./skills/gang-review/scripts/prepare-review.mjs";

const SCRIPT = fileURLToPath(new URL("./skills/gang-review/scripts/prepare-review.mjs", import.meta.url));

type ReviewPlan = {
  source: Record<string, unknown>;
  files: Array<{ path: string; diffPath: string }>;
  excluded: Array<{ path: string; reason: string }>;
  totals: { files: number; added: number; removed: number; lines: number };
  recommendedReviewers: number;
  cleanupPath: string | null;
};

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function git(cwd: string, ...args: string[]): string {
  return run("git", args, cwd).trim();
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "gang-review-test-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "gang-review@example.test");
  git(repo, "config", "user.name", "Gang Review Test");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
  writeFileSync(join(repo, "package-lock.json"), "{\"lockfileVersion\": 3}\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "initial");
  return repo;
}

function prepare(repo: string, ...args: string[]): ReviewPlan {
  return JSON.parse(run(process.execPath, [SCRIPT, ...args], repo)) as ReviewPlan;
}

function prepareWithEnv(repo: string, env: NodeJS.ProcessEnv, ...args: string[]): ReviewPlan {
  return JSON.parse(run(process.execPath, [SCRIPT, ...args], repo, env)) as ReviewPlan;
}

function cleanup(plan: ReviewPlan, repo: string): void {
  if (!plan.cleanupPath) return;
  run(process.execPath, [SCRIPT, "cleanup", plan.cleanupPath], repo);
}

test("prepare-review applies reviewer-count thresholds", () => {
  assert.equal(recommendedReviewerCount(0, 0), 0);
  assert.equal(recommendedReviewerCount(99, 10), 1);
  assert.equal(recommendedReviewerCount(100, 4), 2);
  assert.equal(recommendedReviewerCount(500, 9), 3);
  assert.equal(recommendedReviewerCount(2000, 10), 5);
  assert.equal(recommendedReviewerCount(5000, 20), 16);
});

test("prepare-review does not mistake source text about binary patches for a binary file", () => {
  const parsed = parseDiff([
    "diff --git a/review.ts b/review.ts",
    "--- a/review.ts",
    "+++ b/review.ts",
    "@@ -1 +1,2 @@",
    " export const old = true;",
    "+const marker = \"GIT binary patch\";",
  ].join("\n"));
  assert.deepEqual(parsed.files.map((file) => file.path), ["review.ts"]);
  assert.deepEqual(parsed.excluded, []);
});

test("prepare-review preserves quoted Unicode paths and counts marker-like hunk lines", () => {
  const parsed = parseDiff([
    'diff --git "a/café\\tname.ts" "b/café\\tname.ts"',
    '--- "a/café\\tname.ts"',
    '+++ "b/café\\tname.ts"',
    "@@ -1 +1 @@",
    "---removed",
    "+++added",
  ].join("\n"));
  assert.equal(parsed.files[0]?.path, "café\tname.ts");
  assert.equal(parsed.files[0]?.linesAdded, 1);
  assert.equal(parsed.files[0]?.linesRemoved, 1);

  const octal = parseDiff([
    'diff --git "a/\\303\\251.ts" "b/\\303\\251.ts"',
    '--- "a/\\303\\251.ts"',
    '+++ "b/\\303\\251.ts"',
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n"));
  assert.equal(octal.files[0]?.path, "é.ts");
});

test("prepare-review resolves mode-only paths that contain spaces", () => {
  const parsed = parseDiff([
    "diff --git a/space name.ts b/space name.ts",
    "old mode 100644",
    "new mode 100755",
  ].join("\n"));
  assert.equal(parsed.files[0]?.path, "space name.ts");
});

test("prepare-review JavaScript entry runs from an npm node_modules path", () => {
  const repo = initRepo();
  let plan: ReviewPlan | undefined;
  try {
    const installedScript = join(repo, "node_modules", "pi-gang", "prepare-review.mjs");
    mkdirSync(join(repo, "node_modules", "pi-gang"), { recursive: true });
    copyFileSync(SCRIPT, installedScript);
    writeFileSync(join(repo, "a.ts"), "export const a = 9;\n");

    plan = JSON.parse(run(process.execPath, [installedScript, "worktree"], repo)) as ReviewPlan;
    assert.deepEqual(plan.files.map((file) => file.path), ["a.ts"]);
    assert.equal(installedScript.endsWith(".mjs"), true);
    run(process.execPath, [installedScript, "cleanup", plan.cleanupPath!], repo);
    plan = undefined;
  } finally {
    if (plan?.cleanupPath) rmSync(plan.cleanupPath, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prepare-review snapshots staged, unstaged, and untracked files while filtering noise", () => {
  const repo = initRepo();
  let plan: ReviewPlan | undefined;
  try {
    writeFileSync(join(repo, "a.ts"), "export const a = 2;  \n");
    writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
    git(repo, "add", "b.ts");
    writeFileSync(join(repo, "new.ts"), "export const fresh = true;\n");
    writeFileSync(join(repo, "space name.ts"), "export const spaced = true;\n");
    writeFileSync(join(repo, "package-lock.json"), "{\"lockfileVersion\": 4}\n");

    plan = prepare(repo, "worktree");

    assert.equal(plan.source.kind, "worktree");
    assert.deepEqual(plan.files.map((file) => file.path), ["a.ts", "b.ts", "new.ts", "space name.ts"]);
    assert.deepEqual(plan.excluded.map(({ path, reason }) => ({ path, reason })), [
      { path: "package-lock.json", reason: "lock file" },
    ]);
    assert.equal(plan.totals.files, 4);
    assert.equal(plan.recommendedReviewers, 1);
    for (const file of plan.files) {
      assert.equal(existsSync(file.diffPath), true);
      assert.match(readFileSync(file.diffPath, "utf8"), /^diff --git /);
    }
    const aPatch = readFileSync(plan.files.find((file) => file.path === "a.ts")!.diffPath, "utf8");
    assert.match(aPatch, /\+export const a = 2;  \n/);

    const cleanupPath = plan.cleanupPath;
    cleanup(plan, repo);
    assert.equal(existsSync(cleanupPath!), false);
    plan = undefined;
  } finally {
    if (plan?.cleanupPath) rmSync(plan.cleanupPath, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prepare-review captures a rename-only path that contains spaces", () => {
  const repo = initRepo();
  let plan: ReviewPlan | undefined;
  try {
    git(repo, "mv", "a.ts", "renamed file.ts");
    plan = prepare(repo, "worktree");
    assert.deepEqual(plan.files.map((file) => file.path), ["renamed file.ts"]);
    assert.match(readFileSync(plan.files[0]!.diffPath, "utf8"), /rename to renamed file\.ts/);
  } finally {
    if (plan) cleanup(plan, repo);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prepare-review pins base and commit targets to resolved SHAs", () => {
  const repo = initRepo();
  const plans: ReviewPlan[] = [];
  try {
    const baseSha = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "a.ts"), "export const a = 3;\n");
    git(repo, "add", "a.ts");
    git(repo, "commit", "-qm", "change a");
    const headSha = git(repo, "rev-parse", "HEAD");

    const basePlan = prepare(repo, "base", baseSha);
    plans.push(basePlan);
    assert.equal(basePlan.source.baseSha, baseSha);
    assert.equal(basePlan.source.mergeBaseSha, baseSha);
    assert.equal(basePlan.source.headSha, headSha);
    assert.deepEqual(basePlan.files.map((file) => file.path), ["a.ts"]);

    const commitPlan = prepare(repo, "commit", "HEAD");
    plans.push(commitPlan);
    assert.equal(commitPlan.source.commitSha, headSha);
    assert.deepEqual(commitPlan.files.map((file) => file.path), ["a.ts"]);
  } finally {
    for (const plan of plans) cleanup(plan, repo);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prepare-review uses the aggregate diff for multi-commit PRs", () => {
  const repo = initRepo();
  let plan: ReviewPlan | undefined;
  try {
    const binDir = join(repo, "fake-bin");
    const logPath = join(repo, "fake-gh.log");
    mkdirSync(binDir);
    const aggregateDiff = [
      "diff --git a/final.ts b/final.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/final.ts",
      "@@ -0,0 +1 @@",
      "+export const final = true;",
      "",
    ].join("\n");
    const patchSeries = [
      "diff --git a/reverted.ts b/reverted.ts",
      "--- a/reverted.ts",
      "+++ b/reverted.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      "diff --git a/reverted.ts b/reverted.ts",
      "--- a/reverted.ts",
      "+++ b/reverted.ts",
      "@@ -1 +1 @@",
      "-export const value = 2;",
      "+export const value = 1;",
      aggregateDiff,
    ].join("\n");
    const fakeGh = [
      "const { appendFileSync } = require('node:fs');",
      "const args = process.argv.slice(2);",
      "appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');",
      `const aggregate = ${JSON.stringify(aggregateDiff)};`,
      `const patches = ${JSON.stringify(patchSeries)};`,
      "if (args[0] === 'pr' && args[1] === 'view') process.stdout.write(JSON.stringify({ number: 42, url: 'https://github.com/acme/widget/pull/42', headRefOid: 'head-sha', baseRefOid: 'base-sha', headRepository: { nameWithOwner: 'fork/widget' } }));",
      "else if (args[0] === 'api') process.stdout.write('merge-base-sha\\n');",
      "else if (args[0] === 'pr' && args[1] === 'diff') process.stdout.write(args.includes('--patch') ? patches : aggregate);",
      "else process.exitCode = 2;",
      "",
    ].join("\n");
    const fakeGhScript = join(binDir, "gh.cjs");
    writeFileSync(fakeGhScript, fakeGh);
    const gh = join(binDir, "gh");
    writeFileSync(gh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$(dirname "$0")/gh.cjs" "$@"\n`);
    chmodSync(gh, 0o755);
    writeFileSync(join(binDir, "gh.cmd"), `@"${process.execPath}" "%~dp0\\gh.cjs" %*\r\n`);

    const env = {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_GH_LOG: logPath,
    };
    plan = prepareWithEnv(repo, env, "pr", "42");

    assert.deepEqual(plan.files.map((file) => file.path), ["final.ts"]);
    assert.deepEqual(plan.totals, { files: 1, added: 1, removed: 0, lines: 1 });
    assert.equal(plan.source.mergeBaseSha, "merge-base-sha");
    const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const diffCall = calls.find((args) => args[0] === "pr" && args[1] === "diff");
    assert.ok(diffCall);
    assert.equal(diffCall.includes("--patch"), false);
  } finally {
    if (plan) cleanup(plan, repo);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prepare-review diffs merge commits against their first parent", () => {
  const repo = initRepo();
  let plan: ReviewPlan | undefined;
  try {
    const mainBranch = git(repo, "branch", "--show-current");
    git(repo, "checkout", "-qb", "feature-review");
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    git(repo, "add", "a.ts");
    git(repo, "commit", "-qm", "change a");

    git(repo, "checkout", "-q", mainBranch);
    writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
    git(repo, "add", "b.ts");
    git(repo, "commit", "-qm", "change b");
    const firstParentSha = git(repo, "rev-parse", "HEAD");
    git(repo, "merge", "--no-ff", "-qm", "merge feature", "feature-review");

    plan = prepare(repo, "commit", "HEAD");
    assert.equal(plan.source.parentSha, firstParentSha);
    assert.deepEqual(plan.files.map((file) => file.path), ["a.ts"]);
    assert.deepEqual(plan.totals, { files: 1, added: 1, removed: 1, lines: 2 });
  } finally {
    if (plan) cleanup(plan, repo);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("prepare-review cleanup refuses paths outside its private temp prefix", () => {
  const repo = initRepo();
  try {
    const result = spawnSync(process.execPath, [SCRIPT, "cleanup", repo], { cwd: repo, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing to remove unsafe cleanup path/);
    assert.equal(existsSync(repo), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
