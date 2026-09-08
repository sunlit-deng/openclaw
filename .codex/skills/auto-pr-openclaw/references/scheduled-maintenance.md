# Scheduled existing-PR maintenance

Use for an unattended run maintaining published PRs. The saved task supplies
account scope, cadence, and publication authorization. It does not authorize
new PRs, comments, review requests, or gate bypasses unless explicitly stated.

## Select concrete work

- List eligible open PRs once using compact live metadata. Read detailed
  reviews, unresolved inline threads, changed hunks, and failed CI logs only
  for the selected PR. Include edited comments and check reruns when detecting
  changes; a comment count or PR `updatedAt` alone is not a reliable cursor.
- Resolve real mergeability before ranking candidates: a bulk
  `gh pr list --json mergeable` returns `UNKNOWN` for every PR because GitHub
  computes it asynchronously, so a list alone can never reveal a conflict.
  Run `scripts/openclaw-pr-mergeability.mjs --root <accounts root>
  --output <automation-dir>/mergeability-report.json` once; it queries per
  profile and resolves each PR's `mergeable` through bounded concurrent
  per-PR view retries, printing `conflicting`, `unknown`, and `mergeable`
  groups. Only a resolved `CONFLICTING` (or `DIRTY` merge state) counts as a
  real conflict input for selection; PRs still `UNKNOWN` after the retries are
  neither conflicts nor clean and stay out of conflict priority until
  resolved. A report with `scanStatus: "partial"` is not a no-conflict result:
  keep its `errors`, persist the report, and do not treat failed or omitted PRs
  as clean. Known conflicts in a partial report may still be selected, but if
  no known conflict is available, record the scan as externally blocked and
  retry it rather than reporting `no-action`. Record the resolved state and
  scan status per PR in the maintenance index.
- Work on a real conflict, actionable reviewer finding, PR-caused CI failure,
  or specifically requested missing proof. A non-Platinum grade alone is not
  a repair request. Check older findings against current code before discarding
  them as stale. A pending check or unknown mergeability is not a failure.
- Prefer finishing a safely resumable validated change, then concrete P1s,
  real conflicts, and remaining actionable findings. Within the same priority,
  use oldest last-attempt time so one newer PR cannot starve the rest.
- A resumable workflow may preempt conflict work only when it has a concrete
  next step and the current run makes material progress. If its head, finding,
  blocker, and next action are unchanged, perform only a lightweight recheck
  and allow the oldest resolved conflict to be selected; do not let an
  unchanged `in-progress` record permanently preempt the conflict queue.
- Default to one PR through publication per run. If it has a documented hard
  blocker, select at most one alternative. Do not deeply analyze every PR
  before starting the selected repair.

## Resume without rebuilding the workspace

- Read the selected workflow's context pack and saved progress before intake
  mutates anything. Compare live remote head, saved starting head, local HEAD,
  uncommitted changes, and any active rebase. A local HEAD differing from the
  remote is expected after a saved repair; it is not sufficient evidence of
  staleness. Never discard useful work merely to start from live head again.
- Reuse the canonical worktree and shared clone/store. A dirty main checkout
  does not prevent non-checkout Git operations or adding an isolated worktree.
  Do not reset or clean that checkout. Inspect the helper's actual refusal
  before choosing a recovery operation.
- If recovery needs a clean worktree, preserve the old branch, tracked patch,
  needed untracked artifacts, and receipt paths first. Use the existing clone
  and a documented recovery worktree; record its path in progress. Do not
  create a dated workspace root, fresh full clone, or private package store
  every run. Never remove an active worktree or another task's lock.
- Check disk space before a large install/clone. Resource shortage needs an
  exact resource diagnosis, not another clone. Keep account tokens out of
  progress files. Check for another active writer before mutating a PR.

## Repair and validate the selected path

- Start a new review-driven code repair on a fresh base: fetch once, pin the
  current target SHA, and rebase before implementing the requested change.
  This is not chasing `main`; the pinned SHA remains the validation base. Do
  not use the clean rebase-only publisher in this case, because code changes
  follow the rebase. If saved local repair exists, resume and safely commit it
  first, then perform one fresh-base rebase before additional review-driven
  code edits. For a conflict-free rebase, proceed directly to the repair; for
  conflicts, restore patch equivalence through the conflict path first, then
  implement the review fix unless it is part of the same declared resolution.
  Body-only, proof-only, no-op, and pure analysis paths do not require a
  rebase merely because main advanced.
- For conflicts, pin the target once and record each conflict before resolving
  it. Declare justified maintenance files and matching validation before
  `finish`. Preserve the original patch and rejection receipt. On a failed
  receipt, inspect the exact failing invariant and file/patch difference;
  correct a demonstrable setup, implementation, or plan error within the
  existing permitted scope, then regenerate the receipt. One justified retry
  is the default. Never edit a receipt to claim success, relabel unknown drift
  as external, expand scope merely to silence the check, or start broad lanes
  to get around an equivalence refusal. See `review-gates.md` for invariants.
- A gate blocker is a repair input before it becomes an escalation. Fix stale
  body binding, task-owned identity errors, missing scoped evidence, or local
  failures when the remedy is established. Do not rewrite foreign commits.
- Reuse valid receipts only through their fingerprint/HEAD rules. Body-only
  edits need body validation and a fresh gate; clean patch-equivalent rebases
  use the dedicated receipt/publisher. Never relabel old runtime proof as a
  newly executed exact-head run. Collect new proof when invalidated or when a
  specific review request demands it; do not build a larger proof harness
  solely to chase a grade.
- Commit completed task-owned code before final HEAD-bound proof/preflight
  and gate generation. Apply required squash before those final receipts.
  Follow the selected preflight profile's validation/cache rules. If the gate
  permits the already-authorized update, invoke the publisher immediately and
  verify remote head/body. Local tests passing is not publication.

## Bounded retries and durable progress

Keep a compact maintenance index under the existing automation's directory,
with per-PR evidence in its workflow outputs. Save after each meaningful phase:
PR/account, remote starting SHA, local SHA, worktree/workflow paths, pinned base,
review identifiers and content digest, CI run/check identifiers and states,
actionable findings, changed files, commands and receipt paths, current phase,
next exact action, retry trigger, last-attempt time, and elapsed phase times.
This progress is orchestration state, never publication evidence.

Use `published` only after a material remote branch/body update and verification;
use `no-action` for a verified no-op. `in-progress` records durable unfinished
work, `blocked` records a precise local failure, `external-blocked` requires
external-cause evidence, and `needs-user-decision` requires an actual decision
that cannot be derived from the repository contract. Never describe an
uncommitted patch or successful no-op publisher call as a completed repair.

For the same head, finding, blocker, and relevant environment, do not repeat a
failed heavy command without a new hypothesis or changed input. Recheck live
metadata cheaply each run. Retry external availability at a recorded time;
retry local work when the corrective action, relevant base/scope, tool version,
or evidence changes. Legacy prose-only blocked records get one fresh diagnosis
under this procedure rather than becoming permanent skip rules.

Use the task's time budget, defaulting to 45 minutes with the final 10 reserved
for validation/publication or a durable checkpoint. This is a planning budget,
not a hard process kill: keep handles for bounded commands and preserve an
active rebase safely. Do not begin another PR near the budget boundary. Every
`in-progress` checkpoint must name what changed and the next executable step;
repeated checkpoints without progress require a precise blocker report.

Report actual repair, validation, remote publication, and any required decision
briefly. Record intake/setup/fix/validation/publish durations so later tuning
uses measured bottlenecks, not model-speed guesses.
