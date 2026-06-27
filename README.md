# auto-pr

Personal Codex workflows for preparing OpenClaw pull requests with repeatable local gates.

## Layout

```text
.codex/
  skills/
    openclaw-pr-workflow/   # project-local Codex skill
scripts/
  install.ps1               # validate the project-local skill
```

Recommended OpenClaw working directory layout:

```text
E:\Projects\OpenClawWork\
  repos\
    openclaw\               # main clone used for fetch/base
    clawsweeper\            # official openclaw/clawsweeper clone
  worktrees\
    issue-94432\            # default one issue -> one PR worktree
  outputs\
    issue-94432\
      pr-body.md
      live-proof.md
      local-review.md
      ci-notes.md
```

Use `issue-<number>` by default. If one issue needs multiple candidate PRs, use `issue-<number>-<topic>`.

## Use

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Run Codex from `E:\Projects\auto-pr` so the project-local `.codex` directory is the workflow home.
