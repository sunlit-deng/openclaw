---
name: openclaw-pr-workflow
description: Prepare and maintain contributor pull requests for openclaw/openclaw issues with repo-policy intake, per-issue worktrees, focused implementation validation, durable PR-body evidence, official ClawSweeper local-review, and a mandatory human approval gate before any push, PR update, or GitHub comment. Use when Codex is asked to handle an OpenClaw issue, prepare or update an OpenClaw PR, respond to ClawSweeper/Codex review, debug PR CI, or request ClawSweeper re-review for openclaw/openclaw.
---

# OpenClaw PR Workflow

## Core Rules

Use this skill for `openclaw/openclaw` contributor work. Keep the process conservative and evidence-first.

- Treat GitHub writes as gated: do not push, create/update a PR, edit the PR body, post comments, or request bot review until the pre-push human gate has been shown and the user confirms.
- Use `sunlit-deng <yang.jiajun1@xydigit.com>` for authored and committed changes unless the user explicitly overrides it.
- Use one worktree per issue by default: `worktrees/issue-<number>` and `outputs/issue-<number>`. Add a topic suffix only when one issue needs multiple candidate PRs.
- Keep PR explanations durable in the PR body. If a bot or maintainer asks for evidence or context, update the PR body before posting a short pointer comment.
- When requesting ClawSweeper review, the comment body must be exactly `@clawsweeper re-review`.
- Never print secrets. Redact tokens, account ids, cookies, private endpoints, and other private values in live proof.
- For Codex/provider/external API behavior, inspect upstream source or official docs and collect live behavior proof when feasible.

## Workflow

1. **Issue intake**
   - Create or reuse a per-issue worktree with `scripts/new-openclaw-worktree.ps1`.
   - Read the issue or PR, latest comments, current PR diff, CI state, root `AGENTS.md`, relevant scoped `AGENTS.md`, `CONTRIBUTING.md`, and `.github/pull_request_template.md`.
   - Search for duplicate or canonical issues/PRs before implementing or defending a branch.
   - For Codex-related work, inspect the sibling `../codex` checkout or clone `https://github.com/openai/codex.git` before making any dependency-behavior verdict.

2. **Implementation and evidence**
   - Keep changes focused on one user-visible or operational problem.
   - Run focused tests for the touched surface before broad checks.
   - Collect real behavior proof for external contributor PRs when the change is not docs-only. Tests and CI supplement proof; they do not replace live proof.
   - Draft or update the PR body using `references/pr-body.md`.

3. **Local review gates**
   - Run `codex review --base origin/main` when available and address accepted actionable findings.
   - Run official ClawSweeper local-review before push. Use `references/review-gates.md` for setup and interpretation.
   - Use `scripts/openclaw-prepush-check.ps1` to summarize branch state, authorship, diff, PR body draft, local-review report, and remaining gate failures.

4. **Pre-push human gate**
   - Stop before any GitHub write.
   - Show the user: diff summary, commit author/committer, tests/checks run, PR body draft path or summary, live proof summary, ClawSweeper local-review result, and any unresolved risks.
   - Continue with push/PR/comment only after explicit user confirmation.

5. **PR maintenance**
   - If CI fails, inspect logs and distinguish PR-caused failures from unrelated main/flaky failures with concrete evidence.
   - If ClawSweeper misreads stale state, first verify current head SHA and file diff, then update durable PR body if needed.
   - If re-review is needed after confirmation, post only `@clawsweeper re-review`.

## References

- Read `references/worktree-layout.md` before creating or reusing worktrees.
- Read `references/pr-body.md` before drafting or editing an OpenClaw PR body.
- Read `references/review-gates.md` before running pre-push review, ClawSweeper local-review, or interpreting bot/CI gates.

## Scripts

Create a worktree:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\Yang\.codex\skills\openclaw-pr-workflow\scripts\new-openclaw-worktree.ps1 -Issue 94432
```

Run the pre-push summary from an OpenClaw checkout:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\Yang\.codex\skills\openclaw-pr-workflow\scripts\openclaw-prepush-check.ps1 `
  -RepoPath C:\path\to\openclaw `
  -Base origin/main `
  -PrBodyDraft C:\path\to\pr-body.md `
  -ClawSweeperReport C:\path\to\local-review.md
```

The pre-push script is read-only for the target repository. It reports gate status; it does not run tests, build ClawSweeper, push, comment, or edit tracked files.

