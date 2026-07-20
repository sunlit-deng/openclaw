import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  findAccountProfileByLogin,
  resolveAccountForLogin,
} from "../.codex/skills/auto-pr-openclaw/scripts/lib/account-utils.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const accountTool = path.join(repoRoot, ".codex/skills/auto-pr-openclaw/scripts/openclaw-account.mjs");
const setAccountTool = path.join(repoRoot, ".codex/skills/auto-pr-openclaw/scripts/openclaw-set-account.mjs");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.trim();
}

test("account profiles resolve without printing tokens in show mode", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-account-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const config = path.join(temp, "accounts.json");
  fs.writeFileSync(config, JSON.stringify({
    profiles: {
      alt: {
        login: "octo-alt",
        username: "Alt User",
        email: "alt@example.com",
        tokenEnv: "GITHUB_TOKEN_ALT",
        pushRemote: "alt-fork",
      },
    },
  }, null, 2), "utf8");

  const env = {
    ...process.env,
    OPENCLAW_ACCOUNTS_FILE: config,
    GITHUB_TOKEN_ALT: "test_secret_for_profile",
  };
  const shown = JSON.parse(run(process.execPath, [
    accountTool,
    "show",
    "--profile", "alt",
  ], { env }));
  assert.equal(shown.profile, "alt");
  assert.equal(shown.username, "Alt User");
  assert.equal(shown.email, "alt@example.com");
  assert.equal(shown.login, "octo-alt");
  assert.equal(shown.pushRemote, "alt-fork");
  assert.equal(shown.tokenSource, "configured");
  assert.ok(!JSON.stringify(shown).includes("test_secret_for_profile"));

  const shellEnv = run(process.execPath, [
    accountTool,
    "shell-env",
    "--profile", "alt",
  ], { env });
  assert.match(shellEnv, /OPENCLAW_ACCOUNT_PROFILE='alt'/);
  assert.match(shellEnv, /GH_TOKEN='test_secret_for_profile'/);
});

test("existing PR owner can select the matching account profile", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-account-match-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const config = path.join(temp, "accounts.json");
  fs.writeFileSync(config, JSON.stringify({
    defaultProfile: "sunlit",
    profiles: {
      sunlit: {
        login: "sunlit-deng",
        username: "sunlit-deng",
        email: "yang.jiajun1@xydigit.com",
        tokenEnv: "GITHUB_TOKEN_SUNLIT",
      },
      alt: {
        login: "octo-alt",
        username: "Alt User",
        email: "alt@example.com",
        tokenEnv: "GITHUB_TOKEN_ALT",
      },
    },
  }, null, 2), "utf8");

  const previousFile = process.env.OPENCLAW_ACCOUNTS_FILE;
  const previousSunlit = process.env.GITHUB_TOKEN_SUNLIT;
  const previousAlt = process.env.GITHUB_TOKEN_ALT;
  process.env.OPENCLAW_ACCOUNTS_FILE = config;
  process.env.GITHUB_TOKEN_SUNLIT = "sunlit_secret_for_profile";
  process.env.GITHUB_TOKEN_ALT = "alt_secret_for_profile";
  t.after(() => {
    if (previousFile === undefined) delete process.env.OPENCLAW_ACCOUNTS_FILE;
    else process.env.OPENCLAW_ACCOUNTS_FILE = previousFile;
    if (previousSunlit === undefined) delete process.env.GITHUB_TOKEN_SUNLIT;
    else process.env.GITHUB_TOKEN_SUNLIT = previousSunlit;
    if (previousAlt === undefined) delete process.env.GITHUB_TOKEN_ALT;
    else process.env.GITHUB_TOKEN_ALT = previousAlt;
  });

  assert.deepEqual(findAccountProfileByLogin("octo-alt"), {
    profile: "alt",
    configPath: config,
  });
  const selected = resolveAccountForLogin({ login: "octo-alt" });
  assert.equal(selected.selection, "pr-head-owner");
  assert.equal(selected.account.profile, "alt");
  assert.equal(selected.account.login, "octo-alt");
  assert.equal(selected.account.email, "alt@example.com");
});

test("set-account updates workflow and local git identity", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "auto-pr-set-account-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const config = path.join(temp, "accounts.json");
  const repo = path.join(temp, "repo");
  const output = path.join(temp, "output");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(config, JSON.stringify({
    profiles: {
      alt: {
        login: "octo-alt",
        username: "Alt User",
        email: "alt@example.com",
        tokenEnv: "GITHUB_TOKEN_ALT",
      },
    },
  }, null, 2), "utf8");
  run("git", ["init", "-b", "main"], { cwd: repo });
  fs.writeFileSync(path.join(output, "workflow.json"), JSON.stringify({
    schemaVersion: 2,
    mode: "local-candidate",
    issue: 7,
    pr: null,
    root: temp,
    repoPath: repo,
    outputPath: output,
    branch: "main",
    headOwner: null,
  }, null, 2), "utf8");

  const env = {
    ...process.env,
    OPENCLAW_ACCOUNTS_FILE: config,
    GITHUB_TOKEN_ALT: "alt_secret_for_profile",
  };
  const result = JSON.parse(run(process.execPath, [
    setAccountTool,
    "--workflow", path.join(output, "workflow.json"),
    "--account", "alt",
  ], { env }));
  assert.equal(result.account.profile, "alt");
  assert.equal(result.gitConfig.userName, "Alt User");
  assert.equal(result.gitConfig.userEmail, "alt@example.com");

  const workflow = JSON.parse(fs.readFileSync(path.join(output, "workflow.json"), "utf8"));
  assert.equal(workflow.githubAccountProfile, "alt");
  assert.equal(workflow.githubAccount.login, "octo-alt");
});
