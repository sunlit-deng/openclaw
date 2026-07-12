# auto-pr

Personal Codex workflows for preparing OpenClaw pull requests with repeatable local gates.

## Layout

```text
.codex/
  skills/
    auto-pr-openclaw/   # project-local Codex skill
scripts/
  install.ps1               # validate the project-local skill
```

Recommended OpenClaw working directory layout:

```text
<auto-pr>\workspace\openclaw\
  repos\
    openclaw\               # main clone used for fetch/base
    clawsweeper\            # official openclaw/clawsweeper clone
  worktrees\
    issue-94432\            # default one issue -> one PR worktree
  outputs\
    issue-94432\
      pr-body.md
      live-proof.md
      workflow.json
      preflight.json
      ci-notes.md
```

Use `issue-<number>` by default. If one issue needs multiple candidate PRs, use `issue-<number>-<topic>`.

The worktree helper always fetches `origin/main`, refuses to reuse an existing
local branch implicitly, uses `workspace/openclaw/.pnpm-store`, and installs
dependencies by default. It records the exact paths and Git SHAs in
`outputs/<name>/workflow.json`.

Existing PR maintenance uses `prepare-openclaw-pr-worktree.mjs --pr <number>`.
It fetches the actual fork head into `worktrees/pr-<number>` and reports whether
the head contains the latest upstream main, preventing a stale fork head from
being mistaken for a fresh new-PR base.

Run deterministic checks before the human publication gate:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-preflight.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json
```

This executes OpenClaw's `pnpm check` lane and `test:changed`, validates branch
state, commit identity, and PR body proof, then writes `preflight.json` tied to
the checked HEAD. Local AI reviews are optional diagnostics rather than gates.

After the human gate, `publish-openclaw-pr.mjs` requires the approved HEAD and
body SHA-256, pushes through an explicitly named SSH remote, and creates or
updates the PR body through GitHub's REST pulls API. It then re-reads the PR and
verifies the body and maintainer edit access. `gh pr create` and `gh pr edit`
are not used for PR body writes.

`workspace/` is local working state and is ignored by git.

## Use

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

On Linux/macOS, validate the skill and bundled scripts with:

```bash
./scripts/validate.sh
```

Run Codex from the `auto-pr` repository root so the project-local `.codex`
directory is the workflow home.
