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
import { validateWorkflowReceipt } from "./lib/receipt-utils.mjs";
import {
  commitIdentityProblems,
  ghEnv,
  publicAccount,
  resolveAccount,
} from "./lib/account-utils.mjs";
import { projectForWorkflow } from "../../../auto-pr-core/project-profile.mjs";

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
const project = projectForWorkflow(context.workflow);
const projectName = project.displayName || project.id;
const openclawDiagnostics = project.id === "openclaw";
const duplicateCheckApplicable = !context.workflow.pr;
const account = resolveAccount({ workflow: context.workflow });
const accountEnv = ghEnv(account);
const baseSha = context.workflow.validationBaseSha || context.workflow.baseSha;
const headSha = currentHead(context.repoPath);
const branch = currentBranch(context.repoPath);
const body = prBodyInfo(context.prBodyPath, project.prPolicy);
const headSubject = run("git", ["log", "-1", "--format=%s"], {
  cwd: context.repoPath,
  allowFailure: true,
}).stdout.trim();
const preflight = readJsonIfPresent(context.preflightPath);
const intakePath = context.workflow.intakePath || path.join(context.outputPath, "intake.json");
const intake = readJsonIfPresent(intakePath);
const reviewIntakeApplicable = project.id === "zeroclaw" && context.workflow.mode === "existing-pr";
const reviewIntakePath = context.workflow.reviewIntakePath || path.join(context.outputPath, "review-intake.json");
const reviewIntake = reviewIntakeApplicable ? readJsonIfPresent(reviewIntakePath) : null;
const duplicateCheckPath = args.duplicateCheck || path.join(context.outputPath, "duplicate-check.json");
const candidateScorePath = args.candidateScore || path.join(context.outputPath, "candidate-score.json");
const rebaseOnlyCheckPath = args.rebaseOnlyCheck || path.join(context.outputPath, "rebase-only-check.json");
const duplicateCheck = duplicateCheckApplicable ? readJsonIfPresent(duplicateCheckPath) : null;
const candidateScore = readJsonIfPresent(candidateScorePath);
const preflightValidation = validateWorkflowReceipt(preflight, {
  kind: "preflight",
  schemaVersions: [2],
  workflowPath: context.workflowPath,
  repoPath: context.repoPath,
  headSha,
  validationBaseSha: baseSha,
});
const duplicateCheckValidation = duplicateCheckApplicable
  ? validateWorkflowReceipt(duplicateCheck, {
      kind: "duplicate check",
      schemaVersions: [1, 2],
      workflowPath: context.workflowPath,
      validationBaseSha: baseSha,
    })
  : { valid: true, problems: [] };
const candidateScoreValidation = validateWorkflowReceipt(candidateScore, {
  kind: "candidate score",
  schemaVersions: [1],
  workflowPath: context.workflowPath,
  repoPath: context.repoPath,
  headSha,
  validationBaseSha: baseSha,
});
const candidateScoreStaleForExistingPr = Boolean(
  context.workflow.pr && candidateScore
    && (candidateScore.duplicateCheckApplicable !== false || !candidateScoreValidation.valid),
);
const rebaseOnlyCheck = readJsonIfPresent(rebaseOnlyCheckPath);
const rebaseOnlyPassedForHead = rebaseOnlyCheck?.status === "passed" && rebaseOnlyCheck.headSha === headSha;
const preflightPassed = checkStatus(preflight) === "passed" && preflightValidation.valid;
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
const duplicateCheckBlocks = duplicateCheckApplicable && (
  !duplicateCheck
  || duplicateCheck.offline === true
  || (duplicateCheck.summary?.errors?.length ?? 0) > 0
  || likelyDuplicateCount > 0
);

let maintainer = { checked: false, maintainerCanModify: context.workflow.maintainerCanModify ?? null, error: null };
if (context.workflow.pr) {
  const result = run("gh", [
    "pr", "view", String(context.workflow.pr), "--repo", project.github.repo,
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
if (!preflightPassed && !rebaseOnlyPassedForHead) {
  blockers.push(preflight?.status === "passed" ? "preflight receipt is invalid" : `preflight is ${checkStatus(preflight)}`);
}
if (project.id === "zeroclaw" && context.workflow.mode === "new-issue") {
  if (!intake) blockers.push("ZeroClaw issue intake receipt is missing");
  else if ((intake.blockers?.length ?? 0) > 0) blockers.push(...intake.blockers.map((item) => `issue intake: ${item}`));
}
if (reviewIntakeApplicable) {
  if (!reviewIntake) blockers.push("ZeroClaw review and CI intake receipt is missing");
  else {
    if (reviewIntake.kind !== "zeroclaw-review-intake") blockers.push("review intake receipt kind is invalid");
    if (reviewIntake.pr?.number !== context.workflow.pr) blockers.push("review intake PR does not match workflow PR");
    if (reviewIntake.pr?.state !== "OPEN") blockers.push("review intake was not captured while the PR was open");
    if (reviewIntake.pr?.headRefOid !== headSha) blockers.push("review intake head does not match current HEAD");
    if (reviewIntake.pr?.baseRefName !== project.github.defaultBranch) blockers.push(`review intake base is not ${project.github.defaultBranch}`);
    if (reviewIntake.untrustedGithubInput !== true) blockers.push("review intake does not record untrusted GitHub input handling");
    if ((reviewIntake.lookupErrors ?? []).length > 0) blockers.push(...reviewIntake.lookupErrors);
  }
}
if (!rebaseOnlyPassedForHead) blockers.push(...preflightValidation.problems);
if (rebaseOnlyGateRequired && rebaseOnlyCheck && rebaseOnlyCheck.status !== "passed") blockers.push(`rebase-only check is ${rebaseOnlyCheck.status}`);
if (rebaseOnlyGateRequired && rebaseOnlyCheck?.headSha && rebaseOnlyCheck.headSha !== headSha) blockers.push("rebase-only check head does not match current HEAD");
if (context.workflow.pr && maintainer.maintainerCanModify !== true) blockers.push("maintainerCanModify is not confirmed true");
if (body.sha256 !== context.workflow.prBodySha256 && context.workflow.prBodySha256) blockers.push("PR body changed since workflow validation");
for (const problem of commitIdentityProblems(identities, account)) blockers.push(problem);
if (duplicateCheckApplicable && !duplicateCheck) blockers.push("duplicate-check receipt is missing");
else if (duplicateCheck?.offline === true) blockers.push("duplicate-check is offline planning only");
else if ((duplicateCheck?.summary?.errors?.length ?? 0) > 0) blockers.push("duplicate-check has unresolved GitHub lookup errors");
else if (duplicateCheckBlocks) blockers.push("duplicate-check found likely duplicates");
if (duplicateCheckApplicable) blockers.push(...duplicateCheckValidation.problems);
if (openclawDiagnostics && candidateScore && !candidateScoreStaleForExistingPr) blockers.push(...candidateScoreValidation.problems);
if (openclawDiagnostics && !candidateScoreStaleForExistingPr && candidateScore?.verdict && ["needs-work", "poor-fit"].includes(candidateScore.verdict)) {
  blockers.push(`candidate score verdict is ${candidateScore.verdict}`);
}

const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  workflowPath: context.workflowPath,
  project: { id: project.id, name: projectName, repo: project.github.repo, defaultBranch: project.github.defaultBranch },
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
    receiptValid: preflightValidation.valid,
    receiptProblems: preflightValidation.problems,
  } : null,
  intake: project.id === "zeroclaw" && context.workflow.mode === "new-issue" ? {
    path: intakePath,
    present: Boolean(intake),
    issue: intake?.issue?.number ?? null,
    relatedOpenPrCount: intake?.relatedOpenPrs?.length ?? 0,
    blockers: intake?.blockers ?? [],
  } : null,
  reviewIntake: reviewIntakeApplicable ? {
    path: reviewIntakePath,
    present: Boolean(reviewIntake),
    pr: reviewIntake?.pr?.number ?? null,
    headRefOid: reviewIntake?.pr?.headRefOid ?? null,
    activeChangeRequestCount: reviewIntake?.activeChangeRequests?.length ?? 0,
    failedCheckCount: reviewIntake?.failedChecks?.length ?? 0,
    lookupErrorCount: reviewIntake?.lookupErrors?.length ?? 0,
    activeChangeRequests: reviewIntake?.activeChangeRequests ?? [],
    failedChecks: reviewIntake?.failedChecks ?? [],
    lookupErrors: reviewIntake?.lookupErrors ?? [],
  } : null,
  rebaseOnlyCheck: rebaseOnlyCheck ? {
    path: rebaseOnlyCheckPath,
    status: rebaseOnlyCheck.status,
    headSha: rebaseOnlyCheck.headSha,
    targetSha: rebaseOnlyCheck.targetSha,
    blockers: rebaseOnlyCheck.blockers ?? [],
    active: rebaseOnlyPassedForHead,
  } : null,
  duplicateCheckApplicable,
  duplicateCheck: duplicateCheck ? {
    path: duplicateCheckPath,
    likelyDuplicateCount,
    rawLikelyDuplicateCount: duplicateCheck.summary?.rawLikelyDuplicateCount ?? likelyDuplicateCount,
    reviewedLikelyDuplicateCount: duplicateCheck.summary?.reviewedLikelyDuplicateCount ?? 0,
    reviewedPrs: duplicateCheck.reviewedPrs ?? [],
    relatedOpenPrCount,
    blocking: duplicateCheckBlocks,
    receiptValid: duplicateCheckValidation.valid,
    receiptProblems: duplicateCheckValidation.problems,
  } : null,
  candidateScore: candidateScore && openclawDiagnostics ? {
    path: candidateScorePath,
    score: candidateScore.score,
    verdict: candidateScore.verdict,
    clawsweeperAReadiness: candidateScore.clawsweeperAReadiness?.verdict ?? null,
    staleForExistingPr: candidateScoreStaleForExistingPr,
    receiptValid: candidateScoreValidation.valid,
    receiptProblems: candidateScoreValidation.problems,
  } : null,
  maintainer,
  blockers,
  publishInputs: {
    approvedHead: headSha,
    approvedBodySha256: body.sha256,
    workflowRuleBypass: {
      flag: "--allow-workflow-rule-bypass",
      reasonFlag: "--workflow-rule-bypass-reason",
      scope: "current publish attempt",
      explicitUserInstructionRequired: true,
    },
  },
};

// Ready-to-copy normal publish command for the human gate. New PR creation also
// needs --title and --head; propose them from the head commit subject and the
// selected account so approval never stalls on publisher argument discovery.
// The title is provisional: the human gate must check it against the issue's
// semantic type and .github/pull_request_template.md before publishing.
// An explicit workflow-rule bypass may omit the approval-input flags.
const publishCommandParts = [
  "node ./.codex/skills/auto-pr-openclaw/scripts/publish-openclaw-pr.mjs",
  `--workflow ${context.workflowPath}`,
  `--approved-head ${headSha}`,
  `--approved-body-sha ${body.sha256}`,
  `--push-remote ${account.pushRemote || account.profile}`,
];
if (!context.workflow.pr) {
  publishCommandParts.push(`--title ${JSON.stringify(headSubject)}`);
  publishCommandParts.push(`--head ${account.login}:${branch}`);
}
const publishCommand = publishCommandParts.join(" \\\n  ");
summary.publishInputs.command = publishCommand;

const outputJson = path.resolve(args.outputJson || path.join(context.outputPath, "gate-summary.json"));
const outputMd = path.resolve(args.outputMd || path.join(context.outputPath, "gate-summary.md"));
writeJson(outputJson, summary);

const md = `# ${projectName} Human Gate Summary

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
- issue intake: ${summary.intake ? (summary.intake.present ? `${summary.intake.relatedOpenPrCount} related open PRs` : "missing") : "not applicable"}
- review/CI intake: ${summary.reviewIntake ? (summary.reviewIntake.present ? `${summary.reviewIntake.activeChangeRequestCount} active change requests, ${summary.reviewIntake.failedCheckCount} failed or pending checks${summary.reviewIntake.lookupErrorCount ? `, ${summary.reviewIntake.lookupErrorCount} lookup errors` : ""}` : "missing") : "not applicable"}
- failed-preflight bypass: ${preflight?.status === "failed" && preflight.headSha === headSha ? "available only with explicit user approval for this HEAD and body hash" : "not applicable"}
- workflow-rule bypass: available only after an explicit user instruction for this publish; add \`--allow-workflow-rule-bypass --workflow-rule-bypass-reason \"<reason>\"\`
- rebase-only check: ${rebaseOnlyCheck ? `${rebaseOnlyCheck.status}${rebaseOnlyPassedForHead ? " (active fast path)" : ""}` : "missing"}
- rebase-only receipt: \`${rebaseOnlyCheckPath}\`
- duplicate check: ${duplicateCheckApplicable ? (duplicateCheck ? `${summary.duplicateCheck.likelyDuplicateCount} unreviewed likely duplicates, ${summary.duplicateCheck.relatedOpenPrCount} related open PRs${summary.duplicateCheck.reviewedLikelyDuplicateCount ? `; ${summary.duplicateCheck.reviewedLikelyDuplicateCount} manually reviewed matches` : ""}${summary.duplicateCheck.blocking ? "" : " (advisory)"}` : "missing") : "not applicable (existing PR)"}
- candidate score: ${openclawDiagnostics ? (candidateScore ? (candidateScoreStaleForExistingPr ? "stale pre-existing-PR receipt (ignored; rerun scoring)" : `${candidateScore.score} (${candidateScore.verdict})`) : "missing") : "not applicable"}
- ClawSweeper A-readiness: ${openclawDiagnostics ? `${candidateScore?.clawsweeperAReadiness?.verdict ?? "missing"} (advisory)` : "not applicable"}
- maintainer edit: ${maintainer.checked ? String(maintainer.maintainerCanModify) : maintainer.maintainerCanModify === null ? "not checked" : String(maintainer.maintainerCanModify)}

## Commit Identity

- account: ${account.configured ? `\`${account.profile}\`` : "`legacy gh auth`"} (${account.username} <${account.email}>)
${mdList(identities.map((identity) => `\`${identity.sha.slice(0, 12)}\` author=${identity.authorName} <${identity.authorEmail}> committer=${identity.committerName} <${identity.committerEmail}>`))}

## PR Body

- path: \`${context.prBodyPath}\`
- SHA-256: \`${body.sha256}\`
- evidence section: ${body.hasEvidenceSection ? "yes" : "no"}
- terminal/proof source: ${body.hasTerminalFence || body.hasDetailsProofSource ? "yes" : "no"}
- AI policy: ${body.aiDisclosure === "forbidden-footer" ? (body.hasForbiddenAiFooter ? "forbidden footer found" : "no AI attribution footer") : body.hasAiMarker ? "required marker present" : "not configured"}

## PR Title

- provisional proposal from HEAD commit subject: ${headSubject ? `\`${headSubject}\`` : "(empty)"}
- review against \`.github/pull_request_template.md\` before publishing: feature issues use feat, incorrect existing behavior or regressions use fix; the commit subject is not authoritative

## Blockers

${mdList(blockers)}

## Publish Approval Inputs

- approved HEAD: \`${headSha}\`
- approved body SHA-256: \`${body.sha256}\`

### Publish command (run after explicit approval, or after an explicit workflow-rule override)

\`\`\`bash
${publishCommand}
\`\`\`

Do not push or update the PR body until the user explicitly approves this HEAD and body hash, unless the user has explicitly instructed this workflow to bypass its local rules. Comments and review requests always require a separate explicit request. A workflow-rule bypass covers only this publish attempt and does not authorize \`@clawsweeper re-review\` or other unrelated writes.
`;

fs.writeFileSync(outputMd, md, "utf8");
console.log(JSON.stringify({
  outputMd,
  outputJson,
  blockers: blockers.length,
  approvedHead: headSha,
  approvedBodySha256: body.sha256,
}, null, 2));
