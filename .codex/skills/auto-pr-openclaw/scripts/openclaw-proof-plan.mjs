#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  classifyProofRecipe,
  gitChangedFiles,
  loadWorkflow,
  parseKeyArgs,
  prBodyInfo,
  writeJson,
} from "./lib/workflow-utils.mjs";

function usage() {
  return `Usage: openclaw-proof-plan.mjs --workflow PATH [--output-md PATH] [--output-json PATH]

Builds a proof plan for OpenClaw PR evidence. The plan prefers real production
call chains, then loopback/fixture dependencies at the boundary, then production
module boundary proof when live external proof is infeasible.`;
}

function candidateEntrypoints(files, recipe) {
  const production = files.filter((file) => /\.(ts|tsx|js|mjs|go|rs|py)$/.test(file) && !/(\.test\.|\.spec\.|^tests\/|\/tests\/|fixtures?\/)/.test(file));
  const scripts = production.filter((file) => /(^|\/)(bin|cli|scripts|commands?)\//i.test(file));
  const server = production.filter((file) => /(server|route|handler|transport|websocket|socket|http|api)/i.test(file));
  const provider = production.filter((file) => /(provider|client|oauth|fetch|model|runtime)/i.test(file));
  if (recipe.kind === "cli-subprocess" && scripts.length) return scripts;
  if (["runtime-provider", "resource-cap"].includes(recipe.kind) && (server.length || provider.length)) return [...server, ...provider].slice(0, 8);
  return production.slice(0, 8);
}

let args;
try {
  args = parseKeyArgs(process.argv.slice(2), {
    "--workflow": { name: "workflow" },
    "--output-md": { name: "outputMd" },
    "--output-json": { name: "outputJson" },
  });
} catch (error) {
  console.error(error.message);
  console.error(usage());
  process.exit(2);
}
if (args.help) {
  console.log(usage());
  process.exit(0);
}
if (!args.workflow) {
  console.error("--workflow is required");
  process.exit(2);
}

const context = loadWorkflow(args.workflow);
const baseSha = context.workflow.validationBaseSha || context.workflow.baseSha;
const files = gitChangedFiles(context.repoPath, baseSha);
const body = prBodyInfo(context.prBodyPath);
const recipe = classifyProofRecipe(files, body);
const entrypoints = candidateEntrypoints(files, recipe);
const plan = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  workflowPath: context.workflowPath,
  repoPath: context.repoPath,
  outputPath: context.outputPath,
  validationBaseSha: baseSha,
  proofRecipe: recipe,
  currentEvidence: {
    signal: body.proofSignal,
    hasTerminalFence: body.hasTerminalFence,
    hasDetailsProofSource: body.hasDetailsProofSource,
    hasRealCallChainEvidence: body.hasRealCallChainEvidence,
    hasBoundaryControls: body.hasBoundaryControls,
    hasBeforeAfterEvidence: body.hasBeforeAfterEvidence,
    hasExactHeadEvidence: body.hasExactHeadEvidence,
    hasCanonicalPrecedent: body.hasCanonicalPrecedent,
    hasSyntheticEvidence: body.hasSyntheticEvidence,
    hasOnlyTestEvidence: body.hasOnlyTestEvidence,
  },
  changedFiles: files,
  candidateEntrypoints: entrypoints,
  recommendedPlan: [
    "Pick the highest real boundary from candidateEntrypoints: CLI/server/provider/runtime caller before private helper.",
    "If external service credentials are unavailable, replace only the external boundary with localhost/loopback or fixture input.",
    "Run the production entrypoint or import the changed production boundary; do not copy helper logic into the proof.",
    "Run the same command, entrypoint, input, and dependency boundary on the pinned base and exact head whenever feasible.",
    "Capture explicit before-fix, after-fix, and unchanged negative-control results plus the tested head SHA.",
    "Name the merged sibling, canonical helper, established contract, or upstream limit that supports the patch shape.",
    "Paste the concise transcript into PR Evidence; put full proof source/output in live-proof.md or a details block.",
  ],
};

const outputJson = path.resolve(args.outputJson || path.join(context.outputPath, "proof-plan.json"));
const outputMd = path.resolve(args.outputMd || path.join(context.outputPath, "proof-plan.md"));
writeJson(outputJson, plan);

const md = `# OpenClaw Proof Plan

Generated: ${plan.generatedAt}

- workflow: \`${plan.workflowPath}\`
- proof kind: ${recipe.kind}
- preferred proof: ${recipe.preferredProof}
- current evidence signal: ${body.proofSignal}
- required: ${recipe.required}
- acceptable fallback: ${recipe.acceptableFallback}

## Candidate Entrypoints

${entrypoints.length ? entrypoints.map((file) => `- \`${file}\``).join("\n") : "- No obvious production entrypoint detected. Inspect changed callers before writing proof."}

## Checklist

${recipe.checklist.map((item) => `- ${item}`).join("\n")}

## Recommended Plan

${plan.recommendedPlan.map((item) => `- ${item}`).join("\n")}

## PR Evidence Shape

\`\`\`md
## Evidence

- Real call-chain proof: \`<command>\` exercised <production entrypoint> with <loopback/fixture/live dependency>; valid case <accepted>; negative control <rejected/unchanged>.
- Canonical precedent: <merged sibling PR, existing helper/contract, or governing upstream limit>.

\`\`\`text
$ <command>
entrypoint: <real caller or production module>
base: <validationBaseSha> => <before-fix result>
head: <exact head SHA> => <after-fix result>
negative-control: <rejected/status>
\`\`\`

AI-assisted: built with Codex
\`\`\`
`;

fs.writeFileSync(outputMd, md, "utf8");
console.log(JSON.stringify({ outputMd, outputJson, proofKind: recipe.kind, preferredProof: recipe.preferredProof }, null, 2));
