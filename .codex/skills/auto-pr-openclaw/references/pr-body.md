# OpenClaw PR Body Rules

Follow `.github/pull_request_template.md` and `CONTRIBUTING.md`.

## Style

- Write like a human contributor, not a report generator.
- Keep the default PR body short: one short paragraph per required section, plus compact evidence bullets.
- Prefer concrete nouns and observed facts over process narration.
- Do not list files or implementation steps unless they clarify risk.
- Do not add extra sections unless the change genuinely needs them.
- Keep live proof to the minimum useful facts: what real path ran, status/result, and what was redacted.

## Default Shape

```md
## What Problem This Solves

Fixes an issue where users <do X> would <experience Y> when <condition>.

Fixes #<issue-number>

## Why This Change Was Made

<1-2 short sentences. State the fix and any important boundary.>

## User Impact

<1 short sentence describing what users/operators/developers can now expect.>

## Evidence

- <command or live path>: <result>
- <additional proof only if useful>

<!-- Prefer actual output for runtime/resource/network/provider changes. -->

```text
$ <redacted command>
<short terminal/live output showing status, trigger, limit, or negative control>
```

AI-assisted: built with Codex
```

## Example

```md
## What Problem This Solves

Fixes an issue where Codex OAuth users could see an unhelpful provider error when ChatGPT returned a Cloudflare challenge.

Fixes #94432

## Why This Change Was Made

The Codex OAuth calls now use the same browser-like request shape as the working ChatGPT client path, and Cloudflare challenge HTML is classified explicitly.

## User Impact

Users get a clearer auth/challenge failure instead of a generic provider failure.

## Evidence

- `pnpm vitest src/agents/embedded-agent-helpers/provider-error-patterns.test.ts`
- WHAM usage request with redacted OAuth credentials returned `200` JSON.

AI-assisted: built with Codex
```

## Linking Issues

- Use `Fixes #<issue>` or `Closes #<issue>` for a fix that should close the issue.
- Use `Related: #<issue>` only when the PR is related but should not close the issue.
- Keep the link visible as the last line of `## What Problem This Solves`.

## Evidence

- **Only real runtime proof.** For any change touching runtime, subprocess, stream, network, provider, browser, or external API behavior: the Evidence section must contain live terminal output, logs, recording, or redacted runtime trace that exercises the **real production code path**. Tests alone are supplementary; they do not replace real-path proof.
- **Test output is not real proof.** ClawSweeper ignores test-run output (e.g., `npx vitest ...` results, pass counts, test names, durations) as evidence of runtime behavior. Tests prove that code is testable; they do not prove the code works correctly in the real sandbox/exec-server/subprocess/network path. If you only have test output in Evidence, ClawSweeper will block with "needs real behavior proof" regardless of how many tests pass. At minimum, add redacted terminal output from a real production-path run showing the behavior before and after the change.
- **No synthetic checks.** ClawSweeper treats `node -e 'simulate ...'` and similar synthetic stream/error simulations as "thin signal" and will block the PR with 🦪 silver shellfish. The proof must come from the actual sandbox/exec-server/subprocess/network path.
- **No static tool output.** Do not put `oxlint`, `eslint`, `git diff --stat`, or any lint/format output in Evidence. These belong in pre-push validation gates, not the PR body. ClawSweeper ignores them and their presence dilutes the signal of real proof.
- Good terminal proof shows the command, the trigger, and the negative control reviewers care about.
- Use relative commands or redact local paths. Never paste local usernames, tokens, account ids, private URLs, cookies, or full sensitive responses.
- Move long logs, long command output, and detailed notes into an output artifact; summarize only the key line in the PR body.

## AI-Assisted Marker

Use the exact plain line:

```md
AI-assisted: built with Codex
```

Do not create a separate heading just for this marker unless the user explicitly asks.
