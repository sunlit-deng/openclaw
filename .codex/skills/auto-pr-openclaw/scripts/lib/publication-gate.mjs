import path from "node:path";

function samePath(left, right) {
  return typeof left === "string"
    && typeof right === "string"
    && path.resolve(left) === path.resolve(right);
}

function sameLogin(left, right) {
  return typeof left === "string"
    && typeof right === "string"
    && left.toLowerCase() === right.toLowerCase();
}

const AGENT_EXTERNAL_CAUSES = new Set([
  "upstream",
  "infrastructure",
  "tooling",
  "unrelated-ci",
]);

function agentBypassPolicy(id, summary) {
  if (id === "preflight-status"
    && summary.preflight?.status === "failed"
    && summary.preflight?.receiptValid === true) {
    return new Set(["upstream", "infrastructure", "tooling", "unrelated-ci"]);
  }
  if (/^zeroclaw-review-intake-lookup-\d+$/.test(id)
    && summary.reviewIntake?.lookupErrorCount > 0) {
    const index = Number(id.match(/(\d+)$/)?.[1]) - 1;
    if (!summary.reviewIntake.lookupErrors?.[index]) return null;
    return new Set(["infrastructure", "upstream"]);
  }
  return null;
}

function sameStringSet(left, right) {
  return Array.isArray(left)
    && left.length === right.size
    && new Set(left).size === right.size
    && left.every((value) => right.has(value));
}

/**
 * Validate an agent's evidence-backed decision to waive external-only gate
 * blockers. The allowlist is intentionally narrower than the legacy manual
 * workflow-rule bypass: it cannot waive repository, identity, body, duplicate,
 * maintainer-access, target, or remote-lease safety checks.
 */
export function validateAgentPublicationJudgment({
  judgment,
  summary,
  workflow,
  workflowPath,
  gateSummaryPath,
  repoPath,
  currentHead,
  bodySha,
} = {}) {
  const problems = [];
  const bypassedBlockerIds = [];
  if (!judgment || typeof judgment !== "object" || Array.isArray(judgment)) {
    return { valid: false, problems: ["agent publication judgment is missing or invalid"], bypassedBlockerIds };
  }
  if (Number(judgment.schemaVersion) !== 1) problems.push("agent publication judgment schemaVersion is unsupported");
  if (judgment.kind !== "agent-publication-judgment") problems.push("agent publication judgment kind is invalid");
  if (judgment.decision !== "publish") problems.push("agent publication judgment decision is not publish");
  if (judgment.confidence !== "high") problems.push("agent publication judgment confidence must be high");
  if (typeof judgment.agent !== "string" || !judgment.agent.trim()) problems.push("agent publication judgment agent is missing");
  if (typeof judgment.reason !== "string" || !judgment.reason.trim()) problems.push("agent publication judgment reason is missing");
  if (!samePath(judgment.workflowPath, workflowPath)) problems.push("agent judgment workflowPath does not match the current workflow");
  if (!samePath(judgment.gateSummaryPath, gateSummaryPath)) problems.push("agent judgment gateSummaryPath does not match the current gate receipt");
  if (!samePath(judgment.repoPath, repoPath)) problems.push("agent judgment repoPath does not match the current repository");
  if (judgment.headSha !== currentHead) problems.push("agent judgment HEAD does not match the current HEAD");
  if (judgment.bodySha256 !== bodySha) problems.push("agent judgment PR body hash does not match the current body");
  const expectedBase = workflow?.validationBaseSha || workflow?.baseSha;
  if (expectedBase && judgment.validationBaseSha !== expectedBase) problems.push("agent judgment validation base does not match the workflow base");

  const blockers = summary?.blockers;
  const details = summary?.blockerDetails;
  if (!Array.isArray(blockers)) problems.push("gate summary blockers are missing");
  if (!Array.isArray(details)) problems.push("gate summary blocker details are missing");
  if (Array.isArray(blockers) && Array.isArray(details) && blockers.length !== details.length) {
    problems.push("gate summary blocker details do not match the blocker list");
  }
  if (summary?.agentExternalBypass?.eligible !== true) {
    problems.push("gate summary does not mark agent external bypass as eligible");
  }

  const detailById = new Map();
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (!detail || typeof detail !== "object" || typeof detail.id !== "string" || !detail.id) {
        problems.push("gate summary contains an invalid blocker detail");
        continue;
      }
      if (detailById.has(detail.id)) problems.push(`gate summary repeats blocker detail ${detail.id}`);
      detailById.set(detail.id, detail);
      if (Array.isArray(blockers) && !blockers.includes(detail.message)) {
        problems.push(`blocker detail ${detail.id} is not present in the blocker list`);
      }
      if (detail.agentBypassAllowed !== true || !agentBypassPolicy(detail.id, summary)) {
        problems.push(`blocker ${detail.id} is not eligible for agent external-cause bypass`);
      }
    }
  }

  const entries = judgment.bypassedBlockers;
  if (!Array.isArray(entries) || entries.length === 0) {
    problems.push("agent judgment must name at least one blocker to bypass");
  } else {
    const seen = new Set();
    for (const entry of entries) {
      const id = entry?.blockerId;
      if (typeof id !== "string" || !id) {
        problems.push("agent judgment contains a blocker without blockerId");
        continue;
      }
      if (seen.has(id)) problems.push(`agent judgment repeats blocker ${id}`);
      seen.add(id);
      const detail = detailById.get(id);
      const policy = agentBypassPolicy(id, summary);
      if (!detail || !policy) {
        problems.push(`agent judgment cannot bypass blocker ${id}`);
      } else {
        if (detail.message !== entry.message) problems.push(`agent judgment message does not match blocker ${id}`);
        if (/^zeroclaw-review-intake-lookup-\d+$/.test(id)) {
          const index = Number(id.match(/(\d+)$/)?.[1]) - 1;
          if (detail.message !== summary.reviewIntake.lookupErrors?.[index]) {
            problems.push(`agent judgment message does not match review lookup evidence for ${id}`);
          }
        }
        if (!policy.has(entry.cause) || !AGENT_EXTERNAL_CAUSES.has(entry.cause)) {
          problems.push(`agent judgment cause is not allowed for blocker ${id}`);
        }
        if (entry.confidence !== "high") problems.push(`agent judgment confidence for ${id} must be high`);
        if (typeof entry.reason !== "string" || !entry.reason.trim()) problems.push(`agent judgment reason for ${id} is missing`);
        if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
          problems.push(`agent judgment evidence for ${id} is missing`);
        } else {
          for (const evidence of entry.evidence) {
            if (!evidence || typeof evidence !== "object"
              || typeof evidence.source !== "string" || !evidence.source.trim()
              || typeof evidence.reference !== "string" || !evidence.reference.trim()
              || typeof evidence.observation !== "string" || !evidence.observation.trim()) {
              problems.push(`agent judgment evidence for ${id} must include source, reference, and observation`);
            }
          }
        }
      }
      bypassedBlockerIds.push(id);
    }
    const expectedIds = new Set(Array.isArray(details) ? details.map((detail) => detail?.id).filter(Boolean) : []);
    if (seen.size !== expectedIds.size || [...expectedIds].some((id) => !seen.has(id))) {
      problems.push("agent judgment must account for every current gate blocker");
    }
    const advertisedIds = summary?.agentExternalBypass?.blockerIds;
    if (!sameStringSet(advertisedIds, expectedIds)) {
      problems.push("gate summary agent-bypass blocker IDs do not match blocker details");
    }
  }
  if (Array.isArray(judgment.residualBlockers) && judgment.residualBlockers.length > 0) {
    problems.push("agent judgment leaves residual blockers while requesting publication");
  }

  return {
    valid: problems.length === 0,
    problems,
    bypassedBlockerIds,
  };
}

/**
 * Return the reasons an already-generated gate summary cannot authorize an
 * automatic PR publication. The publisher still performs its own live checks
 * after this receipt passes.
 */
export function automaticPublicationProblems({
  summary,
  workflow,
  workflowPath,
  gateSummaryPath,
  repoPath,
  currentHead,
  currentBranch,
  bodySha,
  account,
  pushRemote,
  project,
  agentBypassApproved = false,
  agentBypassedBlockerIds = [],
} = {}) {
  const problems = [];
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return ["gate summary is missing or invalid"];
  }
  if (Number(summary.schemaVersion) !== 1) {
    problems.push(`gate summary schemaVersion ${summary.schemaVersion ?? "missing"} is unsupported`);
  }
  if (!samePath(summary.workflowPath, workflowPath)) {
    problems.push("gate summary workflowPath does not match the current workflow");
  }
  if (!samePath(summary.repoPath, repoPath)) {
    problems.push("gate summary repoPath does not match the current repository");
  }
  if (project?.github?.repo && summary.project?.repo !== project.github.repo) {
    problems.push("gate summary repository target does not match the current project");
  }
  if (summary.branch !== currentBranch) {
    problems.push("gate summary branch does not match the current branch");
  }
  if (summary.headSha !== currentHead) {
    problems.push("gate summary HEAD does not match the current HEAD");
  }
  if (summary.clean !== true) problems.push("gate summary does not confirm a clean worktree");
  if (summary.diffCheck?.status !== "passed") problems.push("gate summary does not confirm a passing git diff check");
  if (summary.rebaseOnlyFastPathActive === true) {
    problems.push("gate summary is for the clean rebase-only fast path; use its dedicated publisher");
  }

  const blockers = summary.blockers;
  if (!Array.isArray(blockers)) {
    problems.push("gate summary blockers are missing");
  } else if (blockers.length > 0 && !agentBypassApproved) {
    problems.push(`gate summary has blockers: ${blockers.join("; ")}`);
  }
  if (summary.automaticPublication?.eligible !== true && !agentBypassApproved) {
    problems.push("gate summary does not mark automatic publication as eligible");
  }
  if (agentBypassApproved && summary.agentExternalBypass?.eligible !== true) {
    problems.push("gate summary does not mark agent external bypass as eligible");
  }
  if (agentBypassApproved && Array.isArray(blockers) && blockers.length > 0) {
    const bypassed = new Set(agentBypassedBlockerIds);
    if (!Array.isArray(summary.blockerDetails)
      || summary.blockerDetails.some((detail) => !bypassed.has(detail?.id))) {
      problems.push("agent external bypass does not account for every gate blocker");
    }
  }
  if (!samePath(summary.automaticPublication?.gateSummaryPath, gateSummaryPath)) {
    problems.push("gate summary path does not match the requested gate receipt");
  }

  const expectedBase = workflow?.validationBaseSha || workflow?.baseSha;
  const preflight = summary.preflight;
  const agentApprovedPreflightFailure = agentBypassApproved && preflight?.status === "failed";
  if (!preflight || (preflight.status !== "passed" && !agentApprovedPreflightFailure)) {
    problems.push(`gate summary preflight is ${preflight?.status ?? "missing"}`);
  }
  if (preflight?.receiptValid !== true) problems.push("gate summary preflight receipt is not valid");
  if (preflight?.headSha !== currentHead) problems.push("gate summary preflight HEAD does not match the current HEAD");
  if (expectedBase && preflight?.validationBaseSha !== expectedBase) {
    problems.push("gate summary preflight validation base does not match the workflow base");
  }
  if (expectedBase && summary.workflowValidationBaseSha !== expectedBase) {
    problems.push("gate summary validation base does not match the workflow base");
  }
  if (expectedBase && summary.validationBaseSha !== expectedBase) {
    problems.push("gate summary effective validation base does not match the workflow base");
  }

  if (!samePath(summary.prBody?.path, workflow?.prBodyPath)) {
    problems.push("gate summary PR body path does not match the current workflow");
  }
  if (summary.prBody?.sha256 !== bodySha) problems.push("gate summary PR body hash does not match the current body");
  if (summary.publishInputs?.approvedHead !== currentHead) {
    problems.push("gate summary approved HEAD does not match the current HEAD");
  }
  if (summary.publishInputs?.approvedBodySha256 !== bodySha) {
    problems.push("gate summary approved body hash does not match the current body");
  }

  if (!sameLogin(summary.githubAccount?.login, account?.login)) {
    problems.push("gate summary GitHub account does not match the current account");
  }
  if (!summary.githubAccount?.pushRemote || summary.githubAccount.pushRemote !== pushRemote) {
    problems.push("gate summary push remote does not match the requested push remote");
  }

  if (!workflow?.pr) {
    if (summary.duplicateCheckApplicable !== true) {
      problems.push("gate summary does not confirm that the new PR duplicate check was required");
    }
    if (summary.duplicateCheck?.receiptValid !== true || summary.duplicateCheck?.blocking === true) {
      problems.push("gate summary does not confirm a passing non-blocking duplicate check");
    }
  } else {
    const maintainer = summary.maintainer;
    if (maintainer?.checked !== true || maintainer.maintainerCanModify !== true) {
      problems.push("gate summary does not confirm maintainer edit access");
    }
    if (!maintainer?.headRefOid) {
      problems.push("gate summary does not bind the existing PR remote HEAD");
    }
    if (maintainer?.headRefName !== currentBranch) {
      problems.push("gate summary existing PR branch does not match the current branch");
    }
    if (!sameLogin(maintainer?.headOwner, account?.login)) {
      problems.push("gate summary existing PR owner does not match the current account");
    }
  }

  return problems;
}
