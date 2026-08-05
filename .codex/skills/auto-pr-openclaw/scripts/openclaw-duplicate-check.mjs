#!/usr/bin/env node

import path from "node:path";
import {
  gitChangedFiles,
  loadWorkflow,
  mapConcurrent,
  parseKeyArgs,
  prBodyInfo,
  runAsync,
  writeJson,
} from "./lib/workflow-utils.mjs";
import { ghEnv, publicAccount, resolveAccount } from "./lib/account-utils.mjs";
import { isLikelyDuplicate } from "./lib/duplicate-utils.mjs";

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
  return unique(queries).slice(0, 16);
}

async function ghSearch(kind, repo, query, env) {
  const args = ["search", kind, "--repo", repo, "--limit", "10", "--json", "number,title,state,url,updatedAt"];
  if (kind === "prs") args.push("--match", "title,body");
  args.push(query);
  const result = await runAsync("gh", args, { allowFailure: true, env });
  if (result.exitCode !== 0) {
    return { query, error: result.stderr || result.stdout || result.error, items: [] };
  }
  try {
    return { query, error: null, items: JSON.parse(result.stdout || "[]") };
  } catch (error) {
    return { query, error: error.message, items: [] };
  }
}

async function ghPrFiles(repo, number, env) {
  const result = await runAsync("gh", [
    "pr", "view", String(number), "--repo", repo,
    "--json", "number,title,state,url,files",
  ], { allowFailure: true, env });
  if (result.exitCode !== 0) {
    return { error: result.stderr || result.stdout || result.error, files: [] };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      error: null,
      files: (parsed.files ?? []).map((file) => typeof file === "string" ? file : file.path).filter(Boolean),
    };
  } catch (error) {
    return { error: error.message, files: [] };
  }
}

function githubReadConcurrency(value = process.env.OPENCLAW_GH_READ_CONCURRENCY) {
  if (!value) return 4;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("OPENCLAW_GH_READ_CONCURRENCY must be a positive integer");
  }
  return Math.min(parsed, 8);
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
const output = path.resolve(args.output || path.join(context.outputPath, "duplicate-check.json"));
if (context.workflow.pr) {
  const receipt = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    workflowPath: context.workflowPath,
    repoPath: context.repoPath,
    applicable: false,
    skipped: true,
    skippedReason: `existing PR #${context.workflow.pr} does not need duplicate screening`,
    searches: [],
    summary: {
      queryCount: 0,
      relatedOpenPrCount: 0,
      likelyDuplicateCount: 0,
      errors: [],
    },
    likelyDuplicates: [],
    relatedOpenPrs: [],
  };
  writeJson(output, receipt);
  console.log(JSON.stringify({
    output,
    applicable: false,
    skipped: true,
    reason: receipt.skippedReason,
  }, null, 2));
  process.exit(0);
}

const account = resolveAccount({ workflow: context.workflow });
const accountEnv = ghEnv(account);
const baseSha = context.workflow.validationBaseSha || context.workflow.baseSha;
const body = prBodyInfo(context.prBodyPath);
const files = unique([...(args.files ?? []), ...gitChangedFiles(context.repoPath, baseSha)]);
const repo = args.repo || "openclaw/openclaw";
const queries = deriveQueries(files, body.body, args.queries ?? []);
const concurrency = githubReadConcurrency();
let searches = [];
const detailErrors = [];

if (!args.offline) {
  const searchPlans = [];
  for (const query of queries) {
    searchPlans.push({ kind: "prs", query });
    if (/^#\d+$/.test(query) || query.length > 8) searchPlans.push({ kind: "issues", query });
  }
  searches = await mapConcurrent(searchPlans, concurrency, async ({ kind, query }) => ({
    kind,
    ...await ghSearch(kind, repo, query, accountEnv),
  }));
}

const allPrs = searches.filter((search) => search.kind === "prs").flatMap((search) => search.items.map((item) => ({
  ...item,
  query: search.query,
})));
const currentPr = context.workflow.pr ? Number(context.workflow.pr) : null;
const openPrsByNumber = new Map();
for (const item of allPrs) {
  if (String(item.state).toLowerCase() !== "open" || item.number === currentPr) continue;
  let candidate = openPrsByNumber.get(item.number);
  if (!candidate) {
    candidate = { ...item, matchedQueries: [] };
    delete candidate.query;
    openPrsByNumber.set(item.number, candidate);
  }
  if (candidate && !candidate.matchedQueries.includes(item.query)) candidate.matchedQueries.push(item.query);
}
const dedupedOpenPrs = [...openPrsByNumber.values()];
if (!args.offline) {
  const detailResults = await mapConcurrent(dedupedOpenPrs.slice(0, 20), concurrency, async (item) => ({
    item,
    details: await ghPrFiles(repo, item.number, accountEnv),
  }));
  for (const { item, details } of detailResults) {
    item.changedFiles = details.files;
    if (details.error) detailErrors.push({ pr: item.number, error: details.error });
  }
}
const relatedOpenPrs = dedupedOpenPrs.map((item) => ({
  number: item.number,
  title: item.title,
  state: item.state,
  url: item.url,
  updatedAt: item.updatedAt,
  matchedQueries: item.matchedQueries,
  changedFileCount: item.changedFiles?.length ?? 0,
  overlappingFiles: (item.changedFiles ?? []).filter((file) => files.includes(file)),
}));
const likelyDuplicates = relatedOpenPrs.filter((item) => isLikelyDuplicate(item, files));
const relatedIssuesByNumber = new Map();
for (const search of searches.filter((entry) => entry.kind === "issues")) {
  for (const item of search.items) {
    let related = relatedIssuesByNumber.get(item.number);
    if (!related) {
      related = {
        number: item.number,
        title: item.title,
        state: item.state,
        url: item.url,
        updatedAt: item.updatedAt,
        matchedQueries: [],
      };
      relatedIssuesByNumber.set(item.number, related);
    }
    if (!related.matchedQueries.includes(search.query)) related.matchedQueries.push(search.query);
  }
}
const compactSearches = searches.map((search) => ({
  kind: search.kind,
  query: search.query,
  error: search.error,
  resultCount: search.items.length,
  itemNumbers: search.items.map((item) => item.number),
}));

const receipt = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  workflowPath: context.workflowPath,
  repoPath: context.repoPath,
  repo,
  githubAccount: publicAccount(account),
  offline: Boolean(args.offline),
  validationBaseSha: baseSha,
  changedFiles: files,
  queries,
  searches: compactSearches,
  summary: {
    queryCount: queries.length,
    searchRequestCount: searches.length,
    detailRequestCount: args.offline ? 0 : Math.min(dedupedOpenPrs.length, 20),
    githubReadConcurrency: concurrency,
    relatedOpenPrCount: relatedOpenPrs.length,
    relatedIssueCount: relatedIssuesByNumber.size,
    likelyDuplicateCount: likelyDuplicates.length,
    errors: [
      ...searches.filter((search) => search.error).map((search) => ({ kind: search.kind, query: search.query, error: search.error })),
      ...detailErrors.map((detail) => ({ kind: "pr-files", ...detail })),
    ],
  },
  likelyDuplicates,
  relatedOpenPrs: relatedOpenPrs.slice(0, 30),
  relatedIssues: [...relatedIssuesByNumber.values()].slice(0, 30),
};

writeJson(output, receipt);
console.log(JSON.stringify({
  output,
  queries: queries.length,
  relatedOpenPrs: relatedOpenPrs.length,
  likelyDuplicates: likelyDuplicates.length,
  offline: receipt.offline,
}, null, 2));
