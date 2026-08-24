import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { loadProjectProfile, projectValidationCommands } from "../.codex/auto-pr-core/project-profile.mjs";
import { targetedValidationDecision, targetedValidationPlan } from "../.codex/skills/auto-pr-openclaw/scripts/lib/targeted-validation.mjs";
import { validatePrBody } from "../.codex/skills/auto-pr-openclaw/scripts/lib/pr-body-validator.mjs";

const zero = loadProjectProfile("zeroclaw");
const repoRoot = path.resolve(import.meta.dirname, "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

function git(cwd, ...args) {
  return run("git", args, { cwd });
}

test("ZeroClaw profile encodes upstream branch, Cargo, and PR policy", () => {
  assert.equal(zero.github.repo, "zeroclaw-labs/zeroclaw");
  assert.equal(zero.github.defaultBranch, "master");
  assert.equal(zero.dependencies.kind, "cargo");
  assert.deepEqual(zero.prPolicy.requiredSections, ["Summary", "Testing", "Security & Privacy Impact", "Compatibility"]);
  assert.equal(zero.prPolicy.requireCommittedProof, false);
  assert.equal(zero.prPolicy.aiDisclosure, "forbidden-footer");
  assert.ok(zero.prPolicy.issueLinkVerbs.includes("Implements"));
});

test("ZeroClaw targeted validation selects Cargo commands and escalates policy paths", () => {
  const decision = targetedValidationDecision(["src/runtime.rs"], zero);
  assert.equal(decision.safe, true);
  assert.equal(decision.project.id, "zeroclaw");
  assert.deepEqual(targetedValidationPlan(["src/runtime.rs"], zero).commands, projectValidationCommands(zero, "targeted", ["src/runtime.rs"]));
  assert.equal(targetedValidationDecision([".github/workflows/ci.yml"], zero).safe, false);
  assert.equal(projectValidationCommands(zero, "docs", ["README.md"])[0].bin, "bash");
  assert.ok(projectValidationCommands(zero, "changed", ["crates/zeroclaw-runtime/src/lib.rs"]).some((command) => command.name.includes("parallel runtime")));
  assert.ok(projectValidationCommands(zero, "docs", ["docs/book/src/reference/cli.md"]).some((command) => command.name.includes("generated documentation")));
  assert.ok(projectValidationCommands(zero, "docs", ["docs/book/src/locale/zh.po"]).some((command) => command.name.includes("translation")));
  assert.ok(projectValidationCommands(zero, "changed", ["firmware/zeroclaw-fw-protocol/src/lib.rs"]).some((command) => command.name.includes("firmware")));
});

test("ZeroClaw quick preflight uses origin/master and Cargo metadata", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-zeroclaw-preflight-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const remote = path.join(directory, "remote.git");
  const root = path.join(directory, "workspace/zeroclaw");
  const repo = path.join(root, "worktrees/issue-42");
  const output = path.join(root, "outputs/issue-42");
  fs.mkdirSync(remote, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  writeTemplate(repo);
  fs.mkdirSync(path.join(repo, "docs/book/src/contributing"), { recursive: true });
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "# fixture contract\n", "utf8");
  fs.writeFileSync(path.join(repo, "docs/book/src/contributing/architecture-map.md"), "# fixture map\n", "utf8");
  git(remote, "init", "--bare");
  git(repo, "init", "-b", "master");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  fs.writeFileSync(path.join(repo, "Cargo.toml"), "[package]\nname = \"zeroclaw-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n", "utf8");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src/lib.rs"), "pub fn value() -> u8 { 1 }\n", "utf8");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "chore: base fixture");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "master");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-c", "fix/issue-42");
  fs.writeFileSync(path.join(repo, "src/lib.rs"), "pub fn value() -> u8 { 2 }\n", "utf8");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "fix: update fixture");
  const head = git(repo, "rev-parse", "HEAD");
  const bodyPath = path.join(output, "pr-body.md");
  writeBody(output);
  const intakePath = path.join(output, "intake.json");
  fs.writeFileSync(intakePath, `${JSON.stringify({
    kind: "zeroclaw-intake",
    issue: { number: 42 },
    targetBranch: "master",
    blockers: [],
    untrustedGithubInput: true,
  }, null, 2)}\n`, "utf8");
  const workflowWriter = path.join(repoRoot, ".codex/skills/auto-pr-openclaw/scripts/write-workflow-state.mjs");
  run(process.execPath, [workflowWriter, "--project-id", "zeroclaw", "--project-config", zero.profilePath, "--mode", "new-issue", "--issue", "42", "--root", root, "--repo-path", repo, "--output-path", output, "--branch", "fix/issue-42", "--base-ref", "origin/master", "--base-sha", base, "--head-sha", head, "--intake-path", intakePath, "--pr-body-path", bodyPath, "--preflight-path", path.join(output, "preflight.json"), "--dependency-status", "skipped", "--skip-reason", "fixture dependency setup"], { cwd: repoRoot });
  const fakeBin = path.join(directory, "bin");
  fs.mkdirSync(fakeBin);
  const fakeCargo = path.join(fakeBin, "cargo");
  fs.writeFileSync(fakeCargo, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({packages: [], workspace_members: []}));\n", "utf8");
  fs.chmodSync(fakeCargo, 0o755);
  run(process.execPath, [path.join(repoRoot, ".codex/skills/auto-pr-openclaw/scripts/openclaw-preflight.mjs"), "--workflow", path.join(output, "workflow.json"), "--profile", "quick"], { cwd: repoRoot, env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` } });
  const receipt = JSON.parse(fs.readFileSync(path.join(output, "preflight.json"), "utf8"));
  assert.equal(receipt.status, "passed", JSON.stringify(receipt.checks));
  assert.equal(receipt.profile, "quick");
  assert.equal(receipt.heavyChecks.length, 0);
  assert.equal(receipt.latestObservedMainSha, base);
});

function writeBody(directory, footer = "") {
  const file = path.join(directory, "pr-body.md");
  fs.writeFileSync(file, `## Summary
- **Base branch:** \`master\`
- **What changed and why:** Update the runtime behavior.
- **Scope boundary:** No unrelated behavior.
- **Blast radius:** Runtime crate only.
- **Linked issue(s):** Related #42
- **Labels:** \`risk:low\`

## Testing (required)
### How you can test (when useful)
- **Reviewer testing requested?** N/A — no useful manual verification path.

### How I tested
- **CI checks relied on and why:** focused Rust checks cover the changed crate.
- **Known CI coverage gap, if any:** None.
- **Commands run and tail output:**

\`\`\`text
$ cargo test --locked
test result: ok
\`\`\`

- **Beyond CI, what did I manually verify?** N/A
- **If any command was intentionally skipped, why:** N/A

## Security & Privacy Impact (required)
- **New permissions, capabilities, or file system access scope?** No
- **New external network calls?** No
- **Secrets / tokens / credentials handling changed?** No
- **PII, real identities, or personal data in diff, tests, fixtures, or docs?** No
- **Prompt injection or untrusted model-visible text introduced/changed?** No

## Compatibility (required)
- **Backward compatible?** Yes
- **Config / env / CLI surface changed?** No
- **Rust/MSRV/toolchain floor changed?** No
- **If backward compatibility is No or either surface/floor question is Yes: exact upgrade steps for existing users:** N/A

## Rollback (required for medium/high-risk PRs)
Low-risk change: \`git revert <sha>\` is the plan.
${footer}`, "utf8");
  return file;
}

function writeTemplate(directory) {
  const templatePath = path.join(directory, ".github/pull_request_template.md");
  fs.mkdirSync(path.dirname(templatePath), { recursive: true });
  fs.writeFileSync(templatePath, `## Summary
## Testing (required)
## Security & Privacy Impact (required)
## Compatibility (required)
## Rollback (required for medium/high-risk PRs)
## Supersede Attribution (required only when Supersedes # is used)
`, "utf8");
}

test("ZeroClaw PR body accepts the official sections without a proof-script requirement", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-zeroclaw-body-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  writeTemplate(directory);
  const result = validatePrBody({
    bodyPath: writeBody(directory),
    issue: 42,
    repoPath: directory,
    changedFiles: ["src/runtime.rs"],
    project: zero,
  });
  assert.equal(result.status, "passed", result.errors.join("; "));
});

test("ZeroClaw PR body rejects AI attribution footers", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-zeroclaw-footer-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  writeTemplate(directory);
  const result = validatePrBody({
    bodyPath: writeBody(directory, "\nCreated with Codex\n"),
    issue: 42,
    repoPath: directory,
    changedFiles: ["src/runtime.rs"],
    project: zero,
  });
  assert.equal(result.status, "failed");
  assert.match(result.errors.join("\n"), /forbidden AI attribution/);
});
