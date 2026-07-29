#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const skillRoot = path.join(repoRoot, ".codex/skills/auto-pr-openclaw");
const skillPath = path.join(skillRoot, "SKILL.md");
const contents = fs.readFileSync(skillPath, "utf8");
const problems = [];
const repositoryOwnedScripts = new Set(["scripts/report-test-temp-creations.mjs"]);
const frontmatter = contents.match(/^---\n([\s\S]*?)\n---\n/);

if (!frontmatter) {
  problems.push("SKILL.md is missing YAML frontmatter");
} else {
  const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (name !== "auto-pr-openclaw") problems.push(`unexpected skill name: ${name ?? "missing"}`);
  if (!description) problems.push("skill description is missing");
}

const references = [...contents.matchAll(/`(references\/[^`\s]+)`/g)].map((match) => match[1]);
const scripts = [...contents.matchAll(/(?:\.\/)?(?:\.codex\/skills\/auto-pr-openclaw\/)?(scripts\/[A-Za-z0-9._/-]+)/g)]
  .map((match) => match[1])
  .filter((file) => /\.(?:mjs|sh)$/.test(file));
for (const relative of [...new Set([...references, ...scripts])]) {
  if (!repositoryOwnedScripts.has(relative) && !fs.existsSync(path.join(skillRoot, relative))) {
    problems.push(`missing referenced skill file: ${relative}`);
  }
}

for (const entry of fs.readdirSync(path.join(skillRoot, "scripts"))) {
  if (!entry.endsWith(".sh")) continue;
  const file = path.join(skillRoot, "scripts", entry);
  if ((fs.statSync(file).mode & 0o111) === 0) problems.push(`shell wrapper is not executable: scripts/${entry}`);
}

if (contents.split("\n").length > 500) problems.push("SKILL.md exceeds the 500-line progressive-disclosure limit");

if (problems.length > 0) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"));
  process.exit(1);
}
console.log(`skill structure validated (${new Set(references).size} references, ${new Set(scripts).size} script links)`);
