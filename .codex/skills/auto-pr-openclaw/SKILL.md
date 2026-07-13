---
name: auto-pr-openclaw
description: Prepare and maintain contributor pull requests for openclaw/openclaw issues with repo-policy intake, canonical per-issue worktrees, executable validation checks, durable PR-body evidence, and a mandatory human approval gate before any push, PR update, or GitHub comment. Use when Codex is asked to handle an OpenClaw issue, screen local or remote candidate issues, find easy-to-merge PR opportunities, prepare or update an OpenClaw PR, respond to ClawSweeper/Codex review, debug PR CI, or request ClawSweeper re-review for openclaw/openclaw.
---

# OpenClaw PR Workflow

## Core Rules

Use this skill for `openclaw/openclaw` contributor work. Keep the process conservative and evidence-first.

- Treat GitHub writes as gated: do not push, create/update a PR, edit the PR body, post comments, or request bot review until the pre-push human gate has been shown and the user confirms.
- For existing PR maintenance that only resolves merge conflicts or rebases onto the latest upstream without changing the PR body, use the rebase-only fast path after human confirmation. This path may force-push the existing fork head through `scripts/publish-openclaw-rebase-only.mjs`; it must not update the PR body, post comments, or request bot review.
- Use high-level `gh` commands for GitHub reads, repository download/fork setup, CI, comments, and review operations, including `gh repo clone`, `gh repo fork`, `gh issue`, `gh pr`, `gh run`, and `gh search`. PR creation and PR body updates are the exception: use `gh api` with the GitHub REST pulls API because both operations carry the complete body/proof and must avoid the GraphQL editing path. Do not replace failed `gh` download/fork operations with anonymous HTTPS, stale local refs, or a different GitHub tool unless the user explicitly authorizes it.
- Authorship email is a hard requirement: all commits authored or committed by `sunlit-deng` must use `sunlit-deng <yang.jiajun1@xydigit.com>`. Do not create, amend, cherry-pick, rebase, or push a `sunlit-deng` commit with any other author or committer email unless the user explicitly overrides this requirement for that specific operation.
- Fork PR maintainer edit access is a release gate. Do not pass `--no-maintainer-edit`. This machine's `gh` may not support `--maintainer-edit` because maintainer edits are enabled by default, so omit both flags unless intentionally disabling edits. For existing PRs, verify `maintainerCanModify: true` with `gh pr view <number> --repo openclaw/openclaw --json maintainerCanModify,headRepositoryOwner,headRefName,url`. For new PRs, verify the same immediately after creation, or manually confirm the GitHub web checkbox `Allow edits and access to secrets by maintainers` remains checked when the API cannot prove it.
- Use one worktree per issue by default: `worktrees/issue-<number>` and `outputs/issue-<number>`. Add a topic suffix only when one issue needs multiple candidate PRs.
- Direct local-candidate PRs found from code do not need a GitHub issue or visible issue link. Search for related issues/PRs and link a real one when it exists, but do not create or attach an unrelated issue only to satisfy tooling.
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

1. Refresh upstream first: in the main clone (`workspace/openclaw/repos/openclaw`), run `git fetch origin main` and screen against the freshly fetched `origin/main`. Do this before reading code or ranking candidates; do not screen from a stale checkout unless the fetch fails and the user explicitly accepts stale context.
2. Pull local context: `git status -sb`, latest merged small PRs in the same area when relevant, root/scoped `AGENTS.md`, and current local code.
3. Extract mergeable shapes from recent wins: narrow provider/runtime hardening, existing helper reuse, missing bounded reads/parsing, missing negative-control tests, durable terminal proof, and no broad config/migration/dependency churn.
4. Scan local code for sibling gaps using structural tools for symbols and `rg` for literals. Prefer places where the repo already has a helper or pattern nearby and one path missed it.
5. Only after finding a concrete code point, search GitHub issues/PRs for duplicates, canonical work, or an issue that the code point can honestly fix. If no real issue exists, continue as a direct `local-candidate` PR without a visible issue link.
   - Do not rely on title/body keyword search alone. Search by touched file path, nearby helper or constant names, audit labels, and the exact risky API call or replacement helper (for example `extensions/huggingface/models.ts`, `response.json()`, `readProviderJsonResponse`, `huggingface-model-discovery`).
   - For repeated hardening shapes such as bounded reads, parsing caps, and `ws` `maxPayload`, inspect open and recent merged cluster PRs before claiming a slot is free. If a focused canonical PR already carries the same production change, drop the candidate instead of opening a same-shape PR.
   - Treat high-score `queueable-fix` issues as crowded until proven otherwise. Small helper bugs, truncation/UTF fixes, parser validation, shell completion, auth wording, and channel formatting often have multiple open PRs even when the issue still says `clawsweeper:no-new-fix-pr`; verify live PRs by issue number, title phrase, target file, and helper/API names.
   - When a broad or maintainer PR touches the same files but does not implement the exact behavior or regression test, do not call it a duplicate; report it as file-conflict/rebase risk and name the overlapping PR.
   - Study successful narrow PRs from active community contributors, but do not copy their obvious issue lanes after they have opened a PR. Use their pattern to find sibling gaps on less crowded surfaces instead.
   - Prefer `gh search prs --repo openclaw/openclaw --state open --match title,body <query>` plus path/helper searches and `gh pr view` on likely matches. A "no duplicate" verdict needs at least title/body, target-file, and helper/API-call searches.
6. Reject churn: style-only edits, speculative cleanup, tests without a product risk, broad ownership moves, config/default changes without a real bug, or anything that cannot be proven locally.
7. For each candidate, report: code point, suspected user/operational impact, existing helper/pattern to reuse, related issue/PR status, smallest patch shape, proof command, and merge risk.
8. When the user picks a candidate, switch to the normal PR workflow below.

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
   - Create a per-issue worktree with `scripts/new-openclaw-worktree.sh` on macOS/Linux or `scripts/new-openclaw-worktree.ps1` on Windows. The helpers derive the canonical workspace root, fetch `origin/main`, refuse implicit reuse of stale local branches, and record paths and SHAs in `workflow.json`.
   - For an existing PR, use `scripts/prepare-openclaw-pr-worktree.mjs --pr <number>`. It reads the live PR with `gh pr view`, fetches the exact fork head into `worktrees/pr-<number>`, and records the remote owner/ref separately. Rebase onto current `origin/main` before preflight when the reported head is stale.
   - Share only `workspace/openclaw/.pnpm-store` across worktrees; keep each worktree's `node_modules` private. Dependency installation is the default. Skipping it requires an explicit reason and is recorded as an incomplete validation state.
   - Read the issue or PR, latest comments, current PR diff, CI state, root `AGENTS.md`, relevant scoped `AGENTS.md`, `CONTRIBUTING.md`, and `.github/pull_request_template.md`.
   - Prefer `gh issue view`, `gh pr view`, `gh pr diff`, `gh pr checks`, `gh run view`, and `gh api` for GitHub reads.
   - Search for duplicate or canonical issues/PRs before implementing or defending a branch.
   - Treat inability to fetch current `origin/main` as a hard stop. An HTTP 429 or other fetch failure may be retried through the `gh`-authenticated SSH setup, but never continue implementation, rebase, or preflight using an existing local ref while describing it as current.
   - For Codex-related work, inspect the sibling `../codex` checkout or clone `https://github.com/openai/codex.git` before making any dependency-behavior verdict.

2. **Implementation and evidence**
   - Keep changes focused on one user-visible or operational problem.
   - Run focused tests for the touched surface before broad checks.
   - Collect real behavior proof for external contributor PRs when the change is not docs-only. Prefer pasted terminal output, live logs, HTTP/status output, screenshots, or other actual runtime output over prose summaries. Tests and CI supplement proof; they do not replace live proof.
   - For fail-closed resource caps such as body-size limits or WebSocket `maxPayload`, prove both sides of the boundary: a realistic legitimate large payload still succeeds, and an oversized payload is rejected before unbounded buffering. Do not only prove rejection; reviewers will ask whether the chosen cap breaks valid traffic.
   - When picking a cap, reuse an existing repo convention or provider/runtime limit when one fits. If the cap is lower than a nearby default or plausible valid traffic size, include evidence for the legitimate large case or raise the cap.
   - Draft or update the PR body using `references/pr-body.md`.

3. **Executable local checks**
   - Run `scripts/openclaw-preflight.sh --workflow <outputs>/workflow.json` on macOS/Linux or the `.ps1` wrapper on Windows.
   - Preflight must execute the selected check lane (for issue/PR workflows, repository `check`; for direct `local-candidate` PRs, local `check:changed` by default), focused changed tests, Git and identity checks, and PR body/proof validation. For direct `local-candidate` PRs, record whether the branch contains the freshly fetched `origin/main` as a freshness advisory instead of failing the gate; fast-moving upstream can be left for GitHub mergeability/CI unless there is a known conflict. A prose claim that checks ran is not a substitute for a passing `preflight.json` tied to the current HEAD.
   - Do not use a naked `pnpm check:changed` as the local-candidate release gate when it delegates to Blacksmith/Testbox. Use preflight, which sets `OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false` and runs the changed lanes locally. If running the lane manually, use the same child environment without `CI=1`; remote Testbox is optional supplemental evidence only after the user explicitly asks for it.
   - Local AI review commands are optional diagnostics only. `codex review` and ClawSweeper local-review are not release gates because their availability is environment-dependent.

   **Rebase-only fast path:** If an existing PR only needs a conflict-resolution or upstream rebase refresh and the PR body will not be changed, the full preflight can be deferred. Before the human gate, verify the lightweight release checks instead: clean worktree, branch contains the latest fetched `origin/main`, committed diff exists, `git diff --check` passes, `sunlit-deng` commit identity is correct, and `maintainerCanModify` is true. After confirmation, publish with `scripts/publish-openclaw-rebase-only.mjs --workflow <outputs>/workflow.json --approved-head <sha> --push-remote <remote>`. Do not use this fast path for code edits that respond to review findings, proof/body changes, new PR creation, or any case that needs ClawSweeper re-review.

4. **Pre-push human gate**
   - Stop before any GitHub write.
   - Show the user: diff summary, commit author/committer, tests/checks from `preflight.json`, PR body draft path or summary, live proof summary, and any unresolved risks.
   - Verify every `sunlit-deng` commit that will be pushed uses author and committer email `yang.jiajun1@xydigit.com`. If any `sunlit-deng` commit uses another email, fix the local commit metadata before asking for push approval. Do not rewrite other contributors' authored commits merely to change their author email.
   - For existing fork PRs, show the current maintainer edit status from `maintainerCanModify`. If it is `false`, stop and ask the user to re-enable `Allow edits and access to secrets by maintainers` in the GitHub web UI before push, PR update, or re-review. For new PRs, show that the PR will be created without `--no-maintainer-edit` and must be checked immediately after creation.
   - When the PR already has a ClawSweeper review, show ClawSweeper's current verdict and any unresolved blocking findings before asking for push or re-review confirmation.
   - Continue with push/PR/comment only after explicit user confirmation.
   - After confirmation, pass the approved HEAD and PR body SHA-256 to `scripts/publish-openclaw-pr.mjs`. It pushes through the named SSH remote created for the `gh` identity. Both new PR creation and existing PR body updates use `gh api` with the REST pulls API. It then re-reads with `gh pr view` and verifies the exact body and maintainer edit access.
   - For approved rebase-only maintenance on an existing PR, pass the approved HEAD to `scripts/publish-openclaw-rebase-only.mjs` instead. It uses `--force-with-lease`, re-checks the PR head owner/ref and maintainer edit access, pushes only the branch, and verifies the remote PR head SHA. It intentionally does not read or write the PR body.
   - After creating or updating a fork PR, re-read `maintainerCanModify`. If it is `false`, stop before requesting review and tell the user the web checkbox must be restored.

5. **PR maintenance**
   - If CI fails, inspect logs and distinguish PR-caused failures from unrelated main/flaky failures with concrete evidence.
   - Prefer `gh pr checks`, `gh run list`, `gh run view`, and `gh run download` for CI investigation.
   - If ClawSweeper misreads stale state, first verify current head SHA and file diff, then update durable PR body if needed.
   - **Pre-re-review gate:** Before posting `@clawsweeper re-review`, read ClawSweeper's current review comment. Use `gh pr view <number> --repo openclaw/openclaw --json comments` and scan the most recent ClawSweeper review body. If ClawSweeper's verdict blocks the PR on proof (look for phrases like "needs real behavior proof", "missing proof", "🦪 silver shellfish", "status: 📣 needs proof"), do NOT request re-review until the requested proof is added to the PR body and the head branch is updated.
   - **Loop detection:** If the current head SHA matches the SHA in ClawSweeper's most recent review and ClawSweeper still reports the same blocker class (same "needs real behavior proof" verdict, same "🦪" rank), stop before any re-review request. Explain to the user what proof ClawSweeper is asking for and that the branch has not changed since the last review.
   - If re-review is needed after confirmation and proof has been genuinely added, post only `@clawsweeper re-review`.

## References

- Read `references/worktree-layout.md` before creating or reusing worktrees.
- Read `references/pr-body.md` before drafting or editing an OpenClaw PR body.
- Read `references/review-gates.md` before running preflight or interpreting bot/CI gates.

## Scripts

Create a worktree on macOS/Linux:

```bash
./.codex/skills/auto-pr-openclaw/scripts/new-openclaw-worktree.sh --issue 94432
```

Create a worktree on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\.codex\skills\auto-pr-openclaw\scripts\new-openclaw-worktree.ps1 -Issue 94432
```

Run executable preflight checks:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-preflight.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json
```

Preflight writes `preflight.json` outside the target repository. It never pushes,
comments, or edits a PR.

Publish an existing PR after rebase-only maintenance:

```bash
./.codex/skills/auto-pr-openclaw/scripts/publish-openclaw-rebase-only.sh \
  --workflow workspace/openclaw/outputs/pr-93865/workflow.json \
  --approved-head <sha> \
  --push-remote sunlit
```

The rebase-only publisher force-pushes the recorded existing PR head with
`--force-with-lease` and never updates the PR body, comments, or review state.
