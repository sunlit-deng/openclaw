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

### Preflight process topology

Preflight previously started every child with `spawnSync`, so the network-bound
`git fetch origin <defaultBranch>` blocked all local git reads and every heavy
lane waited for the previous one. The fetch now starts inside a worker thread
(`spawnSync` stays synchronous, so the main thread can keep running the rest of
the flow) and is joined only when the freshness section needs
`origin/<defaultBranch>`. The fetch overlaps the rev-parse, status, merge-base,
diff, log, and identity reads.

A handful of repeated spawns were removed:

- The three `rev-parse` calls for HEAD, the validation base, and the observed
  upstream ref became one batched call for the local pair plus one post-fetch
  call.
- `git branch --show-current` merged into `git status --porcelain --branch`.
- `pnpm --version` and `pnpm store path` results are cached for 24 hours in
  `outputs/.preflight-tool-cache.json`; both fall back to a live run on any
  doubt.

`OPENCLAW_PREFLIGHT_FETCH_TTL_MS` (default `0` = always fetch) reuses a recent
`origin/<defaultBranch>` snapshot instead of re-fetching, recorded in
`outputs/.preflight-fetch-state.json`. Freshness checks stay advisory, so a
reused snapshot never blocks publication; it only means drift risk is observed
slightly stale. Set it while iterating quickly on a branch, leave it off for
publication-gating runs.

### Preflight timing receipts

Every preflight receipt now records `timing: { networkMs, gitMs, validationMs,
otherMs, processSpawns, totalMs }` so future changes optimize observed
bottlenecks instead of command counts. `networkMs` covers the fetch, `gitMs`
all local git calls, and `validationMs` the heavy lanes (check, focused tests,
type and extra lanes, Cargo/docs commands). Because overlapped lanes make the
per-category sums exceed elapsed time, the receipt also records
`wallNetworkMs`, `wallGitMs`, `wallValidationMs`, and `wallOtherMs`: the union
of each category's active intervals, tracked with a depth counter (first enter
stamps the start, last exit settles the elapsed time).

## Heavy lane overlap (implemented)

The check lane and focused-test lane now run concurrently. Each heavy lane
command executes inside a worker thread (`startAsyncRun`) that spawns the child
asynchronously, streams up to 1 MB of output, and reports back through a
shared `SharedArrayBuffer` flag; the main thread joins lanes with
`Atomics.wait`. When the check lane fails, the main thread sends an abort
message and the worker kills the whole child process group (POSIX) before the
test-lane result is recorded as the usual
`skipped because the selected check lane failed` entry, so receipt semantics
are unchanged. Lanes whose results are already cached are not started, and the
git fetch overlap from the previous iteration keeps working through the same
worker mechanism.

## Failure diagnostics (implemented)

Heavy-lane failures no longer force a full manual re-run for diagnosis. The
main-thread `run()` helper accepts `captureFullOutput` and the worker keeps
its untruncated capture (up to 1 MB); when any heavy check fails,
`persistFailedCheckArtifacts` writes the complete stdout/stderr to
`outputs/<issue>/<lane-slug>.failed.log` (one file per lane, overwritten on
each run) and the receipt records on the failed check: `logPath`,
`failureSummary` (up to 20 failure marker lines plus up to 20 distinct source
file paths), and `repro` (`command` + `cwd`) so the exact failing command can
be re-run verbatim if truly needed. Heavy checks keep their existing
`includeOutput: false` receipt behavior — the receipt stays small, the log
file carries the evidence.

## Cold-start typecheck elimination (2026-09-05)

2026-09-05 receipts exposed the remaining dominant cost: the first targeted
preflight in a freshly created worktree paid a cold `tsgo:core:test` shard
typecheck of 587 s (issue-127809) and 1201 s (issue-138620, which also
included a 689 s cold type-aware oxlint pass on two files), while the focused
test lane itself stayed fast (2-45 s). tsgo lanes are already incremental, but
their `.artifacts/tsgo-cache/*.tsbuildinfo` snapshots live per worktree, so
every new worktree rebuilt from scratch. The tsbuildinfo format stores source
paths relative to the tsbuildinfo file, so caches are portable across
worktrees.

Fixes:

1. `seed-openclaw-tsgo-cache.sh` copies the newest sibling worktree's
   tsbuildinfo snapshot into a freshly created worktree. tsgo re-validates the
   snapshot against current file hashes and rebuilds only stale files; a fully
   stale snapshot degrades to a normal full build, so seeding is
   correctness-safe. Both `new-openclaw-worktree.sh` and
   `prepare-openclaw-pr-worktree.mjs` call it right after `git worktree add`.
2. Fixed a targeted-planner bug found via the pr-138819 failed receipt: the
   extensions surface was mapped to the nonexistent
   `config/tsconfig/oxlint.extensions.json` (guaranteeing a failed lint lane
   on every extensions-surface PR after wasting the run). Upstream's own
   constant is `extensions/tsconfig.json`; the planner now matches it.

Remaining observed bottlenecks: cold type-aware oxlint (up to 689 s on two
files, likely CPU-starved while tsgo shards run concurrently) and the
`tsgo:core:test` shard wall time even when warm — both live inside the
upstream targeted check script and would need upstream changes.

## Next optimization priorities

1. Generate `context-pack.md` automatically from in-memory preflight/gate data
   instead of invoking another process and repeating Git reads after every
   material state change.
2. Measure CodeGraph sync and dependency installation separately on real
   OpenClaw worktrees before running them concurrently. Both are disk-heavy, so
   parallel execution should be evidence-driven rather than assumed faster.
3. Upstream OpenClaw: add a fail-only replay mode to the focused test runner so
   failure-driven iterations re-run just the failing tests.

## Content-addressed cache keys and history hygiene (2026-09-04)

Rebases and squashes change `headSha` constantly while the actual file contents
usually stay identical, so the old commit-SHA-keyed heavy cache almost never hit
(real-world hit rate: 6/128 receipts). The cache keys are now content
addressed:

- Check lane (lint/format/types): keyed on the SHA-256 of `git diff --binary
  <base>...<head>` plus root config blobs (tsconfig/lint configs). Any rebase,
  amend, or squash that preserves file contents reuses a passing check lane.
- Focused tests: keyed on `HEAD^{tree}`. Content-preserving history rewrites
  reuse passing tests; a rebase onto advanced main changes the tree and
  correctly misses.
- The whole-array `heavyFingerprint` (commit-SHA-keyed) remains as the
  conservative fast path.

Squashing before publication is now a first-class step:
`scripts/openclaw-squash-pr-commits.mjs` collapses multi-commit branches when
every commit between the pinned base and HEAD is authored and committed by the
selected account (remote PR commits are verified by login via `gh`). The squash
is tree-preserving, so the post-squash preflight runs entirely from cache.
Iterate-and-fix loops are guided to `--profile targeted`, reserving the default
`auto` escalation for the publication attempt.

## Verification

Run the complete deterministic suite:

```bash
./scripts/validate.sh
```

The duplicate-check integration test asserts that live searches overlap while
never exceeding the configured concurrency. The preflight test emits oversized
fake stdout/stderr and asserts that receipts and caches omit duplicate streams
and cap the retained output.
