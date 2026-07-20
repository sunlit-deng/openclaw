#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { publicAccount, resolveAccount } from "./lib/account-utils.mjs";

function parseArgs(argv) {
  const result = { workflow: "", account: "", force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workflow") result.workflow = argv[++index] ?? "";
    else if (arg === "--account") result.account = argv[++index] ?? "";
    else if (arg === "--force") result.force = true;
    else if (arg === "-h" || arg === "--help") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function usage() {
  return `Usage: openclaw-set-account.mjs --workflow PATH --account PROFILE [--force]`;
}

function execute(command, args, { cwd } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.error?.message}`);
  }
  return result.stdout.trim();
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
if (!args.workflow || !args.account) {
  console.error("--workflow and --account are required");
  console.error(usage());
  process.exit(2);
}

const workflowPath = path.resolve(args.workflow);
const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
const account = resolveAccount({ workflow, profile: args.account });
const headOwner = workflow.headOwner || workflow.githubAccount?.login || null;
if (workflow.pr && headOwner && account.login.toLowerCase() !== headOwner.toLowerCase() && !args.force) {
  throw new Error(`Refusing to set account ${account.profile} (${account.login}) because PR head owner is ${headOwner}. Use --force only for an intentional ownership migration.`);
}

const repoPath = path.resolve(workflow.repoPath);
execute("git", ["config", "user.name", account.username], { cwd: repoPath });
execute("git", ["config", "user.email", account.email], { cwd: repoPath });

workflow.githubAccountProfile = account.profile;
workflow.githubAccount = publicAccount(account);
workflow.updatedAt = new Date().toISOString();
fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  workflow: workflowPath,
  repoPath,
  account: publicAccount(account),
  gitConfig: {
    userName: execute("git", ["config", "user.name"], { cwd: repoPath }),
    userEmail: execute("git", ["config", "user.email"], { cwd: repoPath }),
  },
}, null, 2));
