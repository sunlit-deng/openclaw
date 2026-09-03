# auto-pr

Personal Codex and Claude Code workflows for preparing OpenClaw and ZeroClaw pull requests with repeatable local gates on macOS and Linux. Project-specific policy and validation live in `.codex/auto-pr-core/projects/*.json`; the guarded workflow remains shared, with automatic publication when every gate passes, evidence-backed agent bypass for allowlisted external blockers, and a human fallback for repository-owned or uncertain attempts.

## Layout

```text
.codex/
  skills/
    auto-pr-openclaw/       # canonical project-local skill
    auto-pr-zeroclaw/       # canonical ZeroClaw skill
.claude/
  skills/
    auto-pr-openclaw        # symlink to the canonical .codex skill
    auto-pr-zeroclaw         # symlink to the canonical .codex skill
scripts/
  validate.sh               # validate scripts, tests, and skill consistency
```

## ZeroClaw

ZeroClaw uses its own skill and workspace, but not a second automation project:

```text
<auto-pr>/workspace/zeroclaw/
  repos/zeroclaw/          # main clone used for fetch/base
  worktrees/issue-<N>/     # one issue -> one worktree
  outputs/issue-<N>/       # PR body and receipts
```

The intake target is `origin/master`, dependencies use `cargo fetch --locked`,
and the default Rust validation profile records formatting, Clippy, and locked
tests. Start a workflow with:

```bash
./.codex/skills/auto-pr-zeroclaw/scripts/new-zeroclaw-worktree.sh --issue <N> --topic <slug>
```

For an existing PR, use `prepare-zeroclaw-pr-worktree.mjs`. Draft the body from
`.codex/skills/auto-pr-zeroclaw/references/pr-body.md`, then run the ZeroClaw
body validator, preflight, and gate summary. The publisher uses `master` from
the project profile and publishes automatically when the gate summary has no
blockers. If blockers remain, the agent may publish only with a bound,
evidence-backed judgment for the shared external-cause allowlist; it falls back
to the human approval path for repository-owned or uncertain requirements.
When the user explicitly directs a workflow-rule bypass, pass
`--allow-workflow-rule-bypass --workflow-rule-bypass-reason "<user reason>"` to
the publisher; the bypass is recorded in `workflow.json` and does not relax
target/account, lease, secret/privacy, or final-body integrity checks.
See `.codex/skills/auto-pr-zeroclaw/references/contribution-policy.md` for the
upstream contribution, PR-format, privacy, and validation requirements.

Recommended OpenClaw working directory layout:

```text
<auto-pr>/workspace/openclaw/
  repos/
    openclaw/               # main clone used for fetch/base
    clawsweeper/            # official openclaw/clawsweeper clone
  .pnpm-store/              # shared package store for all OpenClaw worktrees
  worktrees/
    issue-94432/            # default one issue -> one PR worktree
  outputs/
    issue-94432/
      pr-body.md
      live-proof.md
      workflow.json
      preflight.json
      ci-notes.md
```

Use `issue-<number>` by default. If one issue needs multiple candidate PRs, use `issue-<number>-<topic>`.

The worktree helper fetches `origin/main` once during intake, refuses to reuse
an existing local branch implicitly, uses `workspace/openclaw/.pnpm-store`, and
installs dependencies by default. It pins the fetched SHA as
`validationBaseSha` and records the exact paths and Git SHAs in
`outputs/<name>/workflow.json`.

The pnpm store is shared to avoid repeated downloads and package unpacking, but
each worktree keeps its own `node_modules` because pnpm creates
checkout-specific workspace links there. OpenClaw's private `node_modules` is
large, so old PR/candidate worktrees are usually the main disk-pressure source.

Repository download uses `gh repo clone` with `gh auth setup-git`. Existing PR
heads use `gh pr checkout`, and the publication step creates or attaches the
fork remote with `gh repo fork --remote` after the publication gate. Fetch failure is
a hard stop; cached refs are never described as current main.

## GitHub Accounts

Workflows can pin a GitHub account profile so different PRs use different
tokens, commit names, emails, and fork remotes. Put account config in
`workspace/openclaw/accounts.json`, `~/.config/auto-pr/openclaw-accounts.json`,
or the file named by `OPENCLAW_ACCOUNTS_FILE`:

```json
{
  "defaultProfile": "sunlit",
  "profiles": {
    "sunlit": {
      "login": "sunlit-deng",
      "username": "sunlit-deng",
      "email": "yang.jiajun1@xydigit.com",
      "tokenEnv": "GITHUB_TOKEN_SUNLIT",
      "pushRemote": "sunlit"
    },
    "alt": {
      "login": "other-login",
      "username": "Other Name",
      "email": "other@example.com",
      "tokenEnv": "GITHUB_TOKEN_ALT",
      "pushRemote": "alt"
    }
  }
}
```

`workspace/` is ignored by git, so `workspace/openclaw/accounts.json` is the
most convenient local-only place for this project. Keep tokens out of committed
files.

Token locations:

- Terminal shells: export token variables in `~/.zshrc`, `~/.zprofile`, or a
  local direnv file before starting Codex from that shell.
- Codex desktop app on macOS: GUI apps often do not inherit `~/.zshrc`. Use
  `launchctl setenv GITHUB_TOKEN_ALT <token>` and restart Codex, or point
  `OPENCLAW_ACCOUNTS_FILE` at a local ignored config that stores the token.
- One-off commands: prefix the command, for example
  `GITHUB_TOKEN_ALT=<token> ./.codex/skills/auto-pr-openclaw/scripts/new-openclaw-worktree.sh ...`.

Select a profile during intake:

```bash
./.codex/skills/auto-pr-openclaw/scripts/new-openclaw-worktree.sh \
  --issue 94432 \
  --account alt

node ./.codex/skills/auto-pr-openclaw/scripts/prepare-openclaw-pr-worktree.mjs \
  --pr 93865 \
  --account alt
```

For existing PRs, `--account` is optional. If omitted, the preparation script
reads the PR head owner and selects the configured profile whose `login` matches
that owner. Its JSON output includes `account` and `accountSelection`, which
Codex should report back before making changes.

Switch an already-prepared workflow:

```bash
node ./.codex/skills/auto-pr-openclaw/scripts/openclaw-set-account.mjs \
  --workflow workspace/openclaw/outputs/pr-93865/workflow.json \
  --account alt
```

For existing PR workflows, this refuses to switch to an account whose `login`
does not match the recorded PR head owner unless `--force` is used.

The selected profile is written to `workflow.json`. Preflight and the publication
gate enforce that commits use the profile's `username <email>`, and publish
scripts run `gh` with the profile token. Without an account profile, the
previous `gh` login behavior and `sunlit-deng <yang.jiajun1@xydigit.com>` check
remain in place.

Existing PR maintenance uses `prepare-openclaw-pr-worktree.mjs --pr <number>`.
It fetches the actual fork head into `worktrees/pr-<number>` and records whether
the head contains the observed upstream main. Main advancement after intake
does not force a rebase; preflight checks its single latest-main snapshot for a
real merge conflict and reports behind count and changed-file overlap as
advisories.

Run read-only candidate quality receipts once the workflow and changed files
exist:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-duplicate-check.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json
./.codex/skills/auto-pr-openclaw/scripts/openclaw-candidate-score.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json
```

These write `duplicate-check.json` and `candidate-score.json` next to the
workflow. They help drop duplicate, crowded, broad, or proof-weak PR lanes
before spending full validation time.

For runtime changes where true external live proof is unavailable, generate a
real-call-chain proof plan and exercise the highest local production boundary
instead of an isolated helper:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-proof-plan.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json
```

Run deterministic checks before the publication gate:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-preflight.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json
```

The default `auto` profile skips pnpm-heavy lanes for documentation-only diffs
and uses focused changed tests for every other change. To inspect
all profiles and options, run:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-preflight.sh --help
```

For source changes, the default release preflight runs the focused tests selected
from the changed surface and writes a passing receipt when the normal Git,
identity, PR-body/proof, and merge-risk gates also pass:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-preflight.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json
```

Use `--profile changed` only when you intentionally want the heavier local
`pnpm check:changed` lane in addition to focused tests.

Preflight validates branch state, commit identity, PR body proof, focused tests
against the pinned validation base, and latest-main merge compatibility, then
writes `preflight.json` tied to the checked HEAD. Successful heavy checks are
safely reused when their fingerprint is unchanged; successful focused test runs
are also cached across `quick`, `focused`, and `changed` profile switches for
the same HEAD and validation base. Use `--profile full` only for an intentional
full-repository `pnpm check`. Local AI reviews are optional diagnostics rather
than gates.

Generate the publication gate summary before any GitHub write:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-gate-summary.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json
```

This writes `gate-summary.md` and `gate-summary.json` with the current HEAD,
PR body hash, changed files, commit identity, preflight status, duplicate
receipt, candidate score, maintainer edit status, and structured blockers. When
`automaticPublication.eligible` is true and `blockers` is empty, publish
without a second confirmation:

```bash
node ./.codex/skills/auto-pr-openclaw/scripts/publish-openclaw-pr.mjs \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json \
  --auto-if-ready \
  --gate-summary workspace/openclaw/outputs/issue-94432/gate-summary.json \
  --title "<reviewed PR title>" \
  --head "<github-account>:<branch>"
```

For an existing PR, omit `--title` and `--head`; the workflow supplies the
current PR and branch identity.

If blockers remain, inspect `blockerDetails` and `agentExternalBypass`. For a
gate containing only allowlisted external blockers, write the bound
`agent-publication-judgment.json` receipt with high-confidence reasons and
evidence for every blocker, then add `--agent-judgment <path>` to the same
`--auto-if-ready` publisher command. Repository-owned, uncertain, identity,
lease, target, and remote-integrity blockers still require human confirmation.

Generate a compact low-token handoff packet after intake or after validation
state changes:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-context-pack.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json
```

Future resumed work should read `context-pack.md` first, then only the specific
receipt or source file needed for the next decision. This keeps Codex quota
focused on judgment instead of repeatedly replaying logs and diffs.

Inspect and maintain local workspace size with:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-workspace-maintenance.sh
```

To warm the shared store before creating new worktrees:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-workspace-maintenance.sh \
  --warm-store --yes
```

To reclaim dependency space from old clean worktrees while keeping their source
checkouts:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-workspace-maintenance.sh \
  --prune-node-modules --older-than-days 14 --yes
```

After the publication gate, `publish-openclaw-pr.mjs --auto-if-ready` binds the
gate summary to the current HEAD and body SHA-256, then pushes through an
explicitly named SSH remote associated with the `gh` identity. If the summary
is stale or contains a non-allowlisted blocker, it stops before any GitHub write
so the human path can be used. A valid `--agent-judgment` can authorize only
the gate's evidence-backed external blockers for that one attempt; the judgment
path, hash, reason, and blocker IDs are recorded in `workflow.json`. Both new
PR creation and existing PR body updates use `gh api` with the REST pulls API
so the body is preserved verbatim. The script re-reads the PR with `gh pr view`
and verifies the body, remote target, and maintainer edit access. An explicit
workflow-rule bypass remains available for exceptional user-directed attempts
and is recorded separately.

`workspace/` is local working state and is ignored by git.

For the current creation/maintenance call graph, measured amplification points,
implemented reductions, and remaining performance work, see
[`docs/performance.md`](docs/performance.md).

## Use

Validate the skill and bundled scripts on macOS or Linux with:

```bash
./scripts/validate.sh
```

Run Codex or Claude Code from the `auto-pr` repository root. The canonical
skill lives under `.codex`; `.claude/skills/auto-pr-openclaw` is a repository
symlink to the same directory, so both tools always read identical content.
