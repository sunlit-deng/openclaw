import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scripts = path.join(repoRoot, ".codex/skills/auto-pr-openclaw/scripts");
const duplicateCheck = path.join(scripts, "openclaw-duplicate-check.mjs");
const candidateScore = path.join(scripts, "openclaw-candidate-score.mjs");
const gateSummary = path.join(scripts, "openclaw-gate-summary.mjs");
const contextPack = path.join(scripts, "openclaw-context-pack.mjs");
const proofPlan = path.join(scripts, "openclaw-proof-plan.mjs");

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

test("quality tools write duplicate, score, and gate receipts", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-quality-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const root = path.join(temp, "workspace/openclaw");
  const repo = path.join(root, "worktrees/issue-7");
  const output = path.join(root, "outputs/issue-7");
  const store = path.join(root, ".pnpm-store");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(store, { recursive: true });

  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "sunlit-deng");
  git(repo, "config", "user.email", "yang.jiajun1@xydigit.com");
  write(path.join(repo, "package.json"), "{\"private\":true}\n");
  write(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  write(path.join(repo, "src/provider/runtime.ts"), "export const cap = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");

  git(repo, "switch", "-c", "sunlit/fix/issue-7");
  write(path.join(repo, "src/provider/runtime.ts"), "export const cap = 2;\n");
  write(path.join(repo, "src/provider/runtime.test.ts"), "import './runtime';\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "fix: cap provider runtime");
  const head = git(repo, "rev-parse", "HEAD");

  const prBody = `## What Problem This Solves

Fixes provider runtime payload handling.

Fixes #7

## Why This Change Was Made

The runtime now applies the cap consistently.

## User Impact

Users get predictable provider behavior.

## Evidence

- \`npx tsx proof-live.ts\`: real call chain uses the production provider runtime entrypoint with a localhost fixture; valid input is accepted and oversized input is rejected.

\`\`\`text
$ npx tsx proof-live.ts
entrypoint: src/provider/runtime.ts production runtime
dependency-boundary: localhost fixture
valid: accepted
negative-control: oversized rejected before buffering
\`\`\`

AI-assisted: built with Codex
`;
  write(path.join(output, "pr-body.md"), prBody);
  write(path.join(output, "workflow.json"), JSON.stringify({
    schemaVersion: 2,
    mode: "local-candidate",
    issue: 7,
    pr: null,
    root,
    repoPath: repo,
    outputPath: output,
    branch: "sunlit/fix/issue-7",
    baseRef: "origin/main",
    baseSha: base,
    validationBaseRef: "origin/main",
    validationBaseSha: base,
    latestObservedMainSha: base,
    headSha: head,
    pnpmStorePath: store,
    prBodyPath: path.join(output, "pr-body.md"),
    preflightPath: path.join(output, "preflight.json"),
    dependencies: { status: "installed", skipReason: null },
  }, null, 2));
  write(path.join(output, "preflight.json"), JSON.stringify({
    schemaVersion: 2,
    status: "passed",
    headSha: head,
    validationBaseSha: base,
    heavyCacheHit: false,
    checks: [],
    heavyChecks: [],
  }, null, 2));

  run(process.execPath, [
    duplicateCheck,
    "--workflow", path.join(output, "workflow.json"),
    "--offline",
  ]);
  const duplicateReceipt = JSON.parse(fs.readFileSync(path.join(output, "duplicate-check.json"), "utf8"));
  assert.equal(duplicateReceipt.offline, true);
  assert.ok(duplicateReceipt.queries.includes("src/provider/runtime.ts"));

  run(process.execPath, [
    candidateScore,
    "--workflow", path.join(output, "workflow.json"),
  ]);
  const scoreReceipt = JSON.parse(fs.readFileSync(path.join(output, "candidate-score.json"), "utf8"));
  assert.equal(scoreReceipt.proofRecipe.kind, "resource-cap");
  assert.equal(scoreReceipt.currentEvidence.signal, "real-call-chain");
  assert.ok(scoreReceipt.score >= 70);
  assert.notEqual(scoreReceipt.verdict, "poor-fit");

  run(process.execPath, [
    proofPlan,
    "--workflow", path.join(output, "workflow.json"),
  ]);
  const proofReceipt = JSON.parse(fs.readFileSync(path.join(output, "proof-plan.json"), "utf8"));
  const proofMd = fs.readFileSync(path.join(output, "proof-plan.md"), "utf8");
  assert.equal(proofReceipt.proofRecipe.kind, "resource-cap");
  assert.equal(proofReceipt.proofRecipe.preferredProof, "real-call-chain-loopback");
  assert.ok(proofReceipt.candidateEntrypoints.includes("src/provider/runtime.ts"));
  assert.ok(!proofReceipt.candidateEntrypoints.includes("src/provider/runtime.test.ts"));
  assert.match(proofMd, /Real call-chain proof/);

  run(process.execPath, [
    gateSummary,
    "--workflow", path.join(output, "workflow.json"),
  ]);
  const gateJson = JSON.parse(fs.readFileSync(path.join(output, "gate-summary.json"), "utf8"));
  const gateMd = fs.readFileSync(path.join(output, "gate-summary.md"), "utf8");
  assert.equal(gateJson.headSha, head);
  assert.equal(gateJson.preflight.status, "passed");
  assert.deepEqual(gateJson.blockers, []);
  assert.match(gateMd, /approved HEAD/);
  assert.match(gateMd, /Do not push/);

  run(process.execPath, [
    contextPack,
    "--workflow", path.join(output, "workflow.json"),
  ]);
  const contextJson = JSON.parse(fs.readFileSync(path.join(output, "context-pack.json"), "utf8"));
  const contextMd = fs.readFileSync(path.join(output, "context-pack.md"), "utf8");
  assert.equal(contextJson.headSha, head);
  assert.equal(contextJson.receipts.candidateScore.verdict, scoreReceipt.verdict);
  assert.equal(contextJson.prBody.proofSignal, "real-call-chain");
  assert.match(contextMd, /OpenClaw Context Pack/);
  assert.match(contextMd, /Next Commands/);

  const workflowPath = path.join(output, "workflow.json");
  const existingPrWorkflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
  existingPrWorkflow.mode = "existing-pr";
  existingPrWorkflow.pr = 123;
  existingPrWorkflow.maintainerCanModify = true;
  write(workflowPath, `${JSON.stringify(existingPrWorkflow, null, 2)}\n`);
  write(path.join(output, "duplicate-check.json"), JSON.stringify({
    applicable: true,
    summary: {
      likelyDuplicateCount: 9,
      relatedOpenPrCount: 12,
      errors: [],
    },
  }));

  run(process.execPath, [
    duplicateCheck,
    "--workflow", workflowPath,
  ]);
  const skippedDuplicate = JSON.parse(fs.readFileSync(path.join(output, "duplicate-check.json"), "utf8"));
  assert.equal(skippedDuplicate.applicable, false);
  assert.equal(skippedDuplicate.skipped, true);
  assert.deepEqual(skippedDuplicate.searches, []);

  // A stale pre-publication receipt must not affect score or gate results.
  write(path.join(output, "duplicate-check.json"), JSON.stringify({
    applicable: true,
    summary: {
      likelyDuplicateCount: 9,
      relatedOpenPrCount: 12,
      errors: [],
    },
  }));
  run(process.execPath, [
    candidateScore,
    "--workflow", workflowPath,
  ]);
  const existingPrScore = JSON.parse(fs.readFileSync(path.join(output, "candidate-score.json"), "utf8"));
  assert.equal(existingPrScore.duplicateCheckApplicable, false);
  assert.equal(existingPrScore.duplicateCheckPath, null);
  assert.ok(!existingPrScore.flags.some((flag) => /duplicate|crowded/i.test(flag.reason)));
  assert.ok(!existingPrScore.recommendations.some((item) => /duplicate/i.test(item)));

  write(path.join(output, "candidate-score.json"), JSON.stringify({
    score: 40,
    verdict: "poor-fit",
    duplicateCheckApplicable: true,
    flags: [{ level: "blocker", reason: "duplicate check found likely duplicate PRs" }],
  }));
  const fakeBin = path.join(temp, "fake-bin");
  const fakeGh = path.join(fakeBin, "gh");
  write(fakeGh, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(fakeGh, 0o755);
  const testEnv = { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` };
  run(process.execPath, [
    gateSummary,
    "--workflow", workflowPath,
  ], { env: testEnv });
  const existingPrGate = JSON.parse(fs.readFileSync(path.join(output, "gate-summary.json"), "utf8"));
  const existingPrGateMd = fs.readFileSync(path.join(output, "gate-summary.md"), "utf8");
  assert.equal(existingPrGate.duplicateCheckApplicable, false);
  assert.equal(existingPrGate.duplicateCheck, null);
  assert.ok(!existingPrGate.blockers.some((item) => /duplicate/i.test(item)));
  assert.ok(!existingPrGate.blockers.some((item) => /candidate score/i.test(item)));
  assert.equal(existingPrGate.candidateScore.staleForExistingPr, true);
  assert.match(existingPrGateMd, /duplicate check: not applicable \(existing PR\)/);
  assert.match(existingPrGateMd, /stale pre-existing-PR receipt \(ignored; rerun scoring\)/);

  run(process.execPath, [
    contextPack,
    "--workflow", workflowPath,
  ]);
  const existingPrContext = JSON.parse(fs.readFileSync(path.join(output, "context-pack.json"), "utf8"));
  const existingPrContextMd = fs.readFileSync(path.join(output, "context-pack.md"), "utf8");
  assert.equal(existingPrContext.duplicateCheckApplicable, false);
  assert.ok(!existingPrContext.nextCommands.some((command) => command.includes("duplicate-check")));
  assert.match(existingPrContextMd, /duplicate: not applicable \(existing PR\)/);
  assert.match(existingPrContextMd, /stale pre-existing-PR receipt \(ignored; rerun scoring\)/);
});
