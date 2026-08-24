import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadProjectProfile } from "../../../../auto-pr-core/project-profile.mjs";
import { isDocumentationOnly } from "./path-policy.mjs";

const OPENCLAW_REQUIRED_SECTIONS = [
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
    name: "local output/worktree path",
    pattern: /(?:^|[\s`'"(<])((?:\.\.\/)+(?:outputs|worktrees|workspace)\/[^\s`'"<>)]+)/g,
  },
  {
    name: "local workspace path",
    pattern: /(?:^|[\s`'"(<])((?:workspace\/[^/]+\/)?(?:outputs|worktrees)\/[^\s`'"<>)]+)/g,
  },
];

function git(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", shell: false });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function headingMatch(body, level, name) {
  return new RegExp(`^${"#".repeat(level)} ${escapeRegExp(name)}(?:\\s+\\([^\\n]*\\))?\\s*$`, "im").exec(body);
}

function sectionStart(body, name) {
  return headingMatch(body, 2, name)?.index ?? -1;
}

function sectionBody(body, name) {
  const match = headingMatch(body, 2, name);
  if (!match) return "";
  const contentStart = body.indexOf("\n", match.index + match[0].length);
  if (contentStart < 0) return "";
  const nextHeading = /^##\s+/gm;
  nextHeading.lastIndex = contentStart + 1;
  const next = nextHeading.exec(body);
  return body.slice(contentStart + 1, next ? next.index : body.length).trim();
}

function subsectionBody(body, name) {
  const match = headingMatch(body, 3, name);
  if (!match) return "";
  const contentStart = body.indexOf("\n", match.index + match[0].length);
  if (contentStart < 0) return "";
  const nextHeading = /^#{2,3}\s+/gm;
  nextHeading.lastIndex = contentStart + 1;
  const next = nextHeading.exec(body);
  return body.slice(contentStart + 1, next ? next.index : body.length).trim();
}

function unique(values) {
  return [...new Set(values)];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractIssueLinks(body) {
  const links = [];
  const pattern = /\b(Fixes|Closes|Resolves|Related|Depends on|Supersedes|Implements)\s*:?\s*#(\d+)\b/gi;
  for (const match of body.matchAll(pattern)) {
    links.push({ verb: match[1], number: Number(match[2]) });
  }
  return links;
}

function answeredField(body, label) {
  return new RegExp(`${escapeRegExp(label)}\\s*\\*{0,2}\\s*(?:\\([^\\n]*\\)\\s*)?(?:[:\\-]\\s*)?(Yes|No|N/A)\\b`, "i").exec(body);
}

function templateInfo(repoPath, policy) {
  if (!repoPath || !policy.requiredTemplatePath) return { path: null, sha256: null, body: null };
  const templatePath = path.resolve(repoPath, policy.requiredTemplatePath);
  if (!fs.existsSync(templatePath)) return { path: templatePath, sha256: null, body: null };
  const templateBody = fs.readFileSync(templatePath, "utf8");
  return {
    path: templatePath,
    sha256: crypto.createHash("sha256").update(templateBody, "utf8").digest("hex"),
    body: templateBody,
  };
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
  project: suppliedProject,
}) {
  const project = typeof suppliedProject === "string"
    ? loadProjectProfile(suppliedProject)
    : suppliedProject ?? loadProjectProfile("openclaw");
  const policy = project.prPolicy ?? {};
  const requiredSections = policy.requiredSections ?? OPENCLAW_REQUIRED_SECTIONS;
  const evidenceSection = policy.evidenceSection ?? "Evidence";
  const template = templateInfo(repoPath, policy);
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

  if (policy.requiredTemplatePath && !template.body) {
    errors.push(`required PR template is missing: ${template.path}`);
  } else if (template.body) {
    for (const name of requiredSections) {
      if (sectionStart(template.body, name) < 0) errors.push(`configured PR section is not present in checked-out template: ## ${name}`);
    }
  }

  const positions = requiredSections.map((name) => sectionStart(body, name));
  for (let index = 0; index < requiredSections.length; index += 1) {
    const name = requiredSections[index];
    if (positions[index] < 0) errors.push(`missing section: ## ${name}`);
    else if (!sectionBody(body, name)) errors.push(`empty section: ## ${name}`);
    if (index > 0 && positions[index] >= 0 && positions[index - 1] >= positions[index]) {
      errors.push(`section out of order: ## ${name}`);
    }
  }

  const hasIssue = Number.isSafeInteger(issue) && issue > 0;
  const hasSelfIssue = Number.isSafeInteger(pr) && pr > 0 && issue === pr;
  const issueLinks = extractIssueLinks(body);
  if (issueLinks.some((link) => link.number === pr)) {
    errors.push(`visible issue link points to PR #${pr}; omit self-links when no real issue exists`);
  }
  if (requireIssueLink) {
    if (!hasIssue || hasSelfIssue) {
      errors.push("workflow requires a positive issue number");
    } else if (!issueLinks.some((link) => link.number === issue)) {
      errors.push(`missing visible issue link for #${issue}`);
    }
  } else if (issueLinks.length > 0 && hasIssue && !hasSelfIssue) {
    if (!issueLinks.some((link) => link.number === issue)) {
      errors.push(`visible issue links do not include expected issue #${issue}`);
    }
  }
  if (policy.aiDisclosure === "marker") {
    const marker = policy.aiMarker || "AI-assisted: built with Codex";
    const markerMatches = body.match(new RegExp(`^${escapeRegExp(marker)}\\s*$`, "gm")) ?? [];
    if (markerMatches.length !== 1) {
      errors.push(`PR body must contain exactly one ${marker} marker`);
    }
  } else if (policy.aiDisclosure === "forbidden-footer") {
    for (const pattern of policy.forbiddenAiPatterns ?? []) {
      if (new RegExp(pattern, "i").test(body)) {
        errors.push(`PR body contains a forbidden AI attribution/footer: ${pattern}`);
      }
    }
  }
  if (/<(?:TODO|issue-number|condition|same command|bad behavior|correct behavior)>/i.test(body)) {
    errors.push("PR body still contains template placeholders");
  }

  const testing = sectionBody(body, evidenceSection);
  const evidence = policy.testingSubsection
    ? subsectionBody(testing, policy.testingSubsection)
    : testing;
  if (policy.testingSubsection && !evidence) {
    errors.push(`missing testing subsection: ### ${policy.testingSubsection}`);
  }
  if (evidence && !/`[^`\n]+`|^\$\s+\S+/m.test(evidence)) {
    errors.push("Testing evidence must include a reproducible command or path");
  }
  if (evidence && !/```(?:text|console|shell|bash)?\s*\n[\s\S]+?```/m.test(evidence)) {
    errors.push("Testing evidence must include captured output in a fenced block");
  }

  if (policy.reviewTestingSubsection) {
    const reviewTesting = subsectionBody(testing, policy.reviewTestingSubsection);
    const reviewerAnswer = reviewTesting.match(/Reviewer testing requested\?[^\n]*(?:\([^\n]*\)\s*)?(Yes|N\/A)\b/i);
    if (!reviewTesting || !reviewerAnswer) {
      errors.push("Testing must state whether reviewer testing is requested");
    } else if (reviewerAnswer[1].toUpperCase() === "YES") {
      for (const field of ["Interface(s) exercised", "Setup / preconditions", "Steps to run", "Expected on this branch", "Prior behavior on master"]) {
        if (!new RegExp(escapeRegExp(field), "i").test(reviewTesting)) {
          errors.push(`reviewer testing is marked Yes but is missing: ${field}`);
        }
      }
    } else if (!/N\/A\s*(?:[—:-]|\b(?:because|due|no)\b)/i.test(reviewTesting)) {
      errors.push("N/A reviewer testing must include a one-line reason");
    }
  }

  const privacy = sectionBody(body, "Security & Privacy Impact");
  if (policy.privacyRequired) {
    const privacyFields = [
      "New permissions, capabilities, or file system access scope?",
      "New external network calls?",
      "Secrets / tokens / credentials handling changed?",
      "PII, real identities, or personal data in diff, tests, fixtures, or docs?",
      "Prompt injection or untrusted model-visible text introduced/changed?",
    ];
    for (const field of privacyFields) {
      const answer = answeredField(privacy, field);
      if (!answer) errors.push(`Security & Privacy Impact is missing a Yes/No answer: ${field}`);
      else if (answer[1].toUpperCase() === "YES" && !/(risk|mitigat|because|guard|prevent)/i.test(privacy)) {
        warnings.push("a Yes security/privacy answer should include a short risk-and-mitigation note");
      }
    }
  }

  const compatibility = sectionBody(body, "Compatibility");
  if (policy.compatibilityRequired === true) {
    for (const field of [
      "Backward compatible?",
      "Config / env / CLI surface changed?",
      "Rust/MSRV/toolchain floor changed?",
    ]) {
      if (!answeredField(compatibility, field)) errors.push(`Compatibility is missing an answer: ${field}`);
    }
    if (!/upgrade steps for existing users\s*[^\n]*\b(?:N\/A|none|no migration|[A-Za-z])/i.test(compatibility)) {
      errors.push("Compatibility must state exact upgrade steps or N/A");
    }
  }

  const riskLevel = body.match(/\brisk:(low|medium|high)\b/i)?.[1]?.toLowerCase() ?? null;
  const rollbackSection = policy.conditionalSections?.rollback;
  if (rollbackSection && ["medium", "high"].includes(riskLevel ?? "") && !sectionBody(body, rollbackSection)) {
    errors.push(`${riskLevel}-risk PRs must include: ## ${rollbackSection}`);
  }
  const supersedes = issueLinks.some((link) => link.verb.toLowerCase() === "supersedes");
  const supersedeSection = policy.conditionalSections?.supersedeAttribution;
  if (supersedes && supersedeSection && !sectionBody(body, supersedeSection)) {
    errors.push(`Supersedes links require: ## ${supersedeSection}`);
  }

  const changedFiles = suppliedChangedFiles ?? git(repoPath, ["diff", "--name-only", `${baseRef}...HEAD`])
    .split("\n")
    .filter(Boolean);
  const docsOnly = isDocumentationOnly(changedFiles);

  if (!docsOnly && policy.requireCommittedProof !== false) {
    const committedProof = changedFiles.some((file) =>
      /(^|\/)(?:proof|repro)(?:[-_.][^/]*)?\.(?:[cm]?[jt]s|py|sh|ps1)$/i.test(file)
    );
    const embeddedProof = /<details>[\s\S]*?<summary>[^<]*(?:proof|repro)[^<]*<\/summary>[\s\S]*?```(?:typescript|javascript|ts|js|python|bash|sh)\s*\n[\s\S]+?```[\s\S]*?<\/details>/i.test(evidence);
    if (!committedProof && !embeddedProof) {
      errors.push("non-docs changes require a committed proof/repro script or full script source in a Testing <details> block");
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
    templatePath: template.path,
    templateSha256: template.sha256,
    docsOnly,
    changedFiles,
    errors,
    warnings,
  };
}
