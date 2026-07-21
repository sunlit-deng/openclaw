# auto-pr

Personal Codex and Claude Code workflows for preparing OpenClaw pull requests with repeatable local gates on macOS and Linux.

## Layout

```text
.codex/
  skills/
    auto-pr-openclaw/       # canonical project-local skill
.claude/
  skills/
    auto-pr-openclaw        # symlink to the canonical .codex skill
scripts/
  validate.sh               # validate scripts, tests, and skill consistency
```

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
fork remote with `gh repo fork --remote` after the human gate. Fetch failure is
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

The selected profile is written to `workflow.json`. Preflight and the human
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

Run deterministic checks before the human publication gate:

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

Generate the human approval packet before any GitHub write:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-gate-summary.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json
```

This writes `gate-summary.md` and `gate-summary.json` with the approved HEAD,
PR body hash, changed files, commit identity, preflight status, duplicate
receipt, candidate score, maintainer edit status, and blockers.

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

After the human gate, `publish-openclaw-pr.mjs` requires the approved HEAD and
body SHA-256 and pushes through an explicitly named SSH remote associated with
the `gh` identity. Both new PR creation and existing PR body updates use `gh
api` with the REST pulls API so the validated body/proof is preserved verbatim.
The script re-reads the PR with `gh pr view` and verifies the body and
maintainer edit access.

`workspace/` is local working state and is ignored by git.

## Use

Validate the skill and bundled scripts on macOS or Linux with:

```bash
./scripts/validate.sh
```

Run Codex or Claude Code from the `auto-pr` repository root. The canonical
skill lives under `.codex`; `.claude/skills/auto-pr-openclaw` is a repository
symlink to the same directory, so both tools always read identical content.
