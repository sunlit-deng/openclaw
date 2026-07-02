---
name: auto-pr-openclaw
description: Prepare and maintain contributor pull requests for openclaw/openclaw issues with repo-policy intake, per-issue worktrees, focused implementation validation, durable PR-body evidence, official ClawSweeper local-review, GitHub operations routed through gh when available, and a mandatory human approval gate before any push, PR update, or GitHub comment. Use when Codex is asked to handle an OpenClaw issue, screen local or remote candidate issues, find easy-to-merge PR opportunities, prepare or update an OpenClaw PR, respond to ClawSweeper/Codex review, debug PR CI, or request ClawSweeper re-review for openclaw/openclaw.
---

# OpenClaw PR Workflow

## Core Rules

Use this skill for `openclaw/openclaw` contributor work. Keep the process conservative and evidence-first.

- Treat GitHub writes as gated: do not push, create/update a PR, edit the PR body, post comments, or request bot review until the pre-push human gate has been shown and the user confirms.
- Use `gh` for GitHub operations by default, including reading issues/PRs/comments, inspecting CI/checks/logs, pushing branches, creating/updating PRs, posting comments, and requesting reviews. Use another GitHub tool only when `gh` is unavailable, unauthenticated, lacks the needed capability, or the user explicitly asks for a different path; mention the fallback reason.
- Authorship email is a hard requirement: all commits authored or committed by `sunlit-deng` must use `sunlit-deng <yang.jiajun1@xydigit.com>`. Do not create, amend, cherry-pick, rebase, or push a `sunlit-deng` commit with any other author or committer email unless the user explicitly overrides this requirement for that specific operation.
- Use one worktree per issue by default: `worktrees/issue-<number>` and `outputs/issue-<number>`. Add a topic suffix only when one issue needs multiple candidate PRs.
- Keep PR explanations durable in the PR body. If a bot or maintainer asks for evidence or context, update the PR body before posting a short pointer comment.
- Keep PR bodies concise by default: required sections, short human paragraphs, compact evidence bullets, and no report-style filler.
- After the human gate, publish branches through the `gh`-authenticated GitHub identity: check `gh auth status`, use a fork/SSH remote matching that identity for the unavoidable `git push`, and create/update PRs with `gh`. Do not push to HTTPS remotes whose cached credentials can differ from `gh auth`.
- When requesting ClawSweeper review, the comment body must be exactly `@clawsweeper re-review`.
- Never print secrets. Redact tokens, account ids, cookies, private endpoints, and other private values in live proof.
- For Codex/provider/external API behavior, inspect upstream source or official docs and collect live behavior proof when feasible.

## Candidate Mining

Use this when the user asks to find or screen candidate issues, easy PRs, or Alix-style opportunities.

### Local candidates

When the user says local candidate issues, local candidates, or asks to find modifiable points in local code, do not start with a random issue list. Start from code and recent merged PR patterns, then map candidates back to issues/PRs.

1. Pull local context: `git status -sb`, latest merged small PRs in the same area when relevant, root/scoped `AGENTS.md`, and current local code.
2. Extract mergeable shapes from recent wins: narrow provider/runtime hardening, existing helper reuse, missing bounded reads/parsing, missing negative-control tests, durable terminal proof, and no broad config/migration/dependency churn.
3. Scan local code for sibling gaps using structural tools for symbols and `rg` for literals. Prefer places where the repo already has a helper or pattern nearby and one path missed it.
4. Only after finding a concrete code point, search GitHub issues/PRs for duplicates, canonical work, or an issue that the code point can honestly fix.
5. Reject churn: style-only edits, speculative cleanup, tests without a product risk, broad ownership moves, config/default changes without a real bug, or anything that cannot be proven locally.
6. For each candidate, report: code point, suspected user/operational impact, existing helper/pattern to reuse, related issue/PR status, smallest patch shape, proof command, and merge risk.
7. When the user picks a candidate, switch to the normal PR workflow below.

### Remote candidates

When the user says remote candidate issues, remote candidates, or asks to screen issues from GitHub, use the remote-list workflow instead of local code mining.

1. Pull live GitHub issue/PR lists with `gh`: open issues, recent labels, recent comments, and related PRs. Prefer small, recent, reproducible items with no active assignee or near-duplicate PR.
2. Bucket candidates by likely patch shape: bounded read/parse hardening, missing validation, narrow provider/channel bug, small docs-proof mismatch, flaky focused test gap, or missing reuse of an existing helper.
3. Read each promising issue enough to identify actual user impact, maintainer signals, stale context, and proof requirements. Drop vague support requests, design debates, broad refactors, and items needing secrets or paid services.
4. For top candidates, inspect only the relevant local code path to confirm the issue is real and patchable. Do not implement yet.
5. Report a ranked shortlist with issue URL, user impact, current status, likely touched files, smallest patch shape, proof plan, duplicate risk, and why it should be easy or hard to merge.
6. When the user picks a candidate, switch to issue intake and normal PR workflow.

## Workflow

1. **Issue intake**
   - Create or reuse a per-issue worktree with `scripts/new-openclaw-worktree.sh` on macOS/Linux or `scripts/new-openclaw-worktree.ps1` on Windows.
   - For dependency setup, share only the pnpm store across worktrees; keep each worktree's `node_modules` private. Use `scripts/ensure-openclaw-deps.sh` or create the worktree with `--install-dependencies` on macOS/Linux; use the `.ps1` equivalents on Windows.
   - Read the issue or PR, latest comments, current PR diff, CI state, root `AGENTS.md`, relevant scoped `AGENTS.md`, `CONTRIBUTING.md`, and `.github/pull_request_template.md`.
   - Prefer `gh issue view`, `gh pr view`, `gh pr diff`, `gh pr checks`, `gh run view`, and `gh api` for GitHub reads.
   - Search for duplicate or canonical issues/PRs before implementing or defending a branch.
   - For Codex-related work, inspect the sibling `../codex` checkout or clone `https://github.com/openai/codex.git` before making any dependency-behavior verdict.

2. **Implementation and evidence**
   - Keep changes focused on one user-visible or operational problem.
   - Run focused tests for the touched surface before broad checks.
   - Collect real behavior proof for external contributor PRs when the change is not docs-only. Prefer pasted terminal output, live logs, HTTP/status output, screenshots, or other actual runtime output over prose summaries. Tests and CI supplement proof; they do not replace live proof.
   - Draft or update the PR body using `references/pr-body.md`.

3. **Local review gates**
   - Run `codex review --base origin/main` when available and address accepted actionable findings.
   - Run official ClawSweeper local-review before push. Use `references/review-gates.md` for setup and interpretation.
   - Use `scripts/openclaw-prepush-check.ps1` to summarize branch state, authorship, diff, PR body draft, local-review report, and remaining gate failures.

4. **Pre-push human gate**
   - Stop before any GitHub write.
   - Show the user: diff summary, commit author/committer, tests/checks run, PR body draft path or summary, live proof summary, ClawSweeper local-review result, and any unresolved risks.
   - Verify every `sunlit-deng` commit that will be pushed uses author and committer email `yang.jiajun1@xydigit.com`. If any `sunlit-deng` commit uses another email, fix the local commit metadata before asking for push approval. Do not rewrite other contributors' authored commits merely to change their author email.
   - Continue with push/PR/comment only after explicit user confirmation.
   - After confirmation, prefer `git push` for the branch push and `gh pr create/edit/comment/review` or `gh api` for PR and comment writes.

5. **PR maintenance**
   - If CI fails, inspect logs and distinguish PR-caused failures from unrelated main/flaky failures with concrete evidence.
   - Prefer `gh pr checks`, `gh run list`, `gh run view`, and `gh run download` for CI investigation.
   - If ClawSweeper misreads stale state, first verify current head SHA and file diff, then update durable PR body if needed.
   - If re-review is needed after confirmation, post only `@clawsweeper re-review`.

## References

- Read `references/worktree-layout.md` before creating or reusing worktrees.
- Read `references/pr-body.md` before drafting or editing an OpenClaw PR body.
- Read `references/review-gates.md` before running pre-push review, ClawSweeper local-review, or interpreting bot/CI gates.

## Scripts

Create a worktree on macOS/Linux:

```bash
/Users/yangjiajun/projects/auto-pr/.codex/skills/auto-pr-openclaw/scripts/new-openclaw-worktree.sh --issue 94432 --install-dependencies
```

Create a worktree on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File E:\Projects\auto-pr\.codex\skills\auto-pr-openclaw\scripts\new-openclaw-worktree.ps1 -Issue 94432
```

Run the pre-push summary from an OpenClaw checkout:

```powershell
powershell -ExecutionPolicy Bypass -File E:\Projects\auto-pr\.codex\skills\auto-pr-openclaw\scripts\openclaw-prepush-check.ps1 `
  -RepoPath C:\path\to\openclaw `
  -Base origin/main `
  -PrBodyDraft C:\path\to\pr-body.md `
  -ClawSweeperReport C:\path\to\local-review.md
```

The pre-push script is read-only for the target repository. It reports gate status; it does not run tests, build ClawSweeper, push, comment, or edit tracked files.
