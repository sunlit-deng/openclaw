const DOCUMENTATION_BASENAMES = /^(?:readme|changelog|license|notice|authors)(?:\..*)?$/i;
const LINTABLE_RE = /\.[cm]?[jt]sx?$/u;
const TEST_FILE_RE = /(?:^|\/)(?:test\/|tests\/)|\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const HIGH_RISK_RE = /^(?:\.github\/|config\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig(?:\.[^/]+)?\.json$|src\/plugin-sdk\/|packages\/plugin-sdk\/)|(?:^|\/)(?:package\.json|tsconfig(?:\.[^/]+)?\.json)$/u;

function normalize(file) {
  return file.replaceAll("\\", "/").replace(/^\.\/+/u, "");
}

function isDocumentation(file) {
  const normalized = normalize(file);
  const basename = normalized.split("/").at(-1) ?? "";
  return normalized.endsWith(".md") || DOCUMENTATION_BASENAMES.test(basename);
}

function surfaceFor(file) {
  const normalized = normalize(file);
  if (/^(?:src\/|packages\/)/u.test(normalized)) return "core";
  if (/^ui\/src\//u.test(normalized)) return "ui";
  if (/^extensions\/[^/]+\//u.test(normalized)) return "extensions";
  if (/^scripts\//u.test(normalized)) return "scripts";
  if (/^(?:test|tests)\//u.test(normalized)) return "tests";
  return "";
}

export function targetedValidationDecision(files) {
  const normalized = files.map(normalize);
  const codeFiles = normalized.filter((file) => !isDocumentation(file));
  const reasons = [];
  if (codeFiles.length === 0) reasons.push("no non-documentation files");
  if (codeFiles.length > 12) reasons.push(`too many changed files (${codeFiles.length} > 12)`);
  const highRisk = codeFiles.filter((file) => HIGH_RISK_RE.test(file));
  if (highRisk.length > 0) reasons.push(`high-risk paths: ${highRisk.join(", ")}`);
  const unknown = codeFiles.filter((file) => !surfaceFor(file));
  if (unknown.length > 0) reasons.push(`unknown paths: ${unknown.join(", ")}`);
  const surfaces = [...new Set(codeFiles.map(surfaceFor).filter(Boolean))];
  if (surfaces.length > 1) reasons.push(`cross-surface change: ${surfaces.join(", ")}`);
  return {
    safe: reasons.length === 0,
    reasons,
    files: normalized,
    codeFiles,
    surfaces,
  };
}

function command(name, bin, args) {
  return { name, bin, args };
}

export function targetedValidationPlan(files) {
  const decision = targetedValidationDecision(files);
  if (!decision.safe) return { ...decision, commands: [] };

  const commands = [];
  const lintable = decision.codeFiles.filter((file) => LINTABLE_RE.test(file));
  if (decision.files.length > 0) {
    commands.push(command(
      "format changed files",
      "pnpm",
      ["format:check", "--no-error-on-unmatched-pattern", "--", ...decision.files],
    ));
  }

  const surface = decision.surfaces[0];
  if (lintable.length > 0) {
    const lintArgs = surface === "extensions"
      ? ["scripts/run-oxlint.mjs", "--tsconfig", "config/tsconfig/oxlint.extensions.json", ...lintable]
      : surface === "scripts"
        ? ["scripts/run-oxlint.mjs", "--tsconfig", "config/tsconfig/oxlint.scripts.json", ...lintable]
        : surface === "tests"
          ? ["scripts/run-oxlint.mjs", ...lintable]
          : ["scripts/run-oxlint.mjs", "--tsconfig", "config/tsconfig/oxlint.core.json", ...lintable];
    commands.push(command("lint changed files", "node", lintArgs));
  }

  const hasTests = decision.codeFiles.some((file) => TEST_FILE_RE.test(file));
  const hasProduction = decision.codeFiles.some((file) => LINTABLE_RE.test(file) && !TEST_FILE_RE.test(file));
  if (surface === "core") {
    if (hasProduction) commands.push(command("typecheck core", "pnpm", ["tsgo:core"]));
    if (hasTests || hasProduction) commands.push(command("typecheck core tests", "pnpm", ["tsgo:core:test"]));
  } else if (surface === "ui") {
    commands.push(command("typecheck UI", "pnpm", ["tsgo:ui"]));
    if (hasTests) commands.push(command("typecheck UI tests", "pnpm", ["tsgo:test:ui"]));
  } else if (surface === "extensions") {
    if (hasProduction) commands.push(command("typecheck extensions", "pnpm", ["tsgo:extensions"]));
    if (hasTests || hasProduction) commands.push(command("typecheck extension tests", "pnpm", ["tsgo:extensions:test"]));
  } else if (surface === "scripts" && lintable.length > 0) {
    commands.push(command("typecheck scripts", "pnpm", ["tsgo:scripts"]));
  } else if (surface === "tests" && lintable.length > 0) {
    commands.push(command("typecheck root tests", "pnpm", ["tsgo:test:root"]));
  }

  return { ...decision, commands };
}
