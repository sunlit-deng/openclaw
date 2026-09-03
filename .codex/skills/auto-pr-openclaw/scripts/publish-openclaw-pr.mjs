#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ghEnv, publicAccount, resolveAccount } from "./lib/account-utils.mjs";
import { validatePrBody } from "./lib/pr-body-validator.mjs";
import { prUpdateRequired } from "./lib/publish-utils.mjs";
import {
  automaticPublicationProblems,
  validateAgentPublicationJudgment,
} from "./lib/publication-gate.mjs";
import { validateWorkflowReceipt } from "./lib/receipt-utils.mjs";
import { projectForWorkflow } from "../../../auto-pr-core/project-profile.mjs";

function parseArgs(argv) {
  const result = {
    workflow: "",
    approvedHead: "",
    approvedBodySha: "",
    title: "",
    head: "",
    base: "",
    pushRemote: "",
    repo: "",
    allowFailedPreflight: false,
    failedPreflightBypassReason: "",
    allowWorkflowRuleBypass: false,
    workflowRuleBypassReason: "",
    autoIfReady: false,
    gateSummary: "",
    agentJudgment: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-failed-preflight") {
      result.allowFailedPreflight = true;
      continue;
    }
    if (arg === "--allow-workflow-rule-bypass") {
      result.allowWorkflowRuleBypass = true;
      continue;
    }
    if (arg === "--auto-if-ready") {
      result.autoIfReady = true;
      continue;
    }
    const key = {
      "--workflow": "workflow",
      "--approved-head": "approvedHead",
      "--approved-body-sha": "approvedBodySha",
      "--title": "title",
      "--head": "head",
      "--base": "base",
      "--push-remote": "pushRemote",
      "--repo": "repo",
      "--failed-preflight-bypass-reason": "failedPreflightBypassReason",
      "--workflow-rule-bypass-reason": "workflowRuleBypassReason",
      "--gate-summary": "gateSummary",
      "--agent-judgment": "agentJudgment",
    }[arg];
    if (!key) throw new Error(`Unknown argument: ${arg}`);
    result[key] = argv[++index] ?? "";
  }
  return result;
}

function execute(command, args, { cwd, input, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (result.status !== 0) {
    const details = String(result.stderr || result.stdout || result.error?.message || "unknown error").slice(-4000);
    throw new Error(`${command} ${args.join(" ")} failed: ${details}`);
  }
  return result.stdout.trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeNewlines(value) {
  return value.replace(/\r\n?/g, "\n");
}

function viewPr(selector, repo, env = process.env) {
  return JSON.parse(execute("gh", [
    "pr", "view", String(selector), "--repo", repo,
    "--json", "number,url,title,body,maintainerCanModify,headRefName,headRefOid,headRepositoryOwner",
  ], { env }));
}

function ownerLogin(value) {
  return typeof value === "string" ? value : value?.login;
}

function repoNameFromSlug(repo) {
  const repoName = repo.split("/")[1];
  if (!repoName) throw new Error(`Invalid repository name: ${repo}`);
  return repoName;
}

function remoteOwnerFromUrl(remoteUrl) {
  return remoteUrl.match(/github\.com(?::|\/)([^/]+)\//i)?.[1];
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

for (const key of ["workflow"]) {
  if (!args[key]) {
    console.error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
    process.exit(2);
  }
}
if (args.allowWorkflowRuleBypass) {
  if (!args.workflowRuleBypassReason.trim()) {
    console.error("--workflow-rule-bypass-reason is required with --allow-workflow-rule-bypass");
    process.exit(2);
  }
} else if (!args.autoIfReady) {
  for (const key of ["approvedHead", "approvedBodySha"]) {
    if (!args[key]) {
      console.error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
      process.exit(2);
    }
  }
}
if (args.autoIfReady && args.allowWorkflowRuleBypass) {
  console.error("--auto-if-ready cannot be combined with --allow-workflow-rule-bypass");
  process.exit(2);
}
if (args.autoIfReady && args.allowFailedPreflight) {
  console.error("--auto-if-ready cannot be combined with --allow-failed-preflight");
  process.exit(2);
}
if (args.agentJudgment && !args.autoIfReady) {
  console.error("--agent-judgment requires --auto-if-ready");
  process.exit(2);
}

const workflowPath = path.resolve(args.workflow);
const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
const project = projectForWorkflow(workflow);
args.repo ||= project.github.repo;
args.base ||= workflow.baseRef?.replace(/^origin\//, "") || project.github.defaultBranch;
const account = resolveAccount({ workflow });
const accountEnv = ghEnv(account);
args.pushRemote ||= account.pushRemote;
if (!args.pushRemote) {
  console.error("--push-remote is required");
  process.exit(2);
}
let preflight = null;
let preflightReadError = null;
if (workflow.preflightPath) {
  try {
    preflight = JSON.parse(fs.readFileSync(path.resolve(workflow.preflightPath), "utf8"));
  } catch (error) {
    preflightReadError = error.message;
  }
}
const repoPath = path.resolve(workflow.repoPath);
const body = normalizeNewlines(fs.readFileSync(path.resolve(workflow.prBodyPath), "utf8"));
const bodySha = sha256(body);
const currentHead = execute("git", ["rev-parse", "HEAD"], { cwd: repoPath });
const currentBranch = execute("git", ["branch", "--show-current"], { cwd: repoPath });
const remoteHeadRef = workflow.headRef || currentBranch;
let automaticPublication = null;
let agentJudgmentPath = null;
let agentJudgmentSha256 = null;
let agentBypassApproved = false;
let agentBypassedBlockerIds = [];
if (args.autoIfReady) {
  const gateSummaryPath = path.resolve(args.gateSummary || path.join(path.dirname(workflowPath), "gate-summary.json"));
  let gateSummary;
  try {
    gateSummary = JSON.parse(fs.readFileSync(gateSummaryPath, "utf8"));
  } catch (error) {
    console.error(`automatic publication blocked: cannot read gate summary ${gateSummaryPath}: ${error.message}`);
    process.exit(1);
  }
  let agentJudgment = null;
  let agentJudgmentProblems = [];
  let agentJudgmentParsed = false;
  if (args.agentJudgment) {
    agentJudgmentPath = path.resolve(args.agentJudgment);
    let rawJudgment;
    try {
      rawJudgment = fs.readFileSync(agentJudgmentPath, "utf8");
      agentJudgmentSha256 = sha256(rawJudgment);
      agentJudgment = JSON.parse(rawJudgment);
      agentJudgmentParsed = true;
    } catch (error) {
      agentJudgmentProblems = [`cannot read agent publication judgment ${agentJudgmentPath}: ${error.message}`];
    }
    if (agentJudgmentParsed) {
      const judgmentValidation = validateAgentPublicationJudgment({
        judgment: agentJudgment,
        summary: gateSummary,
        workflow,
        workflowPath,
        gateSummaryPath,
        repoPath,
        currentHead,
        bodySha,
      });
      agentJudgmentProblems = judgmentValidation.problems;
      if (judgmentValidation.valid) {
        agentBypassApproved = true;
        agentBypassedBlockerIds = judgmentValidation.bypassedBlockerIds;
      }
    }
  }
  const gateProblems = automaticPublicationProblems({
    summary: gateSummary,
    workflow,
    workflowPath,
    gateSummaryPath,
    repoPath,
    currentHead,
    currentBranch,
    bodySha,
    account,
    pushRemote: args.pushRemote,
    project,
    agentBypassApproved,
    agentBypassedBlockerIds,
  });
  gateProblems.push(...agentJudgmentProblems);
  if (args.approvedHead && args.approvedHead !== gateSummary.headSha) {
    gateProblems.push("--approved-head does not match the gate summary HEAD");
  }
  if (args.approvedBodySha && args.approvedBodySha !== gateSummary.prBody?.sha256) {
    gateProblems.push("--approved-body-sha does not match the gate summary body hash");
  }
  if (gateProblems.length > 0) {
    console.error("automatic publication blocked; human confirmation is required for these gate results:");
    console.error(gateProblems.map((problem) => `- ${problem}`).join("\n"));
    process.exit(1);
  }
  args.approvedHead = gateSummary.headSha;
  args.approvedBodySha = gateSummary.prBody.sha256;
  automaticPublication = {
    status: "ready",
    mode: agentBypassApproved ? "agent-judged-external-bypass" : "gate-ready",
    gateSummaryPath,
    gateSummaryGeneratedAt: gateSummary.generatedAt ?? null,
    expectedRemoteHead: gateSummary.maintainer?.headRefOid ?? null,
    agentJudgmentPath,
    agentJudgmentSha256,
    agentJudgmentAgent: agentJudgment?.agent ?? null,
    agentJudgmentReason: agentJudgment?.reason ?? null,
    agentBypassedBlockerIds,
  };
}
args.approvedHead ||= currentHead;
args.approvedBodySha ||= bodySha;

const failures = [];
const bypassedChecks = [];
const workflowRuleBypass = args.allowWorkflowRuleBypass;
const bypassReason = args.workflowRuleBypassReason.trim();

function bypassableFailure(condition, message) {
  if (!condition) return;
  if (workflowRuleBypass) bypassedChecks.push(message);
  else failures.push(message);
}

const preflightValidation = validateWorkflowReceipt(preflight, {
  kind: "preflight",
  schemaVersions: [2],
  workflowPath,
  repoPath,
  headSha: currentHead,
  validationBaseSha: workflow.validationBaseSha || workflow.baseSha,
});
const failedPreflightBypass = args.allowFailedPreflight && preflight?.status === "failed";
const agentBypassedPreflight = agentBypassApproved && agentBypassedBlockerIds.includes("preflight-status");
if (args.allowFailedPreflight && preflight?.status !== "failed") failures.push("--allow-failed-preflight only applies when preflight status is failed");
if (args.allowFailedPreflight && !args.failedPreflightBypassReason.trim()) failures.push("--failed-preflight-bypass-reason is required with --allow-failed-preflight");
if (preflight?.status !== "passed") {
  if (failedPreflightBypass || workflowRuleBypass || agentBypassedPreflight) {
    bypassedChecks.push(agentBypassedPreflight
      ? `preflight status is ${preflight?.status ?? "missing"} (agent judged external)`
      : `preflight status is ${preflight?.status ?? "missing"}`);
  } else {
    failures.push(`preflight status is ${preflight?.status ?? "missing"}`);
  }
}
const preflightProblems = [
  ...preflightValidation.problems,
  ...(preflightReadError ? [`preflight could not be read: ${preflightReadError}`] : []),
];
for (const problem of preflightProblems) bypassableFailure(true, problem);
if (workflow.branch !== currentBranch) failures.push("current branch does not match workflow.json");
if (args.approvedHead !== currentHead) failures.push(`current HEAD does not match the ${args.autoIfReady ? "automatic gate" : "human-approved"} HEAD`);
if (args.approvedBodySha !== bodySha) failures.push(`current PR body does not match the ${args.autoIfReady ? "automatic gate" : "human-approved"} SHA-256`);
if (workflow.prBodySha256 !== bodySha) bypassableFailure(true, "PR body has changed since workflow validation");
try {
  const bodyValidation = validatePrBody({
    bodyPath: workflow.prBodyPath,
    issue: workflow.issue,
    pr: workflow.pr,
    requireIssueLink: Number.isSafeInteger(workflow.issue) && workflow.issue > 0,
    repoPath,
    baseRef: workflow.validationBaseSha || workflow.baseRef,
    project,
  });
  if (bodyValidation.status !== "passed") {
    bypassableFailure(true, `current PR body failed validation: ${bodyValidation.errors.join("; ")}`);
  }
} catch (error) {
  bypassableFailure(true, `current PR body validation failed: ${error.message}`);
}
if (execute("git", ["status", "--porcelain"], { cwd: repoPath })) bypassableFailure(true, "working tree is not clean");
if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

execute("gh", ["auth", "setup-git"], { env: accountEnv });
const ghLogin = JSON.parse(execute("gh", ["api", "user"], { env: accountEnv })).login;
let remoteUrl;
try {
  remoteUrl = execute("git", ["remote", "get-url", args.pushRemote], { cwd: repoPath });
} catch {
  const forkName = repoNameFromSlug(args.repo);
  const forkUrl = `https://github.com/${ghLogin}/${forkName}.git`;
  try {
    execute("gh", ["api", "--method", "POST", `repos/${args.repo}/forks`], { env: accountEnv });
  } catch (forkError) {
    try {
      execute("gh", ["api", `repos/${ghLogin}/${forkName}`], { env: accountEnv });
    } catch {
      throw forkError;
    }
  }
  execute("git", ["remote", "add", args.pushRemote, forkUrl], { cwd: repoPath });
  remoteUrl = execute("git", ["remote", "get-url", args.pushRemote], { cwd: repoPath });
}
const remoteOwner = remoteOwnerFromUrl(remoteUrl);
if (!remoteOwner || remoteOwner.toLowerCase() !== ghLogin.toLowerCase()) {
  throw new Error(`Push remote owner (${remoteOwner ?? "unknown"}) does not match gh identity (${ghLogin})`);
}
if (account.token && remoteUrl.startsWith("git@github.com:")) {
  remoteUrl = `https://github.com/${ghLogin}/${repoNameFromSlug(args.repo)}.git`;
  execute("git", ["remote", "set-url", args.pushRemote, remoteUrl], { cwd: repoPath });
}

let prNumber = workflow.pr;
let existing = null;
if (prNumber) {
  existing = viewPr(prNumber, args.repo, accountEnv);
  if (automaticPublication?.expectedRemoteHead && existing.headRefOid !== automaticPublication.expectedRemoteHead) {
    throw new Error("existing PR remote HEAD changed since the automatic gate summary; regenerate the gate summary");
  }
  if (existing.maintainerCanModify !== true) {
    if (workflowRuleBypass) bypassedChecks.push("maintainer_can_modify is not true before push");
    else throw new Error("maintainer_can_modify is not true; restore maintainer edit access before push");
  }
  if (ownerLogin(existing.headRepositoryOwner)?.toLowerCase() !== ghLogin.toLowerCase() || existing.headRefName !== remoteHeadRef) {
    throw new Error("existing PR head owner or branch does not match the authenticated push target");
  }
  if (!existing.headRefOid) {
    throw new Error("existing PR head OID is unavailable; refusing to push without a force-with-lease expectation");
  }
} else {
  if (!args.title || !args.head) {
    throw new Error("--title and --head <owner:branch> are required when creating a PR");
  }
  const [headOwner, headBranch] = args.head.split(":");
  if (headOwner?.toLowerCase() !== ghLogin.toLowerCase() || headBranch !== remoteHeadRef) {
    throw new Error("--head must match the authenticated GitHub owner and current branch");
  }
}

const pushArgs = ["push", "--set-upstream", args.pushRemote, `${currentBranch}:${remoteHeadRef}`];
if (existing) {
  pushArgs.splice(1, 0, `--force-with-lease=refs/heads/${remoteHeadRef}:${existing.headRefOid}`);
}
execute("git", pushArgs, { cwd: repoPath, env: accountEnv });

let response;
let prWriteSkipped = false;
if (prNumber) {
  const payload = { body };
  if (args.title) payload.title = args.title;
  if (!prUpdateRequired({
    currentBody: existing?.body,
    currentTitle: existing?.title,
    nextBody: body,
    nextTitle: args.title,
  })) {
    response = existing;
    prWriteSkipped = true;
  } else {
    response = JSON.parse(execute(
      "gh",
      ["api", "--method", "PATCH", `repos/${args.repo}/pulls/${prNumber}`, "--input", "-"],
      { input: JSON.stringify(payload), env: accountEnv },
    ));
  }
} else {
  const payload = {
    title: args.title,
    head: args.head,
    base: args.base,
    body,
    maintainer_can_modify: true,
  };
  response = JSON.parse(execute(
    "gh",
    ["api", "--method", "POST", `repos/${args.repo}/pulls`, "--input", "-"],
    { input: JSON.stringify(payload), env: accountEnv },
  ));
  prNumber = response.number;
}

const remote = viewPr(prNumber, args.repo, accountEnv);
const remoteBody = normalizeNewlines(remote.body ?? "");
if (remoteBody !== body) {
  throw new Error(`GitHub PR body differs after REST write (local=${bodySha}, remote=${sha256(remoteBody)})`);
}
if (remote.maintainerCanModify !== true) {
  if (workflowRuleBypass) bypassedChecks.push("maintainer_can_modify is not true after write");
  else throw new Error("maintainer_can_modify is not true; restore maintainer edit access before review requests");
}

workflow.pr = prNumber;
workflow.prUrl = remote.url ?? response.url ?? null;
workflow.publishedHeadSha = currentHead;
workflow.remoteBodySha256 = sha256(remoteBody);
workflow.lastPrWriteSkipped = prWriteSkipped;
workflow.githubAccount = publicAccount(account);
if (failedPreflightBypass) {
  workflow.failedPreflightBypass = {
    status: "used",
    reason: args.failedPreflightBypassReason.trim(),
    preflightPath: path.resolve(workflow.preflightPath),
    preflightStatus: preflight.status,
    approvedHead: args.approvedHead,
    approvedBodySha256: args.approvedBodySha,
    usedAt: new Date().toISOString(),
  };
}
if (workflowRuleBypass) {
  workflow.workflowRuleBypass = {
    status: "used",
    reason: bypassReason,
    scope: "current publish attempt",
    bypassedChecks: [...new Set(bypassedChecks)],
    approvedHead: args.approvedHead,
    approvedBodySha256: args.approvedBodySha,
    usedAt: new Date().toISOString(),
  };
}
if (automaticPublication) {
  workflow.automaticPublication = {
    ...automaticPublication,
    status: "used",
    approvedHead: args.approvedHead,
    approvedBodySha256: args.approvedBodySha,
    usedAt: new Date().toISOString(),
  };
}
workflow.updatedAt = new Date().toISOString();
fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  pr: prNumber,
  url: workflow.prUrl,
  headSha: currentHead,
  bodySha256: workflow.remoteBodySha256,
  maintainerCanModify: remote.maintainerCanModify === true,
  prWriteSkipped,
  automaticPublication: automaticPublication ? workflow.automaticPublication : null,
  failedPreflightBypass: failedPreflightBypass ? workflow.failedPreflightBypass : null,
  workflowRuleBypass: workflowRuleBypass ? workflow.workflowRuleBypass : null,
}, null, 2));
