#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validatePrBody } from "./lib/pr-body-validator.mjs";

function parseArgs(argv) {
  const result = { workflow: "", testScript: "test:changed" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workflow") result.workflow = argv[++index] ?? "";
    else if (arg === "--test-script") result.testScript = argv[++index] ?? "";
    else if (arg === "-h" || arg === "--help") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function usage() {
  return [
    "Usage: openclaw-preflight.mjs --workflow PATH [--test-script NAME]",
    "",
    "Runs deterministic OpenClaw checks and writes preflight.json next to workflow.json.",
    "The default focused test lane is pnpm test:changed.",
  ].join("\n");
}

function run(command, args, cwd, options = {}) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    ...options,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    command: [command, ...args].join(" "),
    exitCode: result.status ?? 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    stdout: (result.stdout ?? "").slice(-12000),
    stderr: (result.stderr ?? "").slice(-12000),
    output: output.slice(-12000),
    error: result.error?.message ?? null,
  };
}

function git(repo, ...args) {
  const result = run("git", args, repo);
  if (result.exitCode !== 0) {
    throw new Error(`${result.command} failed: ${result.output || result.error}`);
  }
  return result.output.trim();
}

function staticCheck(name, passed, details) {
  return {
    name,
    status: passed ? "passed" : "failed",
    command: null,
    exitCode: passed ? 0 : 1,
    details,
  };
}

function commandCheck(name, result) {
  return {
    name,
    status: result.exitCode === 0 ? "passed" : "failed",
    ...result,
  };
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
if (!args.workflow) {
  console.error("--workflow is required");
  process.exit(2);
}

const workflowPath = path.resolve(args.workflow);
const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
const repo = path.resolve(workflow.repoPath);
const root = path.resolve(workflow.root);
const outputPath = path.resolve(workflow.outputPath);
const preflightPath = path.resolve(workflow.preflightPath);
const checks = [];

const expectedWorktreeRoot = `${path.join(root, "worktrees")}${path.sep}`;
const expectedOutputRoot = `${path.join(root, "outputs")}${path.sep}`;
checks.push(staticCheck(
  "canonical worktree path",
  `${repo}${path.sep}`.startsWith(expectedWorktreeRoot),
  repo,
));
checks.push(staticCheck(
  "canonical output path",
  `${outputPath}${path.sep}`.startsWith(expectedOutputRoot),
  outputPath,
));
checks.push(staticCheck(
  "workflow colocated with outputs",
  path.dirname(workflowPath) === outputPath,
  workflowPath,
));
checks.push(staticCheck(
  "dependencies installed",
  workflow.dependencies?.status === "installed" && fs.existsSync(path.join(repo, "node_modules", ".modules.yaml")),
  workflow.dependencies?.status === "installed"
    ? fs.existsSync(path.join(repo, "node_modules", ".modules.yaml")) ? "installed" : "node_modules/.modules.yaml is missing"
    : `not installed: ${workflow.dependencies?.skipReason ?? "no reason recorded"}`,
));

const storeResult = run("pnpm", ["--dir", repo, "store", "path", "--store-dir", workflow.pnpmStorePath], repo);
const expectedStore = path.resolve(workflow.pnpmStorePath);
const reportedStore = storeResult.stdout.split("\n").filter(Boolean).at(-1) ?? "";
const actualStore = reportedStore ? path.resolve(reportedStore) : "";
checks.push(staticCheck(
  "shared pnpm store",
  storeResult.exitCode === 0 && (actualStore === expectedStore || actualStore.startsWith(`${expectedStore}${path.sep}`)),
  storeResult.exitCode === 0 ? `root=${expectedStore} actual=${actualStore}` : storeResult.error || storeResult.output,
));
const modulesPath = path.join(repo, "node_modules", ".modules.yaml");
let modulesStore = "";
if (fs.existsSync(modulesPath)) {
  const modulesYaml = fs.readFileSync(modulesPath, "utf8");
  modulesStore = modulesYaml.match(/^storeDir:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? "";
}
const resolvedModulesStore = modulesStore ? path.resolve(repo, modulesStore) : "";
checks.push(staticCheck(
  "node_modules uses shared store",
  Boolean(resolvedModulesStore) && (
    resolvedModulesStore === expectedStore || resolvedModulesStore.startsWith(`${expectedStore}${path.sep}`)
  ),
  resolvedModulesStore || "node_modules/.modules.yaml has no storeDir",
));

checks.push(commandCheck("fetch latest origin/main", run("git", ["fetch", "origin", "main"], repo)));

let headSha = "";
let baseSha = "";
let branch = "";
let status = "";
try {
  headSha = git(repo, "rev-parse", "HEAD");
  baseSha = git(repo, "rev-parse", "refs/remotes/origin/main^{commit}");
  branch = git(repo, "branch", "--show-current");
  status = git(repo, "status", "--porcelain");
  checks.push(staticCheck("workflow branch matches", branch === workflow.branch, `${branch} vs ${workflow.branch}`));
  checks.push(staticCheck("working tree clean", status.length === 0, status || "clean"));

  const mergeBase = git(repo, "merge-base", headSha, baseSha);
  checks.push(staticCheck(
    "branch contains latest origin/main",
    mergeBase === baseSha,
    `merge-base=${mergeBase} origin/main=${baseSha}`,
  ));
  const changedFiles = git(repo, "diff", "--name-only", `${baseSha}...${headSha}`);
  checks.push(staticCheck(
    "committed diff exists",
    changedFiles.length > 0,
    changedFiles || "no committed changes beyond origin/main",
  ));

  const commits = git(repo, "log", "--format=%H%x09%an%x09%ae%x09%cn%x09%ce", `${mergeBase}..HEAD`);
  const identityProblems = commits
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
  checks.push(staticCheck(
    "sunlit-deng commit identity",
    identityProblems.length === 0,
    identityProblems.join("; ") || "ok",
  ));
} catch (error) {
  checks.push(staticCheck("git repository state", false, error.message));
}

checks.push(commandCheck("git diff check", run("git", ["diff", "--check", "refs/remotes/origin/main...HEAD"], repo)));

try {
  const bodyResult = validatePrBody({
    bodyPath: workflow.prBodyPath,
    issue: workflow.issue,
    repoPath: repo,
  });
  workflow.prBodySha256 = bodyResult.sha256;
  checks.push(staticCheck(
    "PR body and proof",
    bodyResult.status === "passed",
    bodyResult.errors.join("; ") || `sha256=${bodyResult.sha256}`,
  ));
} catch (error) {
  checks.push(staticCheck("PR body and proof", false, error.message));
}

let packageJson;
try {
  packageJson = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
} catch (error) {
  checks.push(staticCheck("package manifest", false, error.message));
}

if (packageJson) {
  checks.push(staticCheck(
    "repository check script exists",
    typeof packageJson.scripts?.check === "string",
    packageJson.scripts?.check ?? "missing package.json scripts.check",
  ));
  checks.push(staticCheck(
    "focused test script exists",
    Boolean(args.testScript && typeof packageJson.scripts?.[args.testScript] === "string"),
    args.testScript || "no focused test script selected",
  ));

  if (typeof packageJson.scripts?.check === "string") {
    checks.push(commandCheck("typecheck lint and policy checks", run("pnpm", ["check"], repo)));
  }
  if (args.testScript && typeof packageJson.scripts?.[args.testScript] === "string") {
    checks.push(commandCheck("focused tests", run("pnpm", [args.testScript], repo)));
  }
}

const failed = checks.filter((check) => check.status !== "passed");
workflow.baseSha = baseSha || workflow.baseSha;
workflow.headSha = headSha || workflow.headSha;
workflow.updatedAt = new Date().toISOString();
fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
const receipt = {
  schemaVersion: 1,
  status: failed.length === 0 ? "passed" : "failed",
  workflowPath,
  repoPath: repo,
  baseSha,
  headSha,
  branch,
  generatedAt: new Date().toISOString(),
  checks,
};

fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
fs.writeFileSync(preflightPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

for (const check of checks) {
  console.log(`${check.status === "passed" ? "PASS" : "FAIL"}  ${check.name}`);
}
console.log(`\n${receipt.status.toUpperCase()}: ${preflightPath}`);
process.exit(receipt.status === "passed" ? 0 : 1);
