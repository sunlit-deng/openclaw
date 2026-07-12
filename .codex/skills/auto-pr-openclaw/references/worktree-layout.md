# Worktree Layout

Use one worktree per issue by default.

```text
<auto-pr>\workspace\openclaw\
  repos\
    openclaw\
  .pnpm-store\
  worktrees\
    issue-94432\
  outputs\
    issue-94432\
      pr-body.md
      live-proof.md
      workflow.json
      preflight.json
      ci-notes.md
```

## Naming

- Default: `issue-<number>`.
- If one issue needs multiple candidate PRs: `issue-<number>-<topic>`.
- Avoid naming worktrees after PR numbers unless the work starts from an existing PR branch rather than an issue.

## Main Clone

Keep `repos/openclaw` as the main clone. Use it for:

- `git fetch`
- `origin/main`
- adding/removing worktrees

Do active coding in `worktrees/issue-<number>`. Existing PR maintenance uses
`worktrees/pr-<number>` with its fork owner and remote head recorded separately
in `workflow.json`.

## Dependencies

Share the pnpm package store across worktrees, but do not share `node_modules`.
`node_modules` contains workspace links for the checkout it was installed in, so
cross-worktree reuse can make tests resolve the wrong source files.

The worktree helpers derive this root from the `auto-pr` checkout, fetch
`origin/main`, and create the branch from the fetched commit. Dependencies are
installed by default. Initial repository download uses `gh repo clone` after
`gh auth setup-git`; do not replace a failed authenticated download with an
anonymous HTTPS clone.

Preferred setup:

```bash
./.codex/skills/auto-pr-openclaw/scripts/new-openclaw-worktree.sh --issue 94432
```

```powershell
powershell -ExecutionPolicy Bypass -File .\.codex\skills\auto-pr-openclaw\scripts\new-openclaw-worktree.ps1 `
  -Issue 94432
```

For an existing PR, use the dedicated intake command instead of creating an
issue branch from a fork head:

```bash
node ./.codex/skills/auto-pr-openclaw/scripts/prepare-openclaw-pr-worktree.mjs --pr 93865
```

It reads the PR through `gh pr view`, checks out its actual fork head through
`gh pr checkout`, records the remote head separately from the local branch, and
reports whether the PR already contains the latest `origin/main`. Rebase before
preflight when it does not.

For an existing worktree:

```bash
./.codex/skills/auto-pr-openclaw/scripts/ensure-openclaw-deps.sh \
  --repo-path ./workspace/openclaw/worktrees/issue-94432
```

```powershell
powershell -ExecutionPolicy Bypass -File .\.codex\skills\auto-pr-openclaw\scripts\ensure-openclaw-deps.ps1 `
  -RepoPath C:\path\to\openclaw-worktree
```

This uses `<workspace>\openclaw\.pnpm-store` with
`pnpm install --frozen-lockfile --prefer-offline`. If `node_modules` already
exists, the helper skips the install; pass `-Force` after lockfile or package
manifest changes.

To skip the initial install, both an explicit switch and a reason are required:

```bash
./.codex/skills/auto-pr-openclaw/scripts/new-openclaw-worktree.sh \
  --issue 94432 --skip-install --skip-install-reason "offline fixture test"
```

The skip is recorded in `workflow.json` and will not count as a passed
validation later.

## Outputs

Keep generated evidence outside the repository checkout:

- `pr-body.md`
- `live-proof.md`
- `workflow.json`
- `preflight.json`
- `ci-notes.md`

Only copy evidence into the PR body or comments after the human gate approves the GitHub write.
