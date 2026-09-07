# Scheduled candidate discovery and publication

Use for an authorized unattended task that creates new contributor PRs. Existing
PR maintenance belongs to its separate task. Preserve the saved account quota,
identity policy, and all new-PR publication gates.

## Cheap screen before expensive setup

1. Check live account capacity before mining. If no permitted account has room,
   save the counts and stop before fetching, setup, or implementation. A failed
   count query is unknown capacity, never zero. Detect another candidate task
   writing the same lane/account before creating a PR; do not break its lock.
2. Resume a viable unpublished workflow before finding new work. Recheck its
   issue/duplicate/ownership state and whether its behavior is now fixed on
   main. Preserve local repairs and exact evidence. If it has a published PR,
   hand it off in local state and leave subsequent changes to maintenance.
3. Refresh and pin main once. Reuse the shared clone and package store. Inspect
   changed metadata and cached candidate decisions first. Default to six cheap
   candidates, two detailed investigations, and one implementation per run;
   these are exploration limits, not a reason to lower acceptance criteria.
4. Before creating a worktree or installing dependencies, use live gh searches
   for the concrete issue/behavior, target file, and helper/API names. Inspect
   plausible matches and recent merged work for exact behavior or regression
   coverage. This is an early read-only screen; still generate the required
   formal duplicate receipt once a selected workflow exists. Run that receipt
   before implementation, not after tests. Title-only search is insufficient.
5. Reject an exact implementation duplicate or current-main fix. Same-file
   overlap alone is integration risk, not duplication. Prefer unclaimed work;
   distinguish an explicit active implementation claim from a generic label.
   Do not repeatedly poll crowded queueable labels. If the bounded issue
   shortlist yields nothing, inspect at most one focused sibling gap suggested
   by a recent merged pattern, within the same budget.
6. For a concrete candidate, run scout and assess current-main reproduction,
   canonical contract, smallest patch, and runnable proof before expensive
   setup. No full score/body work is needed for every rejected idea. Produce
   candidate score after the selected workflow has the artifacts it scores.

## Prove feasibility and then deliver

- Write the intended production entrypoint, identical base/head input, expected
  observations, negative control, and required runtime before implementation.
  Check required tools/services first. A module-only proof must not be described
  as gateway, UI, paired-node, or CLI-to-Docker proof. If the behavior requires
  that integration boundary, establish a feasible local path before investing
  in a patch. Follow the existing highest-real-local-boundary fallback honestly;
  do not add external credentials or a new infrastructure project just to
  manufacture a high score.
- Ownership, authorization, persistence, and compatibility changes need an
  existing contract or maintainer direction. A high scout score is not evidence
  that a missing contract has been settled. Read the relevant contract before
  coding; do not tune score weights from a single outcome.
- After selection, implement and fix local test or tooling failures within the
  planned scope. A local gate failure stops publication, not repair. Retain the
  exact failure and change an input before retrying. If broad validation or a
  new platform setup materially exceeds the plan, save a precise blocker or
  checkpoint instead of switching through profiles until one passes.
- Commit task-owned code and perform required squash before final HEAD-bound
  proof, preflight, and gate. Let preflight run/reuse the applicable checks;
  avoid duplicate manual heavy lanes and optional AI review as a release gate.
- Just before creation, recheck live duplicate/main-overlap risk and account
  capacity. Main advancing alone does not invalidate the pinned base; inspect
  relevant overlap rather than starting another blind rebase/proof cycle.
- Publish with the skill publisher when authorized gates pass. If a create
  response is uncertain, look for the PR by exact owner/head before retrying;
  never create a second PR because a response timed out. Verify remote body,
  head, author, ready state, and maintainer access, then save the handoff locally.

## State, retries, and outcomes

Keep a compact candidate index in the existing automation directory. Record
candidate identity (issue or behavior/file key), observed main, related PRs and
ownership signals, rejection reason, relevant source/issue changes that would
justify reopening, last checked time, workflow/account, local progress, next
command, and setup/implementation/validation/publish durations. Do not store
credentials or treat this index as gate evidence.

An exact duplicate or main-fixed candidate remains excluded until that specific
behavior changes or the competing PR is abandoned without landing. Temporary
network/runtime blocks get a retry time; unknown API results never mean no
duplicates. Recheck relevant state cheaply rather than repeating full search
history. Old prose-only records can seed the index but cannot establish live
capacity, identity, or passing receipts.

Default to a 60-minute planning budget with 15 minutes reserved for validation,
publication, or a durable checkpoint. Keep process handles; do not blindly kill
an active Git operation at the boundary. No suitable candidate is a legitimate
`no-candidate` result. Other outcomes are `published`, `capacity-full`,
`in-progress`, or a precise `blocked`/`external-blocked`/`needs-user-decision`.
Do not create filler PRs to make every run succeed. Persist enough progress to
resume one unfinished implementation instead of replacing it next run.
