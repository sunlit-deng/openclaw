# Worktree Layout

Use one worktree per issue by default.

```text
E:\Projects\OpenClawWork\
  repos\
    openclaw\
    clawsweeper\
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

## Outputs

Keep generated evidence outside the repository checkout:

- `pr-body.md`
- `live-proof.md`
- `local-review.md`
- `ci-notes.md`

Only copy evidence into the PR body or comments after the human gate approves the GitHub write.
