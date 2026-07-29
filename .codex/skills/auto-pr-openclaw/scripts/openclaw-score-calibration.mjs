#!/usr/bin/env node

import path from "node:path";
import { parseKeyArgs, readJson, writeJson } from "./lib/workflow-utils.mjs";

function usage() {
  return `Usage: openclaw-score-calibration.mjs --input PATH [--output PATH]

Analyzes reviewed PR samples to measure whether local A-readiness predictions
match actual ClawSweeper outcomes. No GitHub reads or writes are performed.`;
}

function isActualA(value) {
  return ["a", "diamond", "diamond-shrimp", "钻石", "钻石虾"].includes(String(value ?? "").trim().toLowerCase());
}

function isPredictedHigh(value) {
  return String(value ?? "").trim().toLowerCase() === "high";
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

let args;
try {
  args = parseKeyArgs(process.argv.slice(2), {
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
if (!args.input) {
  console.error("--input is required");
  process.exit(2);
}

const inputPath = path.resolve(args.input);
const input = readJson(inputPath);
if (input.schemaVersion !== 1 || !Array.isArray(input.samples)) {
  throw new Error("Calibration input must have schemaVersion 1 and a samples array");
}
const samples = input.samples.filter((sample) =>
  sample && sample.actualRating != null && sample.predictedAReadiness != null);
const confusion = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 };
for (const sample of samples) {
  const actual = isActualA(sample.actualRating);
  const predicted = isPredictedHigh(sample.predictedAReadiness);
  if (actual && predicted) confusion.truePositive += 1;
  else if (!actual && predicted) confusion.falsePositive += 1;
  else if (!actual && !predicted) confusion.trueNegative += 1;
  else confusion.falseNegative += 1;
}

const signalNames = [...new Set(samples.flatMap((sample) => Object.keys(sample.signals ?? {})))];
const signalCalibration = Object.fromEntries(signalNames.map((signal) => {
  const present = samples.filter((sample) => sample.signals?.[signal] === true);
  const absent = samples.filter((sample) => sample.signals?.[signal] !== true);
  const presentARate = ratio(present.filter((sample) => isActualA(sample.actualRating)).length, present.length);
  const absentARate = ratio(absent.filter((sample) => isActualA(sample.actualRating)).length, absent.length);
  return [signal, {
    presentCount: present.length,
    presentARate,
    absentCount: absent.length,
    absentARate,
    lift: presentARate == null || absentARate == null ? null : Number((presentARate - absentARate).toFixed(4)),
  }];
}));

const precision = ratio(confusion.truePositive, confusion.truePositive + confusion.falsePositive);
const recall = ratio(confusion.truePositive, confusion.truePositive + confusion.falseNegative);
const receipt = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  inputPath,
  sampleCount: samples.length,
  confusion,
  metrics: {
    highPrecision: precision,
    highRecall: recall,
    falsePositiveRate: ratio(confusion.falsePositive, confusion.falsePositive + confusion.trueNegative),
  },
  signalCalibration,
  falsePositivePrs: samples
    .filter((sample) => isPredictedHigh(sample.predictedAReadiness) && !isActualA(sample.actualRating))
    .map((sample) => sample.pr ?? sample.url ?? null)
    .filter(Boolean),
  recommendations: [
    ...(samples.length < 10 ? ["Collect at least 10 reviewed PR samples before changing weights."] : []),
    ...(precision != null && precision < 0.7 ? ["Local high has low precision; strengthen early stops or require higher-lift signals."] : []),
    ...(recall != null && recall < 0.5 ? ["Local high has low recall; inspect actual A samples for missing positive signals."] : []),
  ],
};

const output = path.resolve(args.output || path.join(path.dirname(inputPath), "clawsweeper-calibration.json"));
writeJson(output, receipt);
console.log(JSON.stringify({
  output,
  sampleCount: receipt.sampleCount,
  metrics: receipt.metrics,
  falsePositivePrs: receipt.falsePositivePrs,
}, null, 2));
