#!/usr/bin/env node

import path from "node:path";
import {
  currentHead,
  loadWorkflow,
  parseKeyArgs,
  readJson,
  sha256,
  writeJson,
} from "./lib/workflow-utils.mjs";

function usage() {
  return `Usage: openclaw-proof-receipt.mjs --workflow PATH --input PATH [--output PATH]

Validates structured comparable proof and writes proof-receipt.json. Raw proof
output is reduced to hashes; the source input remains the durable full artifact.`;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedDescriptor(item) {
  return {
    command: text(item?.command),
    entrypoint: text(item?.entrypoint),
    input: text(item?.input),
    boundary: text(item?.boundary),
  };
}

let args;
try {
  args = parseKeyArgs(process.argv.slice(2), {
    "--workflow": { name: "workflow" },
    "--input": { name: "input" },
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
if (!args.workflow || !args.input) {
  console.error("--workflow and --input are required");
  process.exit(2);
}

const context = loadWorkflow(args.workflow);
const inputPath = path.resolve(args.input);
const evidence = readJson(inputPath);
const baseSha = context.workflow.validationBaseSha || context.workflow.baseSha;
const headSha = currentHead(context.repoPath);
const base = evidence.base ?? {};
const head = evidence.head ?? {};
const negativeControl = evidence.negativeControl ?? {};
const baseDescriptor = normalizedDescriptor(base);
const headDescriptor = normalizedDescriptor(head);
const problems = [];

if (evidence.schemaVersion !== 1) problems.push("proof input schemaVersion must be 1");
if (base.sha !== baseSha) problems.push("base proof SHA does not match validationBaseSha");
if (head.sha !== headSha) problems.push("head proof SHA does not match current HEAD");
if (Object.values(baseDescriptor).some((value) => !value)) problems.push("base proof descriptor is incomplete");
if (JSON.stringify(baseDescriptor) !== JSON.stringify(headDescriptor)) {
  problems.push("base and head must use the same command, entrypoint, input, and boundary");
}
if (!text(base.output) || !text(head.output)) problems.push("base and head outputs are required");
if (text(base.output) === text(head.output)) problems.push("base and head outputs do not demonstrate a behavior change");
if (!Number.isInteger(base.exitCode) || !Number.isInteger(head.exitCode)) problems.push("base and head exit codes are required");
if (negativeControl.sha !== headSha
  || !text(negativeControl.command)
  || !text(negativeControl.input)
  || !text(negativeControl.output)
  || !Number.isInteger(negativeControl.exitCode)) {
  problems.push("exact-head negative control is incomplete");
}
if (!text(evidence.canonicalPrecedent?.kind) || !text(evidence.canonicalPrecedent?.reference)) {
  problems.push("canonical precedent kind and reference are required");
}
if (!["real-call-chain", "production-module-boundary"].includes(evidence.kind)) {
  problems.push("proof kind must be real-call-chain or production-module-boundary");
}

const receipt = {
  schemaVersion: 1,
  status: problems.length === 0 ? "passed" : "failed",
  generatedAt: new Date().toISOString(),
  workflowPath: context.workflowPath,
  repoPath: context.repoPath,
  validationBaseSha: baseSha,
  headSha,
  inputPath,
  inputSha256: sha256(JSON.stringify(evidence)),
  kind: evidence.kind ?? null,
  descriptor: baseDescriptor,
  comparableBaseHead: problems.every((problem) => !/base|head|same command|behavior change|exit codes/.test(problem)),
  exactHeadNegativeControl: problems.every((problem) => !/negative control/.test(problem)),
  canonicalPrecedent: evidence.canonicalPrecedent ?? null,
  results: {
    base: { sha: base.sha ?? null, exitCode: base.exitCode ?? null, outputSha256: text(base.output) ? sha256(text(base.output)) : null },
    head: { sha: head.sha ?? null, exitCode: head.exitCode ?? null, outputSha256: text(head.output) ? sha256(text(head.output)) : null },
    negativeControl: {
      sha: negativeControl.sha ?? null,
      exitCode: negativeControl.exitCode ?? null,
      outputSha256: text(negativeControl.output) ? sha256(text(negativeControl.output)) : null,
    },
  },
  problems,
};

const output = path.resolve(args.output || path.join(context.outputPath, "proof-receipt.json"));
writeJson(output, receipt);
console.log(JSON.stringify({ output, status: receipt.status, problems }, null, 2));
if (problems.length > 0) process.exitCode = 1;
