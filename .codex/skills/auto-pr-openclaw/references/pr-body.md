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

- Prefer proof that maps directly to the changed behavior.
- Include focused tests and exact commands/results when useful; for behavior claims, prefer copied terminal/live output over paraphrased "passed" summaries.
- For runtime, auth, network, provider, browser, CSP, CORS, or external API behavior, include live output, network/log proof, recording, or redacted runtime trace that shows the real path.
- For resource-safety/runtime claims, prefer copied terminal output over prose. When live provider proof is impractical, run a loopback/local proof that exercises the same production helper, tee the command and output to `outputs/<topic>/`, and paste the shortest useful transcript into the PR body.
- Good terminal proof shows the command, the trigger, and the negative control reviewers care about, for example: overflow error, configured limit, oversized input, bytes observed before cancellation, and `full_response_buffered=no`.
- Use relative commands or redact local paths. Never paste local usernames, tokens, account ids, private URLs, cookies, or full sensitive responses.
- Do not paste secrets, tokens, cookies, account IDs, private endpoints, or full sensitive response bodies.
- Move long logs, long command output, and detailed notes into an output artifact; summarize only the key line in the PR body.

## AI-Assisted Marker

Use the exact plain line:

```md
AI-assisted: built with Codex
```

Do not create a separate heading just for this marker unless the user explicitly asks.
