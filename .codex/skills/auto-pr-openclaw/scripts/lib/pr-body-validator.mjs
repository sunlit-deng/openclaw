import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REQUIRED_SECTIONS = [
  "What Problem This Solves",
  "Why This Change Was Made",
  "User Impact",
  "Evidence",
];

const FORBIDDEN_LOCAL_PATH_PATTERNS = [
  {
    name: "macOS/Linux home path",
    pattern: /(?:^|[\s`'"(<])((?:\/Users|\/home)\/[^\s`'"<>)]+)/g,
  },
  {
    name: "mounted volume path",
    pattern: /(?:^|[\s`'"(<])(\/Volumes\/[^\s`'"<>)]+)/g,
  },
  {
    name: "Windows user path",
    pattern: /(?:^|[\s`'"(<])([A-Za-z]:\\Users\\[^\s`'"<>)]+)/g,
  },
  {
    name: "local OpenClaw output/worktree path",
    pattern: /(?:^|[\s`'"(<])((?:\.\.\/)+(?:outputs|worktrees|workspace)\/[^\s`'"<>)]+)/g,
  },
  {
    name: "local OpenClaw workspace path",
    pattern: /(?:^|[\s`'"(<])((?:workspace\/openclaw\/)?(?:outputs|worktrees)\/[^\s`'"<>)]+)/g,
  },
];

function git(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", shell: false });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function sectionBody(body, name) {
  const heading = `## ${name}`;
  const start = body.indexOf(heading);
  if (start < 0) return "";
  const contentStart = body.indexOf("\n", start + heading.length);
  if (contentStart < 0) return "";
  const nextHeading = body.indexOf("\n## ", contentStart + 1);
  return body.slice(contentStart + 1, nextHeading < 0 ? body.length : nextHeading).trim();
}

function unique(values) {
  return [...new Set(values)];
}

function findForbiddenLocalPathLeaks(body, { bodyPath, repoPath }) {
  const leaks = [];
  const candidates = [
    bodyPath && path.resolve(bodyPath),
    repoPath && path.resolve(repoPath),
    repoPath && path.dirname(path.resolve(repoPath)),
    repoPath && path.dirname(path.dirname(path.resolve(repoPath))),
    process.env.HOME,
  ].filter(Boolean);

  for (const candidate of unique(candidates)) {
    if (candidate.length > 1 && body.includes(candidate)) {
      leaks.push(candidate);
    }
  }

  for (const { pattern } of FORBIDDEN_LOCAL_PATH_PATTERNS) {
    for (const match of body.matchAll(pattern)) {
      if (match[1]) leaks.push(match[1]);
    }
  }

  return unique(leaks).slice(0, 8);
}

export function validatePrBody({
  bodyPath,
  issue,
  pr,
  requireIssueLink = true,
  repoPath,
  baseRef = "refs/remotes/origin/main",
  changedFiles: suppliedChangedFiles,
}) {
  const errors = [];
  const warnings = [];
  const resolvedBodyPath = path.resolve(bodyPath);
  let body = fs.readFileSync(resolvedBodyPath, "utf8");
  if (body.includes("\r")) {
    errors.push("PR body must use LF line endings");
    body = body.replace(/\r\n?/g, "\n");
  }

  const localPathLeaks = findForbiddenLocalPathLeaks(body, {
    bodyPath: resolvedBodyPath,
    repoPath,
  });
  if (localPathLeaks.length > 0) {
    errors.push(`PR body must not expose local absolute paths or output/worktree paths: ${localPathLeaks.join(", ")}`);
  }

  const positions = REQUIRED_SECTIONS.map((name) => body.indexOf(`## ${name}`));
  for (let index = 0; index < REQUIRED_SECTIONS.length; index += 1) {
    const name = REQUIRED_SECTIONS[index];
    if (positions[index] < 0) errors.push(`missing section: ## ${name}`);
    else if (!sectionBody(body, name)) errors.push(`empty section: ## ${name}`);
    if (index > 0 && positions[index] >= 0 && positions[index - 1] >= positions[index]) {
      errors.push(`section out of order: ## ${name}`);
    }
  }

  const hasIssue = Number.isSafeInteger(issue) && issue > 0;
  const hasSelfIssue = Number.isSafeInteger(pr) && pr > 0 && issue === pr;
  const issueLinkPattern = /^(?:(?:Fixes|Closes):?\s+#(\d+)|Related:\s+#(\d+))[ \t]*$/m;
  const linkedIssue = body.match(issueLinkPattern);
  if (linkedIssue && Number(linkedIssue[1] ?? linkedIssue[2]) === pr) {
    errors.push(`visible issue link points to PR #${pr}; omit self-links when no real issue exists`);
  }
  if (requireIssueLink) {
    if (!hasIssue || hasSelfIssue) {
      errors.push("workflow requires a positive issue number");
    } else if (!new RegExp(`^(?:(?:Fixes|Closes):?\\s+#${issue}|Related:\\s+#${issue})[ \\t]*$`, "m").test(body)) {
      errors.push(`missing visible issue link for #${issue}`);
    }
  } else if (linkedIssue && hasIssue && !hasSelfIssue) {
    const linked = Number(linkedIssue[1] ?? linkedIssue[2]);
    if (linked !== issue) {
      errors.push(`visible issue link points to #${linked}, expected #${issue}`);
    }
  }
  const markerMatches = body.match(/^AI-assisted: built with Codex\s*$/gm) ?? [];
  if (markerMatches.length !== 1) {
    errors.push("PR body must contain exactly one AI-assisted: built with Codex marker");
  }
  if (/<(?:TODO|issue-number|condition|same command|bad behavior|correct behavior)>/i.test(body)) {
    errors.push("PR body still contains template placeholders");
  }

  const evidence = sectionBody(body, "Evidence");
  if (evidence && !/`[^`\n]+`|^\$\s+\S+/m.test(evidence)) {
    errors.push("Evidence must include a reproducible command or path");
  }
  if (evidence && !/```(?:text|console|shell|bash)?\s*\n[\s\S]+?```/m.test(evidence)) {
    errors.push("Evidence must include captured output in a fenced block");
  }

  const changedFiles = suppliedChangedFiles ?? git(repoPath, ["diff", "--name-only", `${baseRef}...HEAD`])
    .split("\n")
    .filter(Boolean);
  const docsOnly = changedFiles.length > 0 && changedFiles.every((file) =>
    file === "README.md" || file.startsWith("docs/") || /\.(?:md|mdx|txt)$/.test(file)
  );

  if (!docsOnly) {
    const committedProof = changedFiles.some((file) =>
      /(^|\/)(?:proof|repro)(?:[-_.][^/]*)?\.(?:[cm]?[jt]s|py|sh|ps1)$/i.test(file)
    );
    const embeddedProof = /<details>[\s\S]*?<summary>[^<]*(?:proof|repro)[^<]*<\/summary>[\s\S]*?```(?:typescript|javascript|ts|js|python|bash|sh)\s*\n[\s\S]+?```[\s\S]*?<\/details>/i.test(evidence);
    if (!committedProof && !embeddedProof) {
      errors.push("non-docs changes require a committed proof/repro script or full script source in an Evidence <details> block");
    }
    if (/vitest|jest|test(?:s|ing)?\s+(?:passed|output)/i.test(evidence) && !/(before|after|negative-control|status|result):/i.test(evidence)) {
      warnings.push("Evidence appears test-only; include real-path before/after or negative-control output");
    }
  }

  const sha256 = crypto.createHash("sha256").update(body, "utf8").digest("hex");
  return {
    status: errors.length === 0 ? "passed" : "failed",
    bodyPath: resolvedBodyPath,
    sha256,
    docsOnly,
    changedFiles,
    errors,
    warnings,
  };
}
