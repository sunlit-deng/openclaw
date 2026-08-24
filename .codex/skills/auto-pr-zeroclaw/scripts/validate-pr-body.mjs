#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePrBody } from "../../../skills/auto-pr-openclaw/scripts/lib/pr-body-validator.mjs";
import { projectForWorkflow } from "../../../auto-pr-core/project-profile.mjs";

const index = process.argv.indexOf("--workflow");
if (index < 0 || !process.argv[index + 1]) {
  console.error("Usage: validate-pr-body.mjs --workflow PATH");
  process.exit(2);
}
const workflowPath = path.resolve(process.argv[index + 1]);
const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
const project = projectForWorkflow(workflow);
const result = validatePrBody({
  bodyPath: workflow.prBodyPath,
  issue: workflow.issue,
  pr: workflow.pr,
  requireIssueLink: Number.isSafeInteger(workflow.issue) && workflow.issue > 0,
  repoPath: workflow.repoPath,
  baseRef: workflow.validationBaseSha || workflow.baseRef || `origin/${project.github.defaultBranch}`,
  project,
});
workflow.prBodySha256 = result.sha256;
workflow.updatedAt = new Date().toISOString();
fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
process.exit(result.status === "passed" ? 0 : 1);
