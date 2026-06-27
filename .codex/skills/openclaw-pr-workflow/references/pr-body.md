# OpenClaw PR Body Rules

Follow `.github/pull_request_template.md` and `CONTRIBUTING.md`.

## Required Shape

Use these visible sections:

```md
Fixes #<issue-number>

## What Problem This Solves

Fixes an issue where users <do X> would <experience Y> when <condition>.

## Why This Change Was Made

<One or two sentences explaining the shipped solution, key boundaries, and non-goals.>

## User Impact

<Concrete user/operator/developer benefit.>

## Evidence

<Focused tests, CI, screenshots, terminal output, redacted logs, live observations, or artifact links.>

## Live Behavior Proof

<Include when the changed behavior needs real runtime proof. Redact secrets.>

AI-assisted: built with Codex
```

## Linking Issues

- Use `Fixes #<issue>` or `Closes #<issue>` for a fix that should close the issue.
- Use `Related: #<issue>` only when the PR is related but should not close the issue.
- Keep the link visible in the PR body, below the template comment or at the start of the body.

## Evidence

- Prefer proof that maps directly to the changed behavior.
- Include focused tests and exact commands/results when useful.
- For runtime, auth, network, provider, browser, CSP, CORS, or external API behavior, include live output, network/log proof, recording, or redacted runtime trace that shows the real path.
- Do not paste secrets, tokens, cookies, account IDs, private endpoints, or full sensitive response bodies.

## AI-Assisted Marker

Use the exact plain line:

```md
AI-assisted: built with Codex
```

Do not create a separate heading just for this marker unless the user explicitly asks.

