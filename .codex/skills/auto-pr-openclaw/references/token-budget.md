# Token Budget Rules

Use low-token mode by default for OpenClaw work. The goal is to spend context on
judgment, not on repeatedly pasting logs, full JSON receipts, or large diffs.

## Default Behavior

- Prefer local receipts over prose: `candidate-score.json`, `preflight.json`, `gate-summary.json`, and `context-pack.md`, plus `duplicate-check.json` for unpublished candidates only.
- Generate `context-pack.md` after intake and after each material validation state change:

```bash
./.codex/skills/auto-pr-openclaw/scripts/openclaw-context-pack.sh \
  --workflow workspace/openclaw/outputs/issue-94432/workflow.json
```

- On resumed work, read `context-pack.md` first, then open only the specific
  source files or receipts needed for the next decision.
- Do not paste full command output into chat. Store it in output artifacts and
  summarize the key line, path, status, and SHA.
- Do not read full PR diffs, full CI logs, or full GitHub comment histories by
  default. Use path lists, short stats, focused hunks, and newest relevant
  comments first.
- Use `gh --json` with explicit fields and small limits. Avoid broad issue/PR
  mining unless the user asks for candidate discovery.
- For unpublished candidates, run `openclaw-duplicate-check.sh --offline` first
  when only planning queries, then run live GitHub duplicate checks only after
  the candidate is concrete. Skip duplicate checks entirely for existing PRs.
- Prefer CodeGraph for structural code questions and `rg` for literal strings.
  Do not run broad grep/read loops over OpenClaw.
- Avoid subagents for normal PR work. Use one agent and compact receipts unless
  the user explicitly asks for parallel agent work.

## Output Discipline

- Commentary updates should name what changed and where the receipt lives.
- Final answers should report only outcome, changed files, validation result,
  and the next human decision.
- If a command emits more than a short screen of output, rerun or post-process it
  into a short summary instead of sending the whole output to chat.
- Keep PR-body evidence concise, but keep full proof in `live-proof.md` or a
  committed proof artifact when needed.

## Suggested Token Tiers

- Scout: use `rg`, CodeGraph, and GitHub summaries only. Stop after a ranked
  shortlist or a concrete code point.
- Build: inspect only touched files and nearby tests. Keep validation receipts
  local.
- Gate: read `context-pack.md`, `candidate-score.json`, `preflight.json`, and
  `gate-summary.md`; avoid re-reading source unless a blocker points to it.

These rules do not weaken safety gates. If a deterministic blocker requires
more context, collect the smallest exact context needed to resolve it.
