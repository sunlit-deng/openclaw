# PR Workflow Performance

## End-to-end flow

New PR preparation follows this path:

1. `new-openclaw-worktree.sh` authenticates, fetches one `origin/main` snapshot,
   creates the issue worktree, seeds CodeGraph, installs dependencies, and writes
   `workflow.json`.
2. Candidate scout, duplicate search, proof receipt, and candidate score reject
   weak or crowded changes before expensive validation.
3. `openclaw-preflight.mjs` validates Git state, identity, PR body, merge risk,
   focused tests, and the selected lint/type lane. Successful heavy work is
   cached by a HEAD/base/toolchain fingerprint.
4. `openclaw-gate-summary.mjs` creates the publication gate receipt. When its
   blockers are empty and `automaticPublication.eligible` is true, the normal
   path proceeds without a second approval. If blockers remain, the agent can
   create a bound judgment receipt only for allowlisted, evidence-backed
   external causes; all other blocked or stale receipts use the human fallback.
5. `publish-openclaw-pr.mjs --auto-if-ready` revalidates the gate-bound
   current HEAD/body, optionally validates the agent external-cause judgment,
   pushes once, creates or updates the PR through REST, and verifies the remote
   body and maintainer-edit setting.

Existing PR maintenance starts at `prepare-openclaw-pr-worktree.mjs`, then uses
the same proof, preflight, gate, and publisher stages. A conflict-free rebase
uses the separate patch-equivalence fast path and skips the general preflight.

## Measured amplification points

### Duplicate screening

The duplicate checker can derive up to 16 queries. The previous implementation
ran as many as 32 search requests and 20 PR-file detail requests serially: up
to 52 network process waits. Reads now use ordered, bounded concurrency with a
default width of four (configurable with `OPENCLAW_GH_READ_CONCURRENCY`, capped
at eight). The worst-case wait topology changes from 52 serial waves to at most
13 waves without weakening any query or detail check.

The v2 duplicate receipt also stores result numbers per query, then stores each
related PR or issue once. It records only changed-file counts and actual overlap
for related PRs instead of copying every file from up to 20 PRs. This removes
the largest variable token multiplier while retaining duplicate evidence.

### Preflight receipts

A command previously retained up to 12,000 characters in each of `stdout`,
`stderr`, and `output`, then appeared in both `checks` and `heavyChecks`. This
could copy roughly 72,000 characters per heavy command into `preflight.json`,
plus another 36,000 into the cache.

The receipt now keeps one 4,000-character output tail in `heavyChecks`; the
general `checks` entry is status-only, and the cache also stores one 4,000
character tail. At the configured bounds, this reduces combined receipt/cache
log storage from about 108,000 to 8,000 characters per command (about 92.6%).
Statuses, timings, commands, exit codes, and cache fingerprints remain intact.

The first lint/type validation lane is also cached independently from the
focused test lane. If lint/type passes and a later test fails, retrying the same
HEAD/base/toolchain fingerprint reruns the failed test but reuses the successful
validation lane. The regression fixture proves the validation counter remains
at one while the test counter advances to two.

### Existing-PR remote calls

Existing-PR intake now reads the PR before selecting its owner-matching account
and configures GitHub authentication once afterward. Publishing still pushes
and performs the mandatory final body/target verification, but skips the REST PATCH when
both the already-read remote body and optional title are unchanged.

## Next optimization priorities

1. Generate `context-pack.md` automatically from in-memory preflight/gate data
   instead of invoking another process and repeating Git reads after every
   material state change.
2. Measure CodeGraph sync and dependency installation separately on real
   OpenClaw worktrees before running them concurrently. Both are disk-heavy, so
   parallel execution should be evidence-driven rather than assumed faster.
3. Add per-phase timing totals to receipts (`networkMs`, `gitMs`, `validationMs`)
   so future changes optimize observed bottlenecks instead of command counts.

## Verification

Run the complete deterministic suite:

```bash
./scripts/validate.sh
```

The duplicate-check integration test asserts that live searches overlap while
never exceeding the configured concurrency. The preflight test emits oversized
fake stdout/stderr and asserts that receipts and caches omit duplicate streams
and cap the retained output.
