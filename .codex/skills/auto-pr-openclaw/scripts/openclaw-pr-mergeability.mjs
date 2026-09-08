#!/usr/bin/env node
// Resolves real mergeability for the configured accounts' open PRs.
// `gh pr list --json mergeable` reports UNKNOWN for every PR because GitHub
// computes mergeability asynchronously; selection that trusts the bulk list
// cannot see CONFLICTING PRs. This helper lists each profile's open PRs with
// its own token, then resolves per-PR `mergeable`/`mergeStateStatus` through
// bounded `gh pr view` retries so scheduled intake ranks real conflicts.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { ghEnv, loadAccountConfig, resolveAccount } from "./lib/account-utils.mjs";

function parseArgs(argv) {
  const result = {
    repo: "openclaw/openclaw",
    root: "",
    profiles: [],
    limit: 60,
    retries: 3,
    retryDelayMs: 2000,
    concurrency: 4,
    output: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") result.repo = argv[++index] ?? "";
    else if (arg === "--root") result.root = argv[++index] ?? "";
    else if (arg === "--profile") result.profiles.push(argv[++index] ?? "");
    else if (arg === "--limit") result.limit = Number(argv[++index]);
    else if (arg === "--retries") result.retries = Number(argv[++index]);
    else if (arg === "--retry-delay-ms") result.retryDelayMs = Number(argv[++index]);
    else if (arg === "--concurrency") result.concurrency = Number(argv[++index]);
    else if (arg === "--output") result.output = argv[++index] ?? "";
    else if (arg === "-h" || arg === "--help") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(result.limit) || result.limit < 1) throw new Error("--limit must be a positive number");
  if (!Number.isFinite(result.retries) || result.retries < 1) throw new Error("--retries must be a positive number");
  if (!Number.isInteger(result.concurrency) || result.concurrency < 1 || result.concurrency > 8) {
    throw new Error("--concurrency must be an integer from 1 to 8");
  }
  if (argv.includes("--output") && !result.output) throw new Error("--output requires a file path");
  if (!Number.isFinite(result.retryDelayMs) || result.retryDelayMs < 0 || result.retryDelayMs > 60000) {
    throw new Error("--retry-delay-ms must be between 0 and 60000 milliseconds");
  }
  return result;
}

function usage() {
  return [
    "Usage: openclaw-pr-mergeability.mjs [--repo OWNER/REPO] [--root PATH]",
    "       [--profile NAME ...] [--limit N] [--retries N] [--retry-delay-ms MS] [--concurrency N]",
    "       [--output PATH]",
    "",
    "Lists open PRs for every account profile (or the selected ones) and resolves",
    "each PR's real mergeable state with per-PR `gh pr view` retries. Prints a",
    "JSON report with conflicting / unknown / mergeable groups. GitHub reads are read-only; --output writes an optional local receipt.",
  ].join("\n");
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

const metrics = { processSpawns: 0, listMs: 0, resolveMs: 0 };
function execute(command, commandArgs, { env } = {}) {
  metrics.processSpawns += 1;
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { env, encoding: "utf8", shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-16 * 1024 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16 * 1024 * 1024); });
    child.on("error", (error) => reject(new Error(`${command} ${commandArgs.join(" ")} failed: ${error.message}`, { cause: error })));
    child.on("close", (status) => {
      if (status !== 0) {
        const details = String(stderr || stdout || "unknown error").slice(-2000);
        reject(new Error(`${command} ${commandArgs.join(" ")} failed: ${details}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function compactError(error) {
  return String(error?.message || error || "unknown error")
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_]+\b/g, "[redacted]")
    .slice(-2000);
}

function markPrError(pr, error) {
  pr.resolveStatus = "error";
  pr.error = compactError(error);
  return pr;
}

async function writeReceipt(outputPath, content) {
  const target = path.resolve(outputPath);
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(temporary, `${content}\n`, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

const { config } = loadAccountConfig(args.root);
const profileNames = args.profiles.length ? args.profiles : Object.keys(config.profiles ?? {});
if (!profileNames.length) {
  console.error("No account profiles configured; nothing to query");
  process.exit(1);
}

const byNumber = new Map();
const profileErrors = [];
const listStartedAt = Date.now();
for (const profileName of profileNames) {
  try {
    const account = resolveAccount({ profile: profileName, root: args.root });
    const env = ghEnv(account);
    const listed = JSON.parse(await execute("gh", [
      "pr", "list",
      "--repo", args.repo,
      "--author", account.login,
      "--state", "open",
      "--limit", String(args.limit),
      "--json", "number,title,updatedAt,headRefName,headRefOid",
    ], { env }));
    if (!Array.isArray(listed)) throw new Error("gh pr list returned a non-array response");
    for (const pr of listed) {
      if (byNumber.has(pr.number)) continue;
      byNumber.set(pr.number, {
        profile: account.profile,
        login: account.login,
        number: pr.number,
        title: pr.title,
        headRefName: pr.headRefName,
        headRefOid: pr.headRefOid,
        updatedAt: pr.updatedAt,
        mergeable: "UNKNOWN",
        mergeStateStatus: null,
        attempts: 0,
        resolveStatus: "pending",
        error: null,
      });
    }
  } catch (error) {
    profileErrors.push({ profile: profileName, stage: "list", error: compactError(error) });
  }
}
metrics.listMs = Date.now() - listStartedAt;

// gh pr view is what asks GitHub to compute mergeability; the value can still
// come back UNKNOWN right after, so retry a bounded number of times and report
// the residual honestly instead of treating it as "no conflict".
async function resolvePr(pr) {
  const account = resolveAccount({ profile: pr.profile, root: args.root });
  const env = ghEnv(account);
  let lastError = null;
  for (let attempt = 1; attempt <= args.retries; attempt += 1) {
    pr.attempts = attempt;
    try {
      const view = JSON.parse(await execute("gh", [
        "pr", "view", String(pr.number),
        "--repo", args.repo,
        "--json", "mergeable,mergeStateStatus",
      ], { env }));
      if (!view || typeof view !== "object") throw new Error("gh pr view returned a non-object response");
      pr.mergeable = view.mergeable ?? "UNKNOWN";
      pr.mergeStateStatus = view.mergeStateStatus ?? null;
      pr.resolveStatus = pr.mergeable === "UNKNOWN" ? "unknown" : "resolved";
      pr.error = null;
      lastError = null;
      if (pr.mergeable !== "UNKNOWN") break;
    } catch (error) {
      lastError = compactError(error);
    }
    if (attempt < args.retries) await sleep(args.retryDelayMs);
  }
  if (lastError) markPrError(pr, lastError);
  return pr;
}

async function runPool(items, concurrency, task) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await task(items[index]);
      } catch (error) {
        results[index] = markPrError(items[index], error);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

const resolveStartedAt = Date.now();
await runPool([...byNumber.values()], args.concurrency, resolvePr);
metrics.resolveMs = Date.now() - resolveStartedAt;

const isConflict = (pr) =>
  pr.resolveStatus === "resolved" && (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY");
const prs = [...byNumber.values()].sort((a, b) => a.number - b.number);
const compact = (pr) => ({
  number: pr.number,
  profile: pr.profile,
  title: pr.title,
  headRefOid: pr.headRefOid,
  updatedAt: pr.updatedAt,
  mergeable: pr.mergeable,
  mergeStateStatus: pr.mergeStateStatus,
  resolveStatus: pr.resolveStatus,
  ...(pr.error ? { error: pr.error } : {}),
});

const resolutionErrors = prs
  .filter((pr) => pr.resolveStatus === "error")
  .map((pr) => ({
    profile: pr.profile,
    number: pr.number,
    stage: "view",
    error: pr.error,
  }));
const scanErrors = [...profileErrors, ...resolutionErrors];

const report = {
  repo: args.repo,
  generatedAt: new Date().toISOString(),
  scanStatus: scanErrors.length ? "partial" : "complete",
  errorCount: scanErrors.length,
  errors: scanErrors,
  total: prs.length,
  conflicting: prs.filter(isConflict).map(compact),
  unknown: prs.filter((pr) => pr.mergeable === "UNKNOWN" && !isConflict(pr) && pr.resolveStatus !== "error").map(compact),
  mergeable: prs.filter((pr) => pr.mergeable === "MERGEABLE").map(compact),
  prs,
  timing: {
    ...metrics,
    concurrency: args.concurrency,
    retries: args.retries,
    retryDelayMs: args.retryDelayMs,
    totalMs: Date.now() - (listStartedAt),
  },
};

let receiptError = null;
if (args.output) {
  try {
    await writeReceipt(args.output, JSON.stringify(report, null, 2));
  } catch (error) {
    receiptError = compactError(error);
    report.scanStatus = "partial";
    report.errorCount += 1;
    report.errors.push({ stage: "persist", path: path.resolve(args.output), error: receiptError });
  }
}

console.log(JSON.stringify(report, null, 2));
console.error(`[mergeability] status=${report.scanStatus} total=${report.total} conflicting=${report.conflicting.length} unknown=${report.unknown.length} mergeable=${report.mergeable.length} errors=${report.errorCount} in ${report.timing.totalMs}ms with concurrency=${report.timing.concurrency}`);
if (report.conflicting.length) {
  console.error(`[mergeability] conflicting PRs: ${report.conflicting.map((pr) => `#${pr.number} (${pr.profile})`).join(", ")}`);
}
if (receiptError) {
  console.error(`[mergeability] failed to persist report: ${receiptError}`);
  process.exitCode = 1;
}
