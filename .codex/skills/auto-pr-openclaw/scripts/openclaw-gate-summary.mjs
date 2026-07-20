#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  currentBranch,
  currentHead,
  gitChangedFiles,
  gitCommitIdentities,
  gitDiffStats,
  gitNameStatus,
  loadWorkflow,
  parseKeyArgs,
  prBodyInfo,
  readJsonIfPresent,
  run,
  writeJson,
} from "./lib/workflow-utils.mjs";
import {
  commitIdentityProblems,
  ghEnv,
  publicAccount,
  resolveAccount,
} from "./lib/account-utils.mjs";

function usage() {
  return `Usage: openclaw-gate-summary.mjs --workflow PATH [--duplicate-check PATH] [--candidate-score PATH] [--rebase-only-check PATH] [--output-md PATH] [--output-json PATH]

Generates the human pre-push gate summary. It performs read-only local checks
and best-effort read-only gh lookups for existing PR maintainer edit status.`;
}

function mdList(items, fallback = "- none") {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : fallback;
}

function checkStatus(preflight) {
  if (!preflight) return "missing";
  return preflight.status ?? "unknown";
}

let args;
try {
  args = parseKeyArgs(process.argv.slice(2), {
    "--workflow": { name: "workflow" },
    "--duplicate-check": { name: "duplicateCheck" },
    "--candidate-score": { name: "candidateScore" },
    "--rebase-only-check": { name: "rebaseOnlyCheck" },
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
const account = resolveAccount({ workflow: context.workflow });
const accountEnv = ghEnv(account);
const baseSha = context.workflow.validationBaseSha || context.workflow.baseSha;
const headSha = currentHead(context.repoPath);
const branch = currentBranch(context.repoPath);
const body = prBodyInfo(context.prBodyPath);
const preflight = readJsonIfPresent(context.preflightPath);
const duplicateCheckPath = args.duplicateCheck || path.join(context.outputPath, "duplicate-check.json");
const candidateScorePath = args.candidateScore || path.join(context.outputPath, "candidate-score.json");
const rebaseOnlyCheckPath = args.rebaseOnlyCheck || path.join(context.outputPath, "rebase-only-check.json");
const duplicateCheck = readJsonIfPresent(duplicateCheckPath);
const candidateScore = readJsonIfPresent(candidateScorePath);
const rebaseOnlyCheck = readJsonIfPresent(rebaseOnlyCheckPath);
const rebaseOnlyPassedForHead = rebaseOnlyCheck?.status === "passed" && rebaseOnlyCheck.headSha === headSha;
const preflightPassed = checkStatus(preflight) === "passed";
const rebaseOnlyGateRequired = !preflightPassed || Boolean(args.rebaseOnlyCheck);
const effectiveBaseSha = rebaseOnlyPassedForHead && rebaseOnlyCheck.targetSha ? rebaseOnlyCheck.targetSha : baseSha;
const files = gitChangedFiles(context.repoPath, effectiveBaseSha);
const stats = gitDiffStats(context.repoPath, effectiveBaseSha);
const nameStatus = gitNameStatus(context.repoPath, effectiveBaseSha);
const identities = gitCommitIdentities(context.repoPath, effectiveBaseSha);
const clean = run("git", ["status", "--porcelain"], { cwd: context.repoPath }).stdout.trim() === "";
const diffCheck = run("git", ["diff", "--check", `${effectiveBaseSha}...HEAD`], { cwd: context.repoPath, allowFailure: true });
const likelyDuplicateCount = duplicateCheck?.summary?.likelyDuplicateCount ?? 0;
const relatedOpenPrCount = duplicateCheck?.summary?.relatedOpenPrCount ?? 0;
const duplicateCheckBlocks = !context.workflow.pr && likelyDuplicateCount > 0;

let maintainer = { checked: false, maintainerCanModify: context.workflow.maintainerCanModify ?? null, error: null };
if (context.workflow.pr) {
  const result = run("gh", [
    "pr", "view", String(context.workflow.pr), "--repo", "openclaw/openclaw",
    "--json", "maintainerCanModify,headRepositoryOwner,headRefName,url",
  ], { allowFailure: true, env: accountEnv });
  if (result.exitCode === 0) {
    try {
      const parsed = JSON.parse(result.stdout);
      maintainer = {
        checked: true,
        maintainerCanModify: parsed.maintainerCanModify === true,
        headOwner: typeof parsed.headRepositoryOwner === "string" ? parsed.headRepositoryOwner : parsed.headRepositoryOwner?.login,
        headRefName: parsed.headRefName,
        url: parsed.url,
        error: null,
      };
    } catch (error) {
      maintainer.error = error.message;
    }
  } else {
    maintainer.error = result.stderr || result.stdout || result.error;
  }
}

const blockers = [];
if (!clean) blockers.push("worktree is not clean");
if (diffCheck.exitCode !== 0) blockers.push("git diff --check failed");
if (!preflightPassed && !rebaseOnlyPassedForHead) blockers.push(`preflight is ${checkStatus(preflight)}`);
if (preflight?.headSha && preflight.headSha !== headSha) blockers.push("preflight head does not match current HEAD");
if (rebaseOnlyGateRequired && rebaseOnlyCheck && rebaseOnlyCheck.status !== "passed") blockers.push(`rebase-only check is ${rebaseOnlyCheck.status}`);
if (rebaseOnlyGateRequired && rebaseOnlyCheck?.headSha && rebaseOnlyCheck.headSha !== headSha) blockers.push("rebase-only check head does not match current HEAD");
if (context.workflow.pr && maintainer.maintainerCanModify !== true) blockers.push("maintainerCanModify is not confirmed true");
if (body.sha256 !== context.workflow.prBodySha256 && context.workflow.prBodySha256) blockers.push("PR body changed since workflow validation");
for (const problem of commitIdentityProblems(identities, account)) blockers.push(problem);
if (duplicateCheckBlocks) blockers.push("duplicate-check found likely duplicates");
if (candidateScore?.verdict && ["needs-work", "poor-fit"].includes(candidateScore.verdict)) {
  blockers.push(`candidate score verdict is ${candidateScore.verdict}`);
}

const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  workflowPath: context.workflowPath,
  repoPath: context.repoPath,
  outputPath: context.outputPath,
  branch,
  headSha,
  validationBaseSha: effectiveBaseSha,
  workflowValidationBaseSha: baseSha,
  rebaseOnlyFastPathActive: rebaseOnlyPassedForHead,
  clean,
  diffCheck: { status: diffCheck.exitCode === 0 ? "passed" : "failed", output: diffCheck.output.trim() },
  stats,
  changedFiles: files,
  nameStatus,
  commitIdentities: identities,
  githubAccount: publicAccount(account),
  prBody: {
    path: context.prBodyPath,
    sha256: body.sha256,
    hasEvidenceSection: body.hasEvidenceSection,
    hasAiMarker: body.hasAiMarker,
    hasTerminalFence: body.hasTerminalFence,
    hasDetailsProofSource: body.hasDetailsProofSource,
  },
  preflight: preflight ? {
    path: context.preflightPath,
    status: preflight.status,
    headSha: preflight.headSha,
    validationBaseSha: preflight.validationBaseSha,
    profile: preflight.profile ?? null,
    validationDepth: preflight.validationDepth ?? null,
    heavyCacheHit: preflight.heavyCacheHit ?? null,
    freshness: preflight.freshness ?? null,
    failedBypassEligible: preflight.status === "failed" && preflight.headSha === headSha,
  } : null,
  rebaseOnlyCheck: rebaseOnlyCheck ? {
    path: rebaseOnlyCheckPath,
    status: rebaseOnlyCheck.status,
    headSha: rebaseOnlyCheck.headSha,
    targetSha: rebaseOnlyCheck.targetSha,
    blockers: rebaseOnlyCheck.blockers ?? [],
    active: rebaseOnlyPassedForHead,
  } : null,
  duplicateCheck: duplicateCheck ? {
    path: duplicateCheckPath,
    likelyDuplicateCount,
    relatedOpenPrCount,
    blocking: duplicateCheckBlocks,
  } : null,
  candidateScore: candidateScore ? {
    path: candidateScorePath,
    score: candidateScore.score,
    verdict: candidateScore.verdict,
  } : null,
  maintainer,
  blockers,
  publishInputs: {
    approvedHead: headSha,
    approvedBodySha256: body.sha256,
  },
};

const outputJson = path.resolve(args.outputJson || path.join(context.outputPath, "gate-summary.json"));
const outputMd = path.resolve(args.outputMd || path.join(context.outputPath, "gate-summary.md"));
writeJson(outputJson, summary);

const md = `# OpenClaw Human Gate Summary

Generated: ${summary.generatedAt}

## Branch

- branch: \`${branch}\`
- HEAD: \`${headSha}\`
- validation base: \`${effectiveBaseSha}\`${effectiveBaseSha !== baseSha ? ` (workflow base: \`${baseSha}\`)` : ""}
- worktree clean: ${clean ? "yes" : "no"}
- diff check: ${summary.diffCheck.status}

## Diff

- stats: ${stats.raw || "no diff stat"}
- changed files:
${mdList(nameStatus.map((line) => `\`${line}\``))}

## Checks

- preflight: ${checkStatus(preflight)}
- preflight profile: ${preflight?.profile ?? "n/a"}${preflight?.validationDepth ? ` (${preflight.validationDepth})` : ""}
- preflight receipt: \`${context.preflightPath}\`
- failed-preflight bypass: ${preflight?.status === "failed" && preflight.headSha === headSha ? "available only with explicit user approval for this HEAD and body hash" : "not applicable"}
- rebase-only check: ${rebaseOnlyCheck ? `${rebaseOnlyCheck.status}${rebaseOnlyPassedForHead ? " (active fast path)" : ""}` : "missing"}
- rebase-only receipt: \`${rebaseOnlyCheckPath}\`
- duplicate check: ${duplicateCheck ? `${summary.duplicateCheck.likelyDuplicateCount} likely duplicates, ${summary.duplicateCheck.relatedOpenPrCount} related open PRs${summary.duplicateCheck.blocking ? "" : " (advisory)"}` : "missing"}
- candidate score: ${candidateScore ? `${candidateScore.score} (${candidateScore.verdict})` : "missing"}
- maintainer edit: ${maintainer.checked ? String(maintainer.maintainerCanModify) : maintainer.maintainerCanModify === null ? "not checked" : String(maintainer.maintainerCanModify)}

## Commit Identity

- account: ${account.configured ? `\`${account.profile}\`` : "`legacy gh auth`"} (${account.username} <${account.email}>)
${mdList(identities.map((identity) => `\`${identity.sha.slice(0, 12)}\` author=${identity.authorName} <${identity.authorEmail}> committer=${identity.committerName} <${identity.committerEmail}>`))}

## PR Body

- path: \`${context.prBodyPath}\`
- SHA-256: \`${body.sha256}\`
- evidence section: ${body.hasEvidenceSection ? "yes" : "no"}
- terminal/proof source: ${body.hasTerminalFence || body.hasDetailsProofSource ? "yes" : "no"}
- AI marker: ${body.hasAiMarker ? "yes" : "no"}

## Blockers

${mdList(blockers)}

## Publish Approval Inputs

- approved HEAD: \`${headSha}\`
- approved body SHA-256: \`${body.sha256}\`

Do not push, update the PR body, comment, or request review until the user explicitly approves this HEAD and body hash.
`;

fs.writeFileSync(outputMd, md, "utf8");
console.log(JSON.stringify({
  outputMd,
  outputJson,
  blockers: blockers.length,
  approvedHead: headSha,
  approvedBodySha256: body.sha256,
}, null, 2));
