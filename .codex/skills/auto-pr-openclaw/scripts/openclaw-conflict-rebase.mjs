#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  currentBranch,
  currentHead,
  loadWorkflow,
  parseKeyArgs,
  readJson,
  run,
  writeJson,
} from "./lib/workflow-utils.mjs";

const HIGH_RISK = [
  /(^|\/)package\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /^\.github\//,
  /^packages\/plugin-sdk\//,
];

function usage() {
  return `Usage:
  openclaw-conflict-rebase.mjs --phase start --workflow PATH --target SHA
  openclaw-conflict-rebase.mjs --phase record --workflow PATH
  openclaw-conflict-rebase.mjs --phase finish --workflow PATH --plan PATH

The start phase pins the pre-rebase patch series and starts the rebase. If Git
stops on conflicts, resolve only the recorded files, run --phase record before
each rebase --continue when additional conflicts appear, then use --phase
finish. Finish rejects non-conflict patch drift and runs only the explicit,
focused validation commands in PLAN.`;
}

function git(repo, ...args) {
  return run("git", args, { cwd: repo }).stdout.trim();
}

function lines(value) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function statePath(context) {
  return path.join(context.outputPath, "conflict-rebase-state.json");
}

function receiptPath(context) {
  return path.join(context.outputPath, "conflict-resolution-check.json");
}

function normalizeRepoFile(file) {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe repository path: ${file}`);
  }
  return normalized;
}

function rebaseInProgress(repo) {
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const gitPath = git(repo, "rev-parse", "--git-path", name);
    if (fs.existsSync(path.resolve(repo, gitPath))) return true;
  }
  return false;
}

function unresolvedFiles(repo) {
  const result = run("git", ["diff", "--name-only", "--diff-filter=U"], {
    cwd: repo,
    allowFailure: true,
  });
  return lines(result.stdout).map(normalizeRepoFile);
}

function commits(repo, range) {
  const value = git(repo, "rev-list", "--reverse", range);
  return lines(value);
}

function stablePatchSeries(repo, range, excludedFiles = []) {
  const exclusions = excludedFiles.map((file) => `:(exclude)${file}`);
  const series = [];
  for (const commit of commits(repo, range)) {
    const parents = git(repo, "rev-list", "--parents", "-n", "1", commit).split(/\s+/);
    if (parents.length > 2) throw new Error(`Merge commit is not supported: ${commit}`);
    const shown = run("git", [
      "show", "--format=email", "--binary", "--no-ext-diff", "--no-renames",
      commit, "--", ".", ...exclusions,
    ], { cwd: repo });
    const patchId = run("git", ["patch-id", "--stable"], {
      cwd: repo,
      input: shown.stdout,
      allowFailure: true,
    });
    if (patchId.exitCode !== 0) {
      throw new Error(`git patch-id failed for ${commit}: ${patchId.stderr || patchId.stdout}`);
    }
    const id = patchId.stdout.trim().split(/\s+/)[0];
    if (id) series.push({ commit, patchId: id });
  }
  return series;
}

function mergeCommits(repo, range) {
  return lines(run("git", ["rev-list", "--reverse", "--merges", range], {
    cwd: repo,
    allowFailure: true,
  }).stdout);
}

function stableNetPatchId(repo, base, head, excludedFiles = []) {
  const exclusions = excludedFiles.map((file) => `:(exclude)${file}`);
  const diff = run("git", [
    "diff", "--binary", "--no-ext-diff", "--no-renames", base, head,
    "--", ".", ...exclusions,
  ], { cwd: repo });
  if (!diff.stdout.trim()) return "";
  const patchId = run("git", ["patch-id", "--stable"], {
    cwd: repo,
    input: diff.stdout,
    allowFailure: true,
  });
  if (patchId.exitCode !== 0) {
    throw new Error(`git patch-id failed for net diff ${base}..${head}: ${patchId.stderr || patchId.stdout}`);
  }
  return patchId.stdout.trim().split(/\s+/)[0] ?? "";
}

function surfaceFor(file) {
  const [first, second] = file.split("/");
  if (first === "extensions") return `${first}/${second ?? ""}`;
  if (first === "packages") return `${first}/${second ?? ""}`;
  if (["src", "apps", "scripts", "docs", ".github"].includes(first)) return first;
  return first || "root";
}

function generatedFile(file) {
  return /(^|\/)(generated|dist|build)\//.test(file)
    || /^extensions\/browser\/chrome-extension\/modules\/.*\.js$/.test(file);
}

function executePlanCommand(repo, item) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const result = spawnSync(item.command, item.args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  return {
    name: item.name,
    kind: item.kind,
    command: [item.command, ...item.args].join(" "),
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status ?? 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    stdout: (result.stdout ?? "").slice(-12000),
    stderr: (result.stderr ?? "").slice(-12000),
    error: result.error?.message ?? null,
  };
}

function validatePlan(plan, conflictFiles) {
  if (plan?.schemaVersion !== 1 || !Array.isArray(plan.commands) || plan.commands.length === 0) {
    throw new Error("Plan must have schemaVersion 1 and a non-empty commands array");
  }
  if (plan.commands.length > 8) throw new Error("Plan has more than 8 commands; use normal preflight");
  if (plan.allowedFiles !== undefined && (!Array.isArray(plan.allowedFiles)
    || plan.allowedFiles.some((file) => typeof file !== "string"))) {
    throw new Error("Plan allowedFiles must be an array of repository-relative paths");
  }
  const shellCommands = new Set(["sh", "bash", "zsh", "fish", "pwsh", "powershell"]);
  for (const item of plan.commands) {
    if (!item || typeof item.name !== "string" || !item.name.trim()) throw new Error("Every plan command needs a name");
    if (!["focused-test", "generated-rebuild", "boundary-check"].includes(item.kind)) {
      throw new Error(`Unsupported validation kind: ${item.kind}`);
    }
    if (typeof item.command !== "string" || !item.command.trim() || !Array.isArray(item.args)
      || item.args.some((arg) => typeof arg !== "string")) {
      throw new Error(`Invalid command definition for ${item.name}`);
    }
    if (shellCommands.has(path.basename(item.command).toLowerCase())) {
      throw new Error(`Shell interpreter commands are not allowed in the plan: ${item.command}`);
    }
  }
  const docsOnly = conflictFiles.every((file) => /\.(md|mdx|txt|rst)$/.test(file));
  if (!docsOnly && !plan.commands.some((item) => item.kind === "focused-test")) {
    throw new Error("A non-document conflict requires at least one focused-test command");
  }
  if (conflictFiles.some(generatedFile)
    && !plan.commands.some((item) => item.kind === "generated-rebuild")) {
    throw new Error("A generated-file conflict requires a generated-rebuild command");
  }
}

function baseReceipt(context, state) {
  return {
    schemaVersion: 1,
    status: "failed",
    workflowPath: context.workflowPath,
    repoPath: context.repoPath,
    branch: state.branch,
    originalHeadSha: state.originalHeadSha,
    originalBaseSha: state.originalBaseSha,
    targetSha: state.targetSha,
    conflictFiles: state.conflictFiles,
    generatedAt: new Date().toISOString(),
    blockers: [],
    commandResults: [],
  };
}

let args;
try {
  args = parseKeyArgs(process.argv.slice(2), {
    "--phase": { name: "phase" },
    "--workflow": { name: "workflow" },
    "--target": { name: "target" },
    "--plan": { name: "plan" },
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
if (!args.workflow || !["start", "record", "finish"].includes(args.phase)) {
  console.error("--workflow and --phase start|record|finish are required");
  console.error(usage());
  process.exit(2);
}

const context = loadWorkflow(args.workflow);
const stateFile = statePath(context);
const receiptFile = receiptPath(context);

try {
  if (!context.workflow.pr) throw new Error("Conflict-rebase mode is only for an existing PR workflow");

  if (args.phase === "start") {
    if (!args.target) throw new Error("--target is required for --phase start");
    if (rebaseInProgress(context.repoPath)) throw new Error("A rebase is already in progress");
    const status = git(context.repoPath, "status", "--porcelain");
    if (status) throw new Error(`Worktree must be clean before rebase:\n${status}`);
    const branch = currentBranch(context.repoPath);
    if (branch !== context.workflow.branch) {
      throw new Error(`Workflow branch mismatch: ${branch} vs ${context.workflow.branch}`);
    }
    const originalHeadSha = currentHead(context.repoPath);
    const targetSha = git(context.repoPath, "rev-parse", `${args.target}^{commit}`);
    const originalBaseSha = git(context.repoPath, "merge-base", originalHeadSha, targetSha);
    const originalRange = `${originalBaseSha}..${originalHeadSha}`;
    const originalMergeCommits = mergeCommits(context.repoPath, originalRange);
    const historyMode = originalMergeCommits.length > 0 ? "net-patch" : "patch-series";
    const originalPatchSeries = historyMode === "patch-series"
      ? stablePatchSeries(context.repoPath, originalRange)
      : [];
    const state = {
      schemaVersion: 1,
      status: "started",
      workflowPath: context.workflowPath,
      repoPath: context.repoPath,
      branch,
      originalHeadSha,
      originalBaseSha,
      targetSha,
      historyMode,
      originalMergeCommits,
      originalPatchSeries,
      conflictFiles: [],
      startedAt: new Date().toISOString(),
    };
    writeJson(stateFile, state);
    const rebase = run("git", ["rebase", targetSha], { cwd: context.repoPath, allowFailure: true });
    const conflicts = unresolvedFiles(context.repoPath);
    if (rebase.exitCode === 0) {
      state.status = "clean";
      state.headSha = currentHead(context.repoPath);
      state.finishedAt = new Date().toISOString();
      writeJson(stateFile, state);
      console.log(JSON.stringify({
        status: "clean",
        statePath: stateFile,
        next: "Use openclaw-rebase-only-check.mjs and the clean rebase-only publisher.",
      }, null, 2));
      process.exit(0);
    }
    if (!rebaseInProgress(context.repoPath) || conflicts.length === 0) {
      throw new Error(`Rebase failed without a resolvable conflict:\n${rebase.stderr || rebase.stdout}`);
    }
    state.status = "conflicted";
    state.conflictFiles = conflicts;
    state.lastRecordedAt = new Date().toISOString();
    writeJson(stateFile, state);
    console.error(JSON.stringify({
      status: "conflicted",
      statePath: stateFile,
      conflictFiles: conflicts,
      next: "Resolve only these files, record any later conflict stop, then run --phase finish.",
    }, null, 2));
    process.exit(1);
  }

  const state = readJson(stateFile);
  if (state.workflowPath !== context.workflowPath || state.repoPath !== context.repoPath) {
    throw new Error("Conflict-rebase state does not belong to this workflow");
  }

  if (args.phase === "record") {
    if (!rebaseInProgress(context.repoPath)) throw new Error("No rebase is in progress");
    const conflicts = unresolvedFiles(context.repoPath);
    if (conflicts.length === 0) throw new Error("No unresolved conflict files to record");
    state.conflictFiles = [...new Set([...state.conflictFiles, ...conflicts])].sort();
    state.status = "conflicted";
    state.lastRecordedAt = new Date().toISOString();
    writeJson(stateFile, state);
    console.log(JSON.stringify({ status: "recorded", conflictFiles: state.conflictFiles, statePath: stateFile }, null, 2));
    process.exit(0);
  }

  if (!args.plan) throw new Error("--plan is required for --phase finish");
  const receipt = baseReceipt(context, state);
  try {
    if (state.status === "clean") throw new Error("Clean rebases must use the rebase-only fast path");
    if (rebaseInProgress(context.repoPath)) throw new Error("Rebase is still in progress");
    if (currentBranch(context.repoPath) !== state.branch) throw new Error("Current branch changed since rebase start");
    if (git(context.repoPath, "status", "--porcelain")) throw new Error("Worktree must be clean before validation");
    const headSha = currentHead(context.repoPath);
    const targetAncestor = run("git", ["merge-base", "--is-ancestor", state.targetSha, headSha], {
      cwd: context.repoPath,
      allowFailure: true,
    });
    if (targetAncestor.exitCode !== 0) throw new Error("Pinned rebase target is not an ancestor of HEAD");
    const conflictFiles = [...new Set(state.conflictFiles.map(normalizeRepoFile))].sort();
    if (conflictFiles.length === 0) throw new Error("No conflict files were recorded");
    const plan = readJson(path.resolve(args.plan));
    if (plan.allowedFiles !== undefined && (!Array.isArray(plan.allowedFiles)
      || plan.allowedFiles.some((file) => typeof file !== "string"))) {
      throw new Error("Plan allowedFiles must be an array of repository-relative paths");
    }
    const allowedFiles = [...new Set(
      (plan.allowedFiles ?? []).map(normalizeRepoFile).filter((file) => !conflictFiles.includes(file)),
    )].sort();
    const resolutionFiles = [...new Set([...conflictFiles, ...allowedFiles])].sort();
    validatePlan(plan, resolutionFiles);
    if (resolutionFiles.length > 8) {
      throw new Error("More than 8 conflict/maintenance files requires explicit user approval for heavier validation");
    }
    const risky = resolutionFiles.filter((file) => HIGH_RISK.some((pattern) => pattern.test(file)));
    if (risky.length) {
      throw new Error(`High-risk conflict/maintenance files require explicit user approval for heavier validation: ${risky.join(", ")}`);
    }
    const surfaces = [...new Set(resolutionFiles.map(surfaceFor))];
    receipt.allowedMaintenanceFiles = allowedFiles;
    receipt.resolutionFiles = resolutionFiles;
    receipt.conflictSurfaces = surfaces;

    let before = [];
    let after = [];
    if (state.historyMode === "net-patch") {
      const beforeId = stableNetPatchId(
        context.repoPath,
        state.originalBaseSha,
        state.originalHeadSha,
        resolutionFiles,
      );
      const afterId = stableNetPatchId(context.repoPath, state.targetSha, headSha, resolutionFiles);
      if (beforeId !== afterId) {
        throw new Error("Patch outside conflict/maintenance files changed; stop before any heavier validation");
      }
      receipt.nonConflictNetPatchBefore = beforeId;
      receipt.nonConflictNetPatchAfter = afterId;
    } else {
      before = stablePatchSeries(
        context.repoPath,
        `${state.originalBaseSha}..${state.originalHeadSha}`,
        resolutionFiles,
      );
      after = stablePatchSeries(context.repoPath, `${state.targetSha}..${headSha}`, resolutionFiles);
      const beforeIds = before.map((item) => item.patchId);
      const afterIds = after.map((item) => item.patchId);
      if (JSON.stringify(beforeIds) !== JSON.stringify(afterIds)) {
        throw new Error("Patch series outside conflict/maintenance files changed; stop before any heavier validation");
      }
    }

    receipt.planPath = path.resolve(args.plan);
    receipt.planSha256 = sha256(JSON.stringify(plan));
    receipt.nonConflictPatchEquivalent = true;
    receipt.nonConflictEquivalenceMode = state.historyMode ?? "patch-series";
    receipt.nonConflictPatchSeriesBefore = before;
    receipt.nonConflictPatchSeriesAfter = after;
    receipt.headSha = headSha;
    for (const item of plan.commands) {
      const result = executePlanCommand(context.repoPath, item);
      receipt.commandResults.push(result);
      if (result.status !== "passed") throw new Error(`Focused validation failed: ${item.name}`);
    }
    if (git(context.repoPath, "status", "--porcelain")) {
      throw new Error("Focused validation changed the worktree; generated output is not current or deterministic");
    }
    const diffCheck = run("git", ["diff", "--check", `${state.targetSha}...${headSha}`, "--", ...resolutionFiles], {
      cwd: context.repoPath,
      allowFailure: true,
    });
    receipt.diffCheck = {
      status: diffCheck.exitCode === 0 ? "passed" : "failed",
      output: diffCheck.output.slice(-12000),
    };
    if (diffCheck.exitCode !== 0) throw new Error("git diff --check failed for conflict files");

    context.workflow.validationBaseSha = state.targetSha;
    context.workflow.baseSha = state.targetSha;
    context.workflow.rebaseTargetSha = state.targetSha;
    context.workflow.headSha = headSha;
    context.workflow.updatedAt = new Date().toISOString();
    writeJson(context.workflowPath, context.workflow);
    state.status = "validated";
    state.headSha = headSha;
    state.finishedAt = new Date().toISOString();
    writeJson(stateFile, state);
    receipt.status = "passed";
    receipt.finishedAt = new Date().toISOString();
    writeJson(receiptFile, receipt);
    console.log(JSON.stringify({
      status: "passed",
      receiptPath: receiptFile,
      headSha,
      conflictFiles,
      allowedMaintenanceFiles: receipt.allowedMaintenanceFiles,
      commands: receipt.commandResults.map(({ name, status, durationMs }) => ({ name, status, durationMs })),
      next: `Run openclaw-preflight.sh --workflow ${context.workflowPath} --profile conflict`,
    }, null, 2));
  } catch (error) {
    receipt.blockers.push(error.message);
    receipt.requiresExplicitHeavyValidationApproval = true;
    receipt.headSha = currentHead(context.repoPath);
    receipt.finishedAt = new Date().toISOString();
    writeJson(receiptFile, receipt);
    throw error;
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
