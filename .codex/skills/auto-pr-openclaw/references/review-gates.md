# OpenClaw Review Gates

Use these gates before pushing or updating an OpenClaw PR.

## Repository Policy Gate

- Read root `AGENTS.md` fully and every scoped `AGENTS.md` owning touched paths.
- Read `CONTRIBUTING.md` lines around Before You PR, review conversations, and AI-assisted PRs.
- Read `.github/pull_request_template.md`.
- Check `CODEOWNERS` if touching restricted or sensitive paths.

## Duplicate and Canonical Gate

- Use `gh` for GitHub reads by default. Prefer `gh issue view`, `gh pr view`, `gh pr diff`, `gh pr checks`, `gh run view`, and `gh api`; use another GitHub tool only when `gh` is unavailable, unauthenticated, or missing the needed capability.
- Search linked issues, related PRs, latest comments, and ClawSweeper comments for canonical work.
- Before claiming a PR is not duplicate, verify current head SHA, actual changed files, and whether sibling PRs solve the same remaining problem.

## Validation Gate

- Run focused tests first for changed modules.
- Run `scripts/openclaw-preflight.sh --workflow <path>` (or the PowerShell wrapper) so the repository `pnpm check` lane and focused changed tests are executed and recorded against the current HEAD.
- A passing `preflight.json` is required. Missing, skipped, stale, or failed checks do not pass based on an agent's prose summary.
- For live external behavior, execute the real path when feasible and summarize only redacted proof.
- If ClawSweeper asks for real behavior proof, update the PR body with copied terminal output from a live or loopback run before requesting re-review. Tests alone usually do not satisfy runtime/resource-safety proof.

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

- branch and head SHA
- diff summary and changed files
- commit author/committer
- tests/checks run
- PR body draft summary or path
- live proof summary
- preflight receipt path, HEAD SHA, and result
- maintainer edit status for existing PRs, or the post-create maintainer edit check plan for new PRs
- unresolved risks or blocked checks

Do not push, update PR body, comment, or request re-review until the user explicitly confirms.
After confirmation, use `gh` for PR body updates, comments, review requests, and other GitHub writes unless `gh` cannot perform the operation.
