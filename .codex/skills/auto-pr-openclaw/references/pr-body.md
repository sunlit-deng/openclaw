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

<!-- Omit the issue link for direct PRs that fix a code point without an
existing GitHub issue. Do not create or attach an unrelated issue only to
satisfy the template, and never use the PR number itself as Related/Fixes. -->

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
- For direct PRs discovered from code, including existing PR maintenance, omit the issue link when no real issue exists.
- Never use the PR number itself as `Related`, `Fixes`, or `Closes`; a self-link is not an issue link.

## Evidence

- **Only real runtime proof.** For any change touching runtime, subprocess, stream, network, provider, browser, or external API behavior: the Evidence section must contain live terminal output, logs, recording, or redacted runtime trace that exercises the **real production code path**. Tests alone are supplementary; they do not replace real-path proof.
- **Use the real call chain when live external proof is blocked.** If credentials, paid services, network policy, or private systems make true live proof infeasible, still exercise the highest real boundary available: CLI command, server/route handler, provider/client entrypoint, sandbox/subprocess path, or public production module boundary. Replace only the unavailable external dependency with localhost/loopback, fixture input, or a local fake at the network/process boundary. Do not fall back to isolated helper calls unless that helper is the public production boundary.
- **Write a proof plan first for runtime work.** Run `openclaw-proof-plan.sh --workflow <outputs>/workflow.json` once changed files and the PR body exist. Use `proof-plan.md` to pick the real entrypoint and decide whether the fallback is loopback, fixture, CLI, or production-module-boundary proof.
- **Test output is not real proof.** ClawSweeper ignores test-run output (e.g., `npx vitest ...` results, pass counts, test names, durations) as evidence of runtime behavior. Tests prove that code is testable; they do not prove the code works correctly in the real sandbox/exec-server/subprocess/network path. If you only have test output in Evidence, ClawSweeper will block with "needs real behavior proof" regardless of how many tests pass. At minimum, add redacted terminal output from a real production-path run showing the behavior before and after the change.
- **No synthetic checks.** ClawSweeper treats `node -e 'simulate ...'` and similar synthetic stream/error simulations as "thin signal" and will block the PR with 🦪 silver shellfish. The proof must come from the actual sandbox/exec-server/subprocess/network path.
- **No static tool output.** Do not put `oxlint`, `eslint`, `git diff --stat`, or any lint/format output in Evidence. These belong in pre-push validation gates, not the PR body. ClawSweeper ignores them and their presence dilutes the signal of real proof.
- **Show before and after when feasible.** Strong Evidence proves both sides of the change: the real path fails, misbehaves, duplicates, overflows, accepts invalid input, or misses the intended behavior **before the fix**, and the same real path behaves correctly **after the fix**. Use the same command, script, input, or fixture for both sides whenever possible. If direct before-fix output is impractical, use a linked issue repro, captured base-branch run, or clearly labeled negative-control case, and state why it represents the pre-fix behavior.
- **Tie proof to the exact head.** Include the tested head SHA in the Evidence transcript. For a high-confidence comparison, run the same command, production entrypoint, input, and loopback/fixture dependency on `validationBaseSha` and the exact PR head; label the two outputs `base` and `head`.
- **Name the canonical reason.** State which merged sibling PR, existing shared helper, public facade, repository contract, provider limit, or upstream invariant supports the implementation shape. If none exists, explain why the chosen default, cap, or compatibility behavior is not arbitrary. Do not invent or overstate precedent.
- **Real-module proof for local behavior.** When the change is pure in-memory or local behavior, such as cache caps, deduplication, validation, parsing, normalization, or other logic without a natural external runtime path, create a short proof script that imports the **actual changed production module** and exercises the real exported API, integration boundary, or intentionally exposed test hook. For TypeScript/JavaScript, prefer `npx tsx <proof-script>.ts`; for other stacks, use the closest project-native runner. Do not prove only an extracted helper if the PR changed a production caller that owns the user-visible behavior.
- **Proof script availability.** If the proof script is not committed, include its full source in a `<details>` fold block in the PR body Evidence section, or link a durable artifact produced with the branch. Keep the script focused enough for reviewers to inspect quickly, and make sure its imports reference files that exist in the diff or repository at the PR head. For embedded source, show the command as if the reviewer saves the block in the repository root, such as `npx tsx proof-live.ts` or `pnpm exec tsx proof-live.ts`; do not use local output-workspace paths like `../../outputs/.../proof-live.ts` unless that path is a committed artifact available from the PR head.
- **Evidence must match the diff.** Every Evidence claim must correspond to changed files, added tests, committed proof artifacts, or production modules that exist on the branch. Do not mention scripts, files, tests, or commands that are absent from the branch or cannot be reproduced from the PR head.
- Good terminal proof shows the command, the trigger, and the negative control reviewers care about.
- Use commands that can run from the repository root. Never paste local absolute paths such as `/Users/...`, `/Volumes/...`, `/home/...`, or `C:\Users\...`.
- Do not reference local `outputs/`, `worktrees/`, or `workspace/openclaw/...` paths in commands, imports, artifacts, or embedded proof source. If a proof script is not committed, embed it in the PR body and show a repository-root command such as `npx tsx proof-live.ts`.
- Redact local usernames, tokens, account ids, private URLs, cookies, and full sensitive responses.
- Move long logs, long command output, and detailed notes into an output artifact; summarize only the key line in the PR body.

### Local Proof Script Pattern

Use this pattern only when a live external path is unavailable or would be less direct than importing the changed module itself.

````md
## Evidence

- Before fix: `<same command or linked repro>` showed <bad behavior>.
- After fix: `npx tsx proof-live.ts` imports the real changed production module and shows <correct behavior>; negative control still <expected result>.

```text
$ pnpm exec tsx proof-live.ts
before: <bad behavior, if captured by this script or a base-branch run>
after: <correct behavior>
negative-control: <expected unchanged behavior>
```

<details>
<summary>proof-live.ts</summary>

```ts
import { publicApiOrChangedBoundary } from "./path/to/changed/production-module";
import { optionalTestHook } from "./path/to/same/production-module";

// Exercise the real changed module, not a copied helper or mock-only harness.
```

</details>
````

### Real Call-Chain Fallback Pattern

Use this when the true external service cannot be called but the production
caller can be exercised locally.

````md
## Evidence

- Real call-chain fallback: `<command>` ran the production <CLI/server/provider/subprocess> path against a localhost/fixture boundary; valid input succeeded and the negative control was rejected before <bad behavior>.

```text
$ <command>
entrypoint: <actual CLI/server/provider/subprocess path>
dependency-boundary: localhost fixture for <external service>
valid: accepted <status/result>
negative-control: rejected <status/result>
```

<details>
<summary>proof-live.ts</summary>

```ts
// Start a localhost fixture only at the external boundary.
// Invoke the production caller/entrypoint that owns the changed behavior.
// Print valid and negative-control results.
```

</details>
````

### Evidence Rejection Patterns

- Mock-only proof, including Vitest output where the relevant dependencies or production boundary are mocked.
- Isolated helper proof when the PR changed a production module or caller whose behavior is not exercised.
- Loopback proof that calls only a copied parser/helper instead of the production caller.
- Prose claims without pasted terminal output, logs, recording, screenshot, or linked artifact.
- Mismatched evidence that names files, tests, scripts, or commands absent from the PR head.

## AI-Assisted Marker

Use the exact plain line:

```md
AI-assisted: built with Codex
```

Do not create a separate heading just for this marker unless the user explicitly asks.

## Publication Integrity

- Keep the body in the canonical `outputs/<issue-or-candidate>/pr-body.md` file with LF line endings.
- Run `validate-pr-body.mjs` or the full preflight before the human gate.
- Create new PRs through `gh api --method POST repos/openclaw/openclaw/pulls` so the complete body/proof is submitted through REST.
- Update an existing PR body through `gh api --method PATCH repos/openclaw/openclaw/pulls/<number>`.
- Do not use `gh pr create` or `gh pr edit` for body-bearing writes; both create and update must preserve the canonical body file through REST.
- The human approval applies to one HEAD SHA and one body SHA-256. Any code or body edit requires validation and approval again.
- Re-read the PR after writing and require the normalized remote body to match the local file exactly.
