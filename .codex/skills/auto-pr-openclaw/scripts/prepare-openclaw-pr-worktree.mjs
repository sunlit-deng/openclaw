#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ghEnv, publicAccount, resolveAccount, resolveAccountForLogin } from "./lib/account-utils.mjs";

function parseArgs(argv) {
  const result = { pr: 0, root: "", account: "", skipInstall: false, skipInstallReason: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--pr") result.pr = Number(argv[++index]);
    else if (arg === "--root") result.root = argv[++index] ?? "";
    else if (arg === "--account") result.account = argv[++index] ?? "";
    else if (arg === "--skip-install") result.skipInstall = true;
    else if (arg === "--skip-install-reason") result.skipInstallReason = argv[++index] ?? "";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function execute(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", shell: false, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.error?.message}`);
  }
  return result.stdout.trim();
}

function executeOptional(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", shell: false, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || result.error?.message || `${command} failed\n`);
    process.stderr.write("Warning: CodeGraph setup failed; the worktree remains usable.\n");
    return false;
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return true;
}

const args = parseArgs(process.argv.slice(2));
if (!Number.isSafeInteger(args.pr) || args.pr <= 0) throw new Error("--pr must be a positive integer");
if (args.skipInstall && !args.skipInstallReason.trim()) throw new Error("--skip-install requires --skip-install-reason");
if (!args.skipInstall && args.skipInstallReason.trim()) throw new Error("--skip-install-reason requires --skip-install");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const autoPrRoot = path.resolve(scriptDir, "../../../..");
const root = path.resolve(args.root || path.join(autoPrRoot, "workspace/openclaw"));
let account = resolveAccount({ profile: args.account, root });
let accountEnv = ghEnv(account);
const mainRepo = path.join(root, "repos/openclaw");
const name = `pr-${args.pr}`;
const worktreePath = path.join(root, "worktrees", name);
const outputPath = path.join(root, "outputs", name);
const storePath = path.join(root, ".pnpm-store");
const localBranch = `sunlit/pr-${args.pr}`;

execute("gh", ["auth", "status"], { env: accountEnv });
execute("gh", ["auth", "setup-git"], { env: accountEnv });

const pr = JSON.parse(execute("gh", [
  "pr", "view", String(args.pr), "--repo", "openclaw/openclaw",
  "--json", "body,state,headRefName,headRepository,headRepositoryOwner,maintainerCanModify,url",
], { env: accountEnv }));
if (pr.state !== "OPEN") throw new Error(`PR #${args.pr} is not open`);
if (!pr.headRepository?.nameWithOwner || !pr.headRefName || !pr.headRepositoryOwner?.login) {
  throw new Error(`PR #${args.pr} does not expose a usable head repository`);
}
const accountSelection = resolveAccountForLogin({
  login: pr.headRepositoryOwner.login,
  profile: args.account,
  root,
});
account = accountSelection.account;
accountEnv = ghEnv(account);
execute("gh", ["auth", "status"], { env: accountEnv });
execute("gh", ["auth", "setup-git"], { env: accountEnv });
const linkedIssue = Number((pr.body ?? "").match(/^(?:Fixes|Closes):?\s+#(\d+)\s*$/mi)?.[1] ?? 0);

fs.mkdirSync(path.join(root, "repos"), { recursive: true });
fs.mkdirSync(path.join(root, "worktrees"), { recursive: true });
fs.mkdirSync(outputPath, { recursive: true });
fs.mkdirSync(storePath, { recursive: true });
if (!fs.existsSync(path.join(mainRepo, ".git"))) {
  execute("gh", ["repo", "clone", "openclaw/openclaw", mainRepo], { env: accountEnv });
}

execute("git", ["fetch", "origin", "main"], { cwd: mainRepo });
const baseSha = execute("git", ["rev-parse", "refs/remotes/origin/main^{commit}"], { cwd: mainRepo });
if (fs.existsSync(worktreePath)) throw new Error(`Worktree already exists: ${worktreePath}`);
const branchExists = spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${localBranch}`], { cwd: mainRepo }).status === 0;
if (branchExists) throw new Error(`Local branch already exists and will not be reused implicitly: ${localBranch}`);
if (execute("git", ["status", "--porcelain"], { cwd: mainRepo })) {
  throw new Error(`Main clone is not clean: ${mainRepo}`);
}
execute("gh", ["pr", "checkout", String(args.pr), "--repo", "openclaw/openclaw", "--branch", localBranch], { cwd: mainRepo, env: accountEnv });
execute("git", ["switch", "main"], { cwd: mainRepo });
execute("git", ["worktree", "add", worktreePath, localBranch], { cwd: mainRepo });
execute("git", ["config", "user.name", account.username], { cwd: worktreePath });
execute("git", ["config", "user.email", account.email], { cwd: worktreePath });
executeOptional(path.join(scriptDir, "ensure-openclaw-codegraph.sh"), [
  "--repo-path", worktreePath,
  "--main-repo", mainRepo,
  "--root", root,
  "--base-sha", baseSha,
]);

for (const file of ["pr-body.md", "live-proof.md", "ci-notes.md"]) {
  fs.writeFileSync(path.join(outputPath, file), file === "pr-body.md" ? `${pr.body ?? ""}` : "", "utf8");
}

let dependencyStatus = "installed";
if (args.skipInstall) {
  dependencyStatus = "skipped";
} else {
  execute(path.join(scriptDir, "ensure-openclaw-deps.sh"), [
    "--repo-path", worktreePath,
    "--root", root,
    "--store-path", storePath,
  ]);
}

const headSha = execute("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
const stateWriter = path.join(scriptDir, "write-workflow-state.mjs");
execute(process.execPath, [
  stateWriter,
  "--mode", "existing-pr",
  ...(linkedIssue > 0 ? ["--issue", String(linkedIssue)] : []),
  "--pr", String(args.pr),
  "--root", root,
  "--repo-path", worktreePath,
  "--output-path", outputPath,
  "--branch", localBranch,
  "--head-owner", pr.headRepositoryOwner.login,
  "--head-ref", pr.headRefName,
  "--base-ref", "origin/main",
  "--base-sha", baseSha,
  "--head-sha", headSha,
  "--pnpm-store-path", storePath,
  "--pr-body-path", path.join(outputPath, "pr-body.md"),
  "--preflight-path", path.join(outputPath, "preflight.json"),
  "--dependency-status", dependencyStatus,
  "--skip-reason", args.skipInstallReason,
  "--maintainer-can-modify", String(pr.maintainerCanModify === true),
  "--account-profile", account.profile,
  "--account-username", account.username,
  "--account-email", account.email,
  "--account-login", account.login,
  "--account-push-remote", account.pushRemote,
]);

const mergeBase = execute("git", ["merge-base", headSha, baseSha], { cwd: worktreePath });
console.log(JSON.stringify({
  pr: args.pr,
  worktree: worktreePath,
  outputs: outputPath,
  branch: localBranch,
  head: `${pr.headRepositoryOwner.login}:${pr.headRefName}`,
  headSha,
  latestBaseSha: baseSha,
  containsLatestBase: mergeBase === baseSha,
  maintainerCanModify: pr.maintainerCanModify === true,
  account: publicAccount(account),
  accountSelection: accountSelection.selection,
}, null, 2));
