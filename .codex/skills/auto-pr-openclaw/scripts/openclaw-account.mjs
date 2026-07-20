#!/usr/bin/env node

import { publicAccount, resolveAccount } from "./lib/account-utils.mjs";

function parseArgs(argv) {
  const result = { command: argv[0] || "show", profile: "", root: "" };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") result.profile = argv[++index] ?? "";
    else if (arg === "--root") result.root = argv[++index] ?? "";
    else if (arg === "-h" || arg === "--help") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function usage() {
  return `Usage: openclaw-account.mjs show|shell-env [--profile NAME] [--root PATH]`;
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

const account = resolveAccount({ profile: args.profile, root: args.root });
if (args.command === "show") {
  console.log(JSON.stringify(publicAccount(account), null, 2));
} else if (args.command === "shell-env") {
  const lines = [
    ["OPENCLAW_ACCOUNT_PROFILE", account.profile],
    ["OPENCLAW_ACCOUNT_USERNAME", account.username],
    ["OPENCLAW_ACCOUNT_EMAIL", account.email],
    ["OPENCLAW_ACCOUNT_LOGIN", account.login],
    ["OPENCLAW_ACCOUNT_PUSH_REMOTE", account.pushRemote],
  ];
  if (account.token) {
    lines.push(["GH_TOKEN", account.token], ["GITHUB_TOKEN", account.token]);
  }
  console.log(lines.map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n"));
} else {
  console.error(`Unknown command: ${args.command}`);
  console.error(usage());
  process.exit(2);
}
