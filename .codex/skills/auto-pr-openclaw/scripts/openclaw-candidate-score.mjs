#!/usr/bin/env node

import path from "node:path";
import {
  classifyProofRecipe,
  currentHead,
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
import { validateWorkflowReceipt } from "./lib/receipt-utils.mjs";

function usage() {
  return `Usage: openclaw-candidate-score.mjs --workflow PATH [--duplicate-check PATH] [--candidate-scout PATH] [--proof-receipt PATH] [--output PATH]

Scores an OpenClaw candidate for mergeability and review readiness. This is a
local diagnostic only; it does not contact GitHub or publish anything.`;
}

let args;
try {
  args = parseKeyArgs(process.argv.slice(2), {
    "--workflow": { name: "workflow" },
    "--duplicate-check": { name: "duplicateCheck" },
    "--candidate-scout": { name: "candidateScout" },
    "--proof-receipt": { name: "proofReceipt" },
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
const headSha = currentHead(context.repoPath);
const files = gitChangedFiles(context.repoPath, baseSha);
const stats = gitDiffStats(context.repoPath, baseSha);
const body = prBodyInfo(context.prBodyPath);
const preflight = readJsonIfPresent(context.preflightPath);
const duplicateCheckPath = args.duplicateCheck || path.join(context.outputPath, "duplicate-check.json");
const candidateScoutPath = args.candidateScout || path.join(context.outputPath, "candidate-scout.json");
const proofReceiptPath = args.proofReceipt || path.join(context.outputPath, "proof-receipt.json");
const duplicateCheck = duplicateCheckApplicable ? readJsonIfPresent(duplicateCheckPath) : null;
const candidateScout = readJsonIfPresent(candidateScoutPath);
const proofReceipt = readJsonIfPresent(proofReceiptPath);
const preflightValidation = validateWorkflowReceipt(preflight, {
  kind: "preflight",
  schemaVersions: [2],
  workflowPath: context.workflowPath,
  repoPath: context.repoPath,
  headSha,
  validationBaseSha: baseSha,
});
const proofValidation = validateWorkflowReceipt(proofReceipt, {
  kind: "proof receipt",
  schemaVersions: [1],
  workflowPath: context.workflowPath,
  repoPath: context.repoPath,
  headSha,
  validationBaseSha: baseSha,
});
const duplicateCheckValidation = duplicateCheckApplicable
  ? validateWorkflowReceipt(duplicateCheck, {
      kind: "duplicate check",
      schemaVersions: [1],
      workflowPath: context.workflowPath,
      validationBaseSha: baseSha,
    })
  : { valid: true, problems: [] };
const proofRecipe = classifyProofRecipe(files, body);
const flags = riskFlags(files, stats, context.workflow, preflight, duplicateCheck, body);
if (preflight && !preflightValidation.valid) {
  flags.push(...preflightValidation.problems.map((reason) => ({ level: "blocker", reason })));
}
const productionFiles = files.filter((file) =>
  /\.(?:ts|tsx|js|mjs|cjs|go|rs|py)$/.test(file) &&
  !/(?:^|\/)(?:tests?|__tests__|fixtures?)(?:\/|$)|\.(?:test|spec)\./.test(file));
const structuredProofPassed = proofReceipt?.status === "passed" && proofValidation.valid;
const candidateScoutPatchMatch = Boolean(candidateScout)
  && files.every((file) => candidateScout.expectedFiles?.includes(file));
const structuredScoutUsable = candidateScout?.schemaVersion === 1
  && candidateScoutPatchMatch
  && ["high", "possible", "ordinary", "low"].includes(candidateScout.aLikelihood);
const stableIntegration = context.workflow.pr
  ? true
  : duplicateCheckValidation.valid
    && duplicateCheck?.offline !== true
    && duplicateCheck?.summary?.likelyDuplicateCount === 0
    && (duplicateCheck?.summary?.errors?.length ?? 0) === 0;
const aReadinessSignals = {
  currentMainRepro: structuredProofPassed || candidateScout?.signals?.currentMainRepro === true,
  canonicalPrecedent: structuredProofPassed || candidateScout?.signals?.canonicalPrecedent === true,
  comparableProof: structuredProofPassed && proofReceipt.comparableBaseHead === true,
  realCallChainProof: structuredProofPassed && proofReceipt.kind === "real-call-chain",
  exactHeadNegativeControl: structuredProofPassed && proofReceipt.exactHeadNegativeControl === true,
  deterministicValidationPassed: preflight?.status === "passed" && preflightValidation.valid,
  focusedSurface: productionFiles.length > 0 && productionFiles.length <= 3 && files.length <= 5,
  noUnresolvedPolicyChoice: candidateScout?.signals?.policyNeutral === true
    || (!structuredScoutUsable && !body.hasUnresolvedPolicyChoice),
  stableIntegration: candidateScout?.signals?.stableIntegration === true || stableIntegration,
};
const missingAReadinessSignals = Object.entries(aReadinessSignals)
  .filter(([, present]) => !present)
  .map(([signal]) => signal);
const aReadinessScore = (aReadinessSignals.currentMainRepro ? 2 : 0)
  + (aReadinessSignals.canonicalPrecedent ? 2 : 0)
  + (aReadinessSignals.comparableProof ? 2 : 0)
  + (aReadinessSignals.noUnresolvedPolicyChoice ? 2 : 0)
  + (aReadinessSignals.focusedSurface ? 1 : 0)
  + (aReadinessSignals.stableIntegration ? 1 : 0);
const aReadinessEarlyStops = [
  ...(structuredScoutUsable ? candidateScout.earlyStops ?? [] : []),
  ...(!structuredScoutUsable ? ["candidate scout receipt is missing, unsupported, or does not match the implemented patch"] : []),
  ...(!structuredProofPassed ? ["structured comparable proof receipt is missing, failed, or stale"] : []),
  ...(structuredProofPassed && proofReceipt.kind !== "real-call-chain"
    ? ["proof stops at a production module boundary rather than a real call chain"]
    : []),
];
const aReadinessVerdict = aReadinessEarlyStops.length === 0 && aReadinessScore >= 9
  ? "high"
  : aReadinessScore >= 7
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
  headSha,
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
    score: aReadinessScore,
    signals: aReadinessSignals,
    missingSignals: missingAReadinessSignals,
    earlyStops: aReadinessEarlyStops,
    candidateScoutPath: candidateScout ? candidateScoutPath : null,
    proofReceiptPath: proofReceipt ? proofReceiptPath : null,
    proofReceiptProblems: proofValidation.problems,
    duplicateCheckReceiptProblems: duplicateCheckValidation.problems,
    preflightReceiptProblems: preflightValidation.problems,
    note: "This estimates review-confidence signals associated with ClawSweeper A ratings; it is not a merge gate and never guarantees a rating.",
  },
  duplicateCheckApplicable,
  duplicateCheckPath: duplicateCheck ? duplicateCheckPath : null,
  flags,
  recommendations: [
    ...(duplicateCheckApplicable && !duplicateCheck ? ["Run openclaw-duplicate-check before the human gate."] : []),
    ...(preflight?.status === "passed" ? [] : ["Run openclaw-preflight and fix blockers before publishing."]),
    ...(!candidateScout
      ? ["Run openclaw-candidate-scout before implementation for future candidates; this candidate has no structured early-screen receipt."]
      : []),
    ...(!structuredProofPassed
      ? ["Generate a passing proof-receipt.json from comparable base/head real-path evidence; PR-body wording alone cannot earn high A-readiness."]
      : []),
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
