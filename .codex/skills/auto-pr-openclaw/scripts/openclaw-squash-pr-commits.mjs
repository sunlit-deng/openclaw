#!/usr/bin/env node

// Squash the workflow branch's own commits into one before publication.
//
// Refuses to touch history unless every commit between the pinned validation
// base and HEAD is authored AND committed by the selected account identity.
// The squash is tree-preserving by construction (`git reset --soft` + `git
// commit -C <oldest>`), so preflight heavy-lane caches keyed on diff content
// and the HEAD tree remain valid; only the commit SHA changes.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ghEnv, resolveAccount } from "./lib/account-utils.mjs";
import { projectForWorkflow } from "../../../auto-pr-core/project-profile.mjs";

function parseArgs(argv) {
  const result = { workflow: "", dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    if (arg === "--workflow") {
      result.workflow = argv[++index] ?? "";
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!result.workflow) throw new Error("--workflow is required");
  return result;
}

function execute(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (result.status !== 0) {
    const details = String(result.stderr || result.stdout || result.error?.message || "unknown error").slice(-4000);
    throw new Error(`${command} ${args.join(" ")} failed: ${details}`);
  }
  return result.stdout.trim();
}

function tryExecute(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const workflowPath = path.resolve(args.workflow);
const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf8"));
const project = projectForWorkflow(workflow);
const projectRepo = project?.github?.repo ?? "";
const account = resolveAccount({ workflow });
const repoPath = path.resolve(workflow.repoPath);
const warnings = [];

if (execute("git", ["branch", "--show-current"], { cwd: repoPath }) !== workflow.branch) {
  console.error(`current branch does not match workflow branch ${workflow.branch}`);
  process.exit(1);
}
if (execute("git", ["status", "--porcelain"], { cwd: repoPath }).length > 0) {
  console.error("working tree is not clean; refusing to rewrite history");
  process.exit(1);
}

const baseInput = workflow.validationBaseSha || workflow.baseSha
  || (typeof workflow.baseRef === "string" ? workflow.baseRef.replace(/^origin\//, "") : "");
if (!baseInput) {
  console.error("workflow has no validation base SHA, base SHA, or base ref");
  process.exit(1);
}
const baseSha = execute("git", ["rev-parse", `${baseInput}^{commit}`], { cwd: repoPath });
if (execute("git", ["rev-parse", "HEAD"], { cwd: repoPath }) === baseSha) {
  console.log(JSON.stringify({ squashed: false, reason: "HEAD equals the base; nothing to squash" }, null, 2));
  process.exit(0);
}
const ancestorCheck = tryExecute("git", ["merge-base", "--is-ancestor", baseSha, "HEAD"], { cwd: repoPath });
if (!ancestorCheck.ok) {
  console.error(`validation base ${baseSha} is not an ancestor of HEAD; refusing to squash`);
  process.exit(1);
}

const logSeparator = "\u0001";
const commitLines = execute("git", [
  "log",
  "--reverse",
  `--format=%H${logSeparator}%an${logSeparator}%ae${logSeparator}%cn${logSeparator}%ce${logSeparator}%s`,
  `${baseSha}..HEAD`,
], { cwd: repoPath }).split("\n").filter((line) => line.length > 0);

const commits = commitLines.map((line) => {
  const [sha, authorName, authorEmail, committerName, committerEmail, subject] = line.split(logSeparator);
  return { sha, authorName, authorEmail, committerName, committerEmail, subject };
});

if (commits.length <= 1) {
  console.log(JSON.stringify({
    squashed: false,
    reason: `branch carries ${commits.length} commit(s) past the base; nothing to squash`,
  }, null, 2));
  process.exit(0);
}

// Ownership gate: every commit must be authored and committed by the selected
// account. Foreign commits are never rewritten.
const foreign = commits.filter((commit) =>
  commit.authorEmail !== account.email
  || commit.committerEmail !== account.email);
if (foreign.length > 0) {
  console.error(`refusing to squash: ${foreign.length}/${commits.length} commit(s) are not authored and committed by ${account.username} <${account.email}>:`);
  for (const commit of foreign.slice(0, 10)) {
    console.error(`- ${commit.sha.slice(0, 12)} ${commit.subject} (${commit.authorName} <${commit.authorEmail}>)`);
  }
  process.exit(1);
}

// Remote ownership check (best effort when gh is unusable): the user-visible
// premise is "no other people committed to this PR". A mismatch here is a hard
// refusal; a gh failure only degrades to a warning because the local commits
// are the ones being rewritten and the publish push uses --force-with-lease.
if (workflow.pr && projectRepo) {
  const prView = tryExecute("gh", [
    "pr", "view", String(workflow.pr), "--repo", projectRepo, "--json", "commits",
  ], { env: ghEnv(account) });
  if (!prView.ok) {
    warnings.push(`could not verify remote PR commit authors via gh: ${prView.output.slice(0, 300)}`);
  } else {
    try {
      const remoteCommits = JSON.parse(prView.output).commits ?? [];
      const foreignRemote = remoteCommits.filter((commit) =>
        Array.isArray(commit.authors)
        && commit.authors.some((author) => author?.login
          && author.login.toLowerCase() !== String(account.login).toLowerCase()));
      if (foreignRemote.length > 0) {
        console.error(`refusing to squash: remote PR ${workflow.pr} contains commits from other logins (${foreignRemote.length}/${remoteCommits.length})`);
        process.exit(1);
      }
    } catch (error) {
      warnings.push(`could not parse gh pr view commits output: ${error.message}`);
    }
  }
}

const originalHead = execute("git", ["rev-parse", "HEAD"], { cwd: repoPath });
const treeBefore = execute("git", ["rev-parse", "HEAD^{tree}"], { cwd: repoPath });
const oldest = commits[0];

if (args.dryRun) {
  console.log(JSON.stringify({
    squashed: false,
    dryRun: true,
    wouldSquash: commits.length,
    base: baseSha,
    oldestSubject: oldest.subject,
    head: originalHead,
    tree: treeBefore,
    warnings,
  }, null, 2));
  process.exit(0);
}

execute("git", ["reset", "--soft", baseSha], { cwd: repoPath });
let squashed = false;
try {
  // -C reuses the oldest commit's message, author, and author date; the
  // committer comes from the worktree's configured account identity.
  execute("git", ["commit", "-C", oldest.sha], { cwd: repoPath });
  squashed = true;
} catch (error) {
  // Restore the original history exactly; the tree was clean and reset --soft
  // never touched the working tree or index contents.
  execute("git", ["reset", "--soft", originalHead], { cwd: repoPath });
  throw error;
}

const newHead = execute("git", ["rev-parse", "HEAD"], { cwd: repoPath });
const treeAfter = execute("git", ["rev-parse", "HEAD^{tree}"], { cwd: repoPath });

console.log(JSON.stringify({
  squashed,
  commitsBefore: commits.length,
  base: baseSha,
  head: newHead,
  previousHead: originalHead,
  messageFrom: oldest.sha,
  oldestSubject: oldest.subject,
  treeUnchanged: treeBefore === treeAfter,
  warnings,
}, null, 2));
