import path from "node:path";

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

export function validateWorkflowReceipt(receipt, {
  kind = "receipt",
  schemaVersions = [1],
  workflowPath,
  repoPath,
  headSha,
  validationBaseSha,
} = {}) {
  const problems = [];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { valid: false, problems: [`${kind} is missing or invalid`] };
  }
  if (!schemaVersions.includes(Number(receipt.schemaVersion))) {
    problems.push(`${kind} schemaVersion ${receipt.schemaVersion ?? "missing"} is unsupported`);
  }
  if (workflowPath && !samePath(receipt.workflowPath, workflowPath)) {
    problems.push(`${kind} workflowPath does not match current workflow`);
  }
  if (repoPath && !samePath(receipt.repoPath, repoPath)) {
    problems.push(`${kind} repoPath does not match current repository`);
  }
  if (headSha && receipt.headSha !== headSha) {
    problems.push(`${kind} headSha does not match current HEAD`);
  }
  if (validationBaseSha && receipt.validationBaseSha !== validationBaseSha) {
    problems.push(`${kind} validationBaseSha does not match current workflow`);
  }
  return { valid: problems.length === 0, problems };
}

export function receiptSummary(receipt, validation) {
  if (!receipt) return { status: "missing", valid: false, problems: validation.problems };
  return {
    status: receipt.status ?? "unknown",
    valid: validation.valid,
    problems: validation.problems,
  };
}
