#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { parseKeyArgs, readJson, writeJson } from "./lib/workflow-utils.mjs";

function usage() {
  return `Usage: openclaw-candidate-scout.mjs --input PATH [--repo-path PATH] [--output PATH]

Scores a structured pre-implementation candidate plan. The input must describe
current-main reproduction, canonical precedent, comparable proof feasibility,
policy neutrality, expected files, duplicate risk, and main overlap.`;
}

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

let args;
try {
  args = parseKeyArgs(process.argv.slice(2), {
    "--input": { name: "input" },
    "--repo-path": { name: "repoPath" },
    "--output": { name: "output" },
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
if (!args.input) {
  console.error("--input is required");
  process.exit(2);
}

const inputPath = path.resolve(args.input);
const input = readJson(inputPath);
const repoPath = args.repoPath ? path.resolve(args.repoPath) : null;
const expectedFiles = Array.isArray(input.expectedFiles)
  ? [...new Set(input.expectedFiles.map((file) => String(file).trim()).filter(Boolean))]
  : [];
const productionFiles = expectedFiles.filter((file) =>
  /\.(?:ts|tsx|js|mjs|cjs|go|rs|py)$/.test(file) &&
  !/(?:^|\/)(?:tests?|__tests__|fixtures?)(?:\/|$)|\.(?:test|spec)\./.test(file));
const missingFiles = repoPath
  ? expectedFiles.filter((file) => !fs.existsSync(path.join(repoPath, file)))
  : [];

const signals = {
  currentMainRepro: input.currentMainRepro?.status === "passed"
    && present(input.currentMainRepro.command)
    && present(input.currentMainRepro.observation),
  canonicalPrecedent: present(input.canonicalPrecedent?.kind)
    && present(input.canonicalPrecedent?.reference),
  comparableProof: input.comparableProof?.status === "feasible"
    && present(input.comparableProof.entrypoint)
    && present(input.comparableProof.command)
    && present(input.comparableProof.input)
    && present(input.comparableProof.boundary)
    && present(input.comparableProof.negativeControl),
  policyNeutral: input.policy?.introducesNewPolicy === false
    && Array.isArray(input.policy?.unresolvedChoices)
    && input.policy.unresolvedChoices.length === 0,
  focusedSurface: productionFiles.length > 0
    && productionFiles.length <= 3
    && expectedFiles.length <= 5,
  stableIntegration: input.duplicateRisk?.status === "clear"
    && ["none", "stable-boundary"].includes(input.mainOverlap?.status)
    && input.dependencyChurn === false,
};

const earlyStops = [];
if (input.schemaVersion !== 1) earlyStops.push("candidate plan schemaVersion must be 1");
if (!signals.policyNeutral) earlyStops.push("unresolved product, default, threshold, fallback, or compatibility policy");
if (!signals.comparableProof) earlyStops.push("no credible comparable real-path base/head proof");
if (input.duplicateRisk?.status === "duplicate") earlyStops.push("canonical or crowded PR already owns the change");
if (input.mainOverlap?.status === "unstable") earlyStops.push("current main is rewriting the same surface without a stable boundary");
if (input.dependencyChurn === true) earlyStops.push("dependency, lockfile, schema, or migration churn");
if (input.broadRefactor === true) earlyStops.push("broad or cross-surface refactor");

const score = (signals.currentMainRepro ? 2 : 0)
  + (signals.canonicalPrecedent ? 2 : 0)
  + (signals.comparableProof ? 2 : 0)
  + (signals.policyNeutral ? 2 : 0)
  + (signals.focusedSurface ? 1 : 0)
  + (signals.stableIntegration ? 1 : 0);
const aLikelihood = earlyStops.length > 0
  ? "low"
  : score >= 9
    ? "high"
    : score >= 7
      ? "possible"
      : "ordinary";
const mergeFit = input.mergeFit === "strong" && earlyStops.length === 0
  ? "strong"
  : input.mergeFit === "reject" || earlyStops.some((item) => /duplicate|missing from repository/.test(item))
    ? "reject"
    : "review";

const receipt = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  inputPath,
  repoPath,
  candidate: input.candidate ?? null,
  expectedFiles,
  productionFiles,
  plannedNewFiles: missingFiles,
  score,
  aLikelihood,
  mergeFit,
  signals,
  missingSignals: Object.entries(signals).filter(([, value]) => !value).map(([name]) => name),
  earlyStops,
  evidence: {
    currentMainRepro: input.currentMainRepro ?? null,
    canonicalPrecedent: input.canonicalPrecedent ?? null,
    comparableProof: input.comparableProof ?? null,
    policy: input.policy ?? null,
    duplicateRisk: input.duplicateRisk ?? null,
    mainOverlap: input.mainOverlap ?? null,
  },
  advisoryOnly: true,
};

const output = path.resolve(args.output || path.join(path.dirname(inputPath), "candidate-scout.json"));
writeJson(output, receipt);
console.log(JSON.stringify({ output, score, aLikelihood, mergeFit, earlyStops }, null, 2));
