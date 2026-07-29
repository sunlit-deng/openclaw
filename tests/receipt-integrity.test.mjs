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
