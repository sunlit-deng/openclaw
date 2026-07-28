# OpenClaw Review Gates

Use these gates before pushing or updating an OpenClaw PR.

## Repository Policy Gate

- Read root `AGENTS.md` fully and every scoped `AGENTS.md` owning touched paths.
- Read `CONTRIBUTING.md` lines around Before You PR, review conversations, and AI-assisted PRs.
- Read `.github/pull_request_template.md`.
- Check `CODEOWNERS` if touching restricted or sensitive paths.

## Duplicate and Canonical Gate

- This gate applies only to unpublished candidates and new PR preparation. Once `workflow.pr` identifies an already-published PR, skip duplicate searches entirely for score-driven changes, review feedback, proof updates, CI fixes, rebases, and re-review preparation. Ignore any stale `duplicate-check.json` in that workflow.
- Use `gh` for GitHub reads by default. Prefer `gh issue view`, `gh pr view`, `gh pr diff`, `gh pr checks`, `gh run view`, and `gh api`; use another GitHub tool only when `gh` is unavailable, unauthenticated, or missing the needed capability.
- Search linked issues, related PRs, latest comments, and ClawSweeper comments for canonical work.
- Before claiming a PR is not duplicate, verify current head SHA, actual changed files, and whether sibling PRs solve the same remaining problem.
- When an unpublished-candidate workflow exists, run `scripts/openclaw-duplicate-check.sh --workflow <outputs>/workflow.json`. Keep `duplicate-check.json` with the output artifacts. A likely duplicate count above zero is a stop-and-triage signal, not something to wave away in prose.

## Candidate Score Gate

- Run `scripts/openclaw-candidate-score.sh --workflow <outputs>/workflow.json` after the PR body draft and changed files exist. This writes `candidate-score.json`.
- Treat `strong` and `promising` as publishable only when the applicable gates pass: duplicate and validation for unpublished candidates, validation for existing PR maintenance.
- Treat `needs-work` as a local fix signal: tighten scope, add matching proof, add focused tests, or, for an unpublished candidate, resolve duplicate risk before publication.
- Treat `poor-fit` as a likely drop or redesign signal unless the user explicitly wants to pursue a high-risk PR.
- The score is advisory; deterministic blockers from preflight, applicable unpublished-candidate duplicate checks, identity, maintainer edit access, and proof requirements still win.

## Validation Gate

- Run focused tests first for changed modules.
- Run `scripts/openclaw-preflight.sh --workflow <path>` so validation is executed against the pinned `validationBaseSha` and recorded against the current HEAD. The default `auto` profile resolves to `quick` for documentation-only diffs and `focused` for every other diff. The `focused` profile runs the repository's focused changed-test selector and can satisfy the publication gate when the deterministic gates pass. The `changed` profile is optional and runs pinned-base equivalents of `pnpm check:changed` and `pnpm test:changed`; it does not run full repository `pnpm check` or broad `pnpm check:test-types`. Use an explicit `--profile quick` only for very small, low-risk PRs when the user prioritizes fast publication and focused proof/tests have already been collected; it skips pnpm heavy lanes and records `validationDepth: deterministic-no-pnpm`. Use `--profile fast` when timing matters but local lint and type confidence is still required; it runs `pnpm lint`, `pnpm tsgo:prod`, and `pnpm check:test-types`, skips changed tests, and records `validationDepth: fast-lint-prod-and-test-types`. Use `--profile full` only when a full-repository check is intentional, and `--type-script check:test-types` only when the touched surface or user request explicitly needs that broader test-type lane. Run `scripts/openclaw-preflight.sh --help` for the current profile rules and examples.
- Treat the main SHA fetched by preflight as one observation, not a moving validation base. Main advancement, behind count, and overlapping files are advisories. A merge conflict against that observed SHA is blocking. Do not restart the gate merely because main advances again after the observation.
- For an explicit "rebase then publish" request, fetch once, record the exact rebase target SHA, rebase to that SHA, and keep that SHA as `validationBaseSha` through validation and publish. If main advances while checks are running, do not chase it. Publish the validated HEAD unless preflight reports a real merge conflict, the overlapping-file report changes the risk decision, or the user explicitly asks for another rebase after seeing the current gate state.
- Reuse cached heavy checks only when the receipt fingerprint matches HEAD, `validationBaseSha`, package/lockfile content, lanes, toolchain, platform, and relevant execution environment. Focused changed-test results may also be reused across profile switches when their focused-test fingerprint matches. Always recompute latest-main merge risk even on a cache hit.
- Avoid the default `pnpm check:changed` remote delegation path. Preflight sets `OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false` and intentionally omits `CI=1` so changed lanes run locally. When checking manually, use the same environment; Testbox/Blacksmith runs are optional supplemental proof, not the default local gate.
- A passing `preflight.json` is required. Missing, skipped, stale, or failed checks do not pass based on an agent's prose summary.
- A user may explicitly approve a temporary bypass for `preflight.status === "failed"` after seeing the human gate packet. This bypass is scoped to the same workflow task, approved HEAD, and approved PR body hash. It must be passed to `scripts/publish-openclaw-pr.mjs` as `--allow-failed-preflight --failed-preflight-bypass-reason "<user reason>"`. It does not apply to missing preflight, stale preflight, changed HEAD/body, dirty worktree, identity failures, maintainer edit failures, duplicate blockers on unpublished candidates, or proof/re-review blockers.
- For live external behavior, execute the real path when feasible and summarize only redacted proof.
- If true live external proof is infeasible, run `scripts/openclaw-proof-plan.sh --workflow <outputs>/workflow.json` and use the highest real local boundary: CLI command, server/route handler, provider/client entrypoint, sandbox/subprocess path, or production module boundary. Substitute unavailable external dependencies only at the network/process boundary with localhost, loopback, or fixtures.
- Do not treat isolated helper calls, copied parser logic, `node -e` simulations, or test output as real-call-chain fallback proof.
- If ClawSweeper asks for real behavior proof, update the PR body with copied terminal output from a live or loopback run before requesting re-review. Tests alone usually do not satisfy runtime/resource-safety proof.

### Rebase-Only Fast Path

Use this only for existing PR maintenance where the branch was rebased or merge
conflicts were resolved and no PR body, proof, comment, or review request will
be changed.

Run the lightweight receipt first:

```bash
scripts/openclaw-rebase-only-check.sh --workflow <outputs>/workflow.json --target <approved-rebase-target-sha>
```

Required lightweight checks before the human gate:

- worktree is clean
- branch contains the single approved rebase target SHA
- branch still has a committed diff beyond the approved rebase target SHA
- `git diff --check <approved-rebase-target-sha>...HEAD` passes
- every workflow commit uses the selected account's configured author/committer identity, or, for legacy workflows without an account profile, every `sunlit-deng` author/committer email is `yang.jiajun1@xydigit.com`
- existing PR head owner/ref matches the authenticated GitHub push identity
- `maintainerCanModify` is `true`

Then run `scripts/openclaw-gate-summary.sh --workflow <outputs>/workflow.json`.
The summary may use a passing `rebase-only-check.json` for the current HEAD
instead of a passing `preflight.json`. After human approval, publish with
`scripts/publish-openclaw-rebase-only.mjs --target <approved-rebase-target-sha>`.
The approval is tied to the current HEAD SHA and approved rebase target. This fast path must use
`--force-with-lease`, must verify the remote PR head SHA after pushing, and must
not update the PR body or post comments.

## Maintainer Edit and Secrets Gate

- For existing fork PRs, run `gh pr view <number> --repo openclaw/openclaw --json maintainerCanModify,headRepositoryOwner,headRefName,url` before any push, PR-body update, comment, or re-review request.
- Treat `maintainerCanModify: false` as a stop unless the user explicitly wants maintainers unable to edit the branch. Ask the user to re-enable the GitHub web checkbox `Allow edits and access to secrets by maintainers`, then re-check before continuing.
- For new fork PRs, create through `publish-openclaw-pr.mjs`; its REST payload sets `maintainer_can_modify: true` and carries the validated body verbatim.
- Immediately after creating a new PR, re-read `maintainerCanModify`. If it is not `true`, stop before requesting ClawSweeper review or CI attention and ask the user to restore the web checkbox.
- If GitHub does not expose the state through the API, get an explicit web UI confirmation or screenshot from the PR edit page before treating the gate as passed.

## Pre-Re-Review Gate

Use this gate before requesting ClawSweeper re-review to prevent blind re-review loops. The most common anti-pattern is requesting `@clawsweeper re-review` without first adding the proof ClawSweeper already asked for, which wastes review cycles (e.g., 6+ identical re-review rounds in PR 101343).

- Fetch ClawSweeper's current review on the PR. Use `gh pr view <number> --repo openclaw/openclaw --json comments` or `gh api repos/openclaw/openclaw/issues/<number>/comments` and identify the most recent ClawSweeper-authored comment that contains a review verdict.
- Parse the verdict: look for `clawsweeper-verdict:needs-human`, the overall rating (`🦪 silver shellfish`, `🧂 unranked krab`), and the block reason. Common proof blockers include `"needs real behavior proof"`, `"status: 📣 needs proof"`, `"Contributor proof is still test-run output only"`.
- **If ClawSweeper blocks on proof and the PR has not added real runtime proof since the last review, stop.** Do not request re-review. Explain to the user what specific proof ClawSweeper asked for and that adding test output alone will not satisfy the gate.
- **Loop detection by SHA match:** Compare the current head SHA (`git rev-parse HEAD`) against the SHA in ClawSweeper's most recent review (look for `sha=<...>` in `clawsweeper-verdict`). If the SHAs match and the blocker class is unchanged, the re-review request would be a no-op cycle. Explain this to the user and require concrete proof to be added before any re-review.
- **Check the review history:** ClawSweeper comments include a `Review history` section showing how many re-review cycles the PR has gone through. If the history shows multiple consecutive reviews with the same blocker, stop and surface the pattern before requesting another re-review.
- Only proceed with `@clawsweeper re-review` when: (a) ClawSweeper's verdict is not blocking on proof, or (b) the requested proof has been genuinely added to the PR body and/or branch since the last review SHA.

When the pre-re-review gate passes, proceed to the Human Gate below before any GitHub write.


## Optional Local AI Review

`codex review` and ClawSweeper local-review may be run as optional diagnostics
when the installed CLI and model support them. They never replace deterministic
preflight checks and their absence or infrastructure failure is not a release
gate. Actionable findings that are accepted still need normal implementation and
validation.

## Human Gate

Before any GitHub write, show the user:

- generated `gate-summary.md` from `scripts/openclaw-gate-summary.sh --workflow <outputs>/workflow.json`
- branch and head SHA
- diff summary and changed files
- commit author/committer
- tests/checks run
- PR body draft summary or path
- live proof summary
- preflight receipt path, HEAD SHA, and result
- for rebase-only fast path, lightweight check results instead of a preflight receipt
- maintainer edit status for existing PRs, or the post-create maintainer edit check plan for new PRs
- unresolved risks or blocked checks

Do not push, update PR body, comment, or request re-review until the user explicitly confirms.
After confirmation, use `gh` for PR body updates, comments, review requests, and other GitHub writes unless `gh` cannot perform the operation.
If the user explicitly says to bypass the failed-preflight blocker, include the
failed preflight result in the approval record and use the publish script's
failed-preflight bypass flags. Treat the override as consumed after that publish
attempt; rerun the gate or get a new explicit approval if HEAD or the PR body
changes.
