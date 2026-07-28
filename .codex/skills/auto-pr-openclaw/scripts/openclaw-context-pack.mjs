#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  currentBranch,
  currentHead,
  gitChangedFiles,
  gitDiffStats,
  loadWorkflow,
  parseKeyArgs,
  prBodyInfo,
  readJsonIfPresent,
  run,
  writeJson,
} from "./lib/workflow-utils.mjs";

function usage() {
  return `Usage: openclaw-context-pack.mjs --workflow PATH [--output-md PATH] [--output-json PATH]

Writes a compact context packet for low-token task handoffs. It summarizes the
workflow, diff, receipts, PR body status, and next commands without printing
large logs or full JSON receipts.`;
}

function short(value) {
  return value ? String(value).slice(0, 12) : "";
}

let args;
try {
  args = parseKeyArgs(process.argv.slice(2), {
    "--workflow": { name: "workflow" },
    "--output-md": { name: "outputMd" },
    "--output-json": { name: "outputJson" },
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
const duplicateCheckPath = path.join(context.outputPath, "duplicate-check.json");
const candidateScorePath = path.join(context.outputPath, "candidate-score.json");
const gateSummaryPath = path.join(context.outputPath, "gate-summary.json");
const duplicateCheck = duplicateCheckApplicable ? readJsonIfPresent(duplicateCheckPath) : null;
const candidateScore = readJsonIfPresent(candidateScorePath);
const candidateScoreStaleForExistingPr = Boolean(
  context.workflow.pr && candidateScore && candidateScore.duplicateCheckApplicable !== false,
);
const gateSummary = readJsonIfPresent(gateSummaryPath);
const clean = run("git", ["status", "--porcelain"], { cwd: context.repoPath }).stdout.trim() === "";

const packet = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  workflowPath: context.workflowPath,
  repoPath: context.repoPath,
  outputPath: context.outputPath,
  mode: context.workflow.mode,
  issue: context.workflow.issue ?? null,
  pr: context.workflow.pr ?? null,
  branch: currentBranch(context.repoPath),
  headSha: currentHead(context.repoPath),
  validationBaseSha: baseSha,
  duplicateCheckApplicable,
  clean,
  stats,
  changedFiles: files,
  receipts: {
    preflight: preflight ? { path: context.preflightPath, status: preflight.status, headSha: preflight.headSha, cacheHit: preflight.heavyCacheHit ?? null } : null,
    duplicateCheck: duplicateCheck ? { path: duplicateCheckPath, summary: duplicateCheck.summary } : null,
    candidateScore: candidateScore ? {
      path: candidateScorePath,
      score: candidateScore.score,
      verdict: candidateScore.verdict,
      staleForExistingPr: candidateScoreStaleForExistingPr,
    } : null,
    gateSummary: gateSummary ? { path: gateSummaryPath, blockers: gateSummary.blockers?.length ?? null } : null,
  },
  prBody: {
    path: context.prBodyPath,
    sha256: body.sha256,
    hasEvidenceSection: body.hasEvidenceSection,
    hasAiMarker: body.hasAiMarker,
    hasTerminalFence: body.hasTerminalFence,
    hasDetailsProofSource: body.hasDetailsProofSource,
    proofSignal: body.proofSignal,
    hasRealCallChainEvidence: body.hasRealCallChainEvidence,
    hasBoundaryControls: body.hasBoundaryControls,
  },
  nextCommands: [
    ...(duplicateCheckApplicable
      ? [`./.codex/skills/auto-pr-openclaw/scripts/openclaw-duplicate-check.sh --workflow ${path.relative(process.cwd(), context.workflowPath)}`]
      : []),
    `./.codex/skills/auto-pr-openclaw/scripts/openclaw-candidate-score.sh --workflow ${path.relative(process.cwd(), context.workflowPath)}`,
    `./.codex/skills/auto-pr-openclaw/scripts/openclaw-preflight.sh --workflow ${path.relative(process.cwd(), context.workflowPath)}`,
    `./.codex/skills/auto-pr-openclaw/scripts/openclaw-gate-summary.sh --workflow ${path.relative(process.cwd(), context.workflowPath)}`,
  ],
};

const outputJson = path.resolve(args.outputJson || path.join(context.outputPath, "context-pack.json"));
const outputMd = path.resolve(args.outputMd || path.join(context.outputPath, "context-pack.md"));
writeJson(outputJson, packet);

const md = `# OpenClaw Context Pack

Generated: ${packet.generatedAt}

- workflow: \`${packet.workflowPath}\`
- repo: \`${packet.repoPath}\`
- output: \`${packet.outputPath}\`
- mode: ${packet.mode}
- issue/PR: ${packet.issue ?? "none"} / ${packet.pr ?? "none"}
- branch: \`${packet.branch}\`
- HEAD/base: \`${short(packet.headSha)}\` / \`${short(packet.validationBaseSha)}\`
- clean: ${packet.clean ? "yes" : "no"}
- diff: ${packet.stats.raw || "no diff stat"}

## Changed Files

${packet.changedFiles.length ? packet.changedFiles.map((file) => `- \`${file}\``).join("\n") : "- none"}

## Receipts

- preflight: ${packet.receipts.preflight ? `${packet.receipts.preflight.status} at \`${packet.receipts.preflight.path}\`` : "missing"}
- duplicate: ${packet.duplicateCheckApplicable ? (packet.receipts.duplicateCheck ? `${packet.receipts.duplicateCheck.summary?.likelyDuplicateCount ?? 0} likely duplicates` : "missing") : "not applicable (existing PR)"}
- score: ${packet.receipts.candidateScore ? (packet.receipts.candidateScore.staleForExistingPr ? "stale pre-existing-PR receipt (ignored; rerun scoring)" : `${packet.receipts.candidateScore.score} (${packet.receipts.candidateScore.verdict})`) : "missing"}
- gate: ${packet.receipts.gateSummary ? `${packet.receipts.gateSummary.blockers} blockers` : "missing"}

## PR Body

- path: \`${packet.prBody.path}\`
- sha256: \`${packet.prBody.sha256}\`
- evidence: ${packet.prBody.hasEvidenceSection ? "yes" : "no"}
- proof artifact: ${packet.prBody.hasTerminalFence || packet.prBody.hasDetailsProofSource ? "yes" : "no"}
- proof signal: ${packet.prBody.proofSignal}
- AI marker: ${packet.prBody.hasAiMarker ? "yes" : "no"}

## Next Commands

${packet.nextCommands.map((command) => `- \`${command}\``).join("\n")}
`;

fs.writeFileSync(outputMd, md, "utf8");
console.log(JSON.stringify({ outputMd, outputJson }, null, 2));
