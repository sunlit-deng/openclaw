#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || value === undefined) {
    throw new Error(`Invalid argument near ${key ?? "<end>"}`);
  }
  values.set(key.slice(2), value);
}

const required = [
  "mode",
  "root",
  "repo-path",
  "output-path",
  "branch",
  "base-ref",
  "base-sha",
  "head-sha",
  "pnpm-store-path",
  "pr-body-path",
  "preflight-path",
  "dependency-status",
];

for (const key of required) {
  if (!values.get(key)) {
    throw new Error(`Missing required argument --${key}`);
  }
}

const outputPath = path.resolve(values.get("output-path"));
const statePath = path.join(outputPath, "workflow.json");
const mode = values.get("mode");
const issueRaw = values.get("issue");
const issue = issueRaw ? Number(issueRaw) : null;
const createdAt = new Date().toISOString();
const validationBaseSha = values.get("base-sha");
const state = {
  schemaVersion: 2,
  mode,
  issue,
  pr: values.has("pr") ? Number(values.get("pr")) : null,
  root: path.resolve(values.get("root")),
  repoPath: path.resolve(values.get("repo-path")),
  outputPath,
  branch: values.get("branch"),
  headOwner: values.get("head-owner") || null,
  headRef: values.get("head-ref") || values.get("branch"),
  baseRef: values.get("base-ref"),
  baseSha: validationBaseSha,
  validationBaseRef: values.get("base-ref"),
  validationBaseSha,
  latestObservedMainSha: validationBaseSha,
  latestObservedAt: createdAt,
  initialHeadSha: values.get("head-sha"),
  headSha: values.get("head-sha"),
  pnpmStorePath: path.resolve(values.get("pnpm-store-path")),
  prBodyPath: path.resolve(values.get("pr-body-path")),
  preflightPath: path.resolve(values.get("preflight-path")),
  dependencies: {
    status: values.get("dependency-status"),
    skipReason: values.get("skip-reason") || null,
  },
  maintainerCanModify: values.has("maintainer-can-modify")
    ? values.get("maintainer-can-modify") === "true"
    : null,
  githubAccountProfile: values.get("account-profile") || null,
  githubAccount: values.has("account-profile")
    ? {
        profile: values.get("account-profile"),
        username: values.get("account-username") || null,
        email: values.get("account-email") || null,
        login: values.get("account-login") || values.get("account-username") || null,
        pushRemote: values.get("account-push-remote") || values.get("account-profile"),
      }
    : null,
  createdAt,
};

if (mode !== "local-candidate" && mode !== "existing-pr" && (!Number.isSafeInteger(issue) || issue <= 0)) {
  throw new Error("--issue must be a positive integer except for --mode local-candidate or --mode existing-pr");
}
if ((mode === "local-candidate" || mode === "existing-pr") && issue !== null && (!Number.isSafeInteger(issue) || issue <= 0)) {
  throw new Error(`--issue must be omitted or a positive integer for --mode ${mode}`);
}

fs.mkdirSync(outputPath, { recursive: true });
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(state)}\n`);
