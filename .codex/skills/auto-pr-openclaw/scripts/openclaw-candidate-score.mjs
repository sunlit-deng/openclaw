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
const changedLines = stats.insertions + stats.deletions;
const aReadinessSignals = {
  realCallChainProof: body.hasRealCallChainEvidence,
  beforeAfterProof: body.hasBeforeAfterEvidence,
  exactHeadProof: body.hasExactHeadEvidence,
  canonicalPrecedent: body.hasCanonicalPrecedent,
  deterministicValidationPassed: preflight?.status === "passed",
  focusedSurface: files.length <= 5 && changedLines <= 300,
  noUnresolvedPolicyChoice: !body.hasUnresolvedPolicyChoice,
};
const missingAReadinessSignals = Object.entries(aReadinessSignals)
  .filter(([, present]) => !present)
  .map(([signal]) => signal);
const aReadinessVerdict = missingAReadinessSignals.length === 0
  ? "high"
  : missingAReadinessSignals.length <= 2
    ? "possible"
    : "ordinary";

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
    hasBeforeAfterEvidence: body.hasBeforeAfterEvidence,
    hasExactHeadEvidence: body.hasExactHeadEvidence,
    hasCanonicalPrecedent: body.hasCanonicalPrecedent,
    hasUnresolvedPolicyChoice: body.hasUnresolvedPolicyChoice,
    hasSyntheticEvidence: body.hasSyntheticEvidence,
  },
  clawsweeperAReadiness: {
    advisoryOnly: true,
    verdict: aReadinessVerdict,
    signals: aReadinessSignals,
    missingSignals: missingAReadinessSignals,
    note: "This estimates review-confidence signals associated with ClawSweeper A ratings; it is not a merge gate and never guarantees a rating.",
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
    ...(!body.hasBeforeAfterEvidence
      ? ["Capture before-fix and after-fix output through the same production entrypoint and input when feasible."]
      : []),
    ...(!body.hasExactHeadEvidence
      ? ["Record the tested head SHA in Evidence so ClawSweeper can tie runtime proof to the reviewed patch."]
      : []),
    ...(!body.hasCanonicalPrecedent
      ? ["Name the merged sibling, canonical helper, or established contract that makes the patch pattern-consistent; if none exists, explain the governing upstream limit or invariant."]
      : []),
    ...(body.hasUnresolvedPolicyChoice
      ? ["Resolve or narrow new defaults, thresholds, and compatibility choices before publication when possible; otherwise expect ordinary maintainer-review calibration."]
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
