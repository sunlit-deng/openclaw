#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

function usage() {
  process.stdout.write(`Usage: openclaw-workspace-maintenance.mjs [--root PATH] [--json]
       openclaw-workspace-maintenance.mjs [--root PATH] --warm-store [--yes]
       openclaw-workspace-maintenance.mjs [--root PATH] --prune-node-modules --older-than-days N --yes
       openclaw-workspace-maintenance.mjs [--root PATH] --remove-worktree NAME [--remove-output] --yes

Reports OpenClaw workspace disk use by default. Destructive actions require --yes.
`);
}

function parseArgs(argv) {
  const args = {
    root: "",
    json: false,
    yes: false,
    force: false,
    warmStore: false,
    pruneNodeModules: false,
    olderThanDays: 14,
    removeWorktrees: [],
    removeOutput: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") args.root = argv[++index] ?? "";
    else if (arg === "--json") args.json = true;
    else if (arg === "--yes") args.yes = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--warm-store") args.warmStore = true;
    else if (arg === "--prune-node-modules") args.pruneNodeModules = true;
    else if (arg === "--older-than-days") args.olderThanDays = Number(argv[++index]);
    else if (arg === "--remove-worktree") args.removeWorktrees.push(argv[++index] ?? "");
    else if (arg === "--remove-output") args.removeOutput = true;
    else if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function execute(command, args, { cwd, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false, maxBuffer: 32 * 1024 * 1024 });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.error?.message}`);
  }
  return result;
}

function exists(target) {
  return fs.existsSync(target);
}

function listDirs(target) {
  if (!exists(target)) return [];
  return fs.readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function diskKb(target) {
  if (!exists(target)) return 0;
  const result = execute("du", ["-sk", target], { allowFailure: true });
  if (result.status !== 0) return 0;
  return Number(result.stdout.trim().split(/\s+/)[0] ?? 0) || 0;
}

function formatBytesFromKb(kb) {
  const bytes = kb * 1024;
  const units = ["B", "K", "M", "G", "T"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)}${units[unit]}`;
}

function worktreeStatus(repoPath) {
  if (!exists(path.join(repoPath, ".git"))) return { clean: null, reason: "not a git worktree" };
  const result = execute("git", ["status", "--porcelain"], { cwd: repoPath, allowFailure: true });
  if (result.status !== 0) return { clean: null, reason: "git status failed" };
  return { clean: result.stdout.trim() === "", reason: result.stdout.trim() ? "dirty" : "clean" };
}

function registeredWorktreePaths(mainRepo) {
  if (!exists(path.join(mainRepo, ".git"))) return new Set();
  const result = execute("git", ["worktree", "list", "--porcelain"], { cwd: mainRepo, allowFailure: true });
  if (result.status !== 0) return new Set();
  const paths = new Set();
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) paths.add(path.resolve(line.slice("worktree ".length)));
  }
  return paths;
}

function removeDir(target, { dryRun }) {
  if (dryRun) return;
  fs.rmSync(target, { recursive: true, force: true });
}

const args = parseArgs(process.argv.slice(2));
if (!Number.isFinite(args.olderThanDays) || args.olderThanDays < 0) {
  throw new Error("--older-than-days must be a non-negative number");
}
if ((args.pruneNodeModules || args.removeWorktrees.length > 0 || args.warmStore) && !args.yes) {
  throw new Error("Actions that change the workspace require --yes");
}
if (args.removeOutput && args.removeWorktrees.length === 0) {
  throw new Error("--remove-output requires --remove-worktree");
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const autoPrRoot = path.resolve(scriptDir, "../../../..");
const root = path.resolve(args.root || path.join(autoPrRoot, "workspace/openclaw"));
const mainRepo = path.join(root, "repos/openclaw");
const worktreesRoot = path.join(root, "worktrees");
const outputsRoot = path.join(root, "outputs");
const storePath = path.join(root, ".pnpm-store");
const registered = registeredWorktreePaths(mainRepo);
const now = Date.now();
const olderThanMs = args.olderThanDays * 24 * 60 * 60 * 1000;

const report = {
  root,
  totals: {
    trackedDependencyKb: 0,
    storeKb: diskKb(storePath),
    outputsKb: diskKb(outputsRoot),
  },
  repoDependencyDirs: [],
  worktrees: [],
  outputsWithoutWorktree: [],
  actions: [],
};

for (const name of listDirs(path.join(root, "repos"))) {
  const nodeModulesPath = path.join(root, "repos", name, "node_modules");
  const sizeKb = diskKb(nodeModulesPath);
  if (sizeKb > 0) report.repoDependencyDirs.push({ name, path: nodeModulesPath, nodeModulesKb: sizeKb });
}

for (const name of listDirs(worktreesRoot)) {
  const repoPath = path.join(worktreesRoot, name);
  const nodeModulesPath = path.join(repoPath, "node_modules");
  const stat = fs.statSync(repoPath);
  const status = worktreeStatus(repoPath);
  const entry = {
    name,
    path: repoPath,
    registered: registered.size === 0 ? null : registered.has(path.resolve(repoPath)),
    clean: status.clean,
    status: status.reason,
    ageDays: Math.max(0, Math.floor((now - stat.mtimeMs) / (24 * 60 * 60 * 1000))),
    nodeModulesKb: diskKb(nodeModulesPath),
  };
  report.worktrees.push(entry);

  if (args.pruneNodeModules && entry.nodeModulesKb > 0) {
    const oldEnough = now - stat.mtimeMs >= olderThanMs;
    const canPrune = args.force || (status.clean === true && oldEnough);
    if (canPrune) {
      removeDir(nodeModulesPath, { dryRun: false });
      report.actions.push({ action: "removed-node-modules", worktree: name, path: nodeModulesPath, freedKb: entry.nodeModulesKb });
      entry.nodeModulesKb = 0;
    } else {
      report.actions.push({
        action: "skipped-node-modules",
        worktree: name,
        reason: status.clean !== true ? status.reason : `newer than ${args.olderThanDays} days`,
      });
    }
  }
}

const worktreeNames = new Set(report.worktrees.map((entry) => entry.name));
for (const name of listDirs(outputsRoot)) {
  if (!worktreeNames.has(name)) report.outputsWithoutWorktree.push({ name, path: path.join(outputsRoot, name), sizeKb: diskKb(path.join(outputsRoot, name)) });
}

for (const name of args.removeWorktrees) {
  if (!exists(path.join(mainRepo, ".git"))) throw new Error(`Main OpenClaw repo is missing: ${mainRepo}`);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Unsafe worktree name: ${name}`);
  const repoPath = path.join(worktreesRoot, name);
  if (!exists(repoPath)) throw new Error(`Worktree does not exist: ${repoPath}`);
  const status = worktreeStatus(repoPath);
  if (!args.force && status.clean !== true) throw new Error(`Refusing to remove non-clean worktree ${name}: ${status.reason}`);
  const sizeKb = diskKb(repoPath);
  const result = execute("git", ["worktree", "remove", args.force ? "--force" : "", repoPath].filter(Boolean), {
    cwd: mainRepo,
    allowFailure: true,
  });
  if (result.status !== 0) {
    if (!args.force) throw new Error(result.stderr || result.stdout || `Unable to remove ${repoPath}`);
    removeDir(repoPath, { dryRun: false });
  }
  report.actions.push({ action: "removed-worktree", worktree: name, path: repoPath, freedKb: sizeKb });
  if (args.removeOutput) {
    const outputPath = path.join(outputsRoot, name);
    const outputKb = diskKb(outputPath);
    removeDir(outputPath, { dryRun: false });
    report.actions.push({ action: "removed-output", worktree: name, path: outputPath, freedKb: outputKb });
  }
}

if (args.warmStore) {
  if (!exists(path.join(mainRepo, "pnpm-lock.yaml"))) throw new Error(`Main OpenClaw repo is missing pnpm-lock.yaml: ${mainRepo}`);
  fs.mkdirSync(storePath, { recursive: true });
  execute("pnpm", ["--dir", mainRepo, "fetch", "--frozen-lockfile", "--store-dir", storePath]);
  report.actions.push({ action: "warmed-store", repo: mainRepo, store: storePath });
}

report.totals.trackedDependencyKb = report.totals.storeKb
  + report.repoDependencyDirs.reduce((sum, entry) => sum + entry.nodeModulesKb, 0)
  + report.worktrees.reduce((sum, entry) => sum + entry.nodeModulesKb, 0);
report.worktrees.sort((a, b) => b.nodeModulesKb - a.nodeModulesKb || a.name.localeCompare(b.name));
report.repoDependencyDirs.sort((a, b) => b.nodeModulesKb - a.nodeModulesKb || a.name.localeCompare(b.name));

if (args.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`OpenClaw workspace: ${root}\n`);
  process.stdout.write(`Tracked dependencies: ${formatBytesFromKb(report.totals.trackedDependencyKb)}  store: ${formatBytesFromKb(report.totals.storeKb)}  outputs: ${formatBytesFromKb(report.totals.outputsKb)}\n`);
  if (report.repoDependencyDirs.length > 0) {
    process.stdout.write("\nRepository node_modules:\n");
    for (const entry of report.repoDependencyDirs) {
      process.stdout.write(`  ${formatBytesFromKb(entry.nodeModulesKb).padStart(6)}  repos/${entry.name}\n`);
    }
  }
  process.stdout.write("\nLargest worktree node_modules:\n");
  for (const entry of report.worktrees.slice(0, 20)) {
    process.stdout.write(`  ${formatBytesFromKb(entry.nodeModulesKb).padStart(6)}  ${entry.name}  ${entry.status}  age=${entry.ageDays}d\n`);
  }
  if (report.outputsWithoutWorktree.length > 0) {
    process.stdout.write("\nOutputs without a matching worktree:\n");
    for (const entry of report.outputsWithoutWorktree) {
      process.stdout.write(`  ${formatBytesFromKb(entry.sizeKb).padStart(6)}  ${entry.name}\n`);
    }
  }
  if (report.actions.length > 0) {
    process.stdout.write("\nActions:\n");
    for (const action of report.actions) {
      const freed = action.freedKb ? ` freed=${formatBytesFromKb(action.freedKb)}` : "";
      process.stdout.write(`  ${action.action} ${action.worktree ?? action.store ?? ""}${freed}\n`);
    }
  }
}
