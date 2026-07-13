## What Problem This Solves

Fixes unbounded memory growth in the Codex app-server ignored-compaction-override warning dedupe. The previous process-lifetime `Set<string>` retained every distinct ignored override key until process exit.

## Why This Change Was Made

The warning dedupe now uses the shared `createDedupeCache({ ttlMs: 0, maxSize: 4096 })` helper from `openclaw/plugin-sdk/dedupe-runtime`. Duplicate warning keys are still suppressed while retained; after the cache exceeds 4096 distinct keys, the oldest key can warn again if it reappears.

## User Impact

Gateways with ordinary ignored compaction-override cardinality keep the same warn-once behavior. Very high-cardinality configurations get bounded process memory at the cost of possible re-warning after eviction.

## Evidence

Production-path cap proof: this imports the patched `extensions/codex/src/app-server/compact.js` module and drives 4097 distinct ignored-override keys through `maybeCompactCodexAppServerSession`. The script only intercepts `embeddedAgentLog.warn` to count calls; it lets the first warning and the evicted oldest-key warning reach the real OpenClaw embedded logger.

```text
$ node --import tsx .artifacts/pr-101745/compact-warning-cap-proof.mjs 2>&1
[agent/embedded] ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction
[agent/embedded] ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction
distinct warning keys through maybeCompactCodexAppServerSession: 4097
warning count after distinct keys: 4097
duplicate newest key suppressed: true
evicted oldest key warned again: true
final warning count: 4098
```

<details>
<summary>Proof script</summary>

```js
import { loggingState } from "../../src/logging/state.js";
loggingState.overrideSettings = { level: "info" };

const harness = await import("openclaw/plugin-sdk/agent-harness-runtime");

const originalWarn = harness.embeddedAgentLog.warn.bind(harness.embeddedAgentLog);
const originalInfo = harness.embeddedAgentLog.info.bind(harness.embeddedAgentLog);
let warnCount = 0;
harness.embeddedAgentLog.warn = (message, fields) => {
  warnCount += 1;
  if (warnCount === 1 || fields?.sessionId === "proof-0") {
    originalWarn(message, fields);
  }
};
harness.embeddedAgentLog.info = () => undefined;

const { maybeCompactCodexAppServerSession } = await import(
  "../../extensions/codex/src/app-server/compact.js"
);

const mockBindingStore = {
  read: async () => undefined,
  mutate: async () => false,
  withLease: async (_identity, fn) => fn(),
};

function makeParams(index) {
  const agentId = `cap-${index}`;
  return {
    sessionId: `proof-${index}`,
    sessionKey: `agent:${agentId}:session-${index}`,
    sandboxSessionKey: `agent:${agentId}:session-${index}`,
    agentId,
    trigger: "budget",
    config: {
      agents: {
        list: [
          {
            id: agentId,
            compaction: {
              model: "openai/gpt-5.4-mini",
              provider: "custom-summary",
            },
          },
        ],
      },
    },
  };
}

for (let index = 0; index < 4_097; index += 1) {
  await maybeCompactCodexAppServerSession(makeParams(index), { bindingStore: mockBindingStore });
}

const afterDistinctWarnings = warnCount;
await maybeCompactCodexAppServerSession(makeParams(4_096), { bindingStore: mockBindingStore });
const duplicateNewestSuppressed = warnCount === afterDistinctWarnings;

await maybeCompactCodexAppServerSession(makeParams(0), { bindingStore: mockBindingStore });
const oldestWarnedAgain = warnCount === afterDistinctWarnings + 1;

harness.embeddedAgentLog.info = originalInfo;

console.log(`distinct warning keys through maybeCompactCodexAppServerSession: 4097`);
console.log(`warning count after distinct keys: ${afterDistinctWarnings}`);
console.log(`duplicate newest key suppressed: ${duplicateNewestSuppressed}`);
console.log(`evicted oldest key warned again: ${oldestWarnedAgain}`);
console.log(`final warning count: ${warnCount}`);

if (
  afterDistinctWarnings !== 4_097 ||
  !duplicateNewestSuppressed ||
  !oldestWarnedAgain ||
  warnCount !== 4_098
) {
  process.exitCode = 1;
}
```

</details>

- `pnpm vitest run extensions/codex/src/app-server/compact.test.ts --reporter=verbose`: 38 passed, including `bounds ignored compaction override warnings through the compact entry point`.
- `pnpm vitest run src/infra/dedupe.test.ts --reporter=verbose`: 5 passed, including zero-TTL retention and touch-on-read max-size pruning.
- `pnpm vitest run src/plugins/contracts/plugin-sdk-package-contract-guardrails.test.ts`: 22 passed, including extension imports through public SDK subpaths.

AI-assisted: built with Codex
