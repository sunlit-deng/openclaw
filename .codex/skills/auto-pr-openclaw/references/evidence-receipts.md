# Candidate and Proof Receipts

## Contents

- Candidate plan
- Comparable proof input
- Calibration samples
- Agent external-cause judgment
- Interpretation and safety

## Candidate Plan

Create this before implementation and pass it to
`scripts/openclaw-candidate-scout.sh`. Claims must be backed by inspected code,
GitHub state, or captured current-main output.

```json
{
  "schemaVersion": 1,
  "candidate": "reuse canonical provider validator",
  "mergeFit": "strong",
  "expectedFiles": [
    "src/provider/runtime.ts",
    "src/provider/runtime.test.ts"
  ],
  "currentMainRepro": {
    "status": "passed",
    "command": "repository-root reproduction command",
    "observation": "specific incorrect behavior on current main"
  },
  "canonicalPrecedent": {
    "kind": "merged-sibling",
    "reference": "PR URL, commit SHA, contract, provider limit, or symbol"
  },
  "comparableProof": {
    "status": "feasible",
    "entrypoint": "production entrypoint",
    "command": "same command planned for base and head",
    "input": "same input planned for base and head",
    "boundary": "real or loopback dependency boundary",
    "negativeControl": "unchanged exact-head control"
  },
  "policy": {
    "introducesNewPolicy": false,
    "unresolvedChoices": []
  },
  "duplicateRisk": { "status": "clear" },
  "mainOverlap": { "status": "none" },
  "dependencyChurn": false,
  "broadRefactor": false
}
```

Allowed `duplicateRisk.status` values used by the scorer are `clear` and
`duplicate`. Allowed `mainOverlap.status` values are `none`, `stable-boundary`,
and `unstable`.

## Comparable Proof Input

Capture the complete raw output in `proof-evidence.json`, then run
`scripts/openclaw-proof-receipt.sh`. Base and head must use identical command,
entrypoint, input, and dependency boundary.

```json
{
  "schemaVersion": 1,
  "kind": "real-call-chain",
  "base": {
    "sha": "<validation-base-sha>",
    "command": "repository-root proof command",
    "entrypoint": "production CLI/server/provider entrypoint",
    "input": "identical test input",
    "boundary": "localhost fixture or real external boundary",
    "exitCode": 1,
    "output": "concise captured base output"
  },
  "head": {
    "sha": "<exact-head-sha>",
    "command": "repository-root proof command",
    "entrypoint": "production CLI/server/provider entrypoint",
    "input": "identical test input",
    "boundary": "localhost fixture or real external boundary",
    "exitCode": 0,
    "output": "concise captured head output"
  },
  "negativeControl": {
    "sha": "<exact-head-sha>",
    "command": "repository-root negative-control command",
    "input": "unchanged invalid or boundary input",
    "exitCode": 1,
    "output": "captured unchanged control output"
  },
  "canonicalPrecedent": {
    "kind": "merged-sibling",
    "reference": "PR URL, commit SHA, contract, provider limit, or symbol"
  }
}
```

Use `production-module-boundary` only when a real call chain is genuinely
infeasible. It can support a merge-ready PR but does not qualify for local
`high` A-readiness.

## Agent External-Cause Judgment

When a publication gate has blockers, inspect `blockerDetails` rather than
classifying raw blocker text. An agent may request automatic publication only
when `agentExternalBypass.eligible` is true and every blocker has an explicit
allowlist entry. The supported causes are `upstream`, `infrastructure`,
`tooling`, and `unrelated-ci`. The current allowlist covers a valid but failed
preflight receipt and ZeroClaw review-intake lookup failures. It does not cover
dirty worktrees, diff failures, identity or PR-body mismatches, duplicate
uncertainty, maintainer access, target/branch identity, remote leases, or
unknown/missing receipts.

Write `agent-publication-judgment.json` bound to the exact gate summary:

```json
{
  "schemaVersion": 1,
  "kind": "agent-publication-judgment",
  "generatedAt": "2026-09-03T00:00:00.000Z",
  "agent": "codex",
  "decision": "publish",
  "confidence": "high",
  "reason": "The valid preflight receipt contains only an unrelated external infrastructure failure.",
  "workflowPath": "<absolute workflow path>",
  "gateSummaryPath": "<absolute gate summary path>",
  "repoPath": "<absolute repository path>",
  "headSha": "<exact HEAD SHA>",
  "bodySha256": "<exact PR body SHA-256>",
  "validationBaseSha": "<pinned validation base SHA>",
  "bypassedBlockers": [
    {
      "blockerId": "preflight-status",
      "message": "preflight is failed",
      "cause": "infrastructure",
      "confidence": "high",
      "reason": "The failing check is outside the changed surface and the receipt remains identity-valid.",
      "evidence": [
        {
          "source": "preflight.checks",
          "reference": "<preflight receipt or redacted log reference>",
          "observation": "The exact failure and why it is unrelated to this change."
        }
      ]
    }
  ],
  "residualBlockers": []
}
```

Every current blocker must appear exactly once with the exact ID and message,
and every entry needs a reason plus evidence with `source`, `reference`, and
`observation`. The publisher binds the judgment to workflow, repository, HEAD,
validation base, body hash, and gate-summary path. It still hard-blocks all
repository-owned and remote-safety checks and records the judgment path, hash,
and bypassed blocker IDs in `workflow.json`. If the cause is uncertain, use the
normal human-confirmation path.

## Calibration Samples

Use the latest local prediction recorded before review and the actual
ClawSweeper outcome:

```json
{
  "schemaVersion": 1,
  "samples": [
    {
      "pr": 123,
      "predictedAReadiness": "high",
      "actualRating": "B",
      "signals": {
        "currentMainRepro": true,
        "canonicalPrecedent": false,
        "comparableProof": true,
        "policyNeutral": true,
        "focusedSurface": true,
        "stableIntegration": true
      }
    }
  ]
}
```

Do not rewrite historical predictions after seeing the rating.

## Interpretation and Safety

- Keep raw output in the input artifact; `proof-receipt.json` stores hashes and
  validation results rather than duplicating potentially sensitive output.
- Redact tokens, cookies, private endpoints, account identifiers, and local
  machine paths before saving proof.
- A receipt validates structure and workflow identity. It does not make a false
  observation true; retain the actual reproduction command and output.
- `candidate-scout.json` and `proof-receipt.json` are advisory quality evidence.
  Deterministic preflight and the guarded GitHub write gate remain mandatory by
  default. An evidence-backed agent judgment may bypass only the documented
  external-cause blockers for one publish attempt; an explicit workflow-rule
  override may bypass broader local gates, with the reason recorded in
  `workflow.json`.
