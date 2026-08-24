const DOCUMENTATION_BASENAMES = /^(?:readme|changelog|license|notice|authors)(?:\..*)?$/iu;

export function normalizeRepoPath(file) {
  return String(file).replaceAll("\\", "/").replace(/^\.\/+/, "");
}

export function isDocumentationFile(file) {
  const normalized = normalizeRepoPath(file);
  const basename = normalized.split("/").at(-1) ?? "";
  return normalized.startsWith("docs/")
    || normalized.startsWith("documentation/")
    || /\.(?:md|mdx|rst|txt|po)$/iu.test(normalized)
    || DOCUMENTATION_BASENAMES.test(basename);
}

export function isDocumentationOnly(files) {
  return files.length > 0 && files.every(isDocumentationFile);
}
