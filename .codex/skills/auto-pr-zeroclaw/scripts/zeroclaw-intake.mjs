#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const result = {
    repo: "zeroclaw-labs/zeroclaw",
    issue: 0,
    output: "",
    reviewedRelatedPrs: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo") result.repo = argv[++index] ?? result.repo;
    else if (arg === "--issue") result.issue = Number(argv[++index]);
    else if (arg === "--output") result.output = argv[++index] ?? "";
    else if (arg === "--reviewed-related-pr") result.reviewedRelatedPrs.push(Number(argv[++index]));
    else if (arg === "-h" || arg === "--help") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function usage() {
  return "Usage: zeroclaw-intake.mjs --issue N [--repo OWNER/REPO] --output PATH [--reviewed-related-pr N ...]";
}

function runGh(args) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || result.error?.message || "gh command failed");
  }
  return result.stdout.trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
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
if (!Number.isSafeInteger(args.issue) || args.issue <= 0 || !args.output
  || args.reviewedRelatedPrs.some((number) => !Number.isSafeInteger(number) || number <= 0)) {
  console.error("--issue and --output are required");
  console.error(usage());
  process.exit(2);
}
const reviewedRelatedPrs = new Set(args.reviewedRelatedPrs);

let issue;
try {
  issue = safeJson(runGh([
    "issue", "view", String(args.issue), "--repo", args.repo,
    "--json", "number,state,title,url,labels,assignees,author,comments",
  ]));
  if (!issue) throw new Error("invalid issue JSON");
} catch (error) {
  console.error(`issue intake failed: ${error.message}`);
  process.exit(1);
}

const labels = (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name).filter(Boolean);
const assignees = (issue.assignees ?? []).map((person) => typeof person === "string" ? person : person.login).filter(Boolean);
const author = typeof issue.author === "string" ? issue.author : issue.author?.login ?? null;
const title = typeof issue.title === "string" ? issue.title : "";
const isRfc = labels.some((label) => label.toLowerCase() === "type:rfc");
const rfcAccepted = labels.some((label) => label.toLowerCase() === "status:accepted");
let issueComments = Array.isArray(issue.comments) ? issue.comments : [];
if (isRfc) {
  const apiComments = safeJson(runGh([
    "api", `repos/${args.repo}/issues/${args.issue}/comments`, "--paginate",
  ]), []);
  if (Array.isArray(apiComments)) issueComments = [...issueComments, ...apiComments];
}
const rfcAcceptanceComment = issueComments.find((comment) =>
  ["OWNER", "MEMBER", "COLLABORATOR"].includes(String(comment.authorAssociation ?? comment.author_association ?? "").toUpperCase())
  && /\b(?:accepted|ratified|final shape|implementation may proceed)\b/i.test(comment.body ?? "")
);
const titleWords = title.split(/[^A-Za-z0-9_-]+/).filter((word) => word.length >= 4).slice(0, 6);
const queries = [`#${args.issue}`, ...titleWords].filter((value, index, values) => values.indexOf(value) === index).slice(0, 8);
const related = [];
for (const query of queries) {
  const result = spawnSync("gh", [
    "search", "prs", "--repo", args.repo, "--limit", "10", "--json", "number,title,state,url,updatedAt",
    "--match", "title,body", query,
  ], { encoding: "utf8", shell: false, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) continue;
  const items = safeJson(result.stdout, []);
  for (const item of Array.isArray(items) ? items : []) {
    if (String(item.state).toUpperCase() === "OPEN") {
      related.push({
        number: item.number,
        titleSha256: sha256(item.title ?? ""),
        state: item.state,
        url: item.url,
        updatedAt: item.updatedAt,
        matchedQuery: query,
      });
    }
  }
}

const uniqueRelated = [...new Map(related.map((item) => [item.number, item])).values()];
const unreviewedRelated = uniqueRelated.filter((item) => !reviewedRelatedPrs.has(Number(item.number)));
const blockers = [];
if (String(issue.state).toUpperCase() !== "OPEN") blockers.push(`issue #${args.issue} is not open`);
if (unreviewedRelated.length > 0) blockers.push(`${unreviewedRelated.length} related open PR(s) require review before implementation`);
if (isRfc && !rfcAccepted) blockers.push(`RFC issue #${args.issue} is not marked status:accepted`);
if (isRfc && !rfcAcceptanceComment) blockers.push(`RFC issue #${args.issue} has no visible maintainer acceptance comment`);

const receipt = {
  schemaVersion: 1,
  kind: "zeroclaw-intake",
  generatedAt: new Date().toISOString(),
  repo: args.repo,
  targetBranch: "master",
  issue: {
    number: issue.number,
    state: issue.state,
    url: issue.url,
    titleSha256: sha256(title),
    labels,
    assignees,
    author,
  },
  queries,
  relatedOpenPrs: uniqueRelated,
  reviewedRelatedPrs: [...reviewedRelatedPrs].sort((a, b) => a - b),
  unreviewedRelatedOpenPrs: unreviewedRelated.map((item) => item.number),
  rfc: {
    isRfc,
    accepted: rfcAccepted,
    requiredBeforeImplementation: isRfc,
    acceptanceComment: rfcAcceptanceComment ? {
      author: typeof rfcAcceptanceComment.author === "string" ? rfcAcceptanceComment.author : rfcAcceptanceComment.author?.login ?? null,
      authorAssociation: rfcAcceptanceComment.authorAssociation ?? rfcAcceptanceComment.author_association ?? null,
      bodySha256: sha256(rfcAcceptanceComment.body ?? ""),
    } : null,
  },
  blockers,
  untrustedGithubInput: true,
  advisory: uniqueRelated.length > 0,
};

const output = path.resolve(args.output);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, issue: args.issue, blockers }, null, 2));
if (blockers.length > 0) process.exit(1);
