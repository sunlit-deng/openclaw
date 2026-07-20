#!/usr/bin/env node

import path from "node:path";
import {
  gitChangedFiles,
  loadWorkflow,
  parseKeyArgs,
  prBodyInfo,
  run,
  writeJson,
} from "./lib/workflow-utils.mjs";
import { ghEnv, publicAccount, resolveAccount } from "./lib/account-utils.mjs";

function usage() {
  return `Usage: openclaw-duplicate-check.mjs --workflow PATH [--query TEXT ...] [--file PATH ...] [--repo OWNER/REPO] [--output PATH] [--offline]

Runs read-only GitHub duplicate/canonical searches and writes duplicate-check.json.
Use --offline to emit the planned queries without calling gh.`;
}

function unique(values) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function shellWords(value) {
  return value.split(/[^A-Za-z0-9_.:/#-]+/).filter((word) => word.length >= 4);
}

function extractIssueRefs(body) {
  return unique([...body.matchAll(/(?:Fixes|Closes|Related):?\s+#(\d+)/gi)].map((match) => `#${match[1]}`));
}

function deriveQueries(files, body, manualQueries) {
  const queries = [];
  queries.push(...manualQueries);
  queries.push(...extractIssueRefs(body));
  for (const file of files.slice(0, 8)) {
    queries.push(file);
    const base = path.basename(file).replace(/\.[^.]+$/, "");
    if (base.length >= 4) queries.push(base);
  }
  const titleWords = shellWords(body.match(/## What Problem This Solves([\s\S]*?)(?:\n## |$)/i)?.[1] ?? "").slice(0, 8);
  if (titleWords.length >= 2) queries.push(titleWords.slice(0, 5).join(" "));
  return unique(queries).slice(0, 24);
}

function ghSearch(kind, repo, query, env) {
  const args = ["search", kind, "--repo", repo, "--limit", "10", "--json", "number,title,state,url,updatedAt"];
  if (kind === "prs") args.push("--match", "title,body");
  args.push(query);
  const result = run("gh", args, { allowFailure: true, env });
  if (result.exitCode !== 0) {
    return { query, error: result.stderr || result.stdout || result.error, items: [] };
  }
  try {
    return { query, error: null, items: JSON.parse(result.stdout || "[]") };
  } catch (error) {
    return { query, error: error.message, items: [] };
  }
}

let args;
try {
  args = parseKeyArgs(process.argv.slice(2), {
    "--workflow": { name: "workflow" },
    "--query": { name: "queries", repeat: true },
    "--file": { name: "files", repeat: true },
    "--repo": { name: "repo" },
    "--output": { name: "output" },
    "--offline": { name: "offline", boolean: true },
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
if (!args.workflow) {
  console.error("--workflow is required");
  process.exit(2);
}

const context = loadWorkflow(args.workflow);
const account = resolveAccount({ workflow: context.workflow });
const accountEnv = ghEnv(account);
const baseSha = context.workflow.validationBaseSha || context.workflow.baseSha;
const body = prBodyInfo(context.prBodyPath);
const files = unique([...(args.files ?? []), ...gitChangedFiles(context.repoPath, baseSha)]);
const repo = args.repo || "openclaw/openclaw";
const queries = deriveQueries(files, body.body, args.queries ?? []);
const searches = [];

if (!args.offline) {
  run("gh", ["auth", "status"], { allowFailure: true, env: accountEnv });
  for (const query of queries) {
    searches.push({ kind: "prs", ...ghSearch("prs", repo, query, accountEnv) });
    if (/^#\d+$/.test(query) || query.length > 8) searches.push({ kind: "issues", ...ghSearch("issues", repo, query, accountEnv) });
  }
}

const allPrs = searches.filter((search) => search.kind === "prs").flatMap((search) => search.items.map((item) => ({
  ...item,
  query: search.query,
})));
const currentPr = context.workflow.pr ? Number(context.workflow.pr) : null;
const relatedOpenPrs = allPrs.filter((item) => item.state === "open" && item.number !== currentPr);
const likelyDuplicates = relatedOpenPrs.filter((item) => {
  const title = item.title.toLowerCase();
  return files.some((file) => title.includes(path.basename(file).replace(/\.[^.]+$/, "").toLowerCase()))
    || queries.some((query) => query.startsWith("#") && item.title.includes(query.slice(1)));
});

const receipt = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  workflowPath: context.workflowPath,
  repo,
  githubAccount: publicAccount(account),
  offline: Boolean(args.offline),
  validationBaseSha: baseSha,
  changedFiles: files,
  queries,
  searches,
  summary: {
    queryCount: queries.length,
    relatedOpenPrCount: relatedOpenPrs.length,
    likelyDuplicateCount: likelyDuplicates.length,
    errors: searches.filter((search) => search.error).map((search) => ({ kind: search.kind, query: search.query, error: search.error })),
  },
  likelyDuplicates,
  relatedOpenPrs: relatedOpenPrs.slice(0, 30),
};

const output = path.resolve(args.output || path.join(context.outputPath, "duplicate-check.json"));
writeJson(output, receipt);
console.log(JSON.stringify({
  output,
  queries: queries.length,
  relatedOpenPrs: relatedOpenPrs.length,
  likelyDuplicates: likelyDuplicates.length,
  offline: receipt.offline,
}, null, 2));
