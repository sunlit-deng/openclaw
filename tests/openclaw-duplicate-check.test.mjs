import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { isLikelyDuplicate } from "../.codex/skills/auto-pr-openclaw/scripts/lib/duplicate-utils.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const duplicateCheck = path.join(repoRoot, ".codex/skills/auto-pr-openclaw/scripts/openclaw-duplicate-check.mjs");

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

test("live duplicate reads are bounded-concurrent and receipts deduplicate search payloads", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-duplicate-concurrency-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const bin = path.join(temp, "bin");
  const output = path.join(temp, "outputs");
  const events = path.join(temp, "events.log");
  fs.mkdirSync(bin);
  fs.mkdirSync(output);
  const gh = path.join(bin, "gh");
  fs.writeFileSync(gh, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const events = process.env.MOCK_GH_EVENTS;
if (args[0] === "search") {
  fs.appendFileSync(events, "start " + process.pid + " " + Date.now() + "\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
  fs.appendFileSync(events, "end " + process.pid + " " + Date.now() + "\\n");
  const isPr = args[1] === "prs";
  process.stdout.write(JSON.stringify([{
    number: isPr ? 101 : 201,
    title: isPr ? "fix runtime overlap" : "runtime issue",
    state: "open",
    url: "https://example.test/" + (isPr ? "pr/101" : "issue/201"),
    updatedAt: "2026-08-05T00:00:00Z"
  }]));
} else if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ files: [{ path: "src/runtime.ts" }] }));
} else {
  process.stderr.write("unexpected gh invocation: " + args.join(" "));
  process.exitCode = 1;
}
`, "utf8");
  fs.chmodSync(gh, 0o755);

  const prBody = path.join(output, "pr-body.md");
  const workflow = path.join(output, "workflow.json");
  fs.writeFileSync(prBody, "## What Problem This Solves\n\nRuntime overlap check.\n", "utf8");
  fs.writeFileSync(workflow, JSON.stringify({
    schemaVersion: 2,
    mode: "local-candidate",
    pr: null,
    repoPath: temp,
    outputPath: output,
    validationBaseSha: "",
    prBodyPath: prBody,
    preflightPath: path.join(output, "preflight.json"),
  }), "utf8");

  const result = spawnSync(process.execPath, [
    duplicateCheck,
    "--workflow", workflow,
    "--file", "src/runtime.ts",
    "--query", "runtime-overlap-one",
    "--query", "runtime-overlap-two",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      MOCK_GH_EVENTS: events,
      OPENCLAW_GH_READ_CONCURRENCY: "4",
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const receipt = JSON.parse(fs.readFileSync(path.join(output, "duplicate-check.json"), "utf8"));
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.summary.githubReadConcurrency, 4);
  assert.ok(receipt.summary.searchRequestCount >= 4);
  assert.deepEqual(receipt.searches[0].itemNumbers, [101]);
  assert.equal("items" in receipt.searches[0], false);
  assert.equal(receipt.relatedOpenPrs[0].changedFileCount, 1);
  assert.equal("changedFiles" in receipt.relatedOpenPrs[0], false);
  assert.deepEqual(receipt.relatedOpenPrs[0].overlappingFiles, ["src/runtime.ts"]);

  const eventLines = fs.readFileSync(events, "utf8").trim().split("\n").map((line) => line.split(" "));
  let active = 0;
  let maxActive = 0;
  for (const [kind] of eventLines) {
    active += kind === "start" ? 1 : -1;
    maxActive = Math.max(maxActive, active);
  }
  assert.ok(maxActive > 1, `expected overlapping gh searches, observed max ${maxActive}`);
  assert.ok(maxActive <= 4, `expected concurrency cap 4, observed max ${maxActive}`);
});
