#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadProjectProfile, projectBaseRef, projectUsesCargo, projectUsesPnpm } from "./project-profile.mjs";
import { ghEnv, resolveAccount, resolveAccountForLogin } from "../skills/auto-pr-openclaw/scripts/lib/account-utils.mjs";

function parseArgs(argv) {
  const result = { project: "openclaw", pr: 0, root: "", account: "", skipInstall: false, skipInstallReason: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project") result.project = argv[++index] ?? "";
    else if (arg === "--pr") result.pr = Number(argv[++index]);
    else if (arg === "--root") result.root = argv[++index] ?? "";
    else if (arg === "--account") result.account = argv[++index] ?? "";
    else if (arg === "--skip-install") result.skipInstall = true;
    else if (arg === "--skip-install-reason") result.skipInstallReason = argv[++index] ?? "";
    else if (arg === "-h" || arg === "--help") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function execute(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", shell: false, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    const details = String(result.stderr || result.stdout || result.error?.message || "unknown error").slice(-4000);
    throw new Error(`${command} ${args.join(" ")} failed: ${details}`);
  }
  return result.stdout.trim();
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: prepare-project-pr-worktree.mjs --project ID --pr N [--root PATH] [--account PROFILE] [--skip-install --skip-install-reason TEXT]");
  process.exit(0);
}
if (!Number.isSafeInteger(args.pr) || args.pr <= 0) throw new Error("--pr must be a positive integer");
if (args.skipInstall && !args.skipInstallReason.trim()) throw new Error("--skip-install requires --skip-install-reason");
if (!args.skipInstall && args.skipInstallReason.trim()) throw new Error("--skip-install-reason requires --skip-install");

const project = loadProjectProfile(args.project);
const coreDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(coreDir, "../..");
const root = path.resolve(args.root || path.join(repoRoot, "workspace", project.workspace.name));
let account = resolveAccount({ profile: args.account, root });
let env = ghEnv(account);
const repoRootPath = path.join(root, "repos");
const mainRepo = path.join(repoRootPath, project.workspace.repoDir);
const name = `pr-${args.pr}`;
const branch = `${project.branch.prPrefix || "sunlit/pr"}-${args.pr}`;
const worktreePath = path.join(root, "worktrees", name);
const outputPath = path.join(root, "outputs", name);
const dependencyStorePath = projectUsesPnpm(project) ? path.join(root, ".pnpm-store") : null;
fs.mkdirSync(repoRootPath, { recursive: true });
fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
fs.mkdirSync(outputPath, { recursive: true });
if (dependencyStorePath) fs.mkdirSync(dependencyStorePath, { recursive: true });

const pr = JSON.parse(execute("gh", ["pr", "view", String(args.pr), "--repo", project.github.repo, "--json", "body,state,headRefName,headRepository,headRepositoryOwner,maintainerCanModify,url"], { env }));
if (pr.state !== "OPEN") throw new Error(`PR #${args.pr} is not open`);
if (!pr.headRepository?.nameWithOwner || !pr.headRefName || !pr.headRepositoryOwner?.login) throw new Error(`PR #${args.pr} does not expose a usable head repository`);
const selection = resolveAccountForLogin({ login: pr.headRepositoryOwner.login, profile: args.account, root });
account = selection.account;
env = ghEnv(account);
execute("gh", ["auth", "status"], { env });
execute("gh", ["auth", "setup-git"], { env });
if (project.intake?.reviewScript) {
  const reviewScript = path.resolve(repoRoot, project.intake.reviewScript);
  execute(process.execPath, [
    reviewScript,
    "--repo", project.github.repo,
    "--pr", String(args.pr),
    "--output", path.join(outputPath, "review-intake.json"),
  ], { env });
}
if (!fs.existsSync(path.join(mainRepo, ".git"))) execute("gh", ["repo", "clone", project.github.repo, mainRepo], { env });
execute("git", ["fetch", "origin", project.github.defaultBranch], { cwd: mainRepo });
const baseSha = execute("git", ["rev-parse", `refs/remotes/origin/${project.github.defaultBranch}^{commit}`], { cwd: mainRepo });
if (fs.existsSync(worktreePath)) throw new Error(`Worktree already exists: ${worktreePath}`);
if (spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: mainRepo }).status === 0) throw new Error(`Local branch already exists: ${branch}`);
if (execute("git", ["status", "--porcelain"], { cwd: mainRepo })) throw new Error(`Main clone is not clean: ${mainRepo}`);
execute("gh", ["pr", "checkout", String(args.pr), "--repo", project.github.repo, "--branch", branch], { cwd: mainRepo, env });
execute("git", ["switch", project.github.defaultBranch], { cwd: mainRepo });
execute("git", ["worktree", "add", worktreePath, branch], { cwd: mainRepo });
execute("git", ["config", "user.name", account.username], { cwd: worktreePath });
execute("git", ["config", "user.email", account.email], { cwd: worktreePath });
for (const file of ["pr-body.md", "live-proof.md", "ci-notes.md"]) fs.writeFileSync(path.join(outputPath, file), file === "pr-body.md" ? `${pr.body ?? ""}` : "", "utf8");

let dependencyStatus = "installed";
if (args.skipInstall) dependencyStatus = "skipped";
else if (projectUsesCargo(project)) execute("cargo", project.dependencies.setupArgs || ["fetch", "--locked"], { cwd: worktreePath });
else if (projectUsesPnpm(project)) execute("pnpm", ["install", "--frozen-lockfile", "--store-dir", dependencyStorePath], { cwd: worktreePath });
else dependencyStatus = "skipped";

const writer = path.join(repoRoot, ".codex/skills/auto-pr-openclaw/scripts/write-workflow-state.mjs");
const headSha = execute("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
const issue = Number((pr.body ?? "").match(/(?:Fixes|Closes|Resolves|Related|Depends on|Supersedes|Implements)\s*:?[ \t]*#(\d+)/i)?.[1] ?? 0);
const writerArgs = [writer, "--project-id", project.id, "--project-config", project.profilePath, "--mode", "existing-pr", ...(issue > 0 ? ["--issue", String(issue)] : []), "--pr", String(args.pr), "--root", root, "--repo-path", worktreePath, "--output-path", outputPath, "--branch", branch, "--head-owner", pr.headRepositoryOwner.login, "--head-ref", pr.headRefName, "--base-ref", projectBaseRef(project), "--base-sha", baseSha, "--head-sha", headSha, ...(project.intake?.reviewScript ? ["--review-intake-path", path.join(outputPath, "review-intake.json")] : []), ...(dependencyStorePath ? ["--dependency-store-path", dependencyStorePath] : []), "--pr-body-path", path.join(outputPath, "pr-body.md"), "--preflight-path", path.join(outputPath, "preflight.json"), "--dependency-status", dependencyStatus, "--skip-reason", args.skipInstallReason, "--maintainer-can-modify", String(pr.maintainerCanModify === true), "--account-profile", account.profile, "--account-username", account.username, "--account-email", account.email, "--account-login", account.login, "--account-push-remote", account.pushRemote];
const state = JSON.parse(execute(process.execPath, writerArgs));
console.log(JSON.stringify({ project: project.id, pr: args.pr, worktree: worktreePath, outputs: outputPath, branch, baseSha, headSha, maintainerCanModify: pr.maintainerCanModify === true, account: { profile: account.profile, login: account.login, pushRemote: account.pushRemote }, accountSelection: selection.selection, workflow: state }, null, 2));
