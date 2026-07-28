#!/usr/bin/env node

import path from "node:path";
import {
  classifyProofRecipe,
  gitChangedFiles,
  gitDiffStats,
  loadWorkflow,
  parseKeyArgs,
  prBodyInfo,
  readJsonIfPresent,
  riskFlags,
  scoreFromFlags,
  writeJson,
} from "./lib/workflow-utils.mjs";

function usage() {
  return `Usage: openclaw-candidate-score.mjs --workflow PATH [--duplicate-check PATH] [--output PATH]

Scores an OpenClaw candidate for mergeability and review readiness. This is a
local diagnostic only; it does not contact GitHub or publish anything.`;
}

let args;
try {
  args = parseKeyArgs(process.argv.slice(2), {
    "--workflow": { name: "workflow" },
    "--duplicate-check": { name: "duplicateCheck" },
    "--output": { name: "output" },
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
const duplicateCheckApplicable = !context.workflow.pr;
const baseSha = context.workflow.validationBaseSha || context.workflow.baseSha;
const files = gitChangedFiles(context.repoPath, baseSha);
const stats = gitDiffStats(context.repoPath, baseSha);
const body = prBodyInfo(context.prBodyPath);
const preflight = readJsonIfPresent(context.preflightPath);
const duplicateCheckPath = args.duplicateCheck || path.join(context.outputPath, "duplicate-check.json");
const duplicateCheck = duplicateCheckApplicable ? readJsonIfPresent(duplicateCheckPath) : null;
const proofRecipe = classifyProofRecipe(files, body);
const flags = riskFlags(files, stats, context.workflow, preflight, duplicateCheck, body);

if (proofRecipe.needsLiveProof && !body.hasTerminalFence && !body.hasDetailsProofSource) {
  flags.push({
    level: "risk",
    reason: `proof recipe ${proofRecipe.kind} needs live terminal output or embedded proof source`,
  });
}

const score = scoreFromFlags(flags);
const verdict = score >= 85 && !flags.some((flag) => flag.level === "blocker")
  ? "strong"
  : score >= 70 && !flags.some((flag) => flag.level === "blocker")
    ? "promising"
    : score >= 50
      ? "needs-work"
      : "poor-fit";

const receipt = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  workflowPath: context.workflowPath,
  repoPath: context.repoPath,
  outputPath: context.outputPath,
  validationBaseSha: baseSha,
  headSha: preflight?.headSha ?? null,
  score,
  verdict,
  stats,
  changedFiles: files,
  proofRecipe,
  currentEvidence: {
    signal: body.proofSignal,
    hasRealCallChainEvidence: body.hasRealCallChainEvidence,
    hasBoundaryControls: body.hasBoundaryControls,
    hasSyntheticEvidence: body.hasSyntheticEvidence,
  },
  duplicateCheckApplicable,
  duplicateCheckPath: duplicateCheck ? duplicateCheckPath : null,
  flags,
  recommendations: [
    ...(duplicateCheckApplicable && !duplicateCheck ? ["Run openclaw-duplicate-check before the human gate."] : []),
    ...(preflight?.status === "passed" ? [] : ["Run openclaw-preflight and fix blockers before publishing."]),
    ...(proofRecipe.needsLiveProof && !body.hasTerminalFence && !body.hasDetailsProofSource
      ? ["Add live or proof-script evidence that exercises the real changed path."]
      : []),
  ],
};

const output = path.resolve(args.output || path.join(context.outputPath, "candidate-score.json"));
writeJson(output, receipt);
console.log(JSON.stringify({
  score: receipt.score,
  verdict: receipt.verdict,
  output,
  blockers: flags.filter((flag) => flag.level === "blocker").length,
  risks: flags.filter((flag) => flag.level === "risk").length,
}, null, 2));
