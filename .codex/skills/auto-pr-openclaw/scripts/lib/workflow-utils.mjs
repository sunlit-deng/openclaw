import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function parseKeyArgs(argv, spec = {}) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      result.help = true;
      continue;
    }
    const field = spec[arg];
    if (!field) throw new Error(`Unknown argument: ${arg}`);
    if (field.repeat) {
      result[field.name] ||= [];
      result[field.name].push(argv[++index] ?? "");
    } else if (field.boolean) {
      result[field.name] = true;
    } else {
      result[field.name] = argv[++index] ?? "";
    }
  }
  return result;
}

export function run(command, args, { cwd, input, allowFailure = false, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    shell: false,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.error?.message}`);
  }
  return {
    command: [command, ...args].join(" "),
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    error: result.error?.message ?? null,
  };
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

export function readJsonIfPresent(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeNewlines(value) {
  return value.replace(/\r\n?/g, "\n");
}

export function loadWorkflow(workflowPath) {
  const resolved = path.resolve(workflowPath);
  const workflow = readJson(resolved);
  return {
    workflowPath: resolved,
    workflow,
    repoPath: path.resolve(workflow.repoPath),
    outputPath: path.resolve(workflow.outputPath),
    preflightPath: path.resolve(workflow.preflightPath),
    prBodyPath: path.resolve(workflow.prBodyPath),
  };
}

export function currentHead(repoPath) {
  return run("git", ["rev-parse", "HEAD"], { cwd: repoPath }).stdout.trim();
}

export function currentBranch(repoPath) {
  return run("git", ["branch", "--show-current"], { cwd: repoPath }).stdout.trim();
}

export function gitChangedFiles(repoPath, baseSha) {
  if (!baseSha) return [];
  const result = run("git", ["diff", "--name-only", `${baseSha}...HEAD`], { cwd: repoPath, allowFailure: true });
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function gitDiffStats(repoPath, baseSha) {
  if (!baseSha) return { files: 0, insertions: 0, deletions: 0, raw: "" };
  const result = run("git", ["diff", "--shortstat", `${baseSha}...HEAD`], { cwd: repoPath, allowFailure: true });
  const raw = result.stdout.trim();
  return {
    files: Number(raw.match(/(\d+) files? changed/)?.[1] ?? 0),
    insertions: Number(raw.match(/(\d+) insertions?\(\+\)/)?.[1] ?? 0),
    deletions: Number(raw.match(/(\d+) deletions?\(-\)/)?.[1] ?? 0),
    raw,
  };
}

export function gitNameStatus(repoPath, baseSha) {
  if (!baseSha) return [];
  const result = run("git", ["diff", "--name-status", `${baseSha}...HEAD`], { cwd: repoPath, allowFailure: true });
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function gitCommitIdentities(repoPath, baseSha) {
  const range = baseSha ? `${baseSha}..HEAD` : "HEAD";
  const result = run("git", ["log", "--format=%H%x09%an%x09%ae%x09%cn%x09%ce", range], { cwd: repoPath, allowFailure: true });
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\n").filter(Boolean).map((line) => {
    const [sha, authorName, authorEmail, committerName, committerEmail] = line.split("\t");
    return { sha, authorName, authorEmail, committerName, committerEmail };
  });
}

export function prBodyInfo(prBodyPath) {
  const body = fs.existsSync(prBodyPath) ? normalizeNewlines(fs.readFileSync(prBodyPath, "utf8")) : "";
  const evidence = body.match(/## Evidence([\s\S]*?)(?:\n## |\nAI-assisted:|$)/i)?.[1] ?? "";
  const lowerEvidence = evidence.toLowerCase();
  const hasBeforeEvidence = /\bbefore(?:[- ]fix)?\b|\bbaseline\b|\bbase branch\b/i.test(evidence);
  const hasAfterEvidence = /\bafter(?:[- ]fix)?\b|\bfixed head\b/i.test(evidence);
  return {
    body,
    sha256: sha256(body),
    hasEvidenceSection: /## Evidence/i.test(body),
    hasAiMarker: /^AI-assisted: built with Codex\s*$/mi.test(body),
    hasTerminalFence: /```(?:text|sh|bash|console)?\s*\n\$?[\s\S]*?\n```/i.test(evidence),
    hasDetailsProofSource: /<details>[\s\S]*?```(?:ts|tsx|js|mjs|py|sh|bash)/i.test(evidence),
    hasOnlyTestEvidence: /(?:vitest|jest|node --test|pnpm test|test:changed|check:changed)/i.test(evidence)
      && !/(before|after|negative-control|status|HTTP|200|rejected|accepted|runtime|live|loopback|production)/i.test(evidence),
    hasSyntheticEvidence: /(?:node\s+-e|simulate|synthetic|mock-only|mocked|fake server only|isolated helper)/i.test(evidence),
    hasRealCallChainEvidence: /(?:real (?:production )?(?:path|call chain|module|entrypoint|entry point)|loopback|localhost|127\.0\.0\.1|cli|subprocess|sandbox|exec-server|production module|changed production module|npx tsx|pnpm --filter|http:\/\/localhost)/i.test(evidence),
    hasBoundaryControls: /(?:before|after|negative-control|valid:|invalid:|oversized|rejected|accepted|baseline|base branch)/i.test(evidence),
    hasBeforeAfterEvidence: hasBeforeEvidence && hasAfterEvidence,
    hasExactHeadEvidence: /(?:exact[- ]head|current[- ]head|head sha|tested head|commit [` ]?[0-9a-f]{7,40})/i.test(evidence),
    hasCanonicalPrecedent: /(?:existing|shared|canonical|established|already[- ]merged|merged PR|same[- ]shape|same pattern).{0,48}(?:helper|contract|pattern|facade|boundary|implementation|precedent)|reuse[sd]?\s+(?:the\s+)?(?:existing|shared|canonical)/i.test(body),
    hasUnresolvedPolicyChoice: /(?:maintainer[- ]owned|maintainer (?:decision|acceptance|confirmation)|compatibility (?:decision|tradeoff)|product direction|new (?:default|policy|unconditional threshold)|arbitrary (?:cap|limit|threshold))/i.test(body),
    proofSignal: lowerEvidence.includes("node -e") || lowerEvidence.includes("simulate")
      ? "synthetic"
      : /(?:loopback|localhost|127\.0\.0\.1|real call chain|real production path|cli|subprocess|sandbox|exec-server)/i.test(evidence)
        ? "real-call-chain"
        : /(?:production module|changed production module|npx tsx|real module)/i.test(evidence)
          ? "production-module-boundary"
          : /(?:vitest|jest|node --test|pnpm test)/i.test(evidence)
            ? "test-only"
            : evidence.trim() ? "weak" : "missing",
  };
}

export function classifyProofRecipe(files, bodyInfo) {
  const joined = files.join("\n");
  const runtime = /\.(ts|tsx|js|mjs|go|rs|py)$/.test(joined) && !/(^|\/)(test|tests|__tests__|fixtures?|docs?)\//.test(joined);
  const docsOnly = files.length > 0 && files.every((file) => /\.(md|mdx|txt|rst)$/.test(file));
  const resourceCap = /(maxPayload|payload|body.?size|limit|cap|bounded|buffer|stream|timeout|bytes|content-length)/i.test(joined + "\n" + bodyInfo.body);
  const provider = /(provider|oauth|api|http|fetch|websocket|socket|browser|sandbox|exec|subprocess|stream|transport|client|server)/i.test(joined + "\n" + bodyInfo.body);
  const cli = /(^|\/)(cli|bin|commands?|scripts?)\/|(?:command|completion|flag|argv|stdio|stdout|stderr)/i.test(joined + "\n" + bodyInfo.body);
  if (resourceCap) {
    return {
      kind: "resource-cap",
      required: "Show a legitimate large payload/path still succeeds and an oversized/invalid case is rejected before unbounded buffering.",
      needsLiveProof: true,
      preferredProof: "real-call-chain-loopback",
      acceptableFallback: "Start the actual local server/entrypoint or import the production boundary, then send valid and oversized payloads through the real handler. Avoid isolated helper calls.",
      checklist: [
        "Identify the production entrypoint that owns buffering or rejection.",
        "Exercise the valid large case through that entrypoint.",
        "Exercise the oversized or invalid case through that same entrypoint.",
        "Paste short terminal output showing accepted and rejected outcomes.",
      ],
    };
  }
  if (provider) {
    return {
      kind: "runtime-provider",
      required: "Show redacted terminal/log output from the real production or loopback runtime path.",
      needsLiveProof: true,
      preferredProof: "real-call-chain-loopback",
      acceptableFallback: "Use a local loopback HTTP/WebSocket server or fixture endpoint while invoking the production provider/client entrypoint. Do not call the parser/helper directly unless it is the public boundary.",
      checklist: [
        "Run the production command, client, provider, sandbox, or transport path.",
        "Replace external services with loopback only at the network boundary.",
        "Show request/response status or log lines from the real caller.",
        "Include a negative control for the changed behavior.",
      ],
    };
  }
  if (cli) {
    return {
      kind: "cli-subprocess",
      required: "Run the actual CLI or subprocess entrypoint with inputs that trigger the changed path.",
      needsLiveProof: true,
      preferredProof: "real-call-chain-cli",
      acceptableFallback: "Use project-native command invocation with local fixtures; avoid importing private helpers directly.",
      checklist: [
        "Invoke the real command or subprocess entrypoint.",
        "Use fixture input that reaches the changed production path.",
        "Capture stdout/stderr/status for success and negative-control cases.",
      ],
    };
  }
  if (runtime) {
    return {
      kind: "runtime-local",
      required: "Show a proof script or command importing the real changed production module, with before/after or a negative control when feasible.",
      needsLiveProof: true,
      preferredProof: "production-module-boundary",
      acceptableFallback: "Import the public production boundary or intentionally exposed test hook from the changed module. Do not copy the helper logic into the proof.",
      checklist: [
        "Import the actual changed production module or public boundary.",
        "Exercise the caller-owned behavior rather than an extracted helper.",
        "Show before/after or a negative-control line in terminal output.",
      ],
    };
  }
  if (docsOnly) {
    return {
      kind: "docs-only",
      required: "Show a lightweight docs validation or source-context check.",
      needsLiveProof: false,
      preferredProof: "source-context",
      acceptableFallback: "Show the source file or command whose documented behavior was checked.",
      checklist: [
        "Show the source context or generated docs check.",
        "Avoid claiming runtime behavior unless it was executed.",
      ],
    };
  }
  return {
    kind: "unknown",
    required: "Add focused proof that matches the changed surface.",
    needsLiveProof: true,
    preferredProof: "real-call-chain-or-production-boundary",
    acceptableFallback: "Use the highest real boundary available: CLI/server/provider entrypoint first, production module boundary second.",
    checklist: [
      "Identify the real entrypoint changed by the diff.",
      "Run that entrypoint with local fixtures or loopback dependencies.",
      "Include a negative control when feasible.",
    ],
  };
}

export function riskFlags(files, stats, workflow, preflight, duplicateCheck, bodyInfo) {
  const flags = [];
  const changed = files.join("\n");
  if (files.length === 0) flags.push({ level: "blocker", reason: "no changed files detected against validation base" });
  if (files.length > 8) flags.push({ level: "risk", reason: `broad file surface (${files.length} files)` });
  if (stats.insertions + stats.deletions > 500) flags.push({ level: "risk", reason: `large diff (${stats.insertions + stats.deletions} changed lines)` });
  if (/(^|\/)(package.json|pnpm-lock.yaml|package-lock.json|yarn.lock)$/.test(changed)) flags.push({ level: "risk", reason: "dependency manifest or lockfile changed" });
  if (/(^|\/)(\.github|CODEOWNERS|AGENTS\.md|CONTRIBUTING\.md)\b/.test(changed)) flags.push({ level: "risk", reason: "policy or CI-owned files touched" });
  if (!files.some((file) => /(\.test\.|\.spec\.|^tests\/|\/tests\/)/.test(file))) flags.push({ level: "advisory", reason: "no focused test file detected in diff" });
  if (preflight && preflight.status !== "passed") flags.push({ level: "blocker", reason: `preflight is ${preflight.status}` });
  if (!preflight) flags.push({ level: "advisory", reason: "preflight receipt is missing" });
  if (workflow.dependencies?.status !== "installed") flags.push({ level: "blocker", reason: "dependencies are not recorded as installed" });
  if (!workflow.pr && duplicateCheck?.summary?.likelyDuplicateCount > 0) flags.push({ level: "blocker", reason: "duplicate check found likely duplicate PRs" });
  if (!workflow.pr && duplicateCheck?.summary?.relatedOpenPrCount > 2) flags.push({ level: "risk", reason: "many related open PRs; lane may be crowded" });
  if (bodyInfo && !bodyInfo.hasEvidenceSection) flags.push({ level: "blocker", reason: "PR body has no Evidence section" });
  if (bodyInfo?.hasOnlyTestEvidence) flags.push({ level: "risk", reason: "Evidence appears to be test output only" });
  if (bodyInfo?.hasSyntheticEvidence) flags.push({ level: "risk", reason: "Evidence appears synthetic or helper-only; prefer real call-chain proof" });
  if (bodyInfo?.hasEvidenceSection && !bodyInfo.hasRealCallChainEvidence && !bodyInfo.hasDetailsProofSource) {
    flags.push({ level: "advisory", reason: "Evidence does not clearly name a real call chain, loopback path, or production module boundary" });
  }
  if (bodyInfo?.hasEvidenceSection && !bodyInfo.hasBoundaryControls) {
    flags.push({ level: "advisory", reason: "Evidence lacks before/after or negative-control signal" });
  }
  if (bodyInfo && !bodyInfo.hasAiMarker) flags.push({ level: "blocker", reason: "missing AI-assisted marker" });
  return flags;
}

export function scoreFromFlags(flags) {
  let score = 100;
  for (const flag of flags) {
    if (flag.level === "blocker") score -= 30;
    else if (flag.level === "risk") score -= 12;
    else score -= 5;
  }
  return Math.max(0, Math.min(100, score));
}
