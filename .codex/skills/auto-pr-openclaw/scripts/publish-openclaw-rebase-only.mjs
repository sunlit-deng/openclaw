#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { commitIdentityProblems, ghEnv, publicAccount, resolveAccount } from "./lib/account-utils.mjs";

function parseArgs(argv) {
  const result = {
    workflow: "",
    check: "",
    pushRemote: "",
    repo: "openclaw/openclaw",
    target: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const key = {
      "--workflow": "workflow",
      "--check": "check",
      "--push-remote": "pushRemote",
      "--repo": "repo",
      "--target": "target",
    }[arg];
    if (arg === "-h" || arg === "--help") result.help = true;
    else if (!key) throw new Error(`Unknown argument: ${arg}`);
    else result[key] = argv[++index] ?? "";
  }
  return result;
}

function usage() {
  return [
    "Usage: publish-openclaw-rebase-only.mjs --workflow PATH --push-remote NAME [--check PATH] [--target SHA] [--repo OWNER/REPO]",
    "",
    "Automatically force-pushes an existing OpenClaw PR branch after a clean, patch-equivalent rebase.",
    "The user's explicit rebase request authorizes this push; no second human gate is required.",
    "This fast path does not read preflight.json, update the PR body, post comments, or request review.",
  ].join("\n");
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

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function viewPr(selector, repo, env = process.env) {
  return JSON.parse(execute("gh", [
    "pr", "view", String(selector), "--repo", repo,
    "--json", "number,url,maintainerCanModify,headRefName,headRefOid,headRepositoryOwner",
  ], { env }));
}

function currentGhLogin(env) {
  try {
    return JSON.parse(execute("gh", ["api", "user"], { env })).login;
  } catch (error) {
    const login = execute("gh", [
      "api",
      "graphql",
      "-f",
      "query=query { viewer { login } }",
      "--jq",
      ".data.viewer.login",
    ], { env });
    if (!login) throw error;
    return login;
  }
}

function checkAccountIdentity(repoPath, mergeBase, account) {
  const commits = execute("git", [
    "log", "--format=%H%x09%an%x09%ae%x09%cn%x09%ce", `${mergeBase}..HEAD`,
  ], { cwd: repoPath });
  const identities = commits
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, authorName, authorEmail, committerName, committerEmail] = line.split("\t");
      return { sha, authorName, authorEmail, committerName, committerEmail };
    });
  return commitIdentityProblems(identities, account);
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  console.error(usage());
  process.exit(2);
}
if (args.help) {
  console.log(usage());
  process.exit(0);
}
for (const key of ["workflow"]) {
  if (!args[key]) {
    console.error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
    console.error(usage());
    process.exit(2);
  }
}

const workflowPath = path.resolve(args.workflow);
const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
const checkPath = path.resolve(args.check || path.join(workflow.outputPath, "rebase-only-check.json"));
const rebaseOnlyCheck = JSON.parse(fs.readFileSync(checkPath, "utf8"));
const account = resolveAccount({ workflow });
const accountEnv = ghEnv(account);
args.pushRemote ||= account.pushRemote;
if (!args.pushRemote) {
  console.error("--push-remote is required");
  console.error(usage());
  process.exit(2);
}
const repoPath = path.resolve(workflow.repoPath);
const remoteHeadRef = workflow.headRef;
const failures = [];

const currentHead = execute("git", ["rev-parse", "HEAD"], { cwd: repoPath });
const currentBranch = execute("git", ["branch", "--show-current"], { cwd: repoPath });
if (!workflow.pr) failures.push("workflow does not describe an existing PR");
if (!remoteHeadRef) failures.push("workflow does not record the PR head ref");
if (workflow.branch !== currentBranch) failures.push(`current branch ${currentBranch} does not match workflow branch ${workflow.branch}`);
if (execute("git", ["status", "--porcelain"], { cwd: repoPath })) failures.push("working tree is not clean");

let baseSha = "";
let mergeBase = "";
try {
  const target = args.target
    || workflow.approvedRebaseTargetSha
    || workflow.rebaseTargetSha
    || workflow.validationBaseSha
    || workflow.baseSha
    || "refs/remotes/origin/main";
  baseSha = execute("git", ["rev-parse", `${target}^{commit}`], { cwd: repoPath });
  mergeBase = execute("git", ["merge-base", currentHead, baseSha], { cwd: repoPath });
  if (mergeBase !== baseSha) failures.push(`branch does not contain pinned rebase target (${baseSha})`);
  const changedFiles = execute("git", ["diff", "--name-only", `${baseSha}...${currentHead}`], { cwd: repoPath });
  if (!changedFiles) failures.push("branch has no committed diff beyond the pinned rebase target");
  const identityProblems = checkAccountIdentity(repoPath, mergeBase, account);
  failures.push(...identityProblems);
} catch (error) {
  failures.push(error.message);
}

if (rebaseOnlyCheck.status !== "passed") failures.push(`rebase-only check is ${rebaseOnlyCheck.status ?? "unknown"}`);
if (rebaseOnlyCheck.headSha !== currentHead) failures.push("rebase-only check does not match current HEAD");
if (rebaseOnlyCheck.targetSha !== baseSha) failures.push("rebase-only check does not match the pinned rebase target");
if (rebaseOnlyCheck.patchEquivalent !== true) failures.push("rebase-only check does not prove patch equivalence");
if (!rebaseOnlyCheck.originalHeadSha) failures.push("rebase-only check does not record the original PR head");

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

const ghLogin = currentGhLogin(accountEnv);
execute("gh", ["auth", "setup-git"], { env: accountEnv });
let remoteUrl;
try {
  remoteUrl = execute("git", ["remote", "get-url", args.pushRemote], { cwd: repoPath });
} catch {
  const repoName = repoNameFromSlug(args.repo);
  remoteUrl = account.token
    ? `https://github.com/${ghLogin}/${repoName}.git`
    : `git@github.com:${ghLogin}/${repoName}.git`;
  execute("git", ["remote", "add", args.pushRemote, remoteUrl], { cwd: repoPath });
}
try {
  remoteUrl = execute("git", ["remote", "get-url", args.pushRemote], { cwd: repoPath });
} catch (error) {
  throw new Error(`Push remote ${args.pushRemote} is unavailable: ${error.message}`);
}
const remoteOwner = remoteOwnerFromUrl(remoteUrl);
if (!remoteOwner || remoteOwner.toLowerCase() !== ghLogin.toLowerCase()) {
  throw new Error(`Push remote owner (${remoteOwner ?? "unknown"}) does not match gh identity (${ghLogin})`);
}
if (account.token && remoteUrl.startsWith("git@github.com:")) {
  remoteUrl = `https://github.com/${ghLogin}/${repoNameFromSlug(args.repo)}.git`;
  execute("git", ["remote", "set-url", args.pushRemote, remoteUrl], { cwd: repoPath });
}

const before = viewPr(workflow.pr, args.repo, accountEnv);
if (before.maintainerCanModify !== true) {
  throw new Error("maintainer_can_modify is not true; restore maintainer edit access before push");
}
if (ownerLogin(before.headRepositoryOwner)?.toLowerCase() !== ghLogin.toLowerCase() || before.headRefName !== remoteHeadRef) {
  throw new Error("existing PR head owner or branch does not match the authenticated push target");
}
if (!before.headRefOid) {
  throw new Error("existing PR head SHA is unavailable; cannot use force-with-lease safely");
}
if (before.headRefOid !== rebaseOnlyCheck.originalHeadSha) {
  throw new Error(`remote PR head moved since the clean-rebase check (expected=${rebaseOnlyCheck.originalHeadSha}, remote=${before.headRefOid})`);
}

execute("git", [
  "push",
  `--force-with-lease=refs/heads/${remoteHeadRef}:${before.headRefOid}`,
  "--set-upstream",
  args.pushRemote,
  `${currentBranch}:refs/heads/${remoteHeadRef}`,
], { cwd: repoPath, env: accountEnv });

let after = viewPr(workflow.pr, args.repo, accountEnv);
for (let attempt = 0; after.headRefOid !== currentHead && attempt < 10; attempt += 1) {
  sleep(1000);
  after = viewPr(workflow.pr, args.repo, accountEnv);
}
if (after.headRefOid !== currentHead) {
  throw new Error(`remote PR head differs after push (local=${currentHead}, remote=${after.headRefOid ?? "unknown"})`);
}
if (after.maintainerCanModify !== true) {
  throw new Error("maintainer_can_modify is not true after push");
}

workflow.baseSha = baseSha || workflow.baseSha;
workflow.validationBaseSha = baseSha || workflow.validationBaseSha || workflow.baseSha;
workflow.validationBaseRef ||= "origin/main";
workflow.latestObservedMainSha = baseSha || workflow.latestObservedMainSha;
workflow.latestObservedAt = new Date().toISOString();
workflow.headSha = currentHead;
workflow.publishedHeadSha = currentHead;
workflow.rebaseOnlyPublishedHeadSha = currentHead;
workflow.rebaseOnlyPublishedAt = workflow.latestObservedAt;
workflow.githubAccount = publicAccount(account);
workflow.updatedAt = workflow.rebaseOnlyPublishedAt;
fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  pr: workflow.pr,
  url: after.url,
  headSha: currentHead,
  baseSha,
  maintainerCanModify: true,
  mode: "rebase-only",
  authorization: "initial-rebase-request",
  checkPath,
  prBodyUpdated: false,
}, null, 2));
