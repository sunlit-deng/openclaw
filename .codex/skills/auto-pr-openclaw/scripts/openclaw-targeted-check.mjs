#!/usr/bin/env node

import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { targetedValidationPlan } from "./lib/targeted-validation.mjs";

function parseArgs(argv) {
  const args = { base: "", head: "HEAD", dryRun: false, concurrency: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") args.base = argv[++index] ?? "";
    else if (arg === "--head") args.head = argv[++index] ?? "";
    else if (arg === "--concurrency") args.concurrency = Number(argv[++index]);
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return `Usage: openclaw-targeted-check.mjs --base SHA [--head SHA] [--concurrency N] [--dry-run]

Runs only changed-file format/lint and owning-project type lanes. Independent
commands run concurrently. Unknown, cross-surface, or high-risk diffs fail and
must use the changed profile.`;
}

function gitChangedFiles(base, head) {
  const result = spawnSync("git", ["diff", "--name-only", `${base}...${head}`], {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "git diff failed");
  }
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

function formatCommand(item) {
  return [item.bin, ...item.args].map((value) => (
    /^[A-Za-z0-9_./:@=-]+$/u.test(value) ? value : JSON.stringify(value)
  )).join(" ");
}

function runCommand(item) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(item.bin, item.args, {
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-12000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-12000);
    });
    child.on("error", (error) => {
      resolve({ ...item, status: "failed", exitCode: 1, durationMs: Date.now() - startedAt, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      resolve({
        ...item,
        status: code === 0 ? "passed" : "failed",
        exitCode: code ?? 1,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        error: null,
      });
    });
  });
}

async function runPool(commands, concurrency) {
  const results = new Array(commands.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < commands.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await runCommand(commands[index]);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, commands.length) },
    () => worker(),
  ));
  return results;
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
if (!args.base || !args.head || !Number.isSafeInteger(args.concurrency) || args.concurrency < 1) {
  console.error("--base, --head, and a positive integer --concurrency are required");
  console.error(usage());
  process.exit(2);
}

const files = gitChangedFiles(args.base, args.head);
const plan = targetedValidationPlan(files);
console.error(`[targeted] files=${files.length} surfaces=${plan.surfaces.join(",") || "none"}`);
if (!plan.safe) {
  console.error(`[targeted] escalate to changed: ${plan.reasons.join("; ")}`);
  process.exit(1);
}
for (const item of plan.commands) {
  console.error(`[targeted] ${args.dryRun ? "would run" : "run"}: ${formatCommand(item)}`);
}
if (args.dryRun) process.exit(0);

const startedAt = Date.now();
const results = await runPool(plan.commands, args.concurrency);
for (const result of results) {
  console.error(`[targeted] ${result.status} ${(result.durationMs / 1000).toFixed(2)}s ${result.name}`);
  if (result.status === "failed") {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
  }
}
console.error(`[targeted] total ${(Date.now() - startedAt) / 1000}s`);
process.exit(results.some(({ status }) => status === "failed") ? 1 : 0);
