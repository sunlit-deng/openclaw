# Worktree Layout

Use one worktree per issue by default.

```text
<auto-pr>/workspace/openclaw/
  repos/
    openclaw/
  .pnpm-store/
  worktrees/
    issue-94432/
  outputs/
    issue-94432/
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
The shared store avoids repeated downloads and package unpacking, while each
worktree still needs a private install step to create the checkout-specific
links. On OpenClaw this private `node_modules` is commonly around 2 GB per
worktree, so old worktrees are the main disk-pressure source.

The worktree helpers derive this root from the `auto-pr` checkout, fetch
`origin/main`, and create the branch from the fetched commit. Dependencies are
installed by default. Initial repository download uses `gh repo clone` after
`gh auth setup-git`; do not replace a failed authenticated download with an
anonymous HTTPS clone.

Preferred setup:

```bash
./.codex/skills/auto-pr-openclaw/scripts/new-openclaw-worktree.sh --issue 94432
```

For an existing PR, use the dedicated intake command instead of creating an
issue branch from a fork head:

```bash
node ./.codex/skills/auto-pr-openclaw/scripts/prepare-openclaw-pr-worktree.mjs --pr 93865
```

It reads the PR through `gh pr view`, checks out its actual fork head through
`gh pr checkout`, records the remote head separately from the local branch, and
reports whether the PR already contains the observed `origin/main`. That SHA is
pinned as the validation base. Do not rebase merely because main moves again;
rebase for a real conflict, risky file overlap, or an explicit up-to-date rule.

For an existing worktree:

```bash
./.codex/skills/auto-pr-openclaw/scripts/ensure-openclaw-deps.sh \
  --repo-path ./workspace/openclaw/worktrees/issue-94432
```

This uses `<workspace>/openclaw/.pnpm-store` with
`pnpm install --frozen-lockfile --prefer-offline`. The helper fingerprints
`package.json` and `pnpm-lock.yaml`; it skips installation only when a private
`node_modules` exists with the same fingerprint. Use `--force` to relink it
explicitly.

To warm the shared store before creating new worktrees:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-workspace-maintenance.sh \
  --warm-store --yes
```

This runs `pnpm fetch` against `repos/openclaw` and
`workspace/openclaw/.pnpm-store`. It does not create or validate a worktree; it
only makes the next per-worktree install less likely to hit the network.

To skip the initial install, both an explicit switch and a reason are required:

```bash
./.codex/skills/auto-pr-openclaw/scripts/new-openclaw-worktree.sh \
  --issue 94432 --skip-install --skip-install-reason "offline fixture test"
```

The skip is recorded in `workflow.json` and will not count as a passed
validation later.

## Workspace Maintenance

Use the maintenance script to inspect and clean the local OpenClaw workspace:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-workspace-maintenance.sh
```

Default mode reports tracked dependency size, shared store size, output size,
and the largest per-worktree `node_modules` directories. It does not delete
anything.

To reclaim dependency space from inactive clean worktrees while keeping their
source checkouts:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-workspace-maintenance.sh \
  --prune-node-modules --older-than-days 14 --yes
```

The next time such a worktree is used, run `ensure-openclaw-deps.sh` to relink
dependencies from the shared store. This should be much cheaper than a cold
install when the store is warm.

To remove a finished worktree explicitly:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-workspace-maintenance.sh \
  --remove-worktree issue-94432 --remove-output --yes
```

Removal refuses dirty worktrees unless `--force` is provided. Prefer explicit
removal after a PR is merged, abandoned, or superseded; keep `outputs/` only
when its evidence is still useful.

## Outputs

Keep generated evidence outside the repository checkout:

- `pr-body.md`
- `live-proof.md`
- `workflow.json`
- `preflight.json`
- `ci-notes.md`

Only copy evidence into the PR body or comments after the human gate approves the GitHub write.
