#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const result = {
    workflow: "",
    approvedHead: "",
    pushRemote: "",
    repo: "openclaw/openclaw",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const key = {
      "--workflow": "workflow",
      "--approved-head": "approvedHead",
      "--push-remote": "pushRemote",
      "--repo": "repo",
    }[arg];
    if (arg === "-h" || arg === "--help") result.help = true;
    else if (!key) throw new Error(`Unknown argument: ${arg}`);
    else result[key] = argv[++index] ?? "";
  }
  return result;
}

function usage() {
  return [
    "Usage: publish-openclaw-rebase-only.mjs --workflow PATH --approved-head SHA --push-remote NAME [--repo OWNER/REPO]",
    "",
    "Force-pushes an existing OpenClaw PR branch after a conflict-only rebase.",
    "This fast path does not read preflight.json, update the PR body, post comments, or request review.",
  ].join("\n");
}

function execute(command, args, { cwd, input } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.error?.message}`);
  }
  return result.stdout.trim();
}

function run(command, args, { cwd } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  return {
    command: [command, ...args].join(" "),
    exitCode: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    error: result.error?.message ?? null,
  };
}

function ownerLogin(value) {
  return typeof value === "string" ? value : value?.login;
}

function viewPr(selector, repo) {
  return JSON.parse(execute("gh", [
    "pr", "view", String(selector), "--repo", repo,
    "--json", "number,url,maintainerCanModify,headRefName,headRefOid,headRepositoryOwner",
  ]));
}

function checkSunlitIdentity(repoPath, mergeBase) {
  const commits = execute("git", [
    "log", "--format=%H%x09%an%x09%ae%x09%cn%x09%ce", `${mergeBase}..HEAD`,
  ], { cwd: repoPath });
  return commits
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [sha, authorName, authorEmail, committerName, committerEmail] = line.split("\t");
      const problems = [];
      if (authorName === "sunlit-deng" && authorEmail !== "yang.jiajun1@xydigit.com") {
        problems.push(`${sha}: author email is ${authorEmail}`);
      }
      if (committerName === "sunlit-deng" && committerEmail !== "yang.jiajun1@xydigit.com") {
        problems.push(`${sha}: committer email is ${committerEmail}`);
      }
      return problems;
    });
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
for (const key of ["workflow", "approvedHead", "pushRemote"]) {
  if (!args[key]) {
    console.error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
    console.error(usage());
    process.exit(2);
  }
}

const workflowPath = path.resolve(args.workflow);
const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
const repoPath = path.resolve(workflow.repoPath);
const remoteHeadRef = workflow.headRef;
const failures = [];

const currentHead = execute("git", ["rev-parse", "HEAD"], { cwd: repoPath });
const currentBranch = execute("git", ["branch", "--show-current"], { cwd: repoPath });
if (!workflow.pr) failures.push("workflow does not describe an existing PR");
if (!remoteHeadRef) failures.push("workflow does not record the PR head ref");
if (workflow.branch !== currentBranch) failures.push(`current branch ${currentBranch} does not match workflow branch ${workflow.branch}`);
if (args.approvedHead !== currentHead) failures.push("current HEAD does not match the human-approved HEAD");
if (execute("git", ["status", "--porcelain"], { cwd: repoPath })) failures.push("working tree is not clean");

const fetchOrigin = run("git", ["fetch", "origin", "main"], { cwd: repoPath });
if (fetchOrigin.exitCode !== 0) failures.push(`git fetch origin main failed: ${fetchOrigin.output || fetchOrigin.error}`);

let baseSha = "";
let mergeBase = "";
try {
  baseSha = execute("git", ["rev-parse", "refs/remotes/origin/main^{commit}"], { cwd: repoPath });
  mergeBase = execute("git", ["merge-base", currentHead, baseSha], { cwd: repoPath });
  if (mergeBase !== baseSha) failures.push(`branch does not contain latest origin/main (${baseSha})`);
  const changedFiles = execute("git", ["diff", "--name-only", `${baseSha}...${currentHead}`], { cwd: repoPath });
  if (!changedFiles) failures.push("branch has no committed diff beyond origin/main");
  const identityProblems = checkSunlitIdentity(repoPath, mergeBase);
  failures.push(...identityProblems);
} catch (error) {
  failures.push(error.message);
}

const diffCheck = run("git", ["diff", "--check", "refs/remotes/origin/main...HEAD"], { cwd: repoPath });
if (diffCheck.exitCode !== 0) failures.push(`git diff --check failed: ${diffCheck.output || diffCheck.error}`);

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

execute("gh", ["auth", "status"]);
execute("gh", ["auth", "setup-git"]);
const ghLogin = JSON.parse(execute("gh", ["api", "user"])).login;
let remoteUrl;
try {
  remoteUrl = execute("git", ["remote", "get-url", args.pushRemote], { cwd: repoPath });
} catch {
  execute("gh", ["repo", "fork", args.repo, "--remote", "--remote-name", args.pushRemote], { cwd: repoPath });
  remoteUrl = execute("git", ["remote", "get-url", args.pushRemote], { cwd: repoPath });
}
const remoteOwner = remoteUrl.match(/github\.com(?::|\/)([^/]+)\//i)?.[1];
if (!remoteOwner || remoteOwner.toLowerCase() !== ghLogin.toLowerCase()) {
  throw new Error(`Push remote owner (${remoteOwner ?? "unknown"}) does not match gh identity (${ghLogin})`);
}

const before = viewPr(workflow.pr, args.repo);
if (before.maintainerCanModify !== true) {
  throw new Error("maintainer_can_modify is not true; restore maintainer edit access before push");
}
if (ownerLogin(before.headRepositoryOwner)?.toLowerCase() !== ghLogin.toLowerCase() || before.headRefName !== remoteHeadRef) {
  throw new Error("existing PR head owner or branch does not match the authenticated push target");
}
if (!before.headRefOid) {
  throw new Error("existing PR head SHA is unavailable; cannot use force-with-lease safely");
}

execute("git", [
  "push",
  `--force-with-lease=refs/heads/${remoteHeadRef}:${before.headRefOid}`,
  "--set-upstream",
  args.pushRemote,
  `${currentBranch}:refs/heads/${remoteHeadRef}`,
], { cwd: repoPath });

const after = viewPr(workflow.pr, args.repo);
if (after.headRefOid !== currentHead) {
  throw new Error(`remote PR head differs after push (local=${currentHead}, remote=${after.headRefOid ?? "unknown"})`);
}
if (after.maintainerCanModify !== true) {
  throw new Error("maintainer_can_modify is not true after push");
}

workflow.baseSha = baseSha || workflow.baseSha;
workflow.headSha = currentHead;
workflow.publishedHeadSha = currentHead;
workflow.rebaseOnlyPublishedHeadSha = currentHead;
workflow.rebaseOnlyPublishedAt = new Date().toISOString();
workflow.updatedAt = workflow.rebaseOnlyPublishedAt;
fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  pr: workflow.pr,
  url: after.url,
  headSha: currentHead,
  baseSha,
  maintainerCanModify: true,
  mode: "rebase-only",
  prBodyUpdated: false,
}, null, 2));
