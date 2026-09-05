#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { validatePrBody } from "./lib/pr-body-validator.mjs";
import {
  commitIdentityProblems,
  identityCheckName,
  publicAccount,
  resolveAccount,
} from "./lib/account-utils.mjs";
import { resolveValidationProfile } from "./lib/validation-profile.mjs";
import { isDocumentationOnly } from "./lib/path-policy.mjs";
import {
  loadProjectProfile,
  projectDefaultBranch,
  projectValidationCommands,
  projectUsesCargo,
  projectUsesPnpm,
} from "../../../auto-pr-core/project-profile.mjs";

const preflightStartedAt = Date.now();
const phaseTiming = { networkMs: 0, gitMs: 0, validationMs: 0, otherMs: 0, processSpawns: 0 };
// Wall-clock tracking per phase. With overlapped lanes the per-category sums
// (phaseTiming) exceed elapsed time, so each category also tracks the union of
// its active intervals via a depth counter: the first enter stamps the start,
// the last exit settles the elapsed wall time.
const phaseWall = Object.fromEntries(
  ["networkMs", "gitMs", "validationMs", "otherMs"].map((key) => [key, { depth: 0, startedAt: 0, ms: 0 }]),
);

function phaseEnter(category) {
  const wall = phaseWall[category];
  if (!wall) return;
  if (wall.depth === 0) wall.startedAt = Date.now();
  wall.depth += 1;
}

function phaseExit(category) {
  const wall = phaseWall[category];
  if (!wall || wall.depth === 0) return;
  wall.depth -= 1;
  if (wall.depth === 0) wall.ms += Date.now() - wall.startedAt;
}

function finalizePhaseWall() {
  const now = Date.now();
  for (const wall of Object.values(phaseWall)) {
    if (wall.depth > 0) {
      wall.ms += now - wall.startedAt;
      wall.depth = 0;
    }
  }
}

function timingCategory(command, category) {
  if (category) return category;
  return command === "git" ? "gitMs" : "otherMs";
}

function parseArgs(argv) {
  const result = {
    workflow: "",
    profile: "auto",
    checkScript: "",
    testScript: "test:changed",
    typeScript: "",
    extraScripts: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workflow") result.workflow = argv[++index] ?? "";
    else if (arg === "--profile") result.profile = argv[++index] ?? "";
    else if (arg === "--check-script") result.checkScript = argv[++index] ?? "";
    else if (arg === "--test-script") result.testScript = argv[++index] ?? "";
    else if (arg === "--type-script") result.typeScript = argv[++index] ?? "";
    else if (arg === "--extra-script") result.extraScripts.push(argv[++index] ?? "");
    else if (arg === "-h" || arg === "--help") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["auto", "targeted", "focused", "iterate", "quick", "conflict", "fast", "changed", "full"].includes(result.profile)) {
    throw new Error("--profile must be auto, targeted, focused, iterate, quick, conflict, fast, changed, or full");
  }
  if (result.checkScript === "check" && result.profile !== "full") {
    throw new Error("pnpm check is a full-repository lane; use --profile full explicitly");
  }
  if (result.profile === "auto" && (
    result.checkScript || result.testScript !== "test:changed" || result.typeScript || result.extraScripts.length > 0
  )) {
    throw new Error("--profile auto cannot be combined with custom pnpm lanes; select a concrete profile first");
  }
  return result;
}

function configureProfile(result, changedFiles, project) {
  const requestedProfile = result.profile;
  result.profile = resolveValidationProfile(requestedProfile, changedFiles, project);
  if (result.profile === "targeted") {
    if (result.checkScript || result.testScript !== "test:changed" || result.typeScript || result.extraScripts.length > 0) {
      throw new Error("--profile targeted uses fixed changed-file lint/format, owning-project types, and focused tests");
    }
    result.checkScript = "";
  } else if (result.profile === "focused" || result.profile === "iterate") {
    if (result.checkScript || result.testScript !== "test:changed" || result.typeScript || result.extraScripts.length > 0) {
      throw new Error(`--profile ${result.profile} uses the fixed focused changed-test lane; do not combine it with custom lanes`);
    }
    result.checkScript = "";
  } else if (result.profile === "quick" || result.profile === "conflict") {
    if (result.checkScript || result.testScript !== "test:changed" || result.typeScript || result.extraScripts.length > 0) {
      throw new Error(`--profile ${result.profile} cannot be combined with pnpm check, test, type, or extra lanes`);
    }
    result.checkScript = "";
    result.testScript = "";
  } else if (result.profile === "fast") {
    if (result.checkScript || result.testScript !== "test:changed" || result.typeScript || result.extraScripts.length > 0) {
      throw new Error("--profile fast uses fixed lint, prod type, and test type lanes; do not combine it with custom lanes");
    }
    result.checkScript = "lint";
    result.testScript = "";
    result.typeScript = "tsgo:prod";
    result.extraScripts = ["check:test-types"];
  } else if (result.profile === "full") {
    if (result.checkScript && result.checkScript !== "check") {
      throw new Error("--profile full cannot be combined with a non-check --check-script");
    }
    result.checkScript = "check";
  } else {
    result.checkScript ||= "check:changed";
    if (result.checkScript === "check") {
      throw new Error("pnpm check is a full-repository lane; use --profile full explicitly");
    }
  }
  return requestedProfile;
}

function usage() {
  return [
    "Usage: openclaw-preflight.sh --workflow PATH [options]",
    "",
    "Runs deterministic OpenClaw checks and writes preflight.json next to workflow.json.",
    "",
    "Options:",
    "  --workflow PATH       Workflow JSON to validate (required).",
    "  --profile PROFILE     auto (default), targeted, focused, quick, conflict, changed, fast, or full.",
    "  --check-script NAME   Override the check lane for the changed profile.",
    "  --test-script NAME    Override the focused test lane (default: test:changed).",
    "  --type-script NAME    Add an optional type-check lane.",
    "  --extra-script NAME   Add a pnpm lane; may be repeated.",
    "  -h, --help            Show this help and exit.",
    "",
    "Profiles:",
    "  auto     Select quick for documentation-only diffs, targeted for ordinary",
    "           single-surface code diffs,",
    "           and changed for high-risk, cross-surface, or unknown paths.",
    "  targeted Run changed-file format/lint and owning-project types in parallel,",
    "           then run focused affected tests.",
    "  focused  Run focused changed tests only.",
    "  iterate  Alias for focused, kept for older edit-loop commands.",
    "  quick    Run Git, identity, PR-body/proof, and merge-risk gates only.",
    "  conflict Require a current conflict-resolution receipt, then run only the",
    "           deterministic Git, identity, PR-body/proof, and merge-risk gates.",
    "  changed  Optional heavier lane: run pnpm check:changed and focused changed tests.",
    "  fast     Run full lint, production types, and test types; despite its name,",
    "           this can be slower than changed on a large repository.",
    "  full     Run the full-repository pnpm check plus focused changed tests.",
    "",
    "Examples:",
    "  openclaw-preflight.sh --workflow outputs/issue-123/workflow.json",
    "  openclaw-preflight.sh --workflow outputs/issue-123/workflow.json --profile targeted",
    "  openclaw-preflight.sh --workflow outputs/issue-123/workflow.json --profile focused",
    "  openclaw-preflight.sh --workflow outputs/issue-123/workflow.json --profile quick",
    "  openclaw-preflight.sh --workflow outputs/pr-123/workflow.json --profile conflict",
    "  openclaw-preflight.sh --workflow outputs/issue-123/workflow.json --profile changed",
  ].join("\n");
}

function run(command, args, cwd, options = {}) {
  const { category, captureFullOutput, ...spawnOptions } = options;
  const resolvedCategory = timingCategory(command, category);
  const startedAt = new Date().toISOString();
  const start = Date.now();
  phaseEnter(resolvedCategory);
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    ...spawnOptions,
  });
  const durationMs = Date.now() - start;
  phaseExit(resolvedCategory);
  phaseTiming[resolvedCategory] += durationMs;
  phaseTiming.processSpawns += 1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = `${stdout}${stderr}`;
  const resultShape = {
    command: [command, ...args].join(" "),
    exitCode: result.status ?? 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs,
    stdout: stdout.slice(-12000),
    stderr: stderr.slice(-12000),
    output: output.slice(-12000),
    error: result.error?.message ?? null,
  };
  if (captureFullOutput) resultShape.fullOutput = output;
  return resultShape;
}

// Start a child process without blocking the main thread, run other work, then
// wait() for the result. A worker thread performs the blocking spawnSync while
// the main thread keeps executing the synchronous preflight flow; the join is
// an Atomics.wait on a shared flag plus a result file, because the main thread
// must stay synchronous. Used to overlap the network-bound git fetch with
// local git reads.
let asyncRunCounter = 0;
function startAsyncRun(command, args, cwd, options = {}) {
  const { category, ...spawnOptions } = options;
  const resolvedCategory = timingCategory(command, category);
  const startedAt = new Date().toISOString();
  const start = Date.now();
  phaseEnter(resolvedCategory);
  const resultFile = path.join(os.tmpdir(), `auto-pr-preflight-${process.pid}-${Date.now()}-${asyncRunCounter += 1}.json`);
  const shared = new Int32Array(new SharedArrayBuffer(8));
  const workerSource = `
    const { workerData, parentPort } = require("node:worker_threads");
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const resultTemplate = (overrides) => ({
      command: [workerData.command, ...workerData.args].join(" "),
      exitCode: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      stdout: "",
      stderr: "",
      output: "",
      error: null,
      ...overrides,
    });
    const finish = (overrides) => {
      if (workerData.shared[0] === 1) return;
      try {
        writeFileSync(workerData.resultFile, JSON.stringify(resultTemplate(overrides)));
      } catch {}
      Atomics.store(workerData.shared, 0, 1);
      Atomics.notify(workerData.shared, 0);
    };
    try {
      const start = Date.now();
      const child = spawn(workerData.command, workerData.args, {
        cwd: workerData.cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        ...workerData.spawnOptions,
      });
      const stdoutChunks = [];
      const stderrChunks = [];
      let collected = 0;
      const collectedCap = 1024 * 1024;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (collected < collectedCap) {
          stdoutChunks.push(chunk);
          collected += chunk.length;
        }
      });
      child.stderr.on("data", (chunk) => {
        if (collected < collectedCap) {
          stderrChunks.push(chunk);
          collected += chunk.length;
        }
      });
      parentPort.on("message", (message) => {
        if (message !== "abort") return;
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
          else child.kill("SIGTERM");
        } catch {
          try { child.kill("SIGTERM"); } catch {}
        }
      });
      let settled = false;
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        const stdout = stdoutChunks.join("");
        const stderr = stderrChunks.join("");
        finish({
          exitCode: code ?? 1,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - start,
          stdout: stdout.slice(-12000),
          stderr: stderr.slice(-12000),
          output: (stdout + stderr).slice(-12000),
          fullOutput: stdout + stderr,
        });
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        finish({
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - start,
          error: error?.message ?? "spawn failure",
        });
      });
    } catch (error) {
      finish({ error: error?.message ?? "worker failure" });
    }
  `;
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: { command, args, cwd, spawnOptions, resultFile, shared },
  });
  const commandText = [command, ...args].join(" ");
  return {
    command: commandText,
    abort() {
      try {
        worker.postMessage("abort");
      } catch {}
    },
    wait(timeoutMs = 600000) {
      const deadline = start + timeoutMs;
      while (Atomics.load(shared, 0) !== 1 && Date.now() < deadline) {
        Atomics.wait(shared, 0, 0, 50);
      }
      const timedOut = Atomics.load(shared, 0) !== 1;
      if (timedOut) {
        this.abort();
        const graceDeadline = Date.now() + 5000;
        while (Atomics.load(shared, 0) !== 1 && Date.now() < graceDeadline) {
          Atomics.wait(shared, 0, 0, 50);
        }
        if (Atomics.load(shared, 0) !== 1) worker.terminate();
      }
      worker.unref();
      let result;
      try {
        result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
      } catch {
        result = {
          command: commandText,
          exitCode: 1,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - start,
          stdout: "",
          stderr: "",
          output: "",
          error: timedOut ? `timed out after ${timeoutMs}ms` : "async runner produced no result",
        };
      }
      try {
        fs.rmSync(resultFile, { force: true });
      } catch {}
      phaseExit(resolvedCategory);
      phaseTiming[resolvedCategory] += result.durationMs ?? Date.now() - start;
      phaseTiming.processSpawns += 1;
      return result;
    },
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

function advisoryCheck(name, details) {
  return {
    name,
    status: "advisory",
    command: null,
    exitCode: 0,
    details,
  };
}

function skippedCheck(name, details) {
  return {
    name,
    status: "skipped",
    command: null,
    exitCode: null,
    details,
  };
}

function lines(value) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function filesUnderPrefixes(files, prefixes) {
  return files.filter((file) => prefixes.some((prefix) => file === prefix || file.startsWith(prefix)));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileSha256(file) {
  return fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
}

function dependencyFingerprint(repo) {
  const hash = crypto.createHash("sha256");
  for (const name of ["package.json", "pnpm-lock.yaml"]) {
    const file = path.join(repo, name);
    hash.update(name);
    hash.update("\0");
    if (fs.existsSync(file)) hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readJsonIfPresent(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// pnpm CLI cold starts cost hundreds of milliseconds per invocation. Version
// and store resolution only change with toolchain/config edits, so cache them
// on disk for a day and fall back to a live run on any doubt.
function toolCachePathForRoot(rootDir) {
  return path.join(rootDir, "outputs", ".preflight-tool-cache.json");
}

function readToolCache(rootDir) {
  return readJsonIfPresent(toolCachePathForRoot(rootDir)) ?? {};
}

function writeToolCache(rootDir, cache) {
  try {
    fs.mkdirSync(path.dirname(toolCachePathForRoot(rootDir)), { recursive: true });
    fs.writeFileSync(toolCachePathForRoot(rootDir), `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  } catch {
    // Cache writes are best-effort; never fail preflight over a cache file.
  }
}

function cachedPnpmVersion(rootDir, repo) {
  const ttlMs = 24 * 60 * 60 * 1000;
  const cache = readToolCache(rootDir);
  if (cache.pnpmVersion?.version && Date.now() - Date.parse(cache.pnpmVersion.at) < ttlMs) {
    return cache.pnpmVersion.version;
  }
  const result = run("pnpm", ["--version"], repo);
  const version = result.exitCode === 0 ? result.stdout.trim() : "";
  if (version) {
    writeToolCache(rootDir, { ...cache, pnpmVersion: { version, at: new Date().toISOString() } });
  }
  return version;
}

function cachedPnpmStorePath(rootDir, repo, expectedStore) {
  const ttlMs = 24 * 60 * 60 * 1000;
  const cache = readToolCache(rootDir);
  const key = `${repo}|${expectedStore}`;
  const entry = cache.pnpmStorePaths?.[key];
  if (entry?.storePath && Date.now() - Date.parse(entry.at) < ttlMs) {
    return { storePath: entry.storePath, cached: true };
  }
  const storeResult = run("pnpm", ["--dir", repo, "store", "path", "--store-dir", expectedStore], repo);
  if (storeResult.exitCode !== 0) return { storeResult, cached: false };
  const reported = storeResult.stdout.split("\n").filter(Boolean).at(-1) ?? "";
  const storePath = reported ? path.resolve(reported) : "";
  if (storePath) {
    writeToolCache(rootDir, {
      ...cache,
      pnpmStorePaths: {
        ...cache.pnpmStorePaths,
        [key]: { storePath, at: new Date().toISOString() },
      },
    });
  }
  return { storeResult, storePath, cached: false };
}

function cacheFileForPreflight(preflightPath) {
  return path.join(path.dirname(preflightPath), "preflight-cache.json");
}

function cachedCommandCheck(check, fingerprint) {
  return {
    ...check,
    durationMs: 0,
    cachedDurationMs: check.cachedDurationMs ?? check.durationMs ?? null,
    cached: true,
    cacheFingerprint: fingerprint,
    reusedAt: new Date().toISOString(),
  };
}

function readCachedHeavyChecks(previousReceipt, cache, fingerprint) {
  if (previousReceipt?.heavyFingerprint === fingerprint &&
    Array.isArray(previousReceipt.heavyChecks) &&
    previousReceipt.heavyChecks.length > 0 &&
    previousReceipt.heavyChecks.every((check) => check.status === "passed")) {
    return previousReceipt.heavyChecks.map((check) => cachedCommandCheck(check, fingerprint));
  }

  const cached = cache?.heavyChecksByFingerprint?.[fingerprint];
  if (Array.isArray(cached) && cached.length > 0 && cached.every((check) => check.status === "passed")) {
    return cached.map((check) => cachedCommandCheck(check, fingerprint));
  }

  return null;
}

function readCachedFocusedTest(cache, fingerprint) {
  const cached = cache?.focusedTestsByFingerprint?.[fingerprint];
  if (cached?.status === "passed") {
    return cachedCommandCheck(cached, fingerprint);
  }
  return null;
}

function readCachedValidationCheck(cache, fingerprint) {
  const cached = cache?.validationChecksByFingerprint?.[fingerprint];
  if (cached?.status === "passed") {
    return cachedCommandCheck(cached, fingerprint);
  }
  return null;
}

function storeCommandCheck(check) {
  const {
    cached: _cached,
    cacheFingerprint: _cacheFingerprint,
    reusedAt: _reusedAt,
    stdout: _stdout,
    stderr: _stderr,
    ...stored
  } = check;
  if (typeof stored.output === "string") stored.output = stored.output.slice(-4000);
  if (stored.cachedDurationMs != null) {
    stored.durationMs = stored.cachedDurationMs;
    delete stored.cachedDurationMs;
  }
  return stored;
}

function receiptCheck(check, { includeOutput = true } = {}) {
  const {
    stdout: _stdout,
    stderr: _stderr,
    output: rawOutput,
    ...summary
  } = check;
  if (includeOutput && typeof rawOutput === "string" && rawOutput.length > 0) {
    summary.output = rawOutput.slice(-4000);
  }
  return summary;
}

function pruneCacheEntries(entries, limit = 32) {
  return Object.fromEntries(Object.entries(entries).slice(-limit));
}

function commandCheck(name, result) {
  return {
    name,
    status: result.exitCode === 0 ? "passed" : "failed",
    ...result,
  };
}

function failureSlug(name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 60) || "failed-check";
}

function failureSummaryFromOutput(output) {
  const lines = output.split("\n");
  const markerLines = lines
    .filter((line) => /(^|\s)(FAIL|FAILED|✗|×)\b|AssertionError|expect\(|Error:|error TS\d/.test(line))
    .slice(0, 20);
  const files = [...new Set(
    lines.flatMap((line) => line.match(/[A-Za-z0-9_@./-]+\.(?:mts|ts|tsx|mjs|js|jsx)/g) ?? []),
  )].slice(0, 20);
  return { markerLines, files };
}

// Failed heavy lanes lose their output in the receipt (it only keeps the last
// 4 KB, and heavy checks opt out entirely), which forces diagnosis to re-run
// the whole lane. Persist the full captured output to the issue's output
// directory once, and point the receipt at it.
function persistFailedCheckArtifacts(checks, repo, outputDir) {
  for (const check of checks) {
    if (check.status !== "failed" || typeof check.command !== "string") continue;
    const full = typeof check.fullOutput === "string" && check.fullOutput.length > 0
      ? check.fullOutput
      : check.output;
    if (typeof full !== "string" || full.length === 0) continue;
    const logPath = path.join(outputDir, `${failureSlug(check.name)}.failed.log`);
    try {
      fs.writeFileSync(logPath, full, "utf8");
      check.logPath = logPath;
      check.failureSummary = failureSummaryFromOutput(full);
      check.repro = { command: check.command, cwd: repo };
    } catch {}
  }
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

// Default the upstream heavy-check lock to worktree scope so parallel PR
// worktrees do not serialize their tsgo/oxlint lanes on one shared .git lock.
// Set OPENCLAW_HEAVY_CHECK_LOCK_SCOPE=shared explicitly to restore the
// upstream single-lock behavior when heavy lanes must stay serialized.
process.env.OPENCLAW_HEAVY_CHECK_LOCK_SCOPE ??= "worktree";
if (!args.workflow) {
  console.error("--workflow is required");
  process.exit(2);
}

const workflowPath = path.resolve(args.workflow);
const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
const project = loadProjectProfile(workflow.projectConfigPath || workflow.projectId || "openclaw");
const account = resolveAccount({ workflow });
const repo = path.resolve(workflow.repoPath);
const root = path.resolve(workflow.root);
const outputPath = path.resolve(workflow.outputPath);
const preflightPath = path.resolve(workflow.preflightPath);
const cachePath = cacheFileForPreflight(preflightPath);
const previousReceipt = readJsonIfPresent(preflightPath);
const preflightCache = readJsonIfPresent(cachePath) ?? {};
const checks = [];
let heavyChecks = [];
let heavyFingerprint = "";
let checkLaneFingerprint = "";
let cacheHit = false;
let primaryValidationCheck = null;
let freshness = null;
const targetedCheckScript = path.join(path.dirname(path.resolve(process.argv[1])), "openclaw-targeted-check.mjs");
const targetedPlanScript = path.join(path.dirname(targetedCheckScript), "lib", "targeted-validation.mjs");

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
if (args.profile === "conflict") {
  checks.push(skippedCheck(
    "dependency environment",
    "validated by the focused conflict-resolution receipt; preflight will not repeat dependency checks",
  ));
} else if (projectUsesPnpm(project)) {
  checks.push(staticCheck(
    "dependencies installed",
    workflow.dependencies?.status === "installed" && fs.existsSync(path.join(repo, "node_modules", ".modules.yaml")),
    workflow.dependencies?.status === "installed"
      ? fs.existsSync(path.join(repo, "node_modules", ".modules.yaml")) ? "installed" : "node_modules/.modules.yaml is missing"
      : `not installed: ${workflow.dependencies?.skipReason ?? "no reason recorded"}`,
  ));
  const expectedStore = path.resolve(workflow.pnpmStorePath);
  const storeLookup = cachedPnpmStorePath(root, repo, expectedStore);
  const storeResult = storeLookup.cached ? null : storeLookup.storeResult;
  const actualStore = storeLookup.cached
    ? storeLookup.storePath
    : storeResult.stdout.split("\n").filter(Boolean).at(-1) ?? "";
  const resolvedActualStore = actualStore ? path.resolve(actualStore) : "";
  checks.push(staticCheck(
    "shared pnpm store",
    storeLookup.cached
      ? true
      : storeResult.exitCode === 0 && (resolvedActualStore === expectedStore || resolvedActualStore.startsWith(`${expectedStore}${path.sep}`)),
    storeLookup.cached
      ? `cached pnpm store resolution: root=${expectedStore} actual=${resolvedActualStore}`
      : storeResult.exitCode === 0 ? `root=${expectedStore} actual=${resolvedActualStore}` : storeResult.error || storeResult.output,
  ));
  const modulesPath = path.join(repo, "node_modules", ".modules.yaml");
  let modulesStore = "";
  if (fs.existsSync(modulesPath)) {
    const modulesMetadata = fs.readFileSync(modulesPath, "utf8");
    try {
      const parsed = JSON.parse(modulesMetadata);
      modulesStore = typeof parsed.storeDir === "string" ? parsed.storeDir : "";
    } catch {
      modulesStore = modulesMetadata.match(/^storeDir:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? "";
    }
  }
  const resolvedModulesStore = modulesStore ? path.resolve(repo, modulesStore) : "";
  checks.push(staticCheck(
    "node_modules uses shared store",
    Boolean(resolvedModulesStore) && (
      resolvedModulesStore === expectedStore || resolvedModulesStore.startsWith(`${expectedStore}${path.sep}`)
    ),
    resolvedModulesStore || "node_modules/.modules.yaml has no storeDir",
  ));
  const dependencyMarker = path.join(repo, "node_modules", ".auto-pr-deps-fingerprint");
  if (fs.existsSync(dependencyMarker)) {
    const installedFingerprint = fs.readFileSync(dependencyMarker, "utf8").trim();
    const expectedFingerprint = dependencyFingerprint(repo);
    checks.push(staticCheck(
      "dependency fingerprint",
      installedFingerprint === expectedFingerprint,
      installedFingerprint === expectedFingerprint
        ? expectedFingerprint
        : `stale node_modules fingerprint: installed=${installedFingerprint} expected=${expectedFingerprint}`,
    ));
  } else {
    checks.push(advisoryCheck(
      "dependency fingerprint",
      "legacy node_modules has no dependency fingerprint; run ensure-openclaw-deps.sh once to enable lockfile-aware reuse",
    ));
  }
} else if (projectUsesCargo(project)) {
  const cargoResult = run("cargo", ["metadata", "--no-deps", "--format-version", "1"], repo);
  checks.push(staticCheck(
    "Cargo workspace available",
    cargoResult.exitCode === 0,
    cargoResult.exitCode === 0 ? "cargo metadata succeeded" : cargoResult.error || cargoResult.output,
  ));
  checks.push(staticCheck(
    "dependency setup recorded",
    workflow.dependencies?.status === "installed" || workflow.dependencies?.status === "skipped",
    workflow.dependencies?.status === "installed"
      ? "cargo dependencies fetched"
      : `skipped: ${workflow.dependencies?.skipReason ?? "no reason recorded"}`,
  ));
}

const defaultBranch = projectDefaultBranch(project);
// Overlap the network-bound fetch with the local git reads below. The fetch
// result is only consumed at the join point, so nothing reads a half-updated
// snapshot. OPENCLAW_PREFLIGHT_FETCH_TTL_MS (default 0 = always fetch) reuses a
// recent snapshot when iterating quickly; freshness stays advisory either way.
const fetchTtlMs = Math.max(0, Number(process.env.OPENCLAW_PREFLIGHT_FETCH_TTL_MS ?? "0"));
const fetchStatePath = path.join(root, "outputs", ".preflight-fetch-state.json");
const fetchState = fetchTtlMs > 0 ? readJsonIfPresent(fetchStatePath) : null;
const fetchStateAgeMs = fetchState?.fetchedAt
  ? Date.now() - Date.parse(fetchState.fetchedAt)
  : Number.POSITIVE_INFINITY;
const fetchStateUsable = fetchState?.defaultBranch === defaultBranch && fetchStateAgeMs < fetchTtlMs;
const fetchCheckName = `fetch latest origin/${defaultBranch} snapshot`;
let fetchHandle = null;
if (fetchStateUsable) {
  checks.push(skippedCheck(
    fetchCheckName,
    `reused origin/${defaultBranch} snapshot fetched ${Math.round(fetchStateAgeMs / 1000)}s ago (OPENCLAW_PREFLIGHT_FETCH_TTL_MS=${fetchTtlMs})`,
  ));
} else {
  fetchHandle = startAsyncRun("git", ["fetch", "origin", defaultBranch], repo, { category: "networkMs" });
}

let headSha = "";
let headTreeSha = "";
let validationBaseSha = workflow.validationBaseSha || workflow.baseSha || "";
let latestMainSha = "";
let branch = "";
let status = "";
let changedFiles = [];
let requestedProfile = args.profile;
let focusedTestFingerprint = "";
let conflictReceipt = null;
try {
  if (!validationBaseSha) throw new Error("workflow has no pinned validation base SHA");
  const [headShaResolved, validationBaseResolved, headTreeResolved] = git(
    repo,
    "rev-parse",
    "HEAD",
    `${validationBaseSha}^{commit}`,
    "HEAD^{tree}",
  ).split("\n");
  headSha = headShaResolved;
  headTreeSha = headTreeResolved;
  validationBaseSha = validationBaseResolved;
  // --branch folds the current-branch read into the same spawn as the status
  // listing; the branch line is "## <branch>..." and detached heads need the
  // separate fallback read.
  const statusOutput = git(repo, "status", "--porcelain", "--branch");
  const statusEntries = statusOutput.split("\n").filter((line) => line.length > 0);
  const branchHeader = statusEntries.find((line) => line.startsWith("## ")) ?? "";
  branch = /^## (?!HEAD\b)[^.\s[\]]+/.exec(branchHeader)?.[0].slice(3) ?? "";
  if (!branch) branch = git(repo, "branch", "--show-current");
  status = statusEntries.filter((line) => !line.startsWith("## ")).join("\n");
  checks.push(staticCheck("workflow branch matches", branch === workflow.branch, `${branch} vs ${workflow.branch}`));
  checks.push(staticCheck("working tree clean", status.length === 0, status || "clean"));

  const validationMergeBase = git(repo, "merge-base", headSha, validationBaseSha);
  changedFiles = lines(git(repo, "diff", "--name-only", `${validationBaseSha}...${headSha}`));
  checks.push(staticCheck(
    "committed diff exists",
    changedFiles.length > 0,
    changedFiles.join("\n") || "no committed changes beyond the pinned validation base",
  ));

  const commits = git(repo, "log", "--format=%H%x09%an%x09%ae%x09%cn%x09%ce", `${validationMergeBase}..HEAD`);
  const identities = commits
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, authorName, authorEmail, committerName, committerEmail] = line.split("\t");
      return { sha, authorName, authorEmail, committerName, committerEmail };
    });
  const identityProblems = commitIdentityProblems(identities, account);
  checks.push(staticCheck(
    identityCheckName(account),
    identityProblems.length === 0,
    identityProblems.join("; ") || "ok",
  ));

  // Join the overlapped fetch here; everything below consumes origin/main.
  if (fetchHandle) {
    const fetchResult = fetchHandle.wait();
    checks.push(commandCheck(fetchCheckName, fetchResult));
    if (fetchResult.exitCode !== 0) {
      throw new Error(`latest origin/${defaultBranch} snapshot is unavailable`);
    }
    if (fetchTtlMs > 0) {
      try {
        fs.writeFileSync(
          fetchStatePath,
          `${JSON.stringify({ defaultBranch, fetchedAt: new Date().toISOString() }, null, 2)}\n`,
          "utf8",
        );
      } catch {
        // Fetch-state bookkeeping is best-effort.
      }
    }
  }
  latestMainSha = git(repo, "rev-parse", `refs/remotes/origin/${defaultBranch}^{commit}`);
  const latestMergeBase = git(repo, "merge-base", headSha, latestMainSha);
  const containsLatestMain = latestMergeBase === latestMainSha;
  const baseAncestorResult = run("git", ["merge-base", "--is-ancestor", validationBaseSha, latestMainSha], repo);
  const upstreamDiffBase = baseAncestorResult.exitCode === 0
    ? validationBaseSha
    : git(repo, "merge-base", validationBaseSha, latestMainSha);
  const upstreamChangedFiles = validationBaseSha === latestMainSha
    ? []
    : lines(git(repo, "diff", "--name-only", `${upstreamDiffBase}..${latestMainSha}`));
  const changedFileSet = new Set(changedFiles);
  const overlappingFiles = upstreamChangedFiles.filter((file) => changedFileSet.has(file));
  const behindBy = validationBaseSha === latestMainSha
    ? 0
    : Number(git(repo, "rev-list", "--count", `${upstreamDiffBase}..${latestMainSha}`));

  const mergeTree = run("git", ["merge-tree", "--write-tree", headSha, latestMainSha], repo);
  const mergeConflict = mergeTree.exitCode === 1;
  checks.push(staticCheck(
    `merge compatibility with observed origin/${defaultBranch}`,
    mergeTree.exitCode === 0,
    mergeConflict
      ? `conflict against observed origin/${defaultBranch} ${latestMainSha}: ${mergeTree.output || "merge-tree reported a conflict"}`
      : mergeTree.exitCode === 0
        ? `clean against observed origin/${defaultBranch} ${latestMainSha}`
        : `unable to evaluate merge compatibility: ${mergeTree.output || mergeTree.error}`,
  ));

  if (validationBaseSha === latestMainSha) {
    checks.push(staticCheck("upstream drift since validation base", true, `origin/${defaultBranch} has not advanced`));
  } else {
    checks.push(advisoryCheck(
      "upstream drift since validation base",
      [
        `validationBase=${validationBaseSha}`,
        `latestObservedMain=${latestMainSha}`,
        `behindBy=${behindBy}`,
        `overlap=${overlappingFiles.length ? overlappingFiles.join(",") : "none"}`,
        `${defaultBranch} advancement alone does not invalidate validation or require a rebase`,
      ].join(" "),
    ));
  }
  if (!containsLatestMain) {
    checks.push(advisoryCheck(
      "branch freshness",
      `branch does not contain observed origin/${defaultBranch} ${latestMainSha}; rebase only for conflicts, risky overlap, or an explicit up-to-date requirement`,
    ));
  } else {
    checks.push(staticCheck("branch freshness", true, `branch contains observed origin/${defaultBranch} ${latestMainSha}`));
  }
  freshness = {
    validationBaseSha,
    latestObservedMainSha: latestMainSha,
    observedAt: new Date().toISOString(),
    behindBy,
    containsLatestMain,
    validationBaseIsAncestorOfLatest: baseAncestorResult.exitCode === 0,
    upstreamChangedFileCount: upstreamChangedFiles.length,
    overlappingFiles,
    mergeConflict,
  };
} catch (error) {
  if (fetchHandle) {
    const abandonedFetch = fetchHandle.wait();
    if (!checks.some((check) => check.name === fetchCheckName)) {
      checks.push(commandCheck(fetchCheckName, abandonedFetch));
    }
  }
  checks.push(staticCheck("git repository state", false, error.message));
}

try {
  requestedProfile = configureProfile(args, changedFiles, project);
  checks.push(staticCheck(
    "validation profile selection",
    true,
    requestedProfile === args.profile
      ? args.profile
      : `${requestedProfile} -> ${args.profile} (${args.profile === "quick"
        ? "documentation-only diff"
        : args.profile === "targeted"
          ? "ordinary single-surface code diff"
          : "high-risk, cross-surface, or unknown diff"})`,
  ));
} catch (error) {
  checks.push(staticCheck("validation profile selection", false, error.message));
}
if (args.profile === "conflict") {
  const conflictReceiptPath = path.join(outputPath, "conflict-resolution-check.json");
  conflictReceipt = readJsonIfPresent(conflictReceiptPath);
  const problems = [];
  if (!conflictReceipt) {
    problems.push("receipt is missing or invalid JSON");
  } else {
    if (!workflow.pr) problems.push("conflict profile is only valid for an existing PR");
    if (conflictReceipt.status !== "passed") problems.push(`status=${conflictReceipt.status ?? "missing"}`);
    if (conflictReceipt.workflowPath !== workflowPath) problems.push("workflow path mismatch");
    if (conflictReceipt.repoPath !== repo) problems.push("repository path mismatch");
    if (conflictReceipt.headSha !== headSha) problems.push("HEAD mismatch");
    if (conflictReceipt.targetSha !== validationBaseSha) problems.push("validation base mismatch");
    if (conflictReceipt.branch !== branch) problems.push("branch mismatch");
    if (conflictReceipt.nonConflictPatchEquivalent !== true) problems.push("non-conflict patch equivalence is not proven");
    if (!Array.isArray(conflictReceipt.commandResults)
      || conflictReceipt.commandResults.length === 0
      || conflictReceipt.commandResults.some((result) => result.status !== "passed")) {
      problems.push("focused validation commands are missing or failed");
    }
  }
  checks.push(staticCheck(
    "conflict resolution receipt",
    problems.length === 0,
    problems.join("; ") || conflictReceiptPath,
  ));
}
const checkScript = args.checkScript;

if (validationBaseSha) {
  checks.push(commandCheck("git diff check", run("git", ["diff", "--check", `${validationBaseSha}...HEAD`], repo)));
}

try {
  const bodyResult = validatePrBody({
    bodyPath: workflow.prBodyPath,
    issue: workflow.issue,
    pr: workflow.pr,
    requireIssueLink: Number.isSafeInteger(workflow.issue) && workflow.issue > 0,
    repoPath: repo,
    baseRef: validationBaseSha || workflow.baseRef,
    changedFiles,
    project,
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

if (project.id === "zeroclaw" && workflow.mode === "new-issue") {
  const intakePath = path.resolve(workflow.intakePath || path.join(outputPath, "intake.json"));
  const intake = readJsonIfPresent(intakePath);
  const intakeProblems = [];
  if (!intake) intakeProblems.push(`missing intake receipt: ${intakePath}`);
  else {
    if (intake.kind !== "zeroclaw-intake") intakeProblems.push("intake receipt kind is invalid");
    if (intake.issue?.number !== workflow.issue) intakeProblems.push("intake issue does not match workflow issue");
    if (intake.targetBranch !== defaultBranch) intakeProblems.push(`intake target branch is not ${defaultBranch}`);
    if (intake.untrustedGithubInput !== true) intakeProblems.push("intake receipt does not record untrusted GitHub input handling");
    if ((intake.blockers ?? []).length > 0) intakeProblems.push(...intake.blockers);
  }
  checks.push(staticCheck("ZeroClaw issue intake", intakeProblems.length === 0, intakeProblems.join("; ") || intakePath));
  workflow.intakePath = intakePath;
}

if (project.id === "zeroclaw" && workflow.mode === "existing-pr") {
  const reviewIntakePath = path.resolve(workflow.reviewIntakePath || path.join(outputPath, "review-intake.json"));
  const reviewIntake = readJsonIfPresent(reviewIntakePath);
  const reviewProblems = [];
  if (!reviewIntake) reviewProblems.push(`missing review intake receipt: ${reviewIntakePath}`);
  else {
    if (reviewIntake.kind !== "zeroclaw-review-intake") reviewProblems.push("review intake receipt kind is invalid");
    if (reviewIntake.pr?.number !== workflow.pr) reviewProblems.push("review intake PR does not match workflow PR");
    if (reviewIntake.pr?.state !== "OPEN") reviewProblems.push("review intake was not captured while the PR was open");
    if (reviewIntake.pr?.headRefOid !== headSha) reviewProblems.push("review intake head does not match current HEAD");
    if (reviewIntake.pr?.baseRefName !== defaultBranch) reviewProblems.push(`review intake base is not ${defaultBranch}`);
    if (reviewIntake.untrustedGithubInput !== true) reviewProblems.push("review intake does not record untrusted GitHub input handling");
    if ((reviewIntake.lookupErrors ?? []).length > 0) reviewProblems.push(...reviewIntake.lookupErrors);
  }
  checks.push(staticCheck("ZeroClaw review and CI intake", reviewProblems.length === 0, reviewProblems.join("; ") || reviewIntakePath));
  workflow.reviewIntakePath = reviewIntakePath;
}

if (project.id === "zeroclaw" && project.reviewPolicy) {
  const architectureFiles = filesUnderPrefixes(changedFiles, project.reviewPolicy.architecturePaths ?? []);
  const rfcFiles = filesUnderPrefixes(changedFiles, project.reviewPolicy.rfcPaths ?? []);
  const requiredPolicyFiles = new Set();
  if (architectureFiles.length > 0 || rfcFiles.length > 0) {
    requiredPolicyFiles.add(project.reviewPolicy.agents);
    requiredPolicyFiles.add(project.reviewPolicy.architectureMap);
    if (rfcFiles.length > 0) requiredPolicyFiles.add(project.reviewPolicy.rfcProcess);
  }
  const missingPolicyFiles = [...requiredPolicyFiles]
    .filter(Boolean)
    .filter((file) => !fs.existsSync(path.join(repo, file)));
  if (requiredPolicyFiles.size === 0) {
    checks.push(skippedCheck("ZeroClaw contribution map/RFC prerequisites", "no architecture or RFC-sensitive path changed"));
  } else {
    checks.push(staticCheck(
      "ZeroClaw contribution map/RFC prerequisites",
      missingPolicyFiles.length === 0,
      missingPolicyFiles.length === 0
        ? `architecture files: ${architectureFiles.length}; RFC-sensitive files: ${rfcFiles.length}; read ${[...requiredPolicyFiles].join(", ")}`
        : `missing: ${missingPolicyFiles.join(", ")}`,
    ));
  }
}

let packageJson;
if (projectUsesPnpm(project)) {
  try {
    packageJson = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  } catch (error) {
    checks.push(staticCheck("package manifest", false, error.message));
  }
}

if (packageJson && ["quick", "conflict"].includes(args.profile)) {
  checks.push(skippedCheck(
    "heavy checks",
    args.profile === "conflict"
      ? "focused checks are recorded in conflict-resolution-check.json; no pnpm lanes were repeated"
      : "skipped by --profile quick; no pnpm check or test lanes were run",
  ));
} else if (packageJson) {
  checks.push(staticCheck(
    "selected check script exists",
    ["targeted", "focused", "iterate"].includes(args.profile) || Boolean(checkScript && typeof packageJson.scripts?.[checkScript] === "string"),
    checkScript || `not selected for ${args.profile} profile`,
  ));
  checks.push(staticCheck(
    "focused test script exists",
    !args.testScript || typeof packageJson.scripts?.[args.testScript] === "string",
    args.testScript || "not selected",
  ));
  checks.push(staticCheck(
    "optional test type script",
    !args.typeScript || typeof packageJson.scripts?.[args.typeScript] === "string",
    args.typeScript || "not selected",
  ));
  for (const script of args.extraScripts) {
    checks.push(staticCheck(
      `extra script exists: ${script}`,
      typeof packageJson.scripts?.[script] === "string",
      script,
    ));
  }

  const prerequisitesPassed = !checks.some((check) => check.status === "failed");
  if (prerequisitesPassed) {
    const pnpmVersionValue = cachedPnpmVersion(root, repo);
    if (!pnpmVersionValue) {
      checks.push(staticCheck("pnpm version", false, "unable to determine the pnpm version (cache and direct lookup failed)"));
    } else {
      const relevantEnvironment = Object.fromEntries(
        Object.entries(process.env)
          .filter(([key]) => key.startsWith("OPENCLAW_") || ["CI", "GITHUB_ACTIONS"].includes(key))
          // Lock scope changes where heavy lanes serialize, never what they
          // validate; keep it out of the reuse fingerprint.
          .filter(([key]) => key !== "OPENCLAW_HEAVY_CHECK_LOCK_SCOPE")
          .toSorted(([left], [right]) => left.localeCompare(right)),
      );
      heavyFingerprint = sha256(JSON.stringify({
        schemaVersion: 1,
        headSha,
        validationBaseSha,
        profile: args.profile,
        checkScript,
        testScript: args.testScript,
        typeScript: args.typeScript,
        extraScripts: args.extraScripts,
        packageJsonSha256: fileSha256(path.join(repo, "package.json")),
        lockfileSha256: fileSha256(path.join(repo, "pnpm-lock.yaml")),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        pnpm: pnpmVersionValue,
        preflightScriptSha256: fileSha256(path.resolve(process.argv[1])),
        targetedCheckScriptSha256: args.profile === "targeted" ? fileSha256(targetedCheckScript) : null,
        targetedPlanScriptSha256: args.profile === "targeted" ? fileSha256(targetedPlanScript) : null,
        environment: relevantEnvironment,
      }));

      // The check lane (lint/format/types) reads only the changed files'
      // contents plus lint-relevant configuration, so its cache key is the
      // committed diff content rather than commit topology. A rebase, amend,
      // or squash that preserves file contents keeps a successful check-lane
      // result valid even though headSha changes. An empty fingerprint means
      // the diff could not be read and the lane must not be cached or reused.
      const rootBlobEntries = git(repo, "ls-tree", "HEAD")
        .split("\n")
        .filter((line) => line.includes(" blob "))
        .map((line) => {
          const [, type, blobSha, ...nameParts] = line.split(/\s+/);
          return [type === "blob" ? nameParts.join(" ") : "", blobSha];
        })
        .filter(([name]) => /^(tsconfig|eslint|biome|prettier|oxlint|pnpm-workspace|pnpm-lock)/.test(name) || name === "package.json");
      const diffContentResult = run(
        "git",
        ["diff", "--binary", `${validationBaseSha}...${headSha}`],
        repo,
        { captureFullOutput: true, category: "gitMs" },
      );
      const checkLaneFingerprintValue = diffContentResult.exitCode === 0
        ? sha256(JSON.stringify({
            schemaVersion: 1,
            diffContentSha256: sha256(diffContentResult.fullOutput ?? diffContentResult.output),
            configBlobs: Object.fromEntries(rootBlobEntries),
            checkScript,
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            pnpm: pnpmVersionValue,
            preflightScriptSha256: fileSha256(path.resolve(process.argv[1])),
            targetedCheckScriptSha256: args.profile === "targeted" ? fileSha256(targetedCheckScript) : null,
            targetedPlanScriptSha256: args.profile === "targeted" ? fileSha256(targetedPlanScript) : null,
            environment: relevantEnvironment,
          }))
        : "";
      checkLaneFingerprint = checkLaneFingerprintValue;

      const focusedTestScriptPath = ["scripts/test-projects.mts", "scripts/test-projects.mjs"]
        .find((relative) => fs.existsSync(path.join(repo, relative))) || "scripts/test-projects.mts";

      focusedTestFingerprint = args.testScript
        ? sha256(JSON.stringify({
            schemaVersion: 2,
            // Tests execute against the whole worktree, so the tree hash (not
            // the commit SHA) is the right identity: a content-preserving
            // rebase, amend, or squash keeps the cache valid while any real
            // content change (including a rebase onto advanced main) misses.
            headTreeSha,
            validationBaseSha,
            testScript: args.testScript,
            packageJsonSha256: fileSha256(path.join(repo, "package.json")),
            lockfileSha256: fileSha256(path.join(repo, "pnpm-lock.yaml")),
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            pnpm: pnpmVersionValue,
            testProjectsScriptSha256: fileSha256(path.join(repo, focusedTestScriptPath)),
            preflightScriptSha256: fileSha256(path.resolve(process.argv[1])),
            environment: relevantEnvironment,
          }))
        : "";

      const cachedHeavyChecks = readCachedHeavyChecks(previousReceipt, preflightCache, heavyFingerprint);
      cacheHit = Boolean(cachedHeavyChecks);

      if (cacheHit) {
        heavyChecks = cachedHeavyChecks;
        checks.push(staticCheck(
          "heavy check cache",
          true,
          `reused successful checks for fingerprint ${heavyFingerprint}`,
        ));
      } else {
        const cachedValidationCheck = checkLaneFingerprint
          ? readCachedValidationCheck(preflightCache, checkLaneFingerprint)
          : null;
        const checkOptions = checkScript === "check:changed"
          ? {
              category: "validationMs",
              captureFullOutput: true,
              env: {
                ...process.env,
                OPENCLAW_CHECK_CHANGED_REMOTE_CHILD: "1",
                OPENCLAW_CHANGED_LANES_RAW_SYNC: "1",
                PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
              },
            }
          : { category: "validationMs", captureFullOutput: true };
        const testScriptRunnable = Boolean(args.testScript && typeof packageJson.scripts?.[args.testScript] === "string");
        const cachedFocusedTest = testScriptRunnable
          ? readCachedFocusedTest(preflightCache, focusedTestFingerprint)
          : null;
        const checkCommand = args.profile === "targeted"
          ? {
              bin: process.execPath,
              args: [targetedCheckScript, "--base", validationBaseSha, "--head", "HEAD"],
              options: { category: "validationMs", captureFullOutput: true },
            }
          : checkScript
            ? {
                bin: "pnpm",
                args: checkScript === "check:changed"
                  ? [checkScript, "--base", validationBaseSha, "--timed"]
                  : [checkScript],
                options: checkOptions,
              }
            : null;
        const testCommand = testScriptRunnable && !cachedFocusedTest
          ? (args.testScript === "test:changed"
              ? {
                  bin: process.execPath,
                  args: focusedTestScriptPath.endsWith(".mts")
                    ? ["--import", "tsx", focusedTestScriptPath, "--changed", validationBaseSha]
                    : [focusedTestScriptPath, "--changed", validationBaseSha],
                  options: { category: "validationMs", captureFullOutput: true },
                }
              : { bin: "pnpm", args: [args.testScript], options: { category: "validationMs", captureFullOutput: true } })
          : null;
        // Overlap the two heavy lanes: the test lane runs in a worker while
        // the check lane occupies the main thread. When the check lane fails,
        // the test lane is aborted before its result is recorded as skipped.
        const parallelTestRun = checkCommand && testCommand
          ? startAsyncRun(testCommand.bin, testCommand.args, repo, testCommand.options)
          : null;
        if (args.profile === "targeted") {
          primaryValidationCheck = cachedValidationCheck ?? commandCheck(
            "targeted changed-file lint format and owning-project types",
            run(checkCommand.bin, checkCommand.args, repo, checkCommand.options),
          );
          heavyChecks.push(primaryValidationCheck);
        } else if (checkScript) {
          const checkLabel = args.profile === "full"
            ? "full-repository lint type and policy checks"
            : checkScript === "check:changed"
              ? "changed-surface lint type and policy checks"
              : `pnpm script: ${checkScript}`;
          primaryValidationCheck = cachedValidationCheck ?? commandCheck(
            checkLabel,
            run("pnpm", checkCommand.args, repo, checkOptions),
          );
          heavyChecks.push(primaryValidationCheck);
        }
        const checkFailed = heavyChecks.some((check) => check.status === "failed");
        if (checkFailed) {
          if (parallelTestRun) {
            parallelTestRun.abort();
            parallelTestRun.wait();
          }
          if (args.testScript) {
            heavyChecks.push(skippedCheck("focused tests", "skipped because the selected check lane failed"));
          }
        } else if (testScriptRunnable) {
          if (cachedFocusedTest) {
            heavyChecks.push(cachedFocusedTest);
          } else if (parallelTestRun) {
            heavyChecks.push(commandCheck("focused tests", parallelTestRun.wait()));
          } else {
            const testResult = run(testCommand.bin, testCommand.args, repo, testCommand.options);
            heavyChecks.push(commandCheck("focused tests", testResult));
          }
        } else if (args.testScript) {
          heavyChecks.push(skippedCheck("focused tests", "skipped because the selected check lane failed"));
        }
        const earlierHeavyFailure = heavyChecks.some((check) => check.status === "failed");
        if (!earlierHeavyFailure && args.typeScript && typeof packageJson.scripts?.[args.typeScript] === "string") {
          heavyChecks.push(commandCheck(`pnpm script: ${args.typeScript}`, run("pnpm", [args.typeScript], repo, { category: "validationMs", captureFullOutput: true })));
        } else if (earlierHeavyFailure && args.typeScript) {
          heavyChecks.push(skippedCheck(`pnpm script: ${args.typeScript}`, "skipped because an earlier heavy lane failed"));
        }
        for (const script of args.extraScripts) {
          const failedBeforeExtra = heavyChecks.some((check) => check.status === "failed");
          if (!failedBeforeExtra && typeof packageJson.scripts?.[script] === "string") {
            heavyChecks.push(commandCheck(`extra pnpm script: ${script}`, run("pnpm", [script], repo, { category: "validationMs", captureFullOutput: true })));
          } else if (failedBeforeExtra) {
            heavyChecks.push(skippedCheck(`extra pnpm script: ${script}`, "skipped because an earlier heavy lane failed"));
          }
        }
        checks.push(staticCheck("heavy check cache", true, `cache miss for fingerprint ${heavyFingerprint}`));
      }
      checks.push(...heavyChecks);
    }
  } else {
    checks.push(skippedCheck(
      "heavy checks",
      "skipped because a dependency, repository, freshness, manifest, or PR-body prerequisite failed",
    ));
  }
}

if (projectUsesCargo(project)) {
  const documentationOnly = isDocumentationOnly(changedFiles);
  if (args.profile === "quick" && documentationOnly && project.validation?.docs?.length) {
    const commands = projectValidationCommands(project, "docs", changedFiles);
    for (const command of commands) {
      const commandResult = run(command.bin, command.args, repo, {
        category: "validationMs",
        captureFullOutput: true,
        env: {
          ...process.env,
          ZEROCLAW_STRICT_LINT: process.env.ZEROCLAW_STRICT_LINT || "1",
          ZEROCLAW_DOCS_LINT: process.env.ZEROCLAW_DOCS_LINT || "1",
          ZEROCLAW_DOCS_LINKS: process.env.ZEROCLAW_DOCS_LINKS || "1",
        },
      });
      const check = commandCheck(command.name, commandResult);
      heavyChecks.push(check);
      if (check.status === "failed") break;
    }
    checks.push(...heavyChecks);
  } else if (["quick", "conflict"].includes(args.profile)) {
    checks.push(skippedCheck(
      "heavy checks",
      args.profile === "conflict"
        ? "focused checks are recorded in conflict-resolution-check.json; no Cargo lanes were repeated"
        : "skipped by --profile quick; no Cargo validation lanes were run",
    ));
  } else {
    const lane = args.profile === "full" ? "full" : args.profile === "targeted" ? "targeted" : "changed";
    const commands = projectValidationCommands(project, lane, changedFiles);
    const cargoLockPath = path.join(repo, "Cargo.lock");
    heavyFingerprint = sha256(JSON.stringify({
      schemaVersion: 1,
      project: project.id,
      headSha,
      validationBaseSha,
      profile: args.profile,
      commands,
      cargoTomlSha256: fileSha256(path.join(repo, "Cargo.toml")),
      lockfileSha256: fileSha256(cargoLockPath),
      rustc: run("rustc", ["--version"], repo).stdout.trim(),
      cargo: run("cargo", ["--version"], repo).stdout.trim(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      preflightScriptSha256: fileSha256(path.resolve(process.argv[1])),
    }));
    const cachedHeavyChecks = readCachedHeavyChecks(previousReceipt, preflightCache, heavyFingerprint);
    cacheHit = Boolean(cachedHeavyChecks);
    if (cacheHit) {
      heavyChecks = cachedHeavyChecks;
      checks.push(staticCheck("heavy check cache", true, `reused successful checks for fingerprint ${heavyFingerprint}`));
    } else {
      for (const command of commands) {
        const commandResult = run(command.bin, command.args, repo, {
          category: "validationMs",
          captureFullOutput: true,
          env: {
            ...process.env,
            BASE_SHA: validationBaseSha,
          },
        });
        const check = commandCheck(command.name, commandResult);
        heavyChecks.push(check);
        if (check.status === "failed") break;
      }
      if (heavyChecks.some((check) => check.status === "failed")) {
        for (const command of commands.slice(heavyChecks.length)) {
          heavyChecks.push(skippedCheck(command.name, "skipped because an earlier Cargo lane failed"));
        }
      }
      checks.push(staticCheck("heavy check cache", true, `cache miss for fingerprint ${heavyFingerprint}`));
    }
    primaryValidationCheck = heavyChecks.find((check) => check.status !== "skipped") ?? null;
    checks.push(...heavyChecks);
  }
}

persistFailedCheckArtifacts(checks, repo, outputPath);
finalizePhaseWall();

const failed = checks.filter((check) => check.status === "failed");
workflow.schemaVersion = Math.max(Number(workflow.schemaVersion) || 1, 2);
workflow.validationBaseSha = validationBaseSha || workflow.validationBaseSha || workflow.baseSha;
workflow.validationBaseRef ||= workflow.baseRef || `origin/${defaultBranch}`;
workflow.baseSha ||= workflow.validationBaseSha;
workflow.latestObservedMainSha = latestMainSha || workflow.latestObservedMainSha || null;
workflow.latestObservedAt = freshness?.observedAt || workflow.latestObservedAt || null;
workflow.headSha = headSha || workflow.headSha;
workflow.updatedAt = new Date().toISOString();
fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
const heavyCheckSet = new Set(heavyChecks);
const receiptHeavyChecks = heavyChecks.map((check) => receiptCheck(check));
const receipt = {
  schemaVersion: 2,
  status: failed.length > 0 ? "failed" : "passed",
  workflowPath,
  repoPath: repo,
  validationBaseSha,
  latestObservedMainSha: latestMainSha,
  headSha,
  branch,
  requestedProfile,
  profile: args.profile,
  validationDepth: args.profile === "quick"
    ? "deterministic-no-pnpm"
    : args.profile === "conflict"
      ? "conflict-resolution-focused"
    : args.profile === "targeted"
      ? "targeted-files-and-owning-projects"
    : ["focused", "iterate"].includes(args.profile)
      ? "focused-changed-tests"
      : args.profile === "full"
        ? "full-pnpm"
        : args.profile === "fast"
          ? "fast-lint-prod-and-test-types"
          : "changed-pnpm",
  freshness,
  conflictResolutionReceipt: conflictReceipt ? {
    path: path.join(outputPath, "conflict-resolution-check.json"),
    status: conflictReceipt.status,
    headSha: conflictReceipt.headSha,
    targetSha: conflictReceipt.targetSha,
    conflictFiles: conflictReceipt.conflictFiles,
    commandResults: conflictReceipt.commandResults?.map(({ name, kind, status, durationMs }) => ({
      name, kind, status, durationMs,
    })),
  } : null,
  githubAccount: publicAccount(account),
  heavyFingerprint,
  heavyCacheHit: cacheHit,
  heavyChecks: receiptHeavyChecks,
  timing: {
    ...phaseTiming,
    wallNetworkMs: phaseWall.networkMs.ms,
    wallGitMs: phaseWall.gitMs.ms,
    wallValidationMs: phaseWall.validationMs.ms,
    wallOtherMs: phaseWall.otherMs.ms,
    totalMs: Date.now() - preflightStartedAt,
  },
  generatedAt: new Date().toISOString(),
  checks: checks.map((check) => receiptCheck(check, { includeOutput: !heavyCheckSet.has(check) })),
};

fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
fs.writeFileSync(preflightPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

const successfulHeavyChecks = heavyChecks.filter((check) => check.status === "passed");
const focusedTestCheck = successfulHeavyChecks.find((check) => check.name === "focused tests");
const nextPreflightCache = {
  schemaVersion: 2,
  updatedAt: new Date().toISOString(),
  heavyChecksByFingerprint: pruneCacheEntries(preflightCache.heavyChecksByFingerprint ?? {}),
  focusedTestsByFingerprint: pruneCacheEntries(preflightCache.focusedTestsByFingerprint ?? {}),
  validationChecksByFingerprint: pruneCacheEntries(preflightCache.validationChecksByFingerprint ?? {}),
};
if (heavyFingerprint && successfulHeavyChecks.length === heavyChecks.length && heavyChecks.length > 0) {
  nextPreflightCache.heavyChecksByFingerprint[heavyFingerprint] = successfulHeavyChecks.map(storeCommandCheck);
}
if (focusedTestFingerprint && focusedTestCheck) {
  nextPreflightCache.focusedTestsByFingerprint[focusedTestFingerprint] = storeCommandCheck(focusedTestCheck);
}
if (checkLaneFingerprint && primaryValidationCheck?.status === "passed") {
  nextPreflightCache.validationChecksByFingerprint[checkLaneFingerprint] = storeCommandCheck(primaryValidationCheck);
}
fs.writeFileSync(cachePath, `${JSON.stringify(nextPreflightCache, null, 2)}\n`, "utf8");

for (const check of checks) {
  const label = check.status === "passed"
    ? "PASS"
    : check.status === "advisory"
      ? "WARN"
      : check.status === "skipped"
        ? "SKIP"
        : "FAIL";
  console.log(`${label}  ${check.name}`);
}
console.log(`\n${receipt.status.toUpperCase()}: ${preflightPath}`);
process.exit(receipt.status === "failed" ? 1 : 0);
