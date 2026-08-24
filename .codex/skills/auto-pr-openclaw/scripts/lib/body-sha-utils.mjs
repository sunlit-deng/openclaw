// Shared helpers for detecting and refreshing exact-head SHA references in a
// canonical PR body. The rebase-only fast path refuses to push when the body
// pins the pre-rebase head SHA, because ClawSweeper treats evidence tied to a
// head SHA that no longer matches the PR head as stale.

const FULL_HEAD_LABEL =
  /(?:^|[^\w])(?:head|exact[- ]?head|current[- ]?head|tested[- ]?head|head[- ]?sha)\b[^0-9a-f]*?([0-9a-f]{40})/gi;
const HEAD_CONTEXT =
  /(?:head|exact[- ]?head|current[- ]?head|tested[- ]?head|head[- ]?sha|commit)/i;
const FULL_SHA = /^[0-9a-f]{40}$/i;

export function shaShortPrefixes(sha, min = 7, max = 12) {
  if (!FULL_SHA.test(sha || "")) return [];
  const prefixes = [];
  const upper = Math.min(max, sha.length);
  for (let length = min; length <= upper; length += 1) {
    prefixes.push(sha.slice(0, length));
  }
  return prefixes;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Find references in a PR body that tie evidence to a head SHA which is not the
 * current head. Three reference kinds are detected:
 *
 * - full: the full pre-rebase head SHA anywhere in the body;
 * - short: a 7-12 hex short form of the pre-rebase head SHA next to a
 *   head-ish label ("head", "exact head", "current head", "tested head",
 *   "head sha", "commit");
 * - labeled-other: a 40-hex SHA introduced by a head-ish label that is neither
 *   the pre-rebase head nor the current head (recorded-head drift).
 *
 * @param {string} body
 * @param {{ oldHead: string, newHead: string }} options
 * @returns {Array<{kind: string, token: string, start: number, end: number}>}
 */
export function findStaleHeadShaRefs(body, { oldHead, newHead }) {
  const refs = [];
  const normalizedOld = String(oldHead || "").toLowerCase();
  const normalizedNew = String(newHead || "").toLowerCase();
  if (!body || !FULL_SHA.test(normalizedOld)) return refs;
  if (normalizedOld === normalizedNew) return refs;

  const fullPattern = new RegExp(`(?<![0-9a-fA-F])${escapeRegExp(normalizedOld)}(?![0-9a-fA-F])`, "g");
  for (const match of body.matchAll(fullPattern)) {
    refs.push({ kind: "full", token: match[0], start: match.index, end: match.index + match[0].length });
  }

  const prefixes = shaShortPrefixes(normalizedOld);
  if (prefixes.length > 0) {
    const shortPattern = new RegExp(
      `(?<![0-9a-fA-F])(${prefixes.map(escapeRegExp).join("|")})(?![0-9a-fA-F])`,
      "gi",
    );
    for (const match of body.matchAll(shortPattern)) {
      const context = body.slice(Math.max(0, match.index - 40), match.index);
      if (HEAD_CONTEXT.test(context)) {
        refs.push({ kind: "short", token: match[0], start: match.index, end: match.index + match[0].length });
      }
    }
  }

  for (const match of body.matchAll(FULL_HEAD_LABEL)) {
    const token = match[1].toLowerCase();
    if (token !== normalizedOld && token !== normalizedNew) {
      refs.push({ kind: "labeled-other", token: match[1], start: match.index, end: match.index + 40 });
    }
  }

  const seen = new Set();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.start - b.start);
}

/**
 * Deterministically replace stale head SHA references with the current head.
 * Full and labeled short forms of the pre-rebase head are rewritten; a
 * head-labeled 40-hex SHA that matches neither the pre-rebase head nor the
 * current head is left untouched and reported so the operator can review it
 * manually instead of silently rewriting an unrelated SHA.
 *
 * @param {string} body
 * @param {{ oldHead: string, newHead: string }} options
 * @returns {{ body: string, replacements: Array<{kind: string, oldToken: string, newToken: string}>,
 *            unresolved: Array<{token: string}> }}
 */
export function replaceStaleHeadShaRefs(body, { oldHead, newHead }) {
  const refs = findStaleHeadShaRefs(body, { oldHead, newHead });
  const normalizedNew = String(newHead || "").toLowerCase();
  const unresolved = [];
  const replacements = [];

  const rewrite = [];
  for (const ref of refs) {
    if (ref.kind === "labeled-other") {
      unresolved.push({ token: ref.token });
      continue;
    }
    const newToken = ref.kind === "full" ? newHead : normalizedNew.slice(0, ref.end - ref.start);
    if (ref.token === newToken) continue;
    rewrite.push({ ...ref, newToken });
    replacements.push({ kind: ref.kind, oldToken: ref.token, newToken });
  }

  let next = body;
  for (const item of [...rewrite].sort((a, b) => b.start - a.start)) {
    next = `${next.slice(0, item.start)}${item.newToken}${next.slice(item.end)}`;
  }
  return { body: next, replacements, unresolved };
}
