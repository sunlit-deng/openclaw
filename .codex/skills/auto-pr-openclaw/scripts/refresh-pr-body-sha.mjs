#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseKeyArgs, run } from "./lib/workflow-utils.mjs";
import { replaceStaleHeadShaRefs } from "./lib/body-sha-utils.mjs";

function usage() {
  return [
    "Usage: refresh-pr-body-sha.mjs --workflow PATH [--head SHA] [--base SHA] [--dry-run]",
    "",
    "Refreshes exact-head SHA references in the canonical PR body after a clean,",
    "patch-equivalent rebase. Only head SHA pins are rewritten (full and short",
    "forms); base SHA references are historical records and are left untouched.",
    "This is a local file edit only: it never pushes, updates the PR body on",
    "GitHub, posts comments, or requests review. Rerun validate-pr-body.mjs after",
    "this edit, then regenerate the publication gate and publish automatically",
    "publish-openclaw-pr.mjs.",
  ].join("\n");
}

let args;
try {
  args = parseKeyArgs(process.argv.slice(2), {
    "--workflow": { name: "workflow" },
    "--head": { name: "head" },
    "--base": { name: "base" },
    "--dry-run": { name: "dryRun", boolean: true },
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
  console.error(usage());
  process.exit(2);
}

const workflowPath = path.resolve(args.workflow);
const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
const repoPath = path.resolve(workflow.repoPath);
const bodyPath = path.resolve(workflow.prBodyPath);
if (!fs.existsSync(bodyPath)) {
  console.error(`PR body file does not exist: ${bodyPath}`);
  process.exit(1);
}

const newHead = args.head || run("git", ["rev-parse", "HEAD"], { cwd: repoPath }).stdout.trim();
const oldHead = workflow.headSha || workflow.publishedHeadSha || workflow.initialHeadSha || "";
if (!/^[0-9a-f]{40}$/i.test(newHead)) {
  console.error(`resolved head is not a full SHA: ${newHead}`);
  process.exit(1);
}

const rawBody = fs.readFileSync(bodyPath, "utf8");
if (rawBody.includes("\r")) {
  console.error("PR body must use LF line endings; normalize the canonical file before refreshing");
  process.exit(1);
}

const result = replaceStaleHeadShaRefs(rawBody, { oldHead, newHead });
if (result.unresolved.length > 0) {
  console.error(
    `PR body labels a head SHA that matches neither the recorded pre-rebase head nor the new head; review manually: ${result.unresolved.map(({ token }) => token).join(", ")}`,
  );
  process.exit(1);
}

if (result.replacements.length > 0) {
  if (!args.dryRun) {
    fs.writeFileSync(bodyPath, result.body, "utf8");
  }
  const nextSha = crypto.createHash("sha256").update(result.body, "utf8").digest("hex");
  console.log(JSON.stringify({
    bodyPath,
    oldHead,
    newHead,
    dryRun: Boolean(args.dryRun),
    replacements: result.replacements,
    bodySha256: args.dryRun ? null : nextSha,
    next: "run scripts/validate-pr-body.mjs --workflow <workflow.json>, regenerate the publication gate, then publish-openclaw-pr.mjs --auto-if-ready",
  }, null, 2));
} else {
  console.log(JSON.stringify({
    bodyPath,
    oldHead,
    newHead,
    dryRun: Boolean(args.dryRun),
    replacements: [],
    note: "no stale head SHA references found; the rebase-only fast path can proceed",
  }, null, 2));
}
