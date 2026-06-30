# Worktree Layout

Use one worktree per issue by default.

```text
E:\Projects\auto-pr\workspace\openclaw\
  repos\
    openclaw\
    clawsweeper\
  .pnpm-store\
  worktrees\
    issue-94432\
  outputs\
    issue-94432\
      pr-body.md
      live-proof.md
      local-review.md
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

Do active coding in `worktrees/issue-<number>`.

## Dependencies

Share the pnpm package store across worktrees, but do not share `node_modules`.
`node_modules` contains workspace links for the checkout it was installed in, so
cross-worktree reuse can make tests resolve the wrong source files.

Preferred setup:

```bash
/Users/yangjiajun/projects/auto-pr/.codex/skills/auto-pr-openclaw/scripts/new-openclaw-worktree.sh \
  --issue 94432 \
  --install-dependencies
```

```powershell
powershell -ExecutionPolicy Bypass -File E:\Projects\auto-pr\.codex\skills\auto-pr-openclaw\scripts\new-openclaw-worktree.ps1 `
  -Issue 94432 `
  -InstallDependencies
```

For an existing worktree:

```bash
/Users/yangjiajun/projects/auto-pr/.codex/skills/auto-pr-openclaw/scripts/ensure-openclaw-deps.sh \
  --repo-path /Users/yangjiajun/projects/auto-pr/workspace/openclaw/worktrees/issue-94432
```

```powershell
powershell -ExecutionPolicy Bypass -File E:\Projects\auto-pr\.codex\skills\auto-pr-openclaw\scripts\ensure-openclaw-deps.ps1 `
  -RepoPath C:\path\to\openclaw-worktree
```

This uses `<workspace>\openclaw\.pnpm-store` with
`pnpm install --frozen-lockfile --prefer-offline`. If `node_modules` already
exists, the helper skips the install; pass `-Force` after lockfile or package
manifest changes.

## Outputs

Keep generated evidence outside the repository checkout:

- `pr-body.md`
- `live-proof.md`
- `local-review.md`
- `ci-notes.md`

Only copy evidence into the PR body or comments after the human gate approves the GitHub write.
