# OpenClaw Candidate Selection

## Contents

- Early stop conditions
- A-likelihood score
- Executable screen
- Calibration
- Preferred candidate shapes
- Shortlist output

Use this rubric before creating a worktree or implementing a candidate when the
user prioritizes ClawSweeper A-rating likelihood. Optimize for intrinsically
high-confidence patch shapes, not rating language.

## Two Separate Judgments

- **Merge fit:** Is this a useful, narrow, non-duplicate contribution worth
  publishing?
- **A-likelihood:** Does the candidate already have the evidence and policy
  shape associated with unusually high reviewer confidence?

A candidate may be strong merge fit but ordinary A-likelihood. Keep those
judgments separate.

## Early Stop Conditions

Classify A-likelihood as `low` when any of these remains unresolved:

- the patch introduces an arbitrary cap, timeout, default, fallback, or
  compatibility policy without a repository convention, provider limit,
  upstream contract, or maintainer direction;
- accepting the patch requires a product-direction or compatibility decision;
- the only feasible proof is tests, mocks, an isolated helper, or after-only
  output with no credible base behavior;
- the patch crosses unrelated surfaces, changes dependencies/configuration, or
  needs broad refactoring;
- a canonical or crowded PR already owns the same production change;
- current `main` is actively rewriting the same code and the candidate cannot
  be reduced to a stable boundary.

Do not rescue a low-likelihood candidate with more prose or optional tests.
Redesign the patch shape or choose another candidate.

## A-Likelihood Score

Award two points for each primary signal:

1. **Current-main repro:** A concrete bug or operational gap is reproducible on
   current `main`, ideally with captured before-fix output.
2. **Canonical precedent:** A merged same-shape PR, existing public facade,
   shared helper, repository contract, provider limit, or upstream invariant
   determines the implementation.
3. **Comparable proof:** The same production entrypoint, input, and boundary
   dependency can run on the pinned base and exact head, with an unchanged
   negative control.
4. **Policy neutrality:** The patch adds no new product/config/default policy
   and leaves no compatibility choice for maintainers.

Award one point for each secondary signal:

5. **Focused surface:** The likely patch stays within one owned surface, usually
   at most three production files plus focused tests.
6. **Stable integration:** No likely duplicate, no direct current-main overlap,
   and no dependency, lockfile, schema, or migration churn.

Interpret totals:

- `9-10`: **high** — prioritize when otherwise useful and non-duplicate.
- `7-8`: **possible** — mergeable candidate, but identify the missing signal
  before implementation.
- `0-6`: **ordinary** — expect normal B calibration unless the patch shape is
  redesigned.

An early stop condition overrides the numeric total and yields `low`.

## Executable Screen

Write the candidate plan described in `references/evidence-receipts.md` and run:

```bash
scripts/openclaw-candidate-scout.sh \
  --input candidate-plan.json \
  --repo-path workspace/openclaw/repos/openclaw
```

Do not implement `low` candidates by default. For `possible`, identify and
resolve the missing primary signal before creating a worktree. Preserve
`candidate-scout.json` with the selected workflow outputs so post-implementation
scoring can compare execution with the original candidate thesis.

## Calibration

Store reviewed samples as `{pr, predictedAReadiness, actualRating, signals}` and
run `scripts/openclaw-score-calibration.sh --input clawsweeper-samples.json`.
Inspect false-positive `high` predictions and per-signal A-rate lift. Do not
change weights until at least ten representative reviews exist.

## Preferred Candidate Shapes

- complete an already-merged sibling pattern on one missed provider/channel;
- replace a local implementation with an established public facade while
  preserving behavior;
- reject malformed input using an existing canonical validator at the real
  persistence/network boundary;
- fix a narrow regression with a current-main before case and deterministic
  after case;
- restore an explicit documented contract without adding configuration or
  defaults.

Treat resource caps, fallback changes, new timeouts, compatibility migrations,
and new configuration as ordinary by default. Promote them only when the exact
value and behavior come from an existing convention or external contract.

## Shortlist Output

For every reported candidate, include:

- `A-likelihood`: high, possible, ordinary, or low;
- score and each satisfied primary/secondary signal;
- early stop condition, if any;
- canonical precedent or governing invariant;
- base/head real-path proof plan;
- unresolved policy choice;
- expected files and current-main overlap;
- merge fit separately from A-likelihood.

Never claim that a high classification guarantees a ClawSweeper rating.
