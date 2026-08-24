import { targetedValidationDecision } from "./targeted-validation.mjs";
import { loadProjectProfile } from "../../../../auto-pr-core/project-profile.mjs";
import { isDocumentationOnly } from "./path-policy.mjs";

export { isDocumentationOnly };

export function resolveValidationProfile(requestedProfile, changedFiles, projectInput = "openclaw") {
  if (requestedProfile !== "auto") return requestedProfile;
  if (isDocumentationOnly(changedFiles)) return "quick";
  const project = typeof projectInput === "string" || !projectInput
    ? loadProjectProfile(projectInput || "openclaw")
    : projectInput;
  return targetedValidationDecision(changedFiles, project).safe ? "targeted" : "changed";
}
