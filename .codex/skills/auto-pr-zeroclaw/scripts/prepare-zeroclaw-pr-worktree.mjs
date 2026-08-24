#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const skillDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(skillDir, "../../../..");
const result = spawnSync(process.execPath, [path.join(repoRoot, ".codex/auto-pr-core/prepare-project-pr-worktree.mjs"), "--project", "zeroclaw", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
