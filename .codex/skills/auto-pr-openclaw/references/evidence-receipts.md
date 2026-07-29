# Candidate and Proof Receipts

## Contents

- Candidate plan
- Comparable proof input
- Calibration samples
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
  Deterministic preflight and the human GitHub write gate remain mandatory.
