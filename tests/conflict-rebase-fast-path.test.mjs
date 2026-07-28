import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(
  repoRoot,
  ".codex/skills/auto-pr-openclaw/scripts/openclaw-conflict-rebase.mjs",
);

function execute(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function run(command, args, options = {}) {
  const result = execute(command, args, options);
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

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-conflict-rebase-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "workspace/openclaw");
  const repo = path.join(root, "worktrees/pr-123");
  const output = path.join(root, "outputs/pr-123");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(output, { recursive: true });

  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  write(path.join(repo, "src/feature.ts"), "export const value = 1;\n");
  write(path.join(repo, "extensions/browser/chrome-extension/modules/runtime.js"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");

  git(repo, "switch", "-c", "sunlit/pr-123");
  write(path.join(repo, "src/feature.ts"), "export const value = 2;\n");
  write(path.join(repo, "extensions/browser/chrome-extension/modules/runtime.js"), "feature\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "fix: update feature");
  const originalHead = git(repo, "rev-parse", "HEAD");

  git(repo, "switch", "main");
  write(path.join(repo, "extensions/browser/chrome-extension/modules/runtime.js"), "upstream\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "upstream: rebuild runtime");
  const target = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "sunlit/pr-123");

  const workflowPath = path.join(output, "workflow.json");
  write(workflowPath, `${JSON.stringify({
    schemaVersion: 2,
    mode: "existing-pr",
    pr: 123,
    root,
    repoPath: repo,
    outputPath: output,
    branch: "sunlit/pr-123",
    baseRef: "origin/main",
    baseSha: base,
    validationBaseSha: base,
    headSha: originalHead,
    prBodyPath: path.join(output, "pr-body.md"),
    preflightPath: path.join(output, "preflight.json"),
  }, null, 2)}\n`);
  write(path.join(output, "pr-body.md"), "fixture\n");
  const planPath = path.join(output, "conflict-validation-plan.json");
  write(planPath, `${JSON.stringify({
    schemaVersion: 1,
    commands: [
      {
        name: "rebuild generated runtime",
        kind: "generated-rebuild",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      {
        name: "focused runtime test",
        kind: "focused-test",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
    ],
  }, null, 2)}\n`);
  return { repo, output, workflowPath, planPath, originalHead, target };
}

test("conflict rebase validates only recorded resolution files and focused commands", (t) => {
  const { repo, output, workflowPath, planPath, originalHead, target } = fixture(t);
  const started = execute(process.execPath, [
    script, "--phase", "start", "--workflow", workflowPath, "--target", target,
  ]);
  assert.equal(started.status, 1);
  const state = JSON.parse(fs.readFileSync(path.join(output, "conflict-rebase-state.json"), "utf8"));
  assert.equal(state.originalHeadSha, originalHead);
  assert.equal(state.targetSha, target);
  assert.deepEqual(state.conflictFiles, [
    "extensions/browser/chrome-extension/modules/runtime.js",
  ]);

  write(path.join(repo, "extensions/browser/chrome-extension/modules/runtime.js"), "resolved\n");
  git(repo, "add", "extensions/browser/chrome-extension/modules/runtime.js");
  run("git", ["-c", "core.editor=true", "rebase", "--continue"], { cwd: repo });

  run(process.execPath, [
    script, "--phase", "finish", "--workflow", workflowPath, "--plan", planPath,
  ]);
  const receipt = JSON.parse(fs.readFileSync(path.join(output, "conflict-resolution-check.json"), "utf8"));
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.targetSha, target);
  assert.equal(receipt.headSha, git(repo, "rev-parse", "HEAD"));
  assert.equal(receipt.nonConflictPatchEquivalent, true);
  assert.deepEqual(receipt.commandResults.map((result) => result.kind), [
    "generated-rebuild",
    "focused-test",
  ]);
  assert.ok(receipt.commandResults.every((result) => result.status === "passed"));
  const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
  assert.equal(workflow.validationBaseSha, target);
  assert.equal(workflow.rebaseTargetSha, target);
});

test("conflict rebase rejects drift outside the recorded conflict files", (t) => {
  const { repo, output, workflowPath, planPath, target } = fixture(t);
  const started = execute(process.execPath, [
    script, "--phase", "start", "--workflow", workflowPath, "--target", target,
  ]);
  assert.equal(started.status, 1);
  write(path.join(repo, "extensions/browser/chrome-extension/modules/runtime.js"), "resolved\n");
  git(repo, "add", "extensions/browser/chrome-extension/modules/runtime.js");
  run("git", ["-c", "core.editor=true", "rebase", "--continue"], { cwd: repo });

  write(path.join(repo, "src/feature.ts"), "export const value = 999;\n");
  git(repo, "add", "src/feature.ts");
  git(repo, "commit", "--amend", "--no-edit");
  const finished = execute(process.execPath, [
    script, "--phase", "finish", "--workflow", workflowPath, "--plan", planPath,
  ]);
  assert.equal(finished.status, 1);
  assert.match(finished.stderr, /Non-conflict patch series changed/);
  const receipt = JSON.parse(fs.readFileSync(path.join(output, "conflict-resolution-check.json"), "utf8"));
  assert.equal(receipt.status, "failed");
  assert.match(receipt.blockers[0], /Non-conflict patch series changed/);
});
