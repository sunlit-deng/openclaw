#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadProjectProfile, projectBaseRef, projectUsesCargo, projectUsesPnpm } from "./project-profile.mjs";
import { ghEnv, resolveAccount } from "../skills/auto-pr-openclaw/scripts/lib/account-utils.mjs";

function parseArgs(argv) {
  const result = { project: "openclaw", mode: "new-issue", issue: "", topic: "", root: "", branchPrefix: "", account: "", skipInstall: false, skipInstallReason: "", reviewedRelatedPrs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project") result.project = argv[++index] ?? "";
    else if (arg === "--mode") result.mode = argv[++index] ?? "";
    else if (arg === "--issue") result.issue = argv[++index] ?? "";
    else if (arg === "--topic") result.topic = argv[++index] ?? "";
    else if (arg === "--root") result.root = argv[++index] ?? "";
    else if (arg === "--branch-prefix") result.branchPrefix = argv[++index] ?? "";
    else if (arg === "--account") result.account = argv[++index] ?? "";
    else if (arg === "--skip-install") result.skipInstall = true;
    else if (arg === "--skip-install-reason") result.skipInstallReason = argv[++index] ?? "";
    else if (arg === "--reviewed-related-pr") result.reviewedRelatedPrs.push(argv[++index] ?? "");
    else if (arg === "-h" || arg === "--help") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function usage() {
  return "Usage: new-project-worktree.mjs --project ID --issue N [--topic TEXT] [--root PATH] [--account PROFILE] [--reviewed-related-pr N ...] [--skip-install --skip-install-reason TEXT]";
}

function execute(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const details = String(result.stderr || result.stdout || result.error?.message || "unknown error").slice(-4000);
    throw new Error(`${command} ${args.join(" ")} failed: ${details}`);
  }
  return result.stdout.trim();
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}
const project = loadProjectProfile(args.project);
const topicSlug = slugify(args.topic);
if (!["new-issue", "local-candidate"].includes(args.mode)) throw new Error("--mode must be new-issue or local-candidate");
if (args.mode === "new-issue" && !/^[1-9][0-9]*$/.test(args.issue)) throw new Error("--issue must be a positive integer");
if (args.mode === "local-candidate" && (args.issue || !topicSlug)) throw new Error("local-candidate requires --topic and no --issue");
if (args.skipInstall && !args.skipInstallReason.trim()) throw new Error("--skip-install requires --skip-install-reason");
if (!args.skipInstall && args.skipInstallReason.trim()) throw new Error("--skip-install-reason requires --skip-install");
if (args.reviewedRelatedPrs.some((number) => !/^[1-9][0-9]*$/.test(number))) {
  throw new Error("--reviewed-related-pr values must be positive integers");
}
for (const command of ["node", "git", "gh"]) {
  if (!process.env.PATH || spawnSync("sh", ["-lc", `command -v ${command}`], { encoding: "utf8" }).status !== 0) {
    throw new Error(`${command} is required`);
  }
}

const coreDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(coreDir, "../..");
const root = path.resolve(args.root || path.join(repoRoot, "workspace", project.workspace.name));
const account = resolveAccount({ profile: args.account, root });
const env = ghEnv(account);
execute("gh", ["auth", "status"], { env });
execute("gh", ["auth", "setup-git"], { env });

const name = args.mode === "local-candidate" ? `local-${topicSlug}` : `issue-${args.issue}${topicSlug ? `-${topicSlug}` : ""}`;
const prefix = args.branchPrefix || project.branch.prefix;
const branch = args.mode === "local-candidate" ? `${prefix}/${topicSlug}` : `${prefix}/issue-${args.issue}${topicSlug ? `-${topicSlug}` : ""}`;
const repoRootPath = path.join(root, "repos");
const mainRepo = path.join(repoRootPath, project.workspace.repoDir);
const worktreePath = path.join(root, "worktrees", name);
const outputPath = path.join(root, "outputs", name);
const dependencyStorePath = projectUsesPnpm(project) ? path.join(root, ".pnpm-store") : null;
fs.mkdirSync(repoRootPath, { recursive: true });
fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
fs.mkdirSync(outputPath, { recursive: true });
if (dependencyStorePath) fs.mkdirSync(dependencyStorePath, { recursive: true });

if (!fs.existsSync(path.join(mainRepo, ".git"))) {
  execute("gh", ["repo", "clone", project.github.repo, mainRepo], { env });
}
execute("git", ["fetch", "origin", project.github.defaultBranch], { cwd: mainRepo });
const baseRef = projectBaseRef(project);
const baseSha = execute("git", ["rev-parse", `refs/remotes/origin/${project.github.defaultBranch}^{commit}`], { cwd: mainRepo });
if (args.mode === "new-issue" && project.intake?.script) {
  const intakeScript = path.resolve(repoRoot, project.intake.script);
  const intakeArgs = [
    intakeScript,
    "--repo", project.github.repo,
    "--issue", args.issue,
    "--output", path.join(outputPath, "intake.json"),
  ];
  for (const relatedPr of args.reviewedRelatedPrs) {
    intakeArgs.push("--reviewed-related-pr", relatedPr);
  }
  execute(process.execPath, intakeArgs, { env });
}
if (fs.existsSync(worktreePath)) throw new Error(`Worktree already exists: ${worktreePath}`);
if (spawnSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: mainRepo }).status === 0) {
  throw new Error(`Local branch already exists and will not be reused implicitly: ${branch}`);
}
execute("git", ["worktree", "add", "-b", branch, worktreePath, baseSha], { cwd: mainRepo });
execute("git", ["config", "user.name", account.username], { cwd: worktreePath });
execute("git", ["config", "user.email", account.email], { cwd: worktreePath });

for (const file of ["pr-body.md", "live-proof.md", "ci-notes.md"]) fs.writeFileSync(path.join(outputPath, file), "", "utf8");
let dependencyStatus = "installed";
if (args.skipInstall) {
  dependencyStatus = "skipped";
} else if (projectUsesCargo(project)) {
  execute("cargo", project.dependencies.setupArgs || ["fetch", "--locked"], { cwd: worktreePath });
} else if (projectUsesPnpm(project)) {
  execute("pnpm", ["install", "--frozen-lockfile", "--store-dir", dependencyStorePath], { cwd: worktreePath });
} else {
  dependencyStatus = "skipped";
}

const writer = path.join(repoRoot, ".codex/skills/auto-pr-openclaw/scripts/write-workflow-state.mjs");
const headSha = execute("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
const writerArgs = [
  writer,
  "--project-id", project.id,
  "--project-config", project.profilePath,
  "--mode", args.mode,
  ...(args.issue ? ["--issue", args.issue] : []),
  "--root", root,
  "--repo-path", worktreePath,
  "--output-path", outputPath,
  "--branch", branch,
  "--base-ref", baseRef,
  "--base-sha", baseSha,
  "--head-sha", headSha,
  ...(project.intake?.script ? ["--intake-path", path.join(outputPath, "intake.json")] : []),
  ...(dependencyStorePath ? ["--dependency-store-path", dependencyStorePath] : []),
  "--pr-body-path", path.join(outputPath, "pr-body.md"),
  "--preflight-path", path.join(outputPath, "preflight.json"),
  "--dependency-status", dependencyStatus,
  "--skip-reason", args.skipInstallReason,
  ...(account.configured ? [
    "--account-profile", account.profile,
    "--account-username", account.username,
    "--account-email", account.email,
    "--account-login", account.login,
    "--account-push-remote", account.pushRemote,
  ] : []),
];
const state = JSON.parse(execute(process.execPath, writerArgs));
console.log(JSON.stringify({
  project: project.id,
  repo: project.github.repo,
  worktree: worktreePath,
  outputs: outputPath,
  branch,
  baseSha,
  headSha,
  dependencyStatus,
  account: { profile: account.profile, login: account.login, pushRemote: account.pushRemote },
  workflow: state,
}, null, 2));
