---
name: auto-pr-openclaw
description: Prepare and maintain contributor pull requests for openclaw/openclaw issues with repo-policy intake, canonical per-issue worktrees, executable validation checks, durable PR-body evidence, and a default human approval gate before any push, PR update, or GitHub comment. An explicit user-directed workflow override can bypass local publication gates for the current attempt. Use when Codex is asked to handle an OpenClaw issue, screen local or remote candidate issues, find easy-to-merge PR opportunities, prepare or update an OpenClaw PR, respond to ClawSweeper/Codex review, debug PR CI, or request ClawSweeper re-review for openclaw/openclaw.
---

# OpenClaw PR Workflow

## Core Rules

Use this skill for `openclaw/openclaw` contributor work. Keep the process conservative and evidence-first.

- Treat GitHub writes as gated by default: do not push, create/update a PR, edit the PR body, post comments, or request bot review until the pre-push human gate has been shown and the user confirms. The clean rebase-only refresh and the explicit workflow-rule override below are the only publication exceptions.
- A direct, unambiguous user instruction to bypass the workflow rules and publish, or to bypass all local publication gates, authorizes that broad local override for the current publish attempt. Do not infer this from urgency or a vague request to continue; a request naming only one gate must stay scoped to that gate, using the narrow legacy flag where available. For the broad override, use `--allow-workflow-rule-bypass --workflow-rule-bypass-reason "<concise user reason>"`; when active, `--approved-head` and `--approved-body-sha` may be omitted and are bound to the current HEAD/body at publisher start.
- The workflow-rule override may bypass local process gates such as the human approval packet, missing/stale/failed preflight, PR-body policy validation, commit-identity policy, dirty-worktree warning, duplicate/intake/score/review/CI blockers, and maintainer-edit policy. Record the reason and every bypassed check in `workflow.json`, and tell the user what was bypassed before writing.
- The override does not bypass higher-priority instructions, secret/PII protections, authenticated account ownership, target repository/branch/PR identity, current HEAD/body binding, remote-head lease protection, GitHub/API failures, or final remote PR-body integrity. It also never authorizes ClawSweeper re-review or unrelated comments; request those separately and explicitly.
- The older `--allow-failed-preflight --failed-preflight-bypass-reason "<reason>"` form remains supported for a failed preflight only. Use the broader flag when the user explicitly wants to bypass other local workflow gates too.
- Duplicate screening applies only while selecting an unpublished candidate or preparing a new PR. For an already-published PR (`workflow.pr` is set), do not search for duplicates again when responding to candidate scores, maintainer/bot review, proof requests, or CI feedback. Existing-PR scoring, gate summaries, and context packs must ignore any stale `duplicate-check.json`. For unpublished candidates, separate exact duplicate risk from broad same-file overlap: a PR that implements the same behavior or regression test is blocking; a broad PR that merely touches the same file is a rebase/coordination risk to disclose, not a reason to open as draft or abandon the lane by itself.
- For existing PR maintenance that only rebases onto a pinned upstream SHA without conflicts or PR-body changes, use the clean rebase-only fast path. An explicit user request to rebase or catch up the PR authorizes the resulting patch-equivalent force-push through `scripts/publish-openclaw-rebase-only.mjs`; do not pause for a second human gate. The path must stop on any conflict, patch-series drift, identity or maintainer-access failure, PR-head mismatch, dirty worktree, target mismatch, force-with-lease failure, or a canonical PR body that pins the pre-rebase head SHA (ClawSweeper would treat the exact-head evidence as stale). It must not update the PR body, post comments, or request bot review. When a conflict occurs, switch to the conflict-resolution fast path: preserve the original patch series (or net patch for merge-containing history), record every conflict file, reject drift outside the explicitly validated resolution scope, run a focused validation plan, then use `preflight --profile conflict` and the normal human gate.
- When the rebase-only check refuses because the body pins a stale head SHA, refresh it locally with `scripts/refresh-pr-body-sha.sh --workflow <outputs>/workflow.json`, rerun `scripts/validate-pr-body.mjs --workflow <outputs>/workflow.json`, then continue through the normal human gate and `scripts/publish-openclaw-pr.mjs`. That body edit changes the approved body hash, so it needs the human gate; it does not need heavy code re-validation because the rebase-only receipt already proved patch equivalence.
- Do not chase moving `main`. When an existing PR needs a rebase, fetch once, record the exact target SHA, rebase to that SHA, and keep that SHA as the validation base through preflight, gate, and publish. If `main` advances after that point, treat it as advisory unless there is a real merge conflict, direct file overlap that changes the risk judgment, or the user explicitly asks for another rebase after seeing the current gate summary.
- Keep long validation commands token-efficient. Start each bounded command once, retain its process handle, and inspect only compact status or the final bounded output. Do not repeatedly reread growing logs, rerun already-passing focused tests in preflight, or emit progress messages for unchanged polling snapshots. After a rebase or PR-body-only edit, prefer the narrow receipt that was invalidated: rerun focused tests only when code changed and no current preflight will run them; rerun proof only when HEAD, the proof input, or the behavior boundary changed; rerun `validate-pr-body` and gate summary for body-only edits. Report phase transitions, failures, and material new evidence. A failed conflict receipt must stop for a user decision; never silently escalate it into `auto`, `changed`, `fast`, `full`, broad type lanes, or thousands of affected tests.
- Use high-level `gh` commands for GitHub reads, repository download/fork setup, CI, comments, and review operations, including `gh repo clone`, `gh repo fork`, `gh issue`, `gh pr`, `gh run`, and `gh search`. PR creation and PR body updates are the exception: use `gh api` with the GitHub REST pulls API because both operations carry the complete body/proof and must avoid the GraphQL editing path. Do not replace failed `gh` download/fork operations with anonymous HTTPS, stale local refs, or a different GitHub tool unless the user explicitly authorizes it.
- GitHub account identity is a hard requirement. When a workflow records `githubAccountProfile`, every workflow commit must use that profile's configured `username <email>` for both author and committer, and all `gh` reads/writes must run with that profile's token. When no account profile is selected, keep the legacy rule: commits authored or committed by `sunlit-deng` must use `sunlit-deng <yang.jiajun1@xydigit.com>`. Do not create, amend, cherry-pick, rebase, or push a commit with mismatched selected-account metadata unless the user explicitly overrides this requirement for that specific operation.
- Fork PR maintainer edit access is a release gate by default. Do not pass `--no-maintainer-edit`. This machine's `gh` may not support `--maintainer-edit` because maintainer edits are enabled by default, so omit both flags unless intentionally disabling edits. For existing PRs, verify `maintainerCanModify: true` with `gh pr view <number> --repo openclaw/openclaw --json maintainerCanModify,headRepositoryOwner,headRefName,url`; an explicit workflow-rule override may proceed with a false value but must report it. For new PRs, verify the same immediately after creation, or manually confirm the GitHub web checkbox `Allow edits and access to secrets by maintainers` remains checked when the API cannot prove it.
- Use one worktree per issue by default: `worktrees/issue-<number>` and `outputs/issue-<number>`. Add a topic suffix only when one issue needs multiple candidate PRs.
- Keep CodeGraph databases worktree-local. The worktree helpers seed them from the exact-SHA baseline at `workspace/openclaw/.codegraph-cache/repo` using copy-on-write when available, then run an incremental branch sync. Never symlink a live `.codegraph` database across PR worktrees.
- Refresh CodeGraph once per pinned maintenance phase, not before every shell command: after the single `origin/main` fetch fixes the target SHA, incrementally sync the shared baseline to that SHA, seed/sync the worktree, and sync the worktree once more after checkout or rebase. During edits, trust the watcher and only run another sync when CodeGraph reports pending/stale files. A PR task must never perform the first full `codegraph init -i`; if the reusable baseline is missing, skip CodeGraph and continue the PR workflow, then build the baseline separately with `ensure-openclaw-codegraph.sh --baseline-only`.
- Keep the workspace pruned intentionally. The shared pnpm store belongs at `workspace/openclaw/.pnpm-store`, but each worktree still has a private `node_modules` for checkout-specific links. Use `scripts/openclaw-workspace-maintenance.sh` to report size, warm the store, prune old clean `node_modules`, or explicitly remove finished worktrees.
- Direct local-candidate PRs found from code do not need a GitHub issue or visible issue link. Search for related issues/PRs and link a real one when it exists, but do not create or attach an unrelated issue only to satisfy tooling.
- For candidate speed and quality, run `scripts/openclaw-candidate-scout.sh` before implementation, use `scripts/openclaw-duplicate-check.sh` only for unpublished candidates, then use `scripts/openclaw-proof-receipt.sh`, `scripts/openclaw-candidate-score.sh`, and `scripts/openclaw-gate-summary.sh` when a workflow exists. These are read-only/local-output diagnostics and never replace the human GitHub write gate.
- Treat `candidate-score.json.clawsweeperAReadiness` as an advisory proof/policy-shape signal, not a priority or final-rating prediction. Prefer candidates with a merged same-shape precedent or canonical contract, feasible base/head real-path proof, a focused surface, and no unresolved default, threshold, product, or compatibility decision. Do not turn this signal into a publication blocker or promise a ClawSweeper rating. Before promising P1/P2 or "diamond"-level outcomes, separately justify high user impact; small CLI wording, diagnostic consistency, docs, and low-blast-radius ergonomics fixes default to P3 even with strong proof.
- Periodically calibrate local predictions against reviewed outcomes with `scripts/openclaw-score-calibration.sh`. Do not change weights from anecdotes; require at least ten representative reviewed PRs and inspect false-positive `high` predictions first.
- When the user prioritizes ClawSweeper A-rating likelihood during candidate mining, read `references/candidate-selection.md` and apply its early screen before creating a worktree or implementing code. Use post-implementation `clawsweeperAReadiness` only to confirm that the selected shape was executed well.
- Use low-token mode by default. Prefer `scripts/openclaw-context-pack.sh` and local receipts over re-reading large diffs, logs, comment histories, or full JSON outputs. Read `references/token-budget.md` before broad candidate mining, PR maintenance, CI debugging, or any resumed task with an existing workflow.
- Keep PR explanations durable in the PR body. If a bot or maintainer asks for evidence or context, update the PR body before posting a short pointer comment.
- Keep PR bodies concise by default: required sections, short human paragraphs, compact evidence bullets, and no report-style filler.
- Treat the PR title as a required repository-policy artifact, separate from the commit subject and PR body. Before drafting or publishing a new PR, read `.github/pull_request_template.md` and use `type(scope): user-facing description` with one of the repository's allowed types. Classify the shipped intent: use `feat` for a new user-facing capability or a feature-request issue, `fix` for incorrect existing behavior or a regression (describe the symptom and trigger), `improve` for a non-bug product improvement, and `refactor`/`docs`/`chore` only for their matching changes. Do not infer `fix` from issue labels, branch names, or a commit prefix; `queueable-fix` and `clawsweeper:*` labels do not override the semantic type. The gate summary's title derived from the head commit is provisional: review it against the issue and template, then pass the final title explicitly to the publisher.
- Never expose local machine or workspace paths in a PR body. Use repository-root commands and committed or embedded proof source; do not paste `/Users/...`, `/Volumes/...`, `/home/...`, Windows user paths, or local `outputs/`, `worktrees/`, or `workspace/openclaw/...` references.
- After the normal human gate, or after an explicit workflow-rule override, publish branches through the workflow's selected GitHub account using `scripts/publish-openclaw-pr.mjs` unless the script is missing or fails for a concrete reason you report. The publisher owns branch push, REST PR create/update, exact PR body verification, and maintainer-edit verification. Do not hand-roll `git push` plus `gh pr create/edit` when the publisher is available. New PRs are ready for review by default; create a draft only when the user explicitly asks for draft, the PR is intentionally incomplete, or an explicitly bypassed gate leaves review premature. Publishing or updating a PR never includes an automatic `@clawsweeper re-review`.
- When the user explicitly asks for ClawSweeper re-review, the comment body must be exactly `@clawsweeper re-review`.
- Never print secrets. Redact tokens, account ids, cookies, private endpoints, and other private values in live proof.
- For Codex/provider/external API behavior, inspect upstream source or official docs and collect live behavior proof when feasible.
- Keep extension tests on documented public SDK surfaces. Never import repo-only `test/helpers/**` or `src/test-utils/**` from `extensions/**`, even when a migration warning recommends a core helper. Resolve a focused `openclaw/plugin-sdk/<subpath>` first; for temporary directories, prefer `withTempDir` from `openclaw/plugin-sdk/test-env` unless a narrower public helper fits.

## Machine Environment and Shell Hygiene

- Direct CLI and proof-script runs (`openclaw.mjs`, `scripts/run-node.mjs`, `npx tsx`) require Node `>=22.22.3`; the WorkBuddy managed Node 22.22.2 does not satisfy it (older embedded SQLite). Use the system Node at `/Users/yangjiajun/.nvm/versions/node/v24.18.0/bin/node` for those runs. Preflight, vitest, and tsgo lanes run fine on the managed runtime.
- If tsgo or preflight stalls waiting on, or fails to clean up, `.git/openclaw-local-checks/heavy-check.lock` under a WorkBuddy-injected `NODE_OPTIONS` safe-delete shim, rerun with `env -u NODE_OPTIONS`.
- Each shell invocation starts a fresh process at the workspace root; cwd does not persist between calls. Use `git -C <absolute-path>` and absolute paths for repo, node, and pnpm commands. Write multi-step dependent sequences (stash → test → pop, cd → build → run) to a script file under `/tmp` and execute that file; do not rely on a previous call's cwd.

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
   - Before opening a workflow, write the structured candidate plan described in `references/evidence-receipts.md`, run `scripts/openclaw-candidate-scout.sh`, and score each concrete code point with `references/candidate-selection.md`. Prefer current-main repros that complete a merged same-shape pattern, permit comparable base/head production-path proof, and introduce no new policy or compatibility choice.
   - Treat arbitrary caps, new defaults, fallback-policy changes, unsponsored configuration, after-only proof, and actively rewritten overlapping code as low A-likelihood unless a repository/provider/upstream contract removes the judgment call.
5. Only after finding a concrete code point, search GitHub issues/PRs for duplicates, canonical work, or an issue that the code point can honestly fix. If no real issue exists, continue as a direct `local-candidate` PR without a visible issue link.
   - Do not rely on title/body keyword search alone. Search by touched file path, nearby helper or constant names, audit labels, and the exact risky API call or replacement helper (for example `extensions/huggingface/models.ts`, `response.json()`, `readProviderJsonResponse`, `huggingface-model-discovery`).
   - For repeated hardening shapes such as bounded reads, parsing caps, and `ws` `maxPayload`, inspect open and recent merged cluster PRs before claiming a slot is free. If a focused canonical PR already carries the same production change, drop the candidate instead of opening a same-shape PR.
   - Treat high-score `queueable-fix` issues as crowded until proven otherwise. Small helper bugs, truncation/UTF fixes, parser validation, shell completion, auth wording, and channel formatting often have multiple open PRs even when the issue still says `clawsweeper:no-new-fix-pr`; verify live PRs by issue number, title phrase, target file, and helper/API names.
   - When a broad or maintainer PR touches the same files but does not implement the exact behavior or regression test, do not call it a duplicate; report it as file-conflict/rebase risk and name the overlapping PR. Do not downgrade the publication mode to draft solely because of broad same-file overlap after merge compatibility has been checked.
   - Study successful narrow PRs from active community contributors, but do not copy their obvious issue lanes after they have opened a PR. Use their pattern to find sibling gaps on less crowded surfaces instead.
   - Prefer `gh search prs --repo openclaw/openclaw --state open --match title,body <query>` plus path/helper searches and `gh pr view` on likely matches. A "no duplicate" verdict needs at least title/body, target-file, and helper/API-call searches.
6. Reject churn: style-only edits, speculative cleanup, tests without a product risk, broad ownership moves, config/default changes without a real bug, or anything that cannot be proven locally.
7. For each candidate, report: proposed PR type/title, code point, suspected user/operational impact, expected priority (P1/P2/P3) with reason, expected overall-rank cap, existing helper/pattern to reuse, related issue/PR status, smallest patch shape, proof command, merge risk, separate merge fit, and `A-likelihood` with its score, missing signals, and any early stop condition.
8. When a workflow exists for the candidate, run duplicate and score receipts before investing in broad validation:
   - `scripts/openclaw-duplicate-check.sh --workflow <outputs>/workflow.json`
   - `scripts/openclaw-candidate-score.sh --workflow <outputs>/workflow.json`
   - An offline duplicate receipt only plans searches and must not pass the gate. Run the live duplicate check before treating the candidate as clear.
   - Rank otherwise similar candidates by `clawsweeperAReadiness`: `high` before `possible` before `ordinary`. Drop or redesign candidates whose novelty is mainly a new arbitrary cap/default or an unresolved compatibility choice unless a repository convention, provider limit, or maintainer direction supplies the policy.
9. When the user picks a candidate, switch to the normal PR workflow below.

### Remote candidates

When the user says remote candidate issues, remote candidates, or asks to screen issues from GitHub, use the remote-list workflow instead of local code mining.

1. Pull live GitHub issue/PR lists with `gh`: open issues, recent labels, recent comments, and related PRs. Prefer small, recent, reproducible items with no active assignee or near-duplicate PR.
2. Bucket candidates by likely patch shape: bounded read/parse hardening, missing validation, narrow provider/channel bug, small docs-proof mismatch, flaky focused test gap, or missing reuse of an existing helper.
3. Read each promising issue enough to identify actual user impact, maintainer signals, stale context, and proof requirements. Drop vague support requests, design debates, broad refactors, and items needing secrets or paid services.
4. For top candidates, inspect only the relevant local code path to confirm the issue is real and patchable. Do not implement yet.
5. Before ranking, apply `references/candidate-selection.md` and run `openclaw-candidate-scout.sh` for each confirmed code point. Prefer candidates whose behavior is reproducible on current `main`, whose implementation is fixed by canonical precedent, and whose proof can compare the same real path on base and head without leaving a maintainer policy decision.
6. Report a ranked shortlist with issue URL, proposed PR type/title, user impact, expected priority (P1/P2/P3) with reason, expected overall-rank cap, current status, likely touched files, smallest patch shape, proof plan, duplicate risk, merge fit, and `A-likelihood` with its score, missing signals, and any early stop condition.
7. After a workflow is created for a selected remote candidate, run `openclaw-duplicate-check.sh` and `openclaw-candidate-score.sh` before broad validation.
8. When the user picks a candidate, switch to issue intake and normal PR workflow.

## Workflow

1. **Issue intake**
   - Create a per-issue worktree with `scripts/new-openclaw-worktree.sh` on macOS/Linux. The helper derives the canonical workspace root, fetches `origin/main`, refuses implicit reuse of stale local branches, and pins that fetched commit as `validationBaseSha` in `workflow.json`.
   - For a local candidate without a GitHub issue, use `scripts/new-openclaw-worktree.sh --mode local-candidate --topic <topic>`. It derives `worktrees/local-<topic>`, branch `<branch-prefix>/<topic>`, and records `mode: local-candidate` with no issue number in `workflow.json`. Do not hand-roll `git worktree add` plus `write-workflow-state.mjs` unless the helper fails for a concrete reason you report.
   - To use a non-default GitHub account, pass `--account <profile>` at intake. The helper reads `accounts.json`, exports the matching token for `gh`, configures the worktree `user.name` and `user.email`, and records the selected profile in `workflow.json`. Existing PR intake supports the same `--account <profile>` flag.
   - For an existing PR, use `scripts/prepare-openclaw-pr-worktree.mjs --pr <number>`. It reads the live PR with `gh pr view`, fetches the exact fork head into `worktrees/pr-<number>`, records the remote owner/ref separately, and pins the observed main SHA as the validation base. Do not rebase merely because main advanced; rebase for a real merge conflict, risky overlapping upstream changes, or an explicit up-to-date requirement. If a rebase is performed, record the single rebase target SHA and do not refresh it again during the same publish attempt just because `origin/main` moved.
   - Share only `workspace/openclaw/.pnpm-store` across worktrees; keep each worktree's `node_modules` private. Dependency installation is the default. Skipping it requires an explicit reason and is recorded as an incomplete validation state.
   - Let the intake helper prepare the worktree-local CodeGraph index. It maintains one detached `origin/main` baseline, validates its exact SHA, clones only the database (not daemon/runtime files), and incrementally synchronizes the target branch. A missing CodeGraph CLI or setup error is advisory and must not invalidate an otherwise usable worktree.
   - Read the issue or PR, latest comments, current PR diff, CI state, root `AGENTS.md`, relevant scoped `AGENTS.md`, `CONTRIBUTING.md`, and `.github/pull_request_template.md`.
   - During intake, classify the issue from its acceptance criteria as a feature, bug/regression, improvement, refactor, docs, or chore and write down the proposed PR type/title before implementation. Do not use labels, branch names, or the existing commit prefix as the semantic classification.
   - Prefer `gh issue view`, `gh pr view`, `gh pr diff`, `gh pr checks`, `gh run view`, and `gh api` for GitHub reads.
   - For unpublished candidates and new PRs, search for duplicate or canonical issues/PRs before implementing. For an already-published PR, skip duplicate searches when modifying or defending the branch in response to scores, reviews, proof requests, or CI feedback.
   - Treat inability to fetch current `origin/main` as a hard stop. An HTTP 429 or other fetch failure may be retried through the `gh`-authenticated SSH setup, but never continue implementation, rebase, or preflight using an existing local ref while describing it as current.
   - For Codex-related work, inspect the sibling `../codex` checkout or clone `https://github.com/openai/codex.git` before making any dependency-behavior verdict.

2. **Implementation and evidence**
   - Keep changes focused on one user-visible or operational problem.
   - Before drafting the PR body or running candidate score/preflight for a new PR, choose the semantic PR type and proposed title from the issue intent and repository template. Feature acceptance criteria default to `feat`; incorrect existing behavior or regression acceptance criteria default to `fix`. Keep the PR title correct even when a local commit subject is stale or mislabeled.
   - Run focused tests for the touched surface during implementation before broad checks. Do not rerun the same focused tests immediately before publication when the current preflight profile will run or reuse them against the same HEAD.
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
   - Before preflight, run the owning typecheck lane standalone for a fast failure loop. Preview the lanes for the pinned diff with `node ./.codex/skills/auto-pr-openclaw/scripts/openclaw-targeted-check.mjs --base <validation-base-sha> --dry-run`, then run the owning lane directly (for example `pnpm tsgo:core:test` for `src/**` test changes). tsgo reuses `.artifacts/tsgo-cache`, so type errors surface in minutes here and the later preflight typecheck lane becomes a warm-cache pass, instead of a type error discovered deep into a cold preflight that then has to be rerun in full.
   - Run `scripts/openclaw-preflight.sh --workflow <outputs>/workflow.json` on macOS/Linux. Before starting, tell the user the selected/default profile can take minutes: `targeted` runs changed-file format/lint, owning TypeScript lanes, and focused affected tests; it is not a single-test smoke check.
   - Record comparable base/head real-path evidence with `scripts/openclaw-proof-receipt.sh --workflow <outputs>/workflow.json --input <proof-evidence.json>` before intentional A-readiness scoring. PR-body wording alone may support merge documentation but cannot produce `clawsweeperAReadiness: high`.
   - By default, preflight must execute validation against the pinned `validationBaseSha`, plus Git, identity, PR body/proof, focused changed tests for source diffs, and latest-main merge-risk checks. The default `auto` profile selects `quick` for documentation-only diffs, `targeted` for ordinary single-surface code diffs, and `changed` for package/lockfile/tsconfig/public-plugin-SDK, cross-surface, too-broad, or unknown diffs. The resolved profile and requested profile are recorded in `preflight.json`. Main advancement alone is advisory and must not invalidate successful checks. A real merge conflict against the single main snapshot fetched at preflight is blocking; overlapping files are reported for human judgment. Do not keep fetching or rebasing during the same gate. After one requested rebase succeeds, do not rebase again in the same publish attempt unless preflight reports an actual conflict or the user explicitly asks for another rebase. The `targeted` profile runs changed-file format and lint plus only the owning TypeScript project lanes concurrently, then runs focused affected tests. It deliberately skips repository-wide database, dependency, API-baseline, and import-cycle guards. The `focused` profile remains a test-only iteration lane and is not the default code release profile. The `conflict` profile is only for a current passing `conflict-resolution-check.json`; it reuses the recorded focused commands and runs no pnpm or dependency lanes, while retaining deterministic Git, identity, PR-body/proof, and merge-risk checks. The `changed` profile is the automatic escalation lane and runs the pinned-base equivalents of `pnpm check:changed` and `pnpm test:changed`; it does not run full repository `pnpm check` or broad `pnpm check:test-types`. Use an explicit `--profile quick` only when the user prioritizes fast publication for a very small, low-risk PR after focused proof/tests have already been collected; it skips pnpm heavy lanes and records `validationDepth: deterministic-no-pnpm`. Use `--profile fast` when full lint and broad production/test type confidence is required; it runs `pnpm lint`, `pnpm tsgo:prod`, and `pnpm check:test-types`, skips changed tests, and records `validationDepth: fast-lint-prod-and-test-types`. Use `--profile full` only for an intentional full-repository check. Run `openclaw-preflight.sh --help` to inspect profiles and examples. A prose claim that checks ran is not a substitute for a passing `preflight.json` tied to the current HEAD and validation base; an explicit workflow-rule override is the documented exception.
   - Preflight may reuse successful heavy checks only when its fingerprint matches the current HEAD, pinned validation base, package and lockfile content, selected lanes, targeted planner implementation, toolchain, platform, and relevant execution environment. Focused changed-test results may also be reused across `quick`, `targeted`, `focused`, and `changed` profile switches when their focused-test fingerprint matches. Latest observed main is deliberately excluded from those fingerprints; merge risk is recomputed separately on every run.
   - Do not use a naked `pnpm check:changed` as the release gate when it delegates to Blacksmith/Testbox. Use preflight, which sets `OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false` and runs the changed lanes locally. If running the lane manually, use the same child environment without `CI=1`; remote Testbox is optional supplemental evidence only after the user explicitly asks for it.
   - Local AI review commands are optional diagnostics only. `codex review` and ClawSweeper local-review are not release gates because their availability is environment-dependent.

   **Clean rebase-only fast path:** If the user explicitly asks to rebase or catch up an existing PR, fetch once, pin the target SHA, and run `git rebase <target-sha>`. If Git reports any conflict, stop immediately; do not resolve it under this path. After a conflict-free rebase, run `scripts/openclaw-rebase-only-check.sh --workflow <outputs>/workflow.json --target <pinned-rebase-target-sha>`. This lightweight check compares the ordered stable patch-id series before and after the rebase and verifies identity, clean state, target ancestry, PR-head ownership, the unchanged remote head, maintainer edit access, and that the canonical PR body does not pin the pre-rebase head SHA. If it passes, immediately publish with `scripts/publish-openclaw-rebase-only.mjs --workflow <outputs>/workflow.json --target <pinned-rebase-target-sha> --push-remote <remote>`; do not run preflight, gate summary, tests, lint, type checks, `git diff --check`, or ask for a second confirmation. If the check refuses because the body pins a stale head SHA, do not push: refresh the body with `scripts/refresh-pr-body-sha.sh --workflow <outputs>/workflow.json`, rerun `scripts/validate-pr-body.mjs --workflow <outputs>/workflow.json` (body-only edit), present the normal human gate, and publish with `scripts/publish-openclaw-pr.mjs`; the rebase-only receipt's patch equivalence is what makes the SHA transfer to the new head honest. Do not use this path for conflict resolution, review-driven code edits, proof/body changes beyond the deterministic SHA refresh, new PR creation, or any case that needs ClawSweeper re-review.

   **Conflict-resolution fast path:** Start the rebase through `scripts/openclaw-conflict-rebase.sh --phase start` before Git changes the branch. A conflict exit is expected; resolve only the recorded files. If a later `rebase --continue` stops again, run `--phase record` before resolving it. Merge-containing PR history is supported through stable net-patch equivalence. Create a small JSON validation plan containing only commands that rebuild a conflicted generated asset, exercise focused affected tests, or check a directly affected package boundary. When conflict/CI investigation requires a small maintenance edit outside the conflict files, list it in `allowedFiles` and add the matching focused command; finish only after those edits are complete. Finish with `--phase finish --plan <plan.json>`. The receipt permits up to eight explicitly scoped files across surfaces, rejects high-risk paths, and rejects any patch drift outside that scope. Generated conflicts require a rebuild command and non-document changes require a focused-test command. If it passes, run `openclaw-preflight.sh --profile conflict`, generate the Human Gate, and wait for approval before normal publication. If it refuses the scope, stop and show the reason plus estimated heavier lanes; do not start normal `auto`/`targeted`/`changed` validation without explicit user approval.

4. **Pre-push human gate**
   - This section applies by default. It does not apply to the clean rebase-only fast path above or to a user-authorized workflow-rule override. The user's explicit rebase/catch-up request is the authorization for the clean rebase-only path; an explicit workflow-rule bypass uses the normal publisher with the bypass flags.
   - Stop before any GitHub write unless the user has explicitly authorized the workflow-rule override.
   - Run `scripts/openclaw-gate-summary.sh --workflow <outputs>/workflow.json` and use the generated `gate-summary.md` as the human approval packet.
   - Show the user: diff summary, commit author/committer, tests/checks from `preflight.json`, PR body draft path or summary, live proof summary, and any unresolved risks.
   - Verify every workflow commit uses the selected account's author and committer identity. If no account profile was selected, verify every `sunlit-deng` commit uses author and committer email `yang.jiajun1@xydigit.com`. In the default path, fix local commit metadata before asking for push approval. An explicit workflow-rule override may publish with the recorded identity warning; do not rewrite other contributors' authored commits merely to change their author email unless the selected-account rule is intentionally being applied to this workflow.
   - For existing fork PRs, show the current maintainer edit status from `maintainerCanModify`. If it is `false`, stop in the default path and ask the user to re-enable `Allow edits and access to secrets by maintainers`; an explicit workflow-rule override may proceed with that warning recorded. For new PRs, show that the PR will be created without `--no-maintainer-edit` and must be checked immediately after creation.
   - When the PR already has a ClawSweeper review, show ClawSweeper's current verdict and any unresolved blocking findings before asking for push or re-review confirmation.
   - In the default path, continue with the branch push and PR create/update only after explicit user confirmation. If the user has explicitly authorized a workflow-rule override, show the bypassed checks and reason, then proceed without asking for a second approval. Neither path authorizes `@clawsweeper re-review`; re-review requires a separate explicit request.
   - After confirmation or an explicit override, pass the approved/current HEAD and PR body SHA-256 to `scripts/publish-openclaw-pr.mjs`. It pushes through the named SSH remote created for the `gh` identity. Both new PR creation and existing PR body updates use `gh api` with the REST pulls API. It then re-reads with `gh pr view` and verifies the exact body and remote target. New PRs should be ready for review by default; use draft only when explicitly requested or intentionally incomplete. For a failed-preflight-only override, use `--allow-failed-preflight --failed-preflight-bypass-reason "<user reason>"`; for a broader explicit override, use `--allow-workflow-rule-bypass --workflow-rule-bypass-reason "<user reason>"`.
   - After publishing, report the PR URL and post-publish maintainer-edit status. Do not post `@clawsweeper re-review` automatically; wait for the user to explicitly ask for re-review.
   - Conflict-resolved rebases remain in the normal human gate. Clean rebase-only maintenance bypasses this section and uses `scripts/publish-openclaw-rebase-only.mjs`, which requires a current passing patch-equivalence receipt, uses `--force-with-lease`, re-checks the PR head owner/ref and maintainer edit access, pushes only the branch, and verifies the remote PR head SHA. It intentionally does not read or write the PR body.
   - After creating or updating a fork PR, re-read `maintainerCanModify`. If it is `false`, stop before requesting review in the default path and tell the user the web checkbox must be restored; if an explicit workflow-rule override was used, report the false status and do not request review automatically.

5. **PR maintenance**
   - Do not run duplicate checks for an already-published PR. Review-driven edits, score-driven improvements, proof additions, CI fixes, rebases, and re-review preparation operate on the accepted PR lane; use the current review and CI state instead.
   - If CI fails, inspect logs and distinguish PR-caused failures from unrelated main/flaky failures with concrete evidence.
   - Prefer `gh pr checks`, `gh run list`, `gh run view`, and `gh run download` for CI investigation.
   - If ClawSweeper misreads stale state, first verify current head SHA and file diff, then update durable PR body if needed.
   - **Pre-re-review gate:** Before posting `@clawsweeper re-review`, read ClawSweeper's current review comment. Use `gh pr view <number> --repo openclaw/openclaw --json comments` and scan the most recent ClawSweeper review body. If ClawSweeper's verdict blocks the PR on proof (look for phrases like "needs real behavior proof", "missing proof", "🦪 silver shellfish", "status: 📣 needs proof"), do NOT request re-review until the requested proof is added to the PR body and the head branch is updated.
   - **Loop detection:** If the current head SHA matches the SHA in ClawSweeper's most recent review and ClawSweeper still reports the same blocker class (same "needs real behavior proof" verdict, same "🦪" rank), stop before any re-review request. Explain to the user what proof ClawSweeper is asking for and that the branch has not changed since the last review.
   - Do not post `@clawsweeper re-review` automatically after a push or PR update. Only when the user explicitly asks for ClawSweeper re-review, run the pre-re-review gate; if it passes and proof has been genuinely added, post exactly `@clawsweeper re-review`.

## References

- Read `references/worktree-layout.md` before creating or reusing worktrees.
- Read `references/token-budget.md` before broad candidate mining, PR maintenance, CI debugging, or resuming an existing workflow.
- Read `references/candidate-selection.md` before local or remote candidate ranking when the user prioritizes ClawSweeper A-rating likelihood.
- Read `references/evidence-receipts.md` before writing candidate-scout or structured proof inputs.
- Read `references/pr-body.md` before drafting or editing an OpenClaw PR body.
- Read `references/review-gates.md` before running preflight or interpreting bot/CI gates.

## Scripts

Create a worktree on macOS/Linux:

```bash
./.codex/skills/auto-pr-openclaw/scripts/new-openclaw-worktree.sh --issue 94432
```

Create a worktree for a local candidate without a GitHub issue:

```bash
./.codex/skills/auto-pr-openclaw/scripts/new-openclaw-worktree.sh \
  --mode local-candidate \
  --topic "doctor transcript atomic"
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

Run the pre-implementation candidate screen:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-candidate-scout.sh \
  --input candidate-plan.json \
  --repo-path workspace/openclaw/repos/openclaw
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

Refresh stale exact-head SHA references in the PR body after a rebase-only
check refuses (local edit only; then re-validate the body and use the normal
human gate):

```bash
./.codex/skills/auto-pr-openclaw/scripts/refresh-pr-body-sha.sh \
  --workflow workspace/openclaw/outputs/pr-93865/workflow.json \
  --dry-run
```

Start and finish a conflicted existing-PR rebase with focused validation:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-conflict-rebase.sh \
  --phase start \
  --workflow workspace/openclaw/outputs/pr-111181/workflow.json \
  --target <pinned-rebase-target-sha>

# Resolve only the files listed in conflict-rebase-state.json, continue rebase,
# then supply a bounded conflict-validation-plan.json. It may include:
# "allowedFiles": ["one/small/ci-maintenance-file.ts"]
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

Validate captured comparable proof before A-readiness scoring:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-proof-receipt.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json \
  --input workspace/openclaw/outputs/issue-94432/proof-evidence.json
```

Measure local prediction precision against reviewed PR samples:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-score-calibration.sh \
  --input clawsweeper-samples.json
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
