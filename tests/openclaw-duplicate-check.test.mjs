import assert from "node:assert/strict";
import test from "node:test";
import { isLikelyDuplicate } from "../.codex/skills/auto-pr-openclaw/scripts/lib/duplicate-utils.mjs";

function candidate(overrides = {}) {
  return {
    title: "unrelated pull request",
    overlappingFiles: [],
    matchedQueries: [],
    ...overrides,
  };
}

test("generic short file stems do not create duplicate blockers", () => {
  const item = candidate({
    title: "refactor shared memory helpers",
    matchedQueries: ["shared"],
  });

  assert.equal(isLikelyDuplicate(item, [
    "extensions/browser/src/cli/browser-cli-actions-input/shared.ts",
  ]), false);
});

test("exact file overlap remains a duplicate blocker", () => {
  const file = "extensions/browser/src/cli/browser-cli-actions-input/shared.ts";
  const item = candidate({ overlappingFiles: [file] });

  assert.equal(isLikelyDuplicate(item, [file]), true);
});

test("explicit issue references remain duplicate blockers", () => {
  const item = candidate({ matchedQueries: ["#12345"] });

  assert.equal(isLikelyDuplicate(item, ["extensions/browser/src/cli/shared.ts"]), true);
});

test("specific file stems in titles remain duplicate blockers", () => {
  const item = candidate({ title: "fix browser-cli-actions-input validation" });

  assert.equal(isLikelyDuplicate(item, [
    "extensions/browser/src/cli/browser-cli-actions-input.ts",
  ]), true);
});
