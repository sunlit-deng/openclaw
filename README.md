# auto-pr

Personal Codex workflows for preparing OpenClaw pull requests with repeatable local gates.

## Layout

```text
skills/
  openclaw-pr-workflow/     # Codex skill source
scripts/
  install.ps1               # install skills into CODEX_HOME
```

Recommended OpenClaw working directory layout:

```text
C:\Users\Yang\Documents\OpenClawWork\
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

## Install

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

