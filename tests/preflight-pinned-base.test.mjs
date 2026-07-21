import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  isDocumentationOnly,
  resolveValidationProfile,
} from "../.codex/skills/auto-pr-openclaw/scripts/lib/validation-profile.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const preflight = path.join(
  repoRoot,
  ".codex/skills/auto-pr-openclaw/scripts/openclaw-preflight.mjs",
);
const stateWriter = path.join(
  repoRoot,
  ".codex/skills/auto-pr-openclaw/scripts/write-workflow-state.mjs",
);
const preflightShell = path.join(
  repoRoot,
  ".codex/skills/auto-pr-openclaw/scripts/openclaw-preflight.sh",
);

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

function docsBody() {
  return `## What Problem This Solves

Documents the test behavior.

## Why This Change Was Made

The previous text was incomplete.

## User Impact

Readers see the corrected documentation.

## Evidence

- \`node scripts/fake-check.mjs\`: completed.

\`\`\`text
status: passed
\`\`\`

AI-assisted: built with Codex
`;
}

test("pins validation base while refreshing drift risk and reusing heavy checks", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-preflight-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const remote = path.join(temp, "remote.git");
  const root = path.join(temp, "workspace/openclaw");
  const worktree = path.join(root, "worktrees/issue-1");
  const output = path.join(root, "outputs/issue-1");
  const store = path.join(root, ".pnpm-store");
  const counter = path.join(temp, "counters");
  fs.mkdirSync(remote, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(store, { recursive: true });
  fs.mkdirSync(counter, { recursive: true });

  git(remote, "init", "--bare");
  git(worktree, "init", "-b", "main");
  git(worktree, "config", "user.name", "Test User");
  git(worktree, "config", "user.email", "test@example.com");
  git(worktree, "remote", "add", "origin", remote);

  write(path.join(worktree, "package.json"), JSON.stringify({
    name: "preflight-fixture",
    private: true,
    scripts: {
      "check:changed": "node scripts/fake-check.mjs check",
      "test:changed": "node scripts/test-projects.mjs",
    },
  }, null, 2));
  write(path.join(worktree, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  write(path.join(worktree, ".gitignore"), "node_modules/\n");
  write(path.join(worktree, "docs/example.md"), "base\n");
  const counterScript = `
import fs from "node:fs";
import path from "node:path";
const name = process.env.FAKE_COUNTER_NAME || process.argv[2] || "test";
const file = path.join(process.env.FAKE_COUNTER_DIR, name);
const count = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
fs.writeFileSync(file, String(count + 1));
`;
  write(path.join(worktree, "scripts/fake-check.mjs"), counterScript);
  write(
    path.join(worktree, "scripts/test-projects.mjs"),
    counterScript.replace(
      "const name = process.env.FAKE_COUNTER_NAME || process.argv[2] || \"test\";",
      "const name = \"test\";",
    ),
  );
  git(worktree, "add", ".");
  git(worktree, "commit", "-m", "base");
  git(worktree, "push", "-u", "origin", "main");
  const validationBase = git(worktree, "rev-parse", "HEAD");

  git(worktree, "switch", "-c", "sunlit/fix/issue-1");
  write(path.join(worktree, "docs/example.md"), "updated\n");
  git(worktree, "add", "docs/example.md");
  git(worktree, "commit", "-m", "docs: update example");
  const head = git(worktree, "rev-parse", "HEAD");

  write(path.join(worktree, "node_modules/.modules.yaml"), `storeDir: ${store}\n`);
  write(path.join(output, "pr-body.md"), docsBody());
  run(process.execPath, [
    stateWriter,
    "--mode", "local-candidate",
    "--root", root,
    "--repo-path", worktree,
    "--output-path", output,
    "--branch", "sunlit/fix/issue-1",
    "--base-ref", "origin/main",
    "--base-sha", validationBase,
    "--head-sha", head,
    "--pnpm-store-path", store,
    "--pr-body-path", path.join(output, "pr-body.md"),
    "--preflight-path", path.join(output, "preflight.json"),
    "--dependency-status", "installed",
  ]);

  const env = { ...process.env, FAKE_COUNTER_DIR: counter };
  const changedArgs = [
    preflight,
    "--workflow", path.join(output, "workflow.json"),
    "--profile", "changed",
  ];
  run(process.execPath, changedArgs, { env });
  const first = JSON.parse(fs.readFileSync(path.join(output, "preflight.json"), "utf8"));
  assert.equal(first.status, "passed");
  assert.equal(first.validationBaseSha, validationBase);
  assert.equal(first.heavyCacheHit, false);
  assert.equal(fs.readFileSync(path.join(counter, "check"), "utf8"), "1");
  assert.equal(fs.readFileSync(path.join(counter, "test"), "utf8"), "1");

  const updater = path.join(temp, "updater");
  git(temp, "clone", remote, updater);
  git(updater, "config", "user.name", "Upstream User");
  git(updater, "config", "user.email", "upstream@example.com");
  write(path.join(updater, "docs/upstream.md"), "upstream moved\n");
  git(updater, "add", "docs/upstream.md");
  git(updater, "commit", "-m", "docs: upstream change");
  git(updater, "push", "origin", "main");
  const latestMain = git(updater, "rev-parse", "HEAD");

  run(process.execPath, changedArgs, { env });
  const second = JSON.parse(fs.readFileSync(path.join(output, "preflight.json"), "utf8"));
  const workflow = JSON.parse(fs.readFileSync(path.join(output, "workflow.json"), "utf8"));
  assert.equal(second.status, "passed");
  assert.equal(second.validationBaseSha, validationBase);
  assert.equal(second.latestObservedMainSha, latestMain);
  assert.equal(second.freshness.behindBy, 1);
  assert.equal(second.freshness.mergeConflict, false);
  assert.deepEqual(second.freshness.overlappingFiles, []);
  assert.equal(second.heavyCacheHit, true);
  assert.equal(workflow.validationBaseSha, validationBase);
  assert.equal(workflow.latestObservedMainSha, latestMain);
  assert.equal(fs.readFileSync(path.join(counter, "check"), "utf8"), "1");
  assert.equal(fs.readFileSync(path.join(counter, "test"), "utf8"), "1");

  run(process.execPath, [preflight, "--workflow", path.join(output, "workflow.json")], { env });
  const automatic = JSON.parse(fs.readFileSync(path.join(output, "preflight.json"), "utf8"));
  assert.equal(automatic.status, "passed");
  assert.equal(automatic.requestedProfile, "auto");
  assert.equal(automatic.profile, "quick");
  assert.equal(automatic.validationDepth, "deterministic-no-pnpm");
  assert.equal(automatic.heavyChecks.length, 0);
  assert.equal(fs.readFileSync(path.join(counter, "check"), "utf8"), "1");
  assert.equal(fs.readFileSync(path.join(counter, "test"), "utf8"), "1");

  run(process.execPath, [
    preflight,
    "--workflow", path.join(output, "workflow.json"),
    "--profile", "focused",
  ], { env });
  const focused = JSON.parse(fs.readFileSync(path.join(output, "preflight.json"), "utf8"));
  assert.equal(focused.status, "passed");
  assert.equal(focused.profile, "focused");
  assert.equal(focused.validationDepth, "focused-changed-tests");
  assert.deepEqual(focused.heavyChecks.map((check) => check.name), ["focused tests"]);
  assert.equal(fs.readFileSync(path.join(counter, "check"), "utf8"), "1");
  assert.equal(fs.readFileSync(path.join(counter, "test"), "utf8"), "2");

  write(path.join(updater, "docs/example.md"), "conflicting upstream edit\n");
  git(updater, "add", "docs/example.md");
  git(updater, "commit", "-m", "docs: conflicting upstream edit");
  git(updater, "push", "origin", "main");
  const conflictRun = spawnSync(process.execPath, [
    preflight,
    "--workflow", path.join(output, "workflow.json"),
  ], { encoding: "utf8", env });
  assert.equal(conflictRun.status, 1);
  const conflicted = JSON.parse(fs.readFileSync(path.join(output, "preflight.json"), "utf8"));
  assert.equal(conflicted.status, "failed");
  assert.equal(conflicted.freshness.mergeConflict, true);
  assert.deepEqual(conflicted.freshness.overlappingFiles, ["docs/example.md"]);
  assert.equal(conflicted.heavyChecks.length, 0);
  assert.equal(fs.readFileSync(path.join(counter, "check"), "utf8"), "1");
  assert.equal(fs.readFileSync(path.join(counter, "test"), "utf8"), "2");
});

test("documents profiles through --help without requiring a workflow", () => {
  for (const [command, args] of [
    [process.execPath, [preflight, "--help"]],
    [preflightShell, ["--help"]],
  ]) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--profile PROFILE/);
    assert.match(result.stdout, /auto \(default\)/);
    assert.match(result.stdout, /focused.*focused changed tests/);
    assert.match(result.stdout, /documentation-only diffs/);
    assert.match(result.stdout, /can be slower than changed/);
  }
});

test("auto profile is quick only for documentation-only diffs", () => {
  assert.equal(isDocumentationOnly(["README.md", "docs/guide.md", "LICENSE"]), true);
  assert.equal(resolveValidationProfile("auto", ["README.md"]), "quick");
  assert.equal(resolveValidationProfile("auto", ["README.md", "src/index.ts"]), "focused");
  assert.equal(resolveValidationProfile("auto", []), "focused");
  assert.equal(resolveValidationProfile("full", ["README.md"]), "full");
});

test("requires an explicit full profile for pnpm check", () => {
  const result = spawnSync(process.execPath, [
    preflight,
    "--workflow", "/does/not/matter.json",
    "--check-script", "check",
  ], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /use --profile full explicitly/);
});
