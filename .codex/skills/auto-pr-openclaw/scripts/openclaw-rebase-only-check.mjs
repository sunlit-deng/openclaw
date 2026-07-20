#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  currentBranch,
  currentHead,
  gitChangedFiles,
  gitCommitIdentities,
  loadWorkflow,
  parseKeyArgs,
  run,
  writeJson,
} from "./lib/workflow-utils.mjs";
import {
  commitIdentityProblems,
  ghEnv,
  identityCheckName,
  publicAccount,
  resolveAccount,
} from "./lib/account-utils.mjs";

function usage() {
  return `Usage: openclaw-rebase-only-check.mjs --workflow PATH [--target SHA] [--repo OWNER/REPO] [--output PATH]

Writes a lightweight receipt for existing-PR rebase-only maintenance. It does
not run pnpm checks, update PR bodies, push, comment, or request review.`;
}

function ownerLogin(value) {
  return typeof value === "string" ? value : value?.login;
}

let args;
try {
  args = parseKeyArgs(process.argv.slice(2), {
    "--workflow": { name: "workflow" },
    "--target": { name: "target" },
    "--repo": { name: "repo" },
    "--output": { name: "output" },
  });
} catch (error) {
  console.error(error.message);
  console.error(usage());
  process.exit(2);
}
if (args.help) {
  console.log(usage());
  process.exit(0);
}
if (!args.workflow) {
  console.error("--workflow is required");
  console.error(usage());
  process.exit(2);
}

const context = loadWorkflow(args.workflow);
const repoSlug = args.repo || "openclaw/openclaw";
const outputPath = path.resolve(args.output || path.join(context.outputPath, "rebase-only-check.json"));
const checks = [];
const blockers = [];
const workflow = context.workflow;
const account = resolveAccount({ workflow });
const accountEnv = ghEnv(account);
const repoPath = context.repoPath;
const headSha = currentHead(repoPath);
const branch = currentBranch(repoPath);
const targetRef = args.target || workflow.approvedRebaseTargetSha || workflow.rebaseTargetSha || "refs/remotes/origin/main";

function addCheck(name, passed, details, extra = {}) {
  const check = {
    name,
    status: passed ? "passed" : "failed",
    details,
    ...extra,
  };
  checks.push(check);
  if (!passed) blockers.push(`${name}: ${details}`);
  return check;
}

addCheck("existing PR workflow", Boolean(workflow.pr), workflow.pr ? `PR #${workflow.pr}` : "workflow has no PR number");
addCheck("workflow branch matches", branch === workflow.branch, `${branch} vs ${workflow.branch}`);

const status = run("git", ["status", "--porcelain"], { cwd: repoPath }).stdout.trim();
addCheck("working tree clean", status.length === 0, status || "clean");

const targetResolve = run("git", ["rev-parse", `${targetRef}^{commit}`], { cwd: repoPath, allowFailure: true });
const targetSha = targetResolve.stdout.trim();
addCheck(
  "rebase target resolves",
  targetResolve.exitCode === 0 && targetSha.length > 0,
  targetResolve.exitCode === 0 ? targetSha : targetResolve.output.trim() || targetResolve.error,
  { targetRef },
);

let changedFiles = [];
if (targetSha) {
  const containsTarget = run("git", ["merge-base", "--is-ancestor", targetSha, "HEAD"], { cwd: repoPath, allowFailure: true });
  addCheck("branch contains rebase target", containsTarget.exitCode === 0, targetSha);

  changedFiles = gitChangedFiles(repoPath, targetSha);
  addCheck(
    "committed diff exists",
    changedFiles.length > 0,
    changedFiles.join("\n") || "no committed changes beyond the rebase target",
  );

  const diffCheck = run("git", ["diff", "--check", `${targetSha}...HEAD`], { cwd: repoPath, allowFailure: true });
  addCheck(
    "git diff check",
    diffCheck.exitCode === 0,
    diffCheck.output.trim() || "ok",
    { command: diffCheck.command, exitCode: diffCheck.exitCode },
  );

  const identities = gitCommitIdentities(repoPath, targetSha);
  const identityProblems = commitIdentityProblems(identities, account);
  addCheck(
    identityCheckName(account),
    identityProblems.length === 0,
    identityProblems.join("; ") || "ok",
    { commitIdentities: identities },
  );
}

let maintainer = { checked: false, maintainerCanModify: workflow.maintainerCanModify ?? null, error: null };
let ghLogin = "";
const ghUser = run("gh", ["api", "user"], { allowFailure: true, env: accountEnv });
if (ghUser.exitCode === 0) {
  try {
    ghLogin = JSON.parse(ghUser.stdout).login ?? "";
  } catch {
    ghLogin = "";
  }
}
addCheck(
  "gh identity",
  ghLogin.length > 0,
  ghLogin || ghUser.output.trim() || ghUser.error || "unable to read gh api user",
);
if (workflow.pr) {
  const prResult = run("gh", [
    "pr", "view", String(workflow.pr), "--repo", repoSlug,
    "--json", "maintainerCanModify,headRepositoryOwner,headRefName,url",
  ], { allowFailure: true, env: accountEnv });
  if (prResult.exitCode === 0) {
    try {
      const parsed = JSON.parse(prResult.stdout);
      maintainer = {
        checked: true,
        maintainerCanModify: parsed.maintainerCanModify === true,
        headOwner: ownerLogin(parsed.headRepositoryOwner),
        headRefName: parsed.headRefName,
        url: parsed.url,
        error: null,
      };
    } catch (error) {
      maintainer.error = error.message;
    }
  } else {
    maintainer.error = prResult.output.trim() || prResult.error;
  }
}
addCheck(
  "maintainer edit access",
  maintainer.maintainerCanModify === true,
  maintainer.checked ? String(maintainer.maintainerCanModify) : maintainer.error || String(maintainer.maintainerCanModify),
  { maintainer },
);
addCheck(
  "existing PR head matches push identity",
  Boolean(ghLogin)
    && maintainer.headOwner?.toLowerCase() === ghLogin.toLowerCase()
    && maintainer.headRefName === workflow.headRef,
  `owner=${maintainer.headOwner ?? "unknown"} ref=${maintainer.headRefName ?? "unknown"} gh=${ghLogin || "unknown"} workflowHeadRef=${workflow.headRef ?? "unknown"}`,
);

const receipt = {
  schemaVersion: 1,
  status: blockers.length === 0 ? "passed" : "failed",
  workflowPath: context.workflowPath,
  repoPath,
  generatedAt: new Date().toISOString(),
  mode: "rebase-only",
  headSha,
  branch,
  targetRef,
  targetSha,
  changedFiles,
  githubAccount: publicAccount(account),
  maintainer,
  checks,
  blockers,
};
writeJson(outputPath, receipt);
console.log(JSON.stringify({
  outputPath,
  status: receipt.status,
  headSha,
  targetSha,
  blockers: blockers.length,
}, null, 2));
process.exit(receipt.status === "passed" ? 0 : 1);
