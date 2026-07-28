import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scripts = path.join(repoRoot, ".codex/skills/auto-pr-openclaw/scripts");
const ensureCodeGraph = path.join(scripts, "ensure-openclaw-codegraph.sh");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.trim();
}

function git(cwd, ...args) {
  return run("git", args, { cwd });
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
}

function createWorktree(mainRepo, worktreesRoot, name, sha) {
  const worktree = path.join(worktreesRoot, name);
  git(mainRepo, "worktree", "add", "-b", name, worktree, sha);
  return worktree;
}

test("CodeGraph baseline is initialized once, cloned privately, and synced by base SHA", (t) => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-codegraph-")));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const root = path.join(temp, "workspace/openclaw");
  const mainRepo = path.join(root, "repos/openclaw");
  const worktreesRoot = path.join(root, "worktrees");
  const fakeBin = path.join(temp, "fake-bin");
  const fakeCodeGraph = path.join(fakeBin, "codegraph");
  const logPath = path.join(temp, "codegraph.log");
  fs.mkdirSync(mainRepo, { recursive: true });
  fs.mkdirSync(worktreesRoot, { recursive: true });

  git(mainRepo, "init", "-b", "main");
  git(mainRepo, "config", "user.name", "Test User");
  git(mainRepo, "config", "user.email", "test@example.com");
  write(path.join(mainRepo, "src/index.ts"), "export const value = 1;\n");
  git(mainRepo, "add", ".");
  git(mainRepo, "commit", "-m", "base");
  const base = git(mainRepo, "rev-parse", "HEAD");

  write(fakeCodeGraph, `#!/usr/bin/env bash
set -euo pipefail
command_name="$1"
shift
repo=""
for argument in "$@"; do repo="$argument"; done
printf '%s %s\\n' "$command_name" "$repo" >> "$OPENCLAW_CODEGRAPH_TEST_LOG"
if [[ "$command_name" == "init" ]]; then
  mkdir -p "$repo/.codegraph"
  printf '%s\\n' '*.db' '*.db-wal' '*.db-shm' '*.log' > "$repo/.codegraph/.gitignore"
  printf 'indexed:%s\\n' "$(git -C "$repo" rev-parse HEAD)" > "$repo/.codegraph/codegraph.db"
  printf '%s\\n' "$$" > "$repo/.codegraph/daemon.pid"
elif [[ "$command_name" == "sync" ]]; then
  printf 'synced:%s\\n' "$(git -C "$repo" rev-parse HEAD)" >> "$repo/.codegraph/codegraph.db"
else
  exit 2
fi
`);
  fs.chmodSync(fakeCodeGraph, 0o755);
  const env = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    OPENCLAW_CODEGRAPH_TEST_LOG: logPath,
  };

  const baseline = run(ensureCodeGraph, [
    "--baseline-only",
    "--main-repo", mainRepo,
    "--root", root,
    "--base-sha", base,
  ], { env });
  assert.match(baseline, /CodeGraph baseline ready/);

  const issueOne = createWorktree(mainRepo, worktreesRoot, "issue-1", base);
  const first = run(ensureCodeGraph, [
    "--repo-path", issueOne,
    "--main-repo", mainRepo,
    "--root", root,
    "--base-sha", base,
  ], { env });
  assert.match(first, /CodeGraph ready/);
  assert.equal(fs.readFileSync(path.join(root, ".codegraph-cache/base-sha"), "utf8").trim(), base);
  assert.equal(fs.readFileSync(path.join(issueOne, ".codegraph/openclaw-base-sha"), "utf8").trim(), base);
  assert.equal(fs.existsSync(path.join(issueOne, ".codegraph/daemon.pid")), false);
  assert.equal(fs.lstatSync(path.join(issueOne, ".codegraph/codegraph.db")).isSymbolicLink(), false);
  assert.match(fs.readFileSync(path.join(issueOne, ".codegraph/codegraph.db"), "utf8"), /synced:/);
  assert.doesNotMatch(
    fs.readFileSync(path.join(root, ".codegraph-cache/repo/.codegraph/codegraph.db"), "utf8"),
    /synced:/,
  );

  const issueTwo = createWorktree(mainRepo, worktreesRoot, "issue-2", base);
  run(ensureCodeGraph, [
    "--repo-path", issueTwo,
    "--main-repo", mainRepo,
    "--root", root,
    "--base-sha", base,
  ], { env });

  write(path.join(mainRepo, "src/index.ts"), "export const value = 2;\n");
  git(mainRepo, "add", ".");
  git(mainRepo, "commit", "-m", "advance main");
  const advancedBase = git(mainRepo, "rev-parse", "HEAD");
  const issueThree = createWorktree(mainRepo, worktreesRoot, "issue-3", advancedBase);
  run(ensureCodeGraph, [
    "--repo-path", issueThree,
    "--main-repo", mainRepo,
    "--root", root,
    "--base-sha", advancedBase,
  ], { env });

  const log = fs.readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(log.filter((line) => line.startsWith("init ")).length, 1);
  assert.equal(
    log.filter((line) => line === `sync ${path.join(root, ".codegraph-cache/repo")}`).length,
    1,
  );
  assert.equal(log.filter((line) => line.startsWith("sync ")).length, 4);
  assert.equal(
    fs.readFileSync(path.join(root, ".codegraph-cache/base-sha"), "utf8").trim(),
    advancedBase,
  );
  assert.equal(
    fs.readFileSync(path.join(issueThree, ".codegraph/openclaw-base-sha"), "utf8").trim(),
    advancedBase,
  );
});

test("both OpenClaw intake paths invoke the CodeGraph seeding helper", () => {
  const newIssue = fs.readFileSync(path.join(scripts, "new-openclaw-worktree.sh"), "utf8");
  const existingPr = fs.readFileSync(path.join(scripts, "prepare-openclaw-pr-worktree.mjs"), "utf8");
  assert.match(newIssue, /ensure-openclaw-codegraph\.sh/);
  assert.match(existingPr, /ensure-openclaw-codegraph\.sh/);
  assert.match(newIssue, /Warning: CodeGraph setup failed; the worktree remains usable/);
  assert.match(existingPr, /Warning: CodeGraph setup failed; the worktree remains usable/);
});

test("a missing CodeGraph CLI is advisory", () => {
  const result = spawnSync(ensureCodeGraph, [
    "--repo-path", "/missing/worktree",
    "--main-repo", "/missing/repo",
    "--root", "/missing/root",
    "--base-sha", "0".repeat(40),
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_CODEGRAPH_BIN: "/definitely/missing/codegraph",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /CodeGraph skipped/);
});
