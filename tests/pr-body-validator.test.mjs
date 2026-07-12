import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validatePrBody } from "../.codex/skills/auto-pr-openclaw/scripts/lib/pr-body-validator.mjs";

function bodyFor(evidence) {
  return `## What Problem This Solves

Fixes the documented behavior.

Fixes #123

## Why This Change Was Made

The previous behavior was incorrect.

## User Impact

Users now get the expected result.

## Evidence

${evidence}

AI-assisted: built with Codex
`;
}

function validate(body, changedFiles) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-body-"));
  const bodyPath = path.join(directory, "pr-body.md");
  fs.writeFileSync(bodyPath, body, "utf8");
  return validatePrBody({ bodyPath, issue: 123, repoPath: directory, changedFiles });
}

test("accepts a docs-only body with captured command output", () => {
  const result = validate(bodyFor("- `pnpm check:docs`: completed.\n\n```text\nstatus: passed\n```"), ["docs/example.md"]);
  assert.equal(result.status, "passed");
  assert.equal(result.docsOnly, true);
});

test("rejects a runtime body without a proof script", () => {
  const result = validate(bodyFor("- `pnpm test:changed`: completed.\n\n```text\nstatus: passed\n```"), ["src/example.ts"]);
  assert.equal(result.status, "failed");
  assert.match(result.errors.join("\n"), /proof\/repro script/);
});

test("accepts embedded proof source for a runtime change", () => {
  const evidence = `- \`npx tsx proof-live.ts\`: exercised the changed module.

\`\`\`text
after: correct behavior
negative-control: unchanged
\`\`\`

<details>
<summary>proof-live.ts</summary>

\`\`\`ts
import { changedApi } from "./src/example.ts";
console.log(changedApi());
\`\`\`

</details>`;
  const result = validate(bodyFor(evidence), ["src/example.ts"]);
  assert.equal(result.status, "passed", result.errors.join("\n"));
});

test("rejects empty sections and template placeholders", () => {
  const result = validate(bodyFor("<same command>"), ["docs/example.md"]);
  assert.equal(result.status, "failed");
  assert.match(result.errors.join("\n"), /template placeholders/);
});
