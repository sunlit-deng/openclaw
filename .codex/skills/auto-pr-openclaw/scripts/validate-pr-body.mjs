#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { validatePrBody } from "./lib/pr-body-validator.mjs";

const workflowIndex = process.argv.indexOf("--workflow");
if (workflowIndex < 0 || !process.argv[workflowIndex + 1]) {
  console.error("Usage: validate-pr-body.mjs --workflow PATH");
  process.exit(2);
}

const workflowPath = path.resolve(process.argv[workflowIndex + 1]);
const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
const result = validatePrBody({
  bodyPath: workflow.prBodyPath,
  issue: workflow.issue,
  requireIssueLink: workflow.mode !== "local-candidate",
  repoPath: workflow.repoPath,
});

workflow.prBodySha256 = result.sha256;
workflow.updatedAt = new Date().toISOString();
fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
process.exit(result.status === "passed" ? 0 : 1);
