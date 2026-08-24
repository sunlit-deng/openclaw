import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const coreRoot = path.dirname(fileURLToPath(import.meta.url));
const profilesRoot = path.join(coreRoot, "projects");

function readProfile(file) {
  const profile = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!profile.id || !profile.github?.repo || !profile.github?.defaultBranch) {
    throw new Error(`Invalid project profile: ${file}`);
  }
  return {
    ...profile,
    profilePath: path.resolve(file),
    workspace: {
      name: profile.id,
      repoDir: profile.id,
      ...(profile.workspace ?? {}),
    },
    branch: {
      prefix: "sunlit/fix",
      ...(profile.branch ?? {}),
    },
    validation: profile.validation ?? {},
    prPolicy: profile.prPolicy ?? {},
  };
}

export function loadProjectProfile(project = "openclaw") {
  const candidate = String(project || "openclaw");
  const file = path.isAbsolute(candidate) || candidate.includes(path.sep)
    ? path.resolve(candidate)
    : path.join(profilesRoot, `${candidate}.json`);
  if (!fs.existsSync(file)) throw new Error(`Unknown project profile: ${candidate}`);
  return readProfile(file);
}

export function projectForWorkflow(workflow = {}) {
  return loadProjectProfile(workflow.projectConfigPath || workflow.projectId || "openclaw");
}

export function projectRepoSlug(project) {
  return project.github.repo;
}

export function projectDefaultBranch(project) {
  return project.github.defaultBranch;
}

export function projectBaseRef(project) {
  return `origin/${projectDefaultBranch(project)}`;
}

export function projectValidationCommands(project, lane, changedFiles = []) {
  const baseCommands = project.validation?.[lane] ?? project.validation?.changed ?? [];
  const rules = project.validation?.surfaceRules ?? [];
  const matchedLanes = new Set();
  for (const rule of lane === "full" ? [] : rules) {
    const paths = rule.paths ?? [];
    if (changedFiles.some((file) => paths.some((prefix) => {
      const normalized = String(file).replaceAll("\\", "/");
      return normalized.startsWith(prefix)
        && (!rule.extensions || rule.extensions.some((extension) => normalized.endsWith(extension)));
    }))) {
      matchedLanes.add(rule.lane);
    }
  }
  const commands = [
    ...baseCommands,
    ...[...matchedLanes].flatMap((matchedLane) => project.validation?.[matchedLane] ?? []),
  ];
  const seen = new Set();
  return commands.map((command) => ({
    ...command,
    args: (command.args ?? []).map((arg) => String(arg)
      .replaceAll("{{base}}", "${BASE_SHA}")
      .replaceAll("{{head}}", "HEAD")
      .replaceAll("{{files}}", changedFiles.join(" "))),
  })).filter((command) => {
    const key = `${command.bin}\0${JSON.stringify(command.args)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function projectSurfaceRules(project, changedFiles = []) {
  const normalized = changedFiles.map((file) => String(file).replaceAll("\\", "/"));
  return (project.validation?.surfaceRules ?? []).filter((rule) =>
    normalized.some((file) => (rule.paths ?? []).some((prefix) => file.startsWith(prefix)
      && (!rule.extensions || rule.extensions.some((extension) => file.endsWith(extension))))
    )
  );
}

export function projectUsesPnpm(project) {
  return project.dependencies?.kind === "pnpm";
}

export function projectUsesCargo(project) {
  return project.dependencies?.kind === "cargo";
}
