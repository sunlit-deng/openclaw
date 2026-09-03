import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const publisher = path.join(repoRoot, ".codex/skills/auto-pr-openclaw/scripts/publish-openclaw-pr.mjs");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}

function git(cwd, ...args) {
  const result = run("git", args, { cwd });
  assert.equal(result.status, 0, `${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, "utf8");
}

const body = `## What Problem This Solves

The publication workflow can submit a validated change without an extra prompt.

## Why This Change Was Made

The gate summary is now bound to the exact workflow state.

## User Impact

Ready changes no longer require a repeated confirmation.

## Evidence

- \`node --test tests/automatic-publication.test.mjs\`: passed.

\`\`\`text
$ node --test tests/automatic-publication.test.mjs
pass
\`\`\`

AI-assisted: built with Codex
`;

function setupWorkflow({ temp, existingPr = false, remoteHead = "remote-head" } = {}) {
  const root = path.join(temp, "workspace/openclaw");
  const repo = path.join(root, "worktrees/issue-7");
  const output = path.join(root, "outputs/issue-7");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "sunlit-deng");
  git(repo, "config", "user.email", "yang.jiajun1@xydigit.com");
  write(path.join(repo, "README.md"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-c", "sunlit/fix/issue-7");
  write(path.join(repo, "docs/change.md"), "change\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "docs: describe automatic publication");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "remote", "add", "sunlit", "https://github.com/sunlit-deng/openclaw.git");

  const bodyPath = path.join(output, "pr-body.md");
  const workflowPath = path.join(output, "workflow.json");
  const preflightPath = path.join(output, "preflight.json");
  const gateSummaryPath = path.join(output, "gate-summary.json");
  const bodySha = crypto.createHash("sha256").update(body).digest("hex");
  write(bodyPath, body);
  write(preflightPath, `${JSON.stringify({
    schemaVersion: 2,
    status: "passed",
    workflowPath,
    repoPath: repo,
    headSha: head,
    validationBaseSha: base,
  }, null, 2)}\n`);
  const workflow = {
    schemaVersion: 3,
    projectId: "openclaw",
    mode: existingPr ? "existing-pr" : "local-candidate",
    issue: null,
    pr: existingPr ? 123 : null,
    root,
    repoPath: repo,
    outputPath: output,
    branch: "sunlit/fix/issue-7",
    headOwner: existingPr ? "sunlit-deng" : null,
    headRef: "sunlit/fix/issue-7",
    baseRef: "origin/main",
    baseSha: base,
    validationBaseRef: "origin/main",
    validationBaseSha: base,
    headSha: head,
    prBodyPath: bodyPath,
    prBodySha256: bodySha,
    preflightPath,
    githubAccount: null,
    maintainerCanModify: existingPr ? true : null,
  };
  write(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
  write(gateSummaryPath, `${JSON.stringify({
    schemaVersion: 1,
    workflowPath,
    repoPath: repo,
    project: { id: "openclaw", repo: "openclaw/openclaw" },
    branch: workflow.branch,
    headSha: head,
    validationBaseSha: base,
    workflowValidationBaseSha: base,
    clean: true,
    diffCheck: { status: "passed" },
    rebaseOnlyFastPathActive: false,
    blockers: [],
    automaticPublication: {
      eligible: true,
      gateSummaryPath,
    },
    preflight: {
      status: "passed",
      receiptValid: true,
      headSha: head,
      validationBaseSha: base,
    },
    prBody: { path: bodyPath, sha256: bodySha },
    publishInputs: { approvedHead: head, approvedBodySha256: bodySha },
    githubAccount: {
      login: "sunlit-deng",
      pushRemote: "sunlit",
    },
    duplicateCheckApplicable: !existingPr,
    duplicateCheck: existingPr ? null : { receiptValid: true, blocking: false },
    maintainer: existingPr ? {
      checked: true,
      maintainerCanModify: true,
      headRefOid: remoteHead,
      headRefName: workflow.branch,
      headOwner: "sunlit-deng",
    } : { checked: false, maintainerCanModify: null },
  }, null, 2)}\n`);
  return { root, repo, output, workflow, workflowPath, gateSummaryPath, bodySha, head, base };
}

function fakeGithub({ temp, bodyAfterPush, existingPr = false, remoteHead = "remote-head" }) {
  const fakeBin = path.join(temp, "fake-bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  const marker = path.join(temp, "pushed");
  const realGit = run("which", ["git"]).stdout.trim();
  write(path.join(fakeBin, "git"), `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
if (process.argv[2] === "push") {
  fs.writeFileSync(process.env.AUTO_PR_PUSH_MARKER, "pushed\\n");
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
  fs.chmodSync(path.join(fakeBin, "git"), 0o755);
  const remoteBody = existingPr ? "old remote body\n" : bodyAfterPush;
  write(path.join(fakeBin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const pushed = fs.existsSync(${JSON.stringify(marker)});
if (args[0] === "auth" && args[1] === "setup-git") process.exit(0);
if (args[0] === "api" && args[1] === "user") {
  console.log(JSON.stringify({ login: "sunlit-deng" }));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "--method" && args[2] === "POST") {
  console.log(JSON.stringify({ number: 123, url: "https://github.com/openclaw/openclaw/pull/123" }));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "--method" && args[2] === "PATCH") {
  console.log(JSON.stringify({ number: 123, url: "https://github.com/openclaw/openclaw/pull/123" }));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({
    number: 123,
    url: "https://github.com/openclaw/openclaw/pull/123",
    title: "old title",
    body: pushed ? ${JSON.stringify(bodyAfterPush)} : ${JSON.stringify(remoteBody)},
    maintainerCanModify: true,
    headRefName: "sunlit/fix/issue-7",
    headRefOid: ${JSON.stringify(remoteHead)},
    headRepositoryOwner: { login: "sunlit-deng" },
  }));
  process.exit(0);
}
process.exit(1);
`);
  fs.chmodSync(path.join(fakeBin, "gh"), 0o755);
  return {
    env: {
      ...process.env,
      AUTO_PR_ACCOUNTS_FILE: path.join(temp, "no-accounts.json"),
      AUTO_PR_PUSH_MARKER: marker,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    },
    marker,
  };
}

test("automatic publication submits a ready new PR without approval flags", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-auto-new-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const fixture = setupWorkflow({ temp });
  const github = fakeGithub({ temp, bodyAfterPush: body });
  const result = run(process.execPath, [
    publisher,
    "--workflow", fixture.workflowPath,
    "--auto-if-ready",
    "--gate-summary", fixture.gateSummaryPath,
    "--push-remote", "sunlit",
    "--title", "docs: describe automatic publication",
    "--head", "sunlit-deng:sunlit/fix/issue-7",
  ], { env: github.env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(github.marker), true);
  const published = JSON.parse(fs.readFileSync(fixture.workflowPath, "utf8"));
  assert.equal(published.pr, 123);
  assert.equal(published.automaticPublication.status, "used");
  assert.equal(JSON.parse(result.stdout).automaticPublication.status, "used");
});

test("automatic publication stops before GitHub writes when a gate blocker remains", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-auto-blocked-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const fixture = setupWorkflow({ temp });
  const gate = JSON.parse(fs.readFileSync(fixture.gateSummaryPath, "utf8"));
  gate.blockers = ["preflight is failed"];
  gate.automaticPublication.eligible = false;
  write(fixture.gateSummaryPath, `${JSON.stringify(gate, null, 2)}\n`);
  const github = fakeGithub({ temp, bodyAfterPush: body });
  const result = run(process.execPath, [
    publisher,
    "--workflow", fixture.workflowPath,
    "--auto-if-ready",
    "--gate-summary", fixture.gateSummaryPath,
    "--push-remote", "sunlit",
    "--title", "docs: describe automatic publication",
    "--head", "sunlit-deng:sunlit/fix/issue-7",
  ], { env: github.env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /human confirmation is required/);
  assert.match(result.stderr, /preflight is failed/);
  assert.equal(fs.existsSync(github.marker), false);
  assert.equal(JSON.parse(fs.readFileSync(fixture.workflowPath, "utf8")).pr, null);
});

test("agent judgment can bypass an evidenced external preflight failure", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-agent-external-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const fixture = setupWorkflow({ temp });
  const preflightPath = fixture.workflow.preflightPath;
  const preflight = JSON.parse(fs.readFileSync(preflightPath, "utf8"));
  preflight.status = "failed";
  write(preflightPath, `${JSON.stringify(preflight, null, 2)}\n`);
  const gate = JSON.parse(fs.readFileSync(fixture.gateSummaryPath, "utf8"));
  gate.blockers = ["preflight is failed"];
  gate.blockerDetails = [{
    id: "preflight-status",
    message: "preflight is failed",
    source: "preflight",
    agentBypassAllowed: true,
    allowedCauses: ["upstream", "infrastructure", "tooling", "unrelated-ci"],
    evidenceRefs: [preflightPath],
  }];
  gate.preflight.status = "failed";
  gate.preflight.receiptValid = true;
  gate.automaticPublication.eligible = false;
  gate.agentExternalBypass = {
    eligible: true,
    blockerIds: ["preflight-status"],
    policy: "agent may bypass only listed blockers with allowed external causes and evidence; repository/identity/HEAD/body/remote safety blockers remain hard stops",
  };
  write(fixture.gateSummaryPath, `${JSON.stringify(gate, null, 2)}\n`);
  const judgmentPath = path.join(fixture.output, "agent-publication-judgment.json");
  write(judgmentPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: "agent-publication-judgment",
    generatedAt: new Date().toISOString(),
    agent: "codex",
    decision: "publish",
    confidence: "high",
    reason: "The only failed preflight is an external infrastructure failure and the receipt identity remains valid.",
    workflowPath: fixture.workflowPath,
    gateSummaryPath: fixture.gateSummaryPath,
    repoPath: fixture.repo,
    headSha: fixture.head,
    bodySha256: fixture.bodySha,
    validationBaseSha: fixture.base,
    bypassedBlockers: [{
      blockerId: "preflight-status",
      message: "preflight is failed",
      cause: "infrastructure",
      confidence: "high",
      reason: "The failure is outside the changed repository behavior.",
      evidence: [{
        source: "preflight.checks",
        reference: preflightPath,
        observation: "The receipt is valid for this workflow, HEAD, and validation base; only the external check failed.",
      }],
    }],
    residualBlockers: [],
  }, null, 2)}\n`);
  const github = fakeGithub({ temp, bodyAfterPush: body });
  const result = run(process.execPath, [
    publisher,
    "--workflow", fixture.workflowPath,
    "--auto-if-ready",
    "--gate-summary", fixture.gateSummaryPath,
    "--agent-judgment", judgmentPath,
    "--push-remote", "sunlit",
    "--title", "docs: describe automatic publication",
    "--head", "sunlit-deng:sunlit/fix/issue-7",
  ], { env: github.env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(github.marker), true);
  const published = JSON.parse(fs.readFileSync(fixture.workflowPath, "utf8"));
  assert.equal(published.automaticPublication.mode, "agent-judged-external-bypass");
  assert.equal(published.automaticPublication.agentJudgmentPath, judgmentPath);
  assert.equal(published.automaticPublication.agentJudgmentAgent, "codex");
  assert.match(published.automaticPublication.agentJudgmentReason, /external infrastructure/);
  assert.equal(published.automaticPublication.agentJudgmentSha256, crypto.createHash("sha256").update(fs.readFileSync(judgmentPath, "utf8")).digest("hex"));
  assert.deepEqual(published.automaticPublication.agentBypassedBlockerIds, ["preflight-status"]);
});

test("agent judgment cannot bypass a repository-owned blocker", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-agent-hard-stop-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const fixture = setupWorkflow({ temp });
  const gate = JSON.parse(fs.readFileSync(fixture.gateSummaryPath, "utf8"));
  gate.blockers = ["git diff --check failed"];
  gate.blockerDetails = [{
    id: "diff-check",
    message: "git diff --check failed",
    source: "git",
    agentBypassAllowed: false,
    allowedCauses: [],
    evidenceRefs: [],
  }];
  gate.automaticPublication.eligible = false;
  gate.agentExternalBypass = { eligible: false, blockerIds: [], policy: "hard stop" };
  write(fixture.gateSummaryPath, `${JSON.stringify(gate, null, 2)}\n`);
  const judgmentPath = path.join(fixture.output, "agent-publication-judgment.json");
  write(judgmentPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: "agent-publication-judgment",
    generatedAt: new Date().toISOString(),
    agent: "codex",
    decision: "publish",
    confidence: "high",
    reason: "Attempted external classification.",
    workflowPath: fixture.workflowPath,
    gateSummaryPath: fixture.gateSummaryPath,
    repoPath: fixture.repo,
    headSha: fixture.head,
    bodySha256: fixture.bodySha,
    validationBaseSha: fixture.base,
    bypassedBlockers: [{
      blockerId: "diff-check",
      message: "git diff --check failed",
      cause: "infrastructure",
      confidence: "high",
      reason: "This is intentionally not an allowed bypass.",
      evidence: [{ source: "test", reference: "fixture", observation: "hard stop" }],
    }],
    residualBlockers: [],
  }, null, 2)}\n`);
  const github = fakeGithub({ temp, bodyAfterPush: body });
  const result = run(process.execPath, [
    publisher,
    "--workflow", fixture.workflowPath,
    "--auto-if-ready",
    "--gate-summary", fixture.gateSummaryPath,
    "--agent-judgment", judgmentPath,
    "--push-remote", "sunlit",
    "--title", "docs: describe automatic publication",
    "--head", "sunlit-deng:sunlit/fix/issue-7",
  ], { env: github.env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot bypass blocker diff-check/);
  assert.equal(fs.existsSync(github.marker), false);
});

test("automatic publication updates a ready existing PR without a second confirmation", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-auto-existing-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const remoteHead = "remote-head";
  const fixture = setupWorkflow({ temp, existingPr: true, remoteHead });
  const github = fakeGithub({ temp, bodyAfterPush: body, existingPr: true, remoteHead });
  const result = run(process.execPath, [
    publisher,
    "--workflow", fixture.workflowPath,
    "--auto-if-ready",
    "--gate-summary", fixture.gateSummaryPath,
    "--push-remote", "sunlit",
  ], { env: github.env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(github.marker), true);
  const published = JSON.parse(fs.readFileSync(fixture.workflowPath, "utf8"));
  assert.equal(published.pr, 123);
  assert.equal(published.lastPrWriteSkipped, false);
  assert.equal(published.automaticPublication.status, "used");
});

test("automatic publication refuses a changed existing PR head before pushing", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-auto-lease-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const fixture = setupWorkflow({ temp, existingPr: true, remoteHead: "remote-head" });
  const github = fakeGithub({ temp, bodyAfterPush: body, existingPr: true, remoteHead: "changed-head" });
  const result = run(process.execPath, [
    publisher,
    "--workflow", fixture.workflowPath,
    "--auto-if-ready",
    "--gate-summary", fixture.gateSummaryPath,
    "--push-remote", "sunlit",
  ], { env: github.env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /remote HEAD changed since the automatic gate summary/);
  assert.equal(fs.existsSync(github.marker), false);
});
