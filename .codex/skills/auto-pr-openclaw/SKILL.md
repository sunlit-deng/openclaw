---
name: auto-pr-openclaw
description: Prepare and maintain contributor pull requests for openclaw/openclaw issues with repo-policy intake, canonical per-issue worktrees, executable validation checks, durable PR-body evidence, and a mandatory human approval gate before any push, PR update, or GitHub comment. Use when Codex is asked to handle an OpenClaw issue, screen local or remote candidate issues, find easy-to-merge PR opportunities, prepare or update an OpenClaw PR, respond to ClawSweeper/Codex review, debug PR CI, or request ClawSweeper re-review for openclaw/openclaw.
---

# OpenClaw PR Workflow

## Core Rules

Use this skill for `openclaw/openclaw` contributor work. Keep the process conservative and evidence-first.

- Treat GitHub writes as gated: do not push, create/update a PR, edit the PR body, post comments, or request bot review until the pre-push human gate has been shown and the user confirms. The sole exception is a clean rebase-only refresh explicitly requested by the user; that initial request authorizes the patch-equivalent force-push described below without a second confirmation.
- If the user explicitly approves bypassing the human gate's failed-preflight blocker, treat that as a temporary override for the same workflow task only. It may bypass `preflight.status === "failed"` for the already-shown HEAD and PR body hash, but it must not bypass missing preflight, stale preflight, a different HEAD/body, dirty worktree, commit identity, maintainer edit access, duplicate blockers on unpublished candidates, or ClawSweeper proof/re-review gates. Record the failed check and user-stated reason in the publish command.
- Duplicate screening applies only while selecting an unpublished candidate or preparing a new PR. For an already-published PR (`workflow.pr` is set), do not search for duplicates again when responding to candidate scores, maintainer/bot review, proof requests, or CI feedback. Existing-PR scoring, gate summaries, and context packs must ignore any stale `duplicate-check.json`.
- For existing PR maintenance that only rebases onto a pinned upstream SHA without conflicts or PR-body changes, use the clean rebase-only fast path. An explicit user request to rebase or catch up the PR authorizes the resulting patch-equivalent force-push through `scripts/publish-openclaw-rebase-only.mjs`; do not pause for a second human gate. The path must stop on any conflict, patch-series drift, identity or maintainer-access failure, PR-head mismatch, dirty worktree, target mismatch, or force-with-lease failure. It must not update the PR body, post comments, or request bot review. When a conflict occurs, switch to the conflict-resolution fast path: preserve the original patch series, record every conflict file, reject non-conflict drift, run an explicit focused validation plan, then use `preflight --profile conflict` and the normal human gate.
- Do not chase moving `main`. When an existing PR needs a rebase, fetch once, record the exact target SHA, rebase to that SHA, and keep that SHA as the validation base through preflight, gate, and publish. If `main` advances after that point, treat it as advisory unless there is a real merge conflict, direct file overlap that changes the risk judgment, or the user explicitly asks for another rebase after seeing the current gate summary.
- Keep long validation commands token-efficient. Start each bounded command once, retain its process handle, and inspect only compact status or the final bounded output. Do not repeatedly reread growing logs, rerun already-passing focused tests in preflight, or emit progress messages for unchanged polling snapshots. Report phase transitions, failures, and material new evidence.
- Use high-level `gh` commands for GitHub reads, repository download/fork setup, CI, comments, and review operations, including `gh repo clone`, `gh repo fork`, `gh issue`, `gh pr`, `gh run`, and `gh search`. PR creation and PR body updates are the exception: use `gh api` with the GitHub REST pulls API because both operations carry the complete body/proof and must avoid the GraphQL editing path. Do not replace failed `gh` download/fork operations with anonymous HTTPS, stale local refs, or a different GitHub tool unless the user explicitly authorizes it.
- GitHub account identity is a hard requirement. When a workflow records `githubAccountProfile`, every workflow commit must use that profile's configured `username <email>` for both author and committer, and all `gh` reads/writes must run with that profile's token. When no account profile is selected, keep the legacy rule: commits authored or committed by `sunlit-deng` must use `sunlit-deng <yang.jiajun1@xydigit.com>`. Do not create, amend, cherry-pick, rebase, or push a commit with mismatched selected-account metadata unless the user explicitly overrides this requirement for that specific operation.
- Fork PR maintainer edit access is a release gate. Do not pass `--no-maintainer-edit`. This machine's `gh` may not support `--maintainer-edit` because maintainer edits are enabled by default, so omit both flags unless intentionally disabling edits. For existing PRs, verify `maintainerCanModify: true` with `gh pr view <number> --repo openclaw/openclaw --json maintainerCanModify,headRepositoryOwner,headRefName,url`. For new PRs, verify the same immediately after creation, or manually confirm the GitHub web checkbox `Allow edits and access to secrets by maintainers` remains checked when the API cannot prove it.
- Use one worktree per issue by default: `worktrees/issue-<number>` and `outputs/issue-<number>`. Add a topic suffix only when one issue needs multiple candidate PRs.
- Keep CodeGraph databases worktree-local. The worktree helpers seed them from the exact-SHA baseline at `workspace/openclaw/.codegraph-cache/repo` using copy-on-write when available, then run an incremental branch sync. Never symlink a live `.codegraph` database across PR worktrees.
- Keep the workspace pruned intentionally. The shared pnpm store belongs at `workspace/openclaw/.pnpm-store`, but each worktree still has a private `node_modules` for checkout-specific links. Use `scripts/openclaw-workspace-maintenance.sh` to report size, warm the store, prune old clean `node_modules`, or explicitly remove finished worktrees.
- Direct local-candidate PRs found from code do not need a GitHub issue or visible issue link. Search for related issues/PRs and link a real one when it exists, but do not create or attach an unrelated issue only to satisfy tooling.
- For candidate speed and quality, use `scripts/openclaw-duplicate-check.sh` only for unpublished candidates, then use `scripts/openclaw-candidate-score.sh` and `scripts/openclaw-gate-summary.sh` when a workflow exists. These are read-only/local-output diagnostics and never replace the human GitHub write gate.
- Treat `candidate-score.json.clawsweeperAReadiness` as an advisory candidate-ranking signal. Prefer candidates with a merged same-shape precedent or canonical contract, feasible base/head real-path proof, a focused surface, and no unresolved default, threshold, product, or compatibility decision. Do not turn this signal into a publication blocker or promise a ClawSweeper rating.
- Use low-token mode by default. Prefer `scripts/openclaw-context-pack.sh` and local receipts over re-reading large diffs, logs, comment histories, or full JSON outputs. Read `references/token-budget.md` before broad candidate mining, PR maintenance, CI debugging, or any resumed task with an existing workflow.
- Keep PR explanations durable in the PR body. If a bot or maintainer asks for evidence or context, update the PR body before posting a short pointer comment.
- Keep PR bodies concise by default: required sections, short human paragraphs, compact evidence bullets, and no report-style filler.
- Never expose local machine or workspace paths in a PR body. Use repository-root commands and committed or embedded proof source; do not paste `/Users/...`, `/Volumes/...`, `/home/...`, Windows user paths, or local `outputs/`, `worktrees/`, or `workspace/openclaw/...` references.
- After the human gate, publish branches through the workflow's selected GitHub account: check `gh auth status` with that token/profile, use a fork/SSH remote matching that identity for the unavoidable `git push`, and create/update PRs with `gh`. Do not push to HTTPS remotes whose cached credentials can differ from the selected `gh` identity.
- When requesting ClawSweeper review, the comment body must be exactly `@clawsweeper re-review`.
- Never print secrets. Redact tokens, account ids, cookies, private endpoints, and other private values in live proof.
- For Codex/provider/external API behavior, inspect upstream source or official docs and collect live behavior proof when feasible.
- Keep extension tests on documented public SDK surfaces. Never import repo-only `test/helpers/**` or `src/test-utils/**` from `extensions/**`, even when a migration warning recommends a core helper. Resolve a focused `openclaw/plugin-sdk/<subpath>` first; for temporary directories, prefer `withTempDir` from `openclaw/plugin-sdk/test-env` unless a narrower public helper fits.

## GitHub Account Selection

Use account profiles from `workspace/openclaw/accounts.json`, `~/.config/auto-pr/openclaw-accounts.json`, or `OPENCLAW_ACCOUNTS_FILE`.

- If the user says "切换成 <profile>", "用 <profile> 账号", or names a configured account for a PR workflow, pass `--account <profile>` at intake and tell the user which profile/login/email is active.
- For existing PR maintenance, run `prepare-openclaw-pr-worktree.mjs --pr <number>` without `--account` unless the user explicitly requested a profile. The script auto-selects a configured profile whose `login` matches the PR head owner. Read its JSON output and explicitly tell the user, for example: `已切换到账号 alt (login=octo-alt, email=alt@example.com)，因为 PR #123 的 head owner 是 octo-alt`.
- For already-prepared workflows, trust `workflow.json`'s `githubAccountProfile`/`githubAccount`; preflight, gate, and publish scripts will use that account automatically. Duplicate-check uses it only for unpublished candidates and is skipped for existing PRs. If the user asks to switch an existing workflow to another account, run `scripts/openclaw-set-account.mjs --workflow <workflow.json> --account <profile>` and tell the user what profile/login/email is now active. Do not use `--force` unless the user explicitly approves an intentional PR ownership migration.
- Never ask the user to paste a token into normal conversation unless they explicitly choose that route. Prefer environment variables, a local ignored account config, or another local secret mechanism.

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
8. When a workflow exists for the candidate, run duplicate and score receipts before investing in broad validation:
   - `scripts/openclaw-duplicate-check.sh --workflow <outputs>/workflow.json`
   - `scripts/openclaw-candidate-score.sh --workflow <outputs>/workflow.json`
   - Rank otherwise similar candidates by `clawsweeperAReadiness`: `high` before `possible` before `ordinary`. Drop or redesign candidates whose novelty is mainly a new arbitrary cap/default or an unresolved compatibility choice unless a repository convention, provider limit, or maintainer direction supplies the policy.
9. When the user picks a candidate, switch to the normal PR workflow below.

### Remote candidates

When the user says remote candidate issues, remote candidates, or asks to screen issues from GitHub, use the remote-list workflow instead of local code mining.

1. Pull live GitHub issue/PR lists with `gh`: open issues, recent labels, recent comments, and related PRs. Prefer small, recent, reproducible items with no active assignee or near-duplicate PR.
2. Bucket candidates by likely patch shape: bounded read/parse hardening, missing validation, narrow provider/channel bug, small docs-proof mismatch, flaky focused test gap, or missing reuse of an existing helper.
3. Read each promising issue enough to identify actual user impact, maintainer signals, stale context, and proof requirements. Drop vague support requests, design debates, broad refactors, and items needing secrets or paid services.
4. For top candidates, inspect only the relevant local code path to confirm the issue is real and patchable. Do not implement yet.
5. Report a ranked shortlist with issue URL, user impact, current status, likely touched files, smallest patch shape, proof plan, duplicate risk, and why it should be easy or hard to merge.
6. After a workflow is created for a selected remote candidate, run `openclaw-duplicate-check.sh` and `openclaw-candidate-score.sh` before broad validation.
7. When the user picks a candidate, switch to issue intake and normal PR workflow.

## Workflow

1. **Issue intake**
   - Create a per-issue worktree with `scripts/new-openclaw-worktree.sh` on macOS/Linux. The helper derives the canonical workspace root, fetches `origin/main`, refuses implicit reuse of stale local branches, and pins that fetched commit as `validationBaseSha` in `workflow.json`.
   - To use a non-default GitHub account, pass `--account <profile>` at intake. The helper reads `accounts.json`, exports the matching token for `gh`, configures the worktree `user.name` and `user.email`, and records the selected profile in `workflow.json`. Existing PR intake supports the same `--account <profile>` flag.
   - For an existing PR, use `scripts/prepare-openclaw-pr-worktree.mjs --pr <number>`. It reads the live PR with `gh pr view`, fetches the exact fork head into `worktrees/pr-<number>`, records the remote owner/ref separately, and pins the observed main SHA as the validation base. Do not rebase merely because main advanced; rebase for a real merge conflict, risky overlapping upstream changes, or an explicit up-to-date requirement. If a rebase is performed, record the single rebase target SHA and do not refresh it again during the same publish attempt just because `origin/main` moved.
   - Share only `workspace/openclaw/.pnpm-store` across worktrees; keep each worktree's `node_modules` private. Dependency installation is the default. Skipping it requires an explicit reason and is recorded as an incomplete validation state.
   - Let the intake helper prepare the worktree-local CodeGraph index. It maintains one detached `origin/main` baseline, validates its exact SHA, clones only the database (not daemon/runtime files), and incrementally synchronizes the target branch. A missing CodeGraph CLI or setup error is advisory and must not invalidate an otherwise usable worktree.
   - Read the issue or PR, latest comments, current PR diff, CI state, root `AGENTS.md`, relevant scoped `AGENTS.md`, `CONTRIBUTING.md`, and `.github/pull_request_template.md`.
   - Prefer `gh issue view`, `gh pr view`, `gh pr diff`, `gh pr checks`, `gh run view`, and `gh api` for GitHub reads.
   - For unpublished candidates and new PRs, search for duplicate or canonical issues/PRs before implementing. For an already-published PR, skip duplicate searches when modifying or defending the branch in response to scores, reviews, proof requests, or CI feedback.
   - Treat inability to fetch current `origin/main` as a hard stop. An HTTP 429 or other fetch failure may be retried through the `gh`-authenticated SSH setup, but never continue implementation, rebase, or preflight using an existing local ref while describing it as current.
   - For Codex-related work, inspect the sibling `../codex` checkout or clone `https://github.com/openai/codex.git` before making any dependency-behavior verdict.

2. **Implementation and evidence**
   - Keep changes focused on one user-visible or operational problem.
   - Run focused tests for the touched surface before broad checks.
   - Collect real behavior proof for external contributor PRs when the change is not docs-only. Prefer pasted terminal output, live logs, HTTP/status output, screenshots, or other actual runtime output over prose summaries. Tests and CI supplement proof; they do not replace live proof.
   - When feasible, capture base and head with the same command, production entrypoint, input, and boundary dependency. Record the exact tested head SHA and one unchanged negative control. Prefer this controlled before/after transcript over separate demonstrations that reviewers cannot compare directly.
   - If true live external proof is infeasible, run `scripts/openclaw-proof-plan.sh --workflow <outputs>/workflow.json` and exercise the highest real local boundary available: CLI/server/provider/subprocess entrypoint first, production module boundary second. Replace unavailable external services only at the network/process boundary with localhost, loopback, or fixtures. Do not prove copied helpers or synthetic `node -e` simulations.
   - For fail-closed resource caps such as body-size limits or WebSocket `maxPayload`, prove both sides of the boundary: a realistic legitimate large payload still succeeds, and an oversized payload is rejected before unbounded buffering. Do not only prove rejection; reviewers will ask whether the chosen cap breaks valid traffic.
   - When picking a cap, reuse an existing repo convention or provider/runtime limit when one fits. If the cap is lower than a nearby default or plausible valid traffic size, include evidence for the legitimate large case or raise the cap.
   - Draft or update the PR body using `references/pr-body.md`.
   - For unpublished candidates and new PRs, run `scripts/openclaw-duplicate-check.sh --workflow <outputs>/workflow.json` when changed files or issue context are known. Use the receipt to drop crowded or duplicate lanes before spending full validation time. Skip this step entirely when `workflow.pr` identifies an already-published PR.
   - Run `scripts/openclaw-candidate-score.sh --workflow <outputs>/workflow.json` after the PR body and focused proof plan exist. Treat `needs-work` or `poor-fit` as a stop-and-fix signal before publication.
   - For an A-readiness attempt, require the PR body to show the same production entrypoint and input on the pinned base and exact head, include an unchanged negative control, name the canonical merged precedent or governing invariant, and resolve avoidable policy/compatibility choices. This is advisory optimization only: never add churn, delay a merge-ready B-rated PR, or claim that ClawSweeper will award A.

3. **Executable local checks**
   - When an `extensions/**` test or test helper changes imports or creates temporary directories, run `pnpm run lint:plugins:no-extension-test-core-imports`, `pnpm run test:extensions:package-boundary:compile`, and `node scripts/report-test-temp-creations.mjs --base <validation-base> --head HEAD --fail-on-findings` before preflight. A passing focused Vitest run alone does not prove extension package-boundary compliance.
   - Run `scripts/openclaw-preflight.sh --workflow <outputs>/workflow.json` on macOS/Linux.
   - Preflight must execute validation against the pinned `validationBaseSha`, plus Git, identity, PR body/proof, focused changed tests for source diffs, and latest-main merge-risk checks. The default `auto` profile selects `quick` for documentation-only diffs, `targeted` for ordinary single-surface code diffs, and `changed` for package/lockfile/tsconfig/public-plugin-SDK, cross-surface, too-broad, or unknown diffs. The resolved profile and requested profile are recorded in `preflight.json`. Main advancement alone is advisory and must not invalidate successful checks. A real merge conflict against the single main snapshot fetched at preflight is blocking; overlapping files are reported for human judgment. Do not keep fetching or rebasing during the same gate. After one requested rebase succeeds, do not rebase again in the same publish attempt unless preflight reports an actual conflict or the user explicitly asks for another rebase. The `targeted` profile runs changed-file format and lint plus only the owning TypeScript project lanes concurrently, then runs focused affected tests. It deliberately skips repository-wide database, dependency, API-baseline, and import-cycle guards. The `focused` profile remains a test-only iteration lane and is not the default code release profile. The `conflict` profile is only for a current passing `conflict-resolution-check.json`; it reuses the recorded focused commands and runs no pnpm or dependency lanes, while retaining deterministic Git, identity, PR-body/proof, and merge-risk checks. The `changed` profile is the automatic escalation lane and runs the pinned-base equivalents of `pnpm check:changed` and `pnpm test:changed`; it does not run full repository `pnpm check` or broad `pnpm check:test-types`. Use an explicit `--profile quick` only when the user prioritizes fast publication for a very small, low-risk PR after focused proof/tests have already been collected; it skips pnpm heavy lanes and records `validationDepth: deterministic-no-pnpm`. Use `--profile fast` when full lint and broad production/test type confidence is required; it runs `pnpm lint`, `pnpm tsgo:prod`, and `pnpm check:test-types`, skips changed tests, and records `validationDepth: fast-lint-prod-and-test-types`. Use `--profile full` only for an intentional full-repository check. Run `openclaw-preflight.sh --help` to inspect profiles and examples. A prose claim that checks ran is not a substitute for a passing `preflight.json` tied to the current HEAD and validation base.
   - Preflight may reuse successful heavy checks only when its fingerprint matches the current HEAD, pinned validation base, package and lockfile content, selected lanes, targeted planner implementation, toolchain, platform, and relevant execution environment. Focused changed-test results may also be reused across `quick`, `targeted`, `focused`, and `changed` profile switches when their focused-test fingerprint matches. Latest observed main is deliberately excluded from those fingerprints; merge risk is recomputed separately on every run.
   - Do not use a naked `pnpm check:changed` as the release gate when it delegates to Blacksmith/Testbox. Use preflight, which sets `OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false` and runs the changed lanes locally. If running the lane manually, use the same child environment without `CI=1`; remote Testbox is optional supplemental evidence only after the user explicitly asks for it.
   - Local AI review commands are optional diagnostics only. `codex review` and ClawSweeper local-review are not release gates because their availability is environment-dependent.

   **Clean rebase-only fast path:** If the user explicitly asks to rebase or catch up an existing PR, fetch once, pin the target SHA, and run `git rebase <target-sha>`. If Git reports any conflict, stop immediately; do not resolve it under this path. After a conflict-free rebase, run `scripts/openclaw-rebase-only-check.sh --workflow <outputs>/workflow.json --target <pinned-rebase-target-sha>`. This lightweight check compares the ordered stable patch-id series before and after the rebase and verifies identity, clean state, target ancestry, PR-head ownership, the unchanged remote head, and maintainer edit access. If it passes, immediately publish with `scripts/publish-openclaw-rebase-only.mjs --workflow <outputs>/workflow.json --target <pinned-rebase-target-sha> --push-remote <remote>`; do not run preflight, gate summary, tests, lint, type checks, `git diff --check`, or ask for a second confirmation. Do not use this path for conflict resolution, review-driven code edits, proof/body changes, new PR creation, or any case that needs ClawSweeper re-review.

   **Conflict-resolution fast path:** Start the rebase through `scripts/openclaw-conflict-rebase.sh --phase start` before Git changes the branch. A conflict exit is expected; resolve only the recorded files. If a later `rebase --continue` stops again, run `--phase record` before resolving it. Create a small JSON validation plan containing only commands that rebuild a conflicted generated asset, exercise focused affected tests, or check a directly affected package boundary. Finish with `--phase finish --plan <plan.json>`. The receipt rejects more than five conflict files, cross-surface or high-risk conflicts, and any patch drift outside the recorded conflict files. Generated conflicts require a rebuild command and non-document conflicts require a focused-test command. If it passes, run `openclaw-preflight.sh --profile conflict`, generate the Human Gate, and wait for approval before normal publication. If it refuses the scope, use normal `auto`/`targeted`/`changed` validation; do not weaken the receipt.

4. **Pre-push human gate**
   - This section does not apply to the clean rebase-only fast path above. The user's explicit rebase/catch-up request is its authorization, and a passing patch-equivalence receipt proceeds directly to the rebase-only publisher.
   - Stop before any GitHub write.
   - Run `scripts/openclaw-gate-summary.sh --workflow <outputs>/workflow.json` and use the generated `gate-summary.md` as the human approval packet.
   - Show the user: diff summary, commit author/committer, tests/checks from `preflight.json`, PR body draft path or summary, live proof summary, and any unresolved risks.
   - Verify every workflow commit uses the selected account's author and committer identity. If no account profile was selected, verify every `sunlit-deng` commit uses author and committer email `yang.jiajun1@xydigit.com`. Fix local commit metadata before asking for push approval. Do not rewrite other contributors' authored commits merely to change their author email unless the selected-account rule is intentionally being applied to this workflow.
   - For existing fork PRs, show the current maintainer edit status from `maintainerCanModify`. If it is `false`, stop and ask the user to re-enable `Allow edits and access to secrets by maintainers` in the GitHub web UI before push, PR update, or re-review. For new PRs, show that the PR will be created without `--no-maintainer-edit` and must be checked immediately after creation.
   - When the PR already has a ClawSweeper review, show ClawSweeper's current verdict and any unresolved blocking findings before asking for push or re-review confirmation.
   - Continue with push/PR/comment only after explicit user confirmation.
   - After confirmation, pass the approved HEAD and PR body SHA-256 to `scripts/publish-openclaw-pr.mjs`. It pushes through the named SSH remote created for the `gh` identity. Both new PR creation and existing PR body updates use `gh api` with the REST pulls API. It then re-reads with `gh pr view` and verifies the exact body and maintainer edit access. If the user explicitly approved bypassing a failed preflight for this same task, also pass `--allow-failed-preflight --failed-preflight-bypass-reason "<user reason>"`; do not use that override for missing or stale preflight.
   - Conflict-resolved rebases remain in the normal human gate. Clean rebase-only maintenance bypasses this section and uses `scripts/publish-openclaw-rebase-only.mjs`, which requires a current passing patch-equivalence receipt, uses `--force-with-lease`, re-checks the PR head owner/ref and maintainer edit access, pushes only the branch, and verifies the remote PR head SHA. It intentionally does not read or write the PR body.
   - After creating or updating a fork PR, re-read `maintainerCanModify`. If it is `false`, stop before requesting review and tell the user the web checkbox must be restored.

5. **PR maintenance**
   - Do not run duplicate checks for an already-published PR. Review-driven edits, score-driven improvements, proof additions, CI fixes, rebases, and re-review preparation operate on the accepted PR lane; use the current review and CI state instead.
   - If CI fails, inspect logs and distinguish PR-caused failures from unrelated main/flaky failures with concrete evidence.
   - Prefer `gh pr checks`, `gh run list`, `gh run view`, and `gh run download` for CI investigation.
   - If ClawSweeper misreads stale state, first verify current head SHA and file diff, then update durable PR body if needed.
   - **Pre-re-review gate:** Before posting `@clawsweeper re-review`, read ClawSweeper's current review comment. Use `gh pr view <number> --repo openclaw/openclaw --json comments` and scan the most recent ClawSweeper review body. If ClawSweeper's verdict blocks the PR on proof (look for phrases like "needs real behavior proof", "missing proof", "🦪 silver shellfish", "status: 📣 needs proof"), do NOT request re-review until the requested proof is added to the PR body and the head branch is updated.
   - **Loop detection:** If the current head SHA matches the SHA in ClawSweeper's most recent review and ClawSweeper still reports the same blocker class (same "needs real behavior proof" verdict, same "🦪" rank), stop before any re-review request. Explain to the user what proof ClawSweeper is asking for and that the branch has not changed since the last review.
   - If re-review is needed after confirmation and proof has been genuinely added, post only `@clawsweeper re-review`.

## References

- Read `references/worktree-layout.md` before creating or reusing worktrees.
- Read `references/token-budget.md` before broad candidate mining, PR maintenance, CI debugging, or resuming an existing workflow.
- Read `references/pr-body.md` before drafting or editing an OpenClaw PR body.
- Read `references/review-gates.md` before running preflight or interpreting bot/CI gates.

## Scripts

Create a worktree on macOS/Linux:

```bash
./.codex/skills/auto-pr-openclaw/scripts/new-openclaw-worktree.sh --issue 94432
```

Create a worktree with a configured GitHub account profile:

```bash
./.codex/skills/auto-pr-openclaw/scripts/new-openclaw-worktree.sh \
  --issue 94432 \
  --account alt-account
```

Prepare an existing PR with a configured GitHub account profile:

```bash
node ./.codex/skills/auto-pr-openclaw/scripts/prepare-openclaw-pr-worktree.mjs \
  --pr 93865 \
  --account alt-account
```

Run executable preflight checks:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-preflight.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json
```

Preflight writes `preflight.json` outside the target repository. It never pushes,
comments, or edits a PR.

Preview the true targeted plan for a pinned diff:

```bash
node ./.codex/skills/auto-pr-openclaw/scripts/openclaw-targeted-check.mjs \
  --base <validation-base-sha> \
  --dry-run
```

Run a quick deterministic preflight without pnpm heavy lanes for a low-risk PR
when timing matters and focused proof/tests have already been collected:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-preflight.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json \
  --profile quick
```

Run a fast typed preflight when timing matters but local lint and type coverage
is still required:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-preflight.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json \
  --profile fast
```

Report local workspace size and largest dependency directories:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-workspace-maintenance.sh
```

Warm the shared pnpm store:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-workspace-maintenance.sh \
  --warm-store --yes
```

Prune dependency directories from clean inactive worktrees:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-workspace-maintenance.sh \
  --prune-node-modules --older-than-days 14 --yes
```

Run read-only duplicate/canonical searches and candidate scoring:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-duplicate-check.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json
./.codex/skills/auto-pr-openclaw/scripts/openclaw-candidate-score.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json
```

Generate the human pre-push approval summary:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-gate-summary.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json
```

Validate a conflict-free rebase-only existing PR without tests or preflight:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-rebase-only-check.sh \
  --workflow workspace/openclaw/outputs/pr-93865/workflow.json \
  --target <pinned-rebase-target-sha>
```

Start and finish a conflicted existing-PR rebase with focused validation:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-conflict-rebase.sh \
  --phase start \
  --workflow workspace/openclaw/outputs/pr-111181/workflow.json \
  --target <pinned-rebase-target-sha>

# Resolve only the files listed in conflict-rebase-state.json, continue rebase,
# then supply a bounded conflict-validation-plan.json.
./.codex/skills/auto-pr-openclaw/scripts/openclaw-conflict-rebase.sh \
  --phase finish \
  --workflow workspace/openclaw/outputs/pr-111181/workflow.json \
  --plan workspace/openclaw/outputs/pr-111181/conflict-validation-plan.json

./.codex/skills/auto-pr-openclaw/scripts/openclaw-preflight.sh \
  --workflow workspace/openclaw/outputs/pr-111181/workflow.json \
  --profile conflict
```

Generate a real-call-chain proof plan:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-proof-plan.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json
```

Generate a compact low-token handoff packet:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-context-pack.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json
```

Automatically publish an existing PR after the clean rebase-only check passes:

```bash
./.codex/skills/auto-pr-openclaw/scripts/publish-openclaw-rebase-only.sh \
  --workflow workspace/openclaw/outputs/pr-93865/workflow.json \
  --target <pinned-rebase-target-sha> \
  --push-remote sunlit
```

The rebase-only publisher force-pushes the recorded existing PR head with
`--force-with-lease` without a second confirmation and never updates the PR
body, comments, or review state.
