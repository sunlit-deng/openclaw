#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validatePrBody } from "./lib/pr-body-validator.mjs";
import {
  commitIdentityProblems,
  identityCheckName,
  publicAccount,
  resolveAccount,
} from "./lib/account-utils.mjs";

function parseArgs(argv) {
  const result = {
    workflow: "",
    profile: "changed",
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
  if (!["quick", "fast", "changed", "full"].includes(result.profile)) {
    throw new Error("--profile must be quick, fast, changed, or full");
  }
  if (result.profile === "quick") {
    if (result.checkScript || result.testScript !== "test:changed" || result.typeScript || result.extraScripts.length > 0) {
      throw new Error("--profile quick cannot be combined with pnpm check, test, type, or extra lanes");
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
  return result;
}

function usage() {
  return [
    "Usage: openclaw-preflight.mjs --workflow PATH [--profile quick|fast|changed|full] [--check-script NAME] [--test-script NAME] [--type-script NAME] [--extra-script NAME]",
    "",
    "Runs deterministic OpenClaw checks and writes preflight.json next to workflow.json.",
    "The default check lane is pnpm check:changed for all workflows; preflight does not run pnpm check by default.",
    "Use --profile quick to run deterministic git, identity, PR body, proof, and merge-risk gates without pnpm heavy lanes.",
    "Use --profile fast to run lint, production type checks, and test type checks without changed tests.",
    "Use --profile full to explicitly opt into the full-repository pnpm check lane.",
    "The default focused test lane is pnpm test:changed.",
    "Use --type-script check:test-types only when broader test type coverage is intentionally needed.",
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
const account = resolveAccount({ workflow });
const checkScript = args.checkScript;
const repo = path.resolve(workflow.repoPath);
const root = path.resolve(workflow.root);
const outputPath = path.resolve(workflow.outputPath);
const preflightPath = path.resolve(workflow.preflightPath);
const previousReceipt = readJsonIfPresent(preflightPath);
const checks = [];
let heavyChecks = [];
let heavyFingerprint = "";
let cacheHit = false;
let freshness = null;

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

const fetchResult = run("git", ["fetch", "origin", "main"], repo);
checks.push(commandCheck("fetch latest origin/main snapshot", fetchResult));

let headSha = "";
let validationBaseSha = workflow.validationBaseSha || workflow.baseSha || "";
let latestMainSha = "";
let branch = "";
let status = "";
let changedFiles = [];
try {
  headSha = git(repo, "rev-parse", "HEAD");
  if (!validationBaseSha) throw new Error("workflow has no pinned validation base SHA");
  validationBaseSha = git(repo, "rev-parse", `${validationBaseSha}^{commit}`);
  if (fetchResult.exitCode !== 0) throw new Error("latest origin/main snapshot is unavailable");
  latestMainSha = git(repo, "rev-parse", "refs/remotes/origin/main^{commit}");
  branch = git(repo, "branch", "--show-current");
  status = git(repo, "status", "--porcelain");
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
    "merge compatibility with observed origin/main",
    mergeTree.exitCode === 0,
    mergeConflict
      ? `conflict against observed origin/main ${latestMainSha}: ${mergeTree.output || "merge-tree reported a conflict"}`
      : mergeTree.exitCode === 0
        ? `clean against observed origin/main ${latestMainSha}`
        : `unable to evaluate merge compatibility: ${mergeTree.output || mergeTree.error}`,
  ));

  if (validationBaseSha === latestMainSha) {
    checks.push(staticCheck("upstream drift since validation base", true, "origin/main has not advanced"));
  } else {
    checks.push(advisoryCheck(
      "upstream drift since validation base",
      [
        `validationBase=${validationBaseSha}`,
        `latestObservedMain=${latestMainSha}`,
        `behindBy=${behindBy}`,
        `overlap=${overlappingFiles.length ? overlappingFiles.join(",") : "none"}`,
        "main advancement alone does not invalidate validation or require a rebase",
      ].join(" "),
    ));
  }
  if (!containsLatestMain) {
    checks.push(advisoryCheck(
      "branch freshness",
      `branch does not contain observed origin/main ${latestMainSha}; rebase only for conflicts, risky overlap, or an explicit up-to-date requirement`,
    ));
  } else {
    checks.push(staticCheck("branch freshness", true, `branch contains observed origin/main ${latestMainSha}`));
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
  checks.push(staticCheck("git repository state", false, error.message));
}

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

if (packageJson && args.profile === "quick") {
  checks.push(skippedCheck(
    "heavy checks",
    "skipped by --profile quick; no pnpm check or test lanes were run",
  ));
} else if (packageJson) {
  checks.push(staticCheck(
    "selected check script exists",
    Boolean(checkScript && typeof packageJson.scripts?.[checkScript] === "string"),
    checkScript || "no check script selected",
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
    const pnpmVersion = run("pnpm", ["--version"], repo);
    if (pnpmVersion.exitCode !== 0) {
      checks.push(commandCheck("pnpm version", pnpmVersion));
    } else {
      const relevantEnvironment = Object.fromEntries(
        Object.entries(process.env)
          .filter(([key]) => key.startsWith("OPENCLAW_") || ["CI", "GITHUB_ACTIONS"].includes(key))
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
        pnpm: pnpmVersion.stdout.trim(),
        preflightScriptSha256: fileSha256(path.resolve(process.argv[1])),
        environment: relevantEnvironment,
      }));

      cacheHit = previousReceipt?.heavyFingerprint === heavyFingerprint &&
        Array.isArray(previousReceipt.heavyChecks) &&
        previousReceipt.heavyChecks.length > 0 &&
        previousReceipt.heavyChecks.every((check) => check.status === "passed");

      if (cacheHit) {
        heavyChecks = previousReceipt.heavyChecks.map((check) => ({
          ...check,
          durationMs: 0,
          cachedDurationMs: check.cachedDurationMs ?? check.durationMs ?? null,
          cached: true,
          reusedAt: new Date().toISOString(),
        }));
        checks.push(staticCheck(
          "heavy check cache",
          true,
          `reused successful checks for fingerprint ${heavyFingerprint}`,
        ));
      } else {
        const checkOptions = checkScript === "check:changed"
          ? {
              env: {
                ...process.env,
                OPENCLAW_CHECK_CHANGED_REMOTE_CHILD: "1",
                OPENCLAW_CHANGED_LANES_RAW_SYNC: "1",
                PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
              },
            }
          : {};
        const checkArgs = checkScript === "check:changed"
          ? [checkScript, "--base", validationBaseSha, "--timed"]
          : [checkScript];
        const checkLabel = args.profile === "full"
          ? "full-repository lint type and policy checks"
          : checkScript === "check:changed"
            ? "changed-surface lint type and policy checks"
            : `pnpm script: ${checkScript}`;
        const changedCheck = commandCheck(
          checkLabel,
          run("pnpm", checkArgs, repo, checkOptions),
        );
        heavyChecks.push(changedCheck);
        if (changedCheck.status === "passed" && args.testScript && typeof packageJson.scripts?.[args.testScript] === "string") {
          const testResult = args.testScript === "test:changed"
            ? run(process.execPath, ["scripts/test-projects.mjs", "--changed", validationBaseSha], repo)
            : run("pnpm", [args.testScript], repo);
          heavyChecks.push(commandCheck("focused tests", testResult));
        } else if (args.testScript) {
          heavyChecks.push(skippedCheck("focused tests", "skipped because the selected check lane failed"));
        }
        const earlierHeavyFailure = heavyChecks.some((check) => check.status === "failed");
        if (!earlierHeavyFailure && args.typeScript && typeof packageJson.scripts?.[args.typeScript] === "string") {
          heavyChecks.push(commandCheck(`pnpm script: ${args.typeScript}`, run("pnpm", [args.typeScript], repo)));
        } else if (earlierHeavyFailure && args.typeScript) {
          heavyChecks.push(skippedCheck(`pnpm script: ${args.typeScript}`, "skipped because an earlier heavy lane failed"));
        }
        for (const script of args.extraScripts) {
          const failedBeforeExtra = heavyChecks.some((check) => check.status === "failed");
          if (!failedBeforeExtra && typeof packageJson.scripts?.[script] === "string") {
            heavyChecks.push(commandCheck(`extra pnpm script: ${script}`, run("pnpm", [script], repo)));
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

const failed = checks.filter((check) => check.status === "failed");
workflow.schemaVersion = Math.max(Number(workflow.schemaVersion) || 1, 2);
workflow.validationBaseSha = validationBaseSha || workflow.validationBaseSha || workflow.baseSha;
workflow.validationBaseRef ||= workflow.baseRef || "origin/main";
workflow.baseSha ||= workflow.validationBaseSha;
workflow.latestObservedMainSha = latestMainSha || workflow.latestObservedMainSha || null;
workflow.latestObservedAt = freshness?.observedAt || workflow.latestObservedAt || null;
workflow.headSha = headSha || workflow.headSha;
workflow.updatedAt = new Date().toISOString();
fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
const receipt = {
  schemaVersion: 2,
  status: failed.length === 0 ? "passed" : "failed",
  workflowPath,
  repoPath: repo,
  validationBaseSha,
  latestObservedMainSha: latestMainSha,
  headSha,
  branch,
  profile: args.profile,
  validationDepth: args.profile === "quick"
    ? "deterministic-no-pnpm"
    : args.profile === "full"
      ? "full-pnpm"
      : args.profile === "fast"
        ? "fast-lint-prod-and-test-types"
        : "changed-pnpm",
  freshness,
  githubAccount: publicAccount(account),
  heavyFingerprint,
  heavyCacheHit: cacheHit,
  heavyChecks,
  generatedAt: new Date().toISOString(),
  checks,
};

fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
fs.writeFileSync(preflightPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

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
process.exit(receipt.status === "passed" ? 0 : 1);
