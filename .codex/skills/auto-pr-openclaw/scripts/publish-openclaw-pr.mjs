#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ghEnv, publicAccount, resolveAccount } from "./lib/account-utils.mjs";

function parseArgs(argv) {
  const result = {
    workflow: "",
    approvedHead: "",
    approvedBodySha: "",
    title: "",
    head: "",
    base: "main",
    pushRemote: "",
    repo: "openclaw/openclaw",
    allowFailedPreflight: false,
    failedPreflightBypassReason: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-failed-preflight") {
      result.allowFailedPreflight = true;
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
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.error?.message}`);
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
    "--json", "number,url,body,maintainerCanModify,headRefName,headRepositoryOwner",
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

for (const key of ["workflow", "approvedHead", "approvedBodySha"]) {
  if (!args[key]) {
    console.error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
    process.exit(2);
  }
}

const workflowPath = path.resolve(args.workflow);
const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
const account = resolveAccount({ workflow });
const accountEnv = ghEnv(account);
args.pushRemote ||= account.pushRemote;
if (!args.pushRemote) {
  console.error("--push-remote is required");
  process.exit(2);
}
const preflight = JSON.parse(fs.readFileSync(path.resolve(workflow.preflightPath), "utf8"));
const repoPath = path.resolve(workflow.repoPath);
const body = normalizeNewlines(fs.readFileSync(path.resolve(workflow.prBodyPath), "utf8"));
const bodySha = sha256(body);
const currentHead = execute("git", ["rev-parse", "HEAD"], { cwd: repoPath });
const currentBranch = execute("git", ["branch", "--show-current"], { cwd: repoPath });
const remoteHeadRef = workflow.headRef || currentBranch;

const failures = [];
const failedPreflightBypass = args.allowFailedPreflight && preflight.status === "failed";
if (args.allowFailedPreflight && preflight.status !== "failed") failures.push("--allow-failed-preflight only applies when preflight status is failed");
if (args.allowFailedPreflight && !args.failedPreflightBypassReason.trim()) failures.push("--failed-preflight-bypass-reason is required with --allow-failed-preflight");
if (preflight.status !== "passed" && !failedPreflightBypass) failures.push("preflight status is not passed");
if (preflight.headSha !== currentHead) failures.push("preflight is stale for the current HEAD");
if (workflow.branch !== currentBranch) failures.push("current branch does not match workflow.json");
if (args.approvedHead !== currentHead) failures.push("current HEAD does not match the human-approved HEAD");
if (args.approvedBodySha !== bodySha) failures.push("current PR body does not match the human-approved SHA-256");
if (workflow.prBodySha256 !== bodySha) failures.push("PR body has changed since validation");
if (execute("git", ["status", "--porcelain"], { cwd: repoPath })) failures.push("working tree is not clean");
if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

execute("gh", ["auth", "status"], { env: accountEnv });
execute("gh", ["auth", "setup-git"], { env: accountEnv });
const ghLogin = JSON.parse(execute("gh", ["api", "user"], { env: accountEnv })).login;
let remoteUrl;
try {
  remoteUrl = execute("git", ["remote", "get-url", args.pushRemote], { cwd: repoPath });
} catch {
  execute("gh", ["repo", "fork", args.repo, "--remote", "--remote-name", args.pushRemote], { cwd: repoPath, env: accountEnv });
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
if (prNumber) {
  const existing = viewPr(prNumber, args.repo, accountEnv);
  if (existing.maintainerCanModify !== true) {
    throw new Error("maintainer_can_modify is not true; restore maintainer edit access before push");
  }
  if (ownerLogin(existing.headRepositoryOwner)?.toLowerCase() !== ghLogin.toLowerCase() || existing.headRefName !== remoteHeadRef) {
    throw new Error("existing PR head owner or branch does not match the authenticated push target");
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

execute("git", ["push", "--set-upstream", args.pushRemote, `${currentBranch}:${remoteHeadRef}`], { cwd: repoPath, env: accountEnv });

let response;
if (prNumber) {
  const payload = { body };
  if (args.title) payload.title = args.title;
  response = JSON.parse(execute(
    "gh",
    ["api", "--method", "PATCH", `repos/${args.repo}/pulls/${prNumber}`, "--input", "-"],
    { input: JSON.stringify(payload), env: accountEnv },
  ));
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
  throw new Error("maintainer_can_modify is not true; restore maintainer edit access before review requests");
}

workflow.pr = prNumber;
workflow.prUrl = remote.url ?? response.url ?? null;
workflow.publishedHeadSha = currentHead;
workflow.remoteBodySha256 = sha256(remoteBody);
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
workflow.updatedAt = new Date().toISOString();
fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  pr: prNumber,
  url: workflow.prUrl,
  headSha: currentHead,
  bodySha256: workflow.remoteBodySha256,
  maintainerCanModify: true,
  failedPreflightBypass: failedPreflightBypass ? workflow.failedPreflightBypass : null,
}, null, 2));
