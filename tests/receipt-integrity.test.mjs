import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  receiptSummary,
  validateWorkflowReceipt,
} from "../.codex/skills/auto-pr-openclaw/scripts/lib/receipt-utils.mjs";
import { prUpdateRequired } from "../.codex/skills/auto-pr-openclaw/scripts/lib/publish-utils.mjs";

const publisher = path.resolve(
  import.meta.dirname,
  "../.codex/skills/auto-pr-openclaw/scripts/publish-openclaw-pr.mjs",
);
const calibrationTool = path.resolve(
  import.meta.dirname,
  "../.codex/skills/auto-pr-openclaw/scripts/openclaw-score-calibration.mjs",
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function git(cwd, ...args) {
  return run("git", args, { cwd });
}

test("workflow receipts require matching schema, workflow, repository, head, and base", () => {
  const expected = {
    kind: "preflight",
    schemaVersions: [2],
    workflowPath: "/tmp/output/workflow.json",
    repoPath: "/tmp/repo",
    headSha: "head",
    validationBaseSha: "base",
  };
  const valid = validateWorkflowReceipt({
    schemaVersion: 2,
    workflowPath: "/tmp/output/workflow.json",
    repoPath: "/tmp/repo",
    headSha: "head",
    validationBaseSha: "base",
    status: "passed",
  }, expected);
  assert.deepEqual(valid, { valid: true, problems: [] });

  const stale = validateWorkflowReceipt({
    schemaVersion: 1,
    workflowPath: "/tmp/other/workflow.json",
    repoPath: "/tmp/other-repo",
    headSha: "old-head",
    validationBaseSha: "old-base",
    status: "passed",
  }, expected);
  assert.equal(stale.valid, false);
  assert.equal(stale.problems.length, 5);
  assert.deepEqual(receiptSummary(null, { valid: false, problems: ["missing"] }), {
    status: "missing",
    valid: false,
    problems: ["missing"],
  });
});

test("existing PR writes are skipped only when body and requested title are unchanged", () => {
  assert.equal(prUpdateRequired({
    currentBody: "same\r\nbody\r\n",
    currentTitle: "Existing title",
    nextBody: "same\nbody\n",
  }), false);
  assert.equal(prUpdateRequired({
    currentBody: "old body\n",
    currentTitle: "Existing title",
    nextBody: "new body\n",
  }), true);
  assert.equal(prUpdateRequired({
    currentBody: "same body\n",
    currentTitle: "Existing title",
    nextBody: "same body\n",
    nextTitle: "New title",
  }), true);
});

test("normal publisher rejects a preflight validated against another base before GitHub writes", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-publish-receipt-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "repo");
  const output = path.join(temp, "output");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  git(repo, "init", "-b", "feature");
  git(repo, "config", "user.name", "sunlit-deng");
  git(repo, "config", "user.email", "yang.jiajun1@xydigit.com");
  fs.writeFileSync(path.join(repo, "file.txt"), "content\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "test");
  const head = git(repo, "rev-parse", "HEAD");
  const workflowPath = path.join(output, "workflow.json");
  const bodyPath = path.join(output, "pr-body.md");
  const preflightPath = path.join(output, "preflight.json");
  const body = "invalid body is sufficient because receipt validation happens before any GitHub command\n";
  const bodySha = crypto.createHash("sha256").update(body).digest("hex");
  fs.writeFileSync(bodyPath, body);
  fs.writeFileSync(workflowPath, `${JSON.stringify({
    schemaVersion: 2,
    root: temp,
    repoPath: repo,
    outputPath: output,
    branch: "feature",
    baseSha: head,
    validationBaseSha: head,
    prBodyPath: bodyPath,
    prBodySha256: bodySha,
    preflightPath,
  }, null, 2)}\n`);
  fs.writeFileSync(preflightPath, `${JSON.stringify({
    schemaVersion: 2,
    status: "passed",
    workflowPath,
    repoPath: repo,
    headSha: head,
    validationBaseSha: "different-base",
  }, null, 2)}\n`);

  const result = spawnSync(process.execPath, [
    publisher,
    "--workflow", workflowPath,
    "--approved-head", head,
    "--approved-body-sha", bodySha,
    "--push-remote", "sunlit",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /preflight validationBaseSha does not match current workflow/);
  assert.doesNotMatch(result.stderr, /gh auth|git push/);
});

test("explicit workflow-rule bypass publishes and records bypassed local gates", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-publish-bypass-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const repo = path.join(temp, "repo");
  const output = path.join(temp, "output");
  const fakeBin = path.join(temp, "fake-bin");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  git(repo, "init", "-b", "feature");
  git(repo, "config", "user.name", "sunlit-deng");
  git(repo, "config", "user.email", "yang.jiajun1@xydigit.com");
  fs.writeFileSync(path.join(repo, "file.txt"), "content\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "test");
  const head = git(repo, "rev-parse", "HEAD");

  const bodyPath = path.join(output, "pr-body.md");
  const workflowPath = path.join(output, "workflow.json");
  const body = "intentionally incomplete body\n";
  fs.writeFileSync(bodyPath, body);
  fs.writeFileSync(workflowPath, `${JSON.stringify({
    schemaVersion: 2,
    root: temp,
    repoPath: repo,
    outputPath: output,
    branch: "feature",
    baseSha: head,
    validationBaseSha: head,
    prBodyPath: bodyPath,
    prBodySha256: "stale-body-sha",
    preflightPath: path.join(output, "missing-preflight.json"),
  }, null, 2)}\n`);
  git(repo, "remote", "add", "sunlit", "https://github.com/sunlit-deng/openclaw.git");

  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  const fakeGit = path.join(fakeBin, "git");
  fs.writeFileSync(fakeGit, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
if (process.argv[2] === "push") process.exit(0);
const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
  fs.chmodSync(fakeGit, 0o755);

  const fakeGh = path.join(fakeBin, "gh");
  fs.writeFileSync(fakeGh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "setup-git") process.exit(0);
if (args[0] === "api" && args[1] === "user") {
  console.log(JSON.stringify({ login: "sunlit-deng" }));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "--method" && args[2] === "POST" && args[3] === "repos/openclaw/openclaw/pulls") {
  console.log(JSON.stringify({ number: 123, url: "https://github.com/openclaw/openclaw/pull/123" }));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({
    number: 123,
    url: "https://github.com/openclaw/openclaw/pull/123",
    title: "test",
    body: ${JSON.stringify(body)},
    maintainerCanModify: false,
    headRefName: "feature",
    headRefOid: ${JSON.stringify(head)},
    headRepositoryOwner: { login: "sunlit-deng" },
  }));
  process.exit(0);
}
process.exit(1);
`);
  fs.chmodSync(fakeGh, 0o755);

  const result = spawnSync(process.execPath, [
    publisher,
    "--workflow", workflowPath,
    "--allow-workflow-rule-bypass",
    "--workflow-rule-bypass-reason", "user explicitly requested publication despite local gates",
    "--push-remote", "sunlit",
    "--title", "test",
    "--head", "sunlit-deng:feature",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      AUTO_PR_ACCOUNTS_FILE: path.join(temp, "no-accounts.json"),
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const published = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
  assert.equal(published.pr, 123);
  assert.equal(published.workflowRuleBypass.status, "used");
  assert.equal(published.workflowRuleBypass.reason, "user explicitly requested publication despite local gates");
  assert.ok(published.workflowRuleBypass.bypassedChecks.some((check) => /preflight/.test(check)));
  assert.ok(published.workflowRuleBypass.bypassedChecks.some((check) => /PR body/.test(check)));
  assert.ok(published.workflowRuleBypass.bypassedChecks.some((check) => /maintainer_can_modify/.test(check)));
  assert.equal(JSON.parse(result.stdout).maintainerCanModify, false);
});

test("score calibration exposes false-positive high predictions and signal lift", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-calibration-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const input = path.join(temp, "samples.json");
  fs.writeFileSync(input, JSON.stringify({
    schemaVersion: 1,
    samples: [
      {
        pr: 1,
        predictedAReadiness: "high",
        actualRating: "A",
        signals: { canonicalPrecedent: true, comparableProof: true },
      },
      {
        pr: 2,
        predictedAReadiness: "high",
        actualRating: "B",
        signals: { canonicalPrecedent: false, comparableProof: true },
      },
      {
        pr: 3,
        predictedAReadiness: "possible",
        actualRating: "B",
        signals: { canonicalPrecedent: false, comparableProof: false },
      },
    ],
  }));
  run(process.execPath, [calibrationTool, "--input", input]);
  const receipt = JSON.parse(fs.readFileSync(path.join(temp, "clawsweeper-calibration.json"), "utf8"));
  assert.equal(receipt.metrics.highPrecision, 0.5);
  assert.deepEqual(receipt.falsePositivePrs, [2]);
  assert.ok(receipt.signalCalibration.canonicalPrecedent.lift > 0);
});
