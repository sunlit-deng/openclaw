## What Problem This Solves

Fixes an issue where Mattermost users replying in an existing thread could lose earlier thread context after the OpenClaw monitor restarted or the agent session was reset.

Fixes #93204

## Why This Change Was Made

The Mattermost monitor now backfills a cold local thread-history window from the Mattermost thread endpoint after inbound admission gates pass. The backfill marker is keyed by the stored thread `sessionId`, not the stable route session key, so a real `/new` or session reset in a thread gets its own recovery fetch while same-session follow-ups avoid repeated server fetches.

When the first cold turn has no stored thread session entry yet, the monitor now records a pending backfill marker and adopts it once `recordInboundSessionMeta` creates the stored session id. That keeps the marker stable for same-session follow-ups and failed-fetch no-retry, without blocking a later real session-id rotation.

Backfilled sender labels use stable Mattermost user ids instead of per-post user lookups, keeping recovery bounded to the thread fetch path.

## User Impact

Mattermost thread replies keep useful prior context after restart or `/new`, without repeated thread-history requests or extra user lookup delays on normal same-session follow-ups.

## Evidence

- `pnpm vitest run extensions/mattermost/src/mattermost/monitor.inbound-system-event.test.ts extensions/mattermost/src/mattermost/monitor.test.ts --reporter=verbose`: 72 passed; covers stored thread `sessionId` rotation, same-session no-refetch, failed-fetch no-retry, dropped pre-admission posts, bounded backfill without sender enrichment, and the initially-missing session entry path where a same-session follow-up must not refetch after a random stored `sessionId` is created.
- `pnpm tsgo:extensions:test`: passed.
- `pnpm exec oxfmt --check --threads=1 extensions/mattermost/src/mattermost/monitor.ts extensions/mattermost/src/mattermost/monitor.inbound-system-event.test.ts extensions/mattermost/src/mattermost/monitor.test.ts`: passed.
- `git diff --check`: passed.

Live proof: local Docker Mattermost Team Edition 10.11.21 at `http://localhost:8065`, with tokens and Mattermost ids redacted. The proof used real Mattermost REST auth, posts, and `/api/v4/posts/<root>/thread` through `monitorMattermostProvider`; a fake websocket only injected `posted` events into the monitor. The route/thread session key stayed stable while the stored thread `sessionId` rotated. Cold start included prior root/thread context, same-session server-only context stayed absent, and stored-thread-session reset included new server-only prior context:

```json
{
  "mattermost": "10.11.21 local Docker, token/id redacted",
  "routeSessionKey": "stable, redacted",
  "threadSessionKey": "stable, redacted",
  "threadSessionKeyStable": true,
  "storedThreadSessionIds": [
    "stored-session-before-reset",
    "stored-session-after-reset"
  ],
  "dispatchCount": 3,
  "firstColdStartContainsPriorThreadContext": true,
  "firstColdStartContainsRootContext": true,
  "sameSessionSkippedServerOnlyContext": true,
  "storedThreadSessionIdResetContainsNewPriorContext": true
}
```

AI-assisted: built with Codex
