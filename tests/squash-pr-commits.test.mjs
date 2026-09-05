import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const script = new URL(
  "../.codex/skills/auto-pr-openclaw/scripts/openclaw-squash-pr-commits.mjs",
  import.meta.url,
).pathname;

function makeFixture(commits) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-squash-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "tester");
  git("config", "user.email", "tester@example.com");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "base commit");
  const baseSha = git("rev-parse", "HEAD");
  for (const commit of commits) {
    fs.writeFileSync(path.join(repo, commit.file), commit.content);
    git("add", ".");
    execFileSync("git", ["commit", "-q", "-m", commit.message], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: commit.authorName,
        GIT_AUTHOR_EMAIL: commit.authorEmail,
        GIT_COMMITTER_NAME: commit.committerName ?? commit.authorName,
        GIT_COMMITTER_EMAIL: commit.committerEmail ?? commit.authorEmail,
      },
    });
  }
  const accountsFile = path.join(root, "accounts.json");
  fs.writeFileSync(accountsFile, JSON.stringify({
    profiles: {
      tester: { username: "tester", email: "tester@example.com", login: "tester", pushRemote: "origin" },
    },
  }), "utf8");
  const workflow = {
    root,
    repoPath: repo,
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    validationBaseSha: baseSha,
    githubAccountProfile: "tester",
  };
  const workflowPath = path.join(root, "workflow.json");
  fs.writeFileSync(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf8");
  const run = () => JSON.parse(execFileSync(
    process.execPath,
    [script, "--workflow", workflowPath],
    { encoding: "utf8" },
  ));
  const runRaw = () => {
    try {
      return { status: 0, stdout: execFileSync(process.execPath, [script, "--workflow", workflowPath], { encoding: "utf8" }) };
    } catch (error) {
      return { status: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
  };
  const state = () => ({
    head: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    count: git("rev-list", "--count", `${baseSha}..HEAD`),
    subject: git("log", "-1", "--format=%s"),
  });
  return { root, repo, git, baseSha, run, runRaw, state };
}

test("squashes multiple own commits into one while preserving the tree", () => {
  const fixture = makeFixture([
    { file: "a.txt", content: "a\n", message: "first: add a", authorName: "tester", authorEmail: "tester@example.com" },
    { file: "b.txt", content: "b\n", message: "second: add b", authorName: "tester", authorEmail: "tester@example.com" },
  ]);
  const before = fixture.state();
  const result = fixture.run();
  assert.equal(result.squashed, true);
  assert.equal(result.commitsBefore, 2);
  assert.equal(result.treeUnchanged, true);
  assert.notEqual(result.head, result.previousHead);
  const after = fixture.state();
  assert.equal(after.count, "1");
  assert.equal(after.tree, before.tree);
  assert.equal(after.subject, "first: add a");
  // The author identity of the oldest commit is preserved.
  assert.equal(fixture.git("log", "-1", "--format=%ae %ce"), "tester@example.com tester@example.com");
});

test("refuses to squash when another author committed", () => {
  const fixture = makeFixture([
    { file: "a.txt", content: "a\n", message: "own commit", authorName: "tester", authorEmail: "tester@example.com" },
    { file: "b.txt", content: "b\n", message: "maintainer commit", authorName: "maintainer", authorEmail: "maintainer@example.com" },
  ]);
  const before = fixture.state();
  const raw = fixture.runRaw();
  assert.notEqual(raw.status, 0);
  assert.match(raw.stderr, /refusing to squash/);
  const after = fixture.state();
  assert.equal(after.head, before.head);
  assert.equal(after.count, before.count);
});

test("refuses to squash when a committer differs from the account", () => {
  const fixture = makeFixture([
    { file: "a.txt", content: "a\n", message: "own commit", authorName: "tester", authorEmail: "tester@example.com" },
    {
      file: "b.txt", content: "b\n", message: "rebased by someone else",
      authorName: "tester", authorEmail: "tester@example.com",
      committerName: "other", committerEmail: "other@example.com",
    },
  ]);
  const raw = fixture.runRaw();
  assert.notEqual(raw.status, 0);
  assert.match(raw.stderr, /refusing to squash/);
});

test("reports a no-op for a single own commit", () => {
  const fixture = makeFixture([
    { file: "a.txt", content: "a\n", message: "only commit", authorName: "tester", authorEmail: "tester@example.com" },
  ]);
  const result = fixture.run();
  assert.equal(result.squashed, false);
  const after = fixture.state();
  assert.equal(after.count, "1");
});

test("dry run does not rewrite history", () => {
  const fixture = makeFixture([
    { file: "a.txt", content: "a\n", message: "first: add a", authorName: "tester", authorEmail: "tester@example.com" },
    { file: "b.txt", content: "b\n", message: "second: add b", authorName: "tester", authorEmail: "tester@example.com" },
  ]);
  const before = fixture.state();
  const workflowPath = path.join(fixture.root, "workflow.json");
  const raw = execFileSync(
    process.execPath,
    [script, "--workflow", workflowPath, "--dry-run"],
    { encoding: "utf8" },
  );
  const result = JSON.parse(raw);
  assert.equal(result.dryRun, true);
  assert.equal(result.wouldSquash, 2);
  assert.equal(fixture.state().head, before.head);
  assert.equal(fixture.state().count, before.count);
});
