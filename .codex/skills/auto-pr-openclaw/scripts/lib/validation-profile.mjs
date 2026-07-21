const DOCUMENTATION_BASENAMES = /^(?:readme|changelog|license|notice|authors)(?:\..*)?$/i;

export function isDocumentationOnly(files) {
  return files.length > 0 && files.every((file) => {
    const normalized = file.replaceAll("\\", "/");
    const basename = normalized.split("/").at(-1) ?? "";
    return normalized.endsWith(".md") || DOCUMENTATION_BASENAMES.test(basename);
  });
}

export function resolveValidationProfile(requestedProfile, changedFiles) {
  if (requestedProfile !== "auto") return requestedProfile;
  return isDocumentationOnly(changedFiles) ? "quick" : "focused";
}
