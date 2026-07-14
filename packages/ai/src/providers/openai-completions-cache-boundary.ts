import { normalizeStructuredPromptSection } from "../utils/prompt-cache-stability.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import {
  splitSystemPromptCacheBoundary,
  stripSystemPromptCacheBoundary,
} from "../utils/system-prompt-cache-boundary.js";

export type OpenAICompletionsPromptCarrier = {
  role: "system" | "developer";
  content: string;
};

export function resolveOpenAICompletionsSystemPromptBoundary(params: {
  prompt: string;
  role: "system" | "developer";
  disableBoundaryAwareCache: boolean | undefined;
  preserveSystemPromptCacheBoundary: boolean | undefined;
}): {
  content: string;
  pendingSuffixCarrier?: OpenAICompletionsPromptCarrier;
} {
  if (params.disableBoundaryAwareCache) {
    const split = splitSystemPromptCacheBoundary(params.prompt);
    const content = split?.stablePrefix
      ? sanitizeSurrogates(split.stablePrefix)
      : sanitizeSurrogates(stripSystemPromptCacheBoundary(params.prompt));
    return {
      content,
      pendingSuffixCarrier: split?.dynamicSuffix
        ? {
            role: params.role,
            content: sanitizeSurrogates(normalizeStructuredPromptSection(split.dynamicSuffix)),
          }
        : undefined,
    };
  }
  return {
    content: sanitizeSurrogates(
      params.preserveSystemPromptCacheBoundary
        ? params.prompt
        : stripSystemPromptCacheBoundary(params.prompt),
    ),
  };
}
