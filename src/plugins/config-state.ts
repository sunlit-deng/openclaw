/** Normalizes plugin config and resolves effective enablement, slots, and activation sources. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createEffectiveEnableStateResolver,
  createPluginEnableStateResolver,
  resolveMemorySlotDecisionShared,
  resolvePluginActivationDecisionShared,
  toPluginActivationState,
  type PluginActivationConfigSourceLike,
  type PluginActivationSource,
  type PluginActivationStateLike,
} from "./config-activation-shared.js";
import {
  hasExplicitPluginConfig as hasExplicitPluginConfigShared,
  isBundledChannelEnabledByChannelConfig as isBundledChannelEnabledByChannelConfigShared,
  normalizePluginsConfigWithResolver,
  type NormalizePluginId,
  type NormalizedPluginsConfig as SharedNormalizedPluginsConfig,
} from "./config-normalization-shared.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { defaultSlotIdForKey } from "./slots.js";

export type { PluginActivationSource };
export type PluginActivationState = PluginActivationStateLike;

export type PluginActivationConfigSource = {
  plugins: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
} & PluginActivationConfigSourceLike<OpenClawConfig>;

export type NormalizedPluginsConfig = SharedNormalizedPluginsConfig;

const BUILT_IN_PLUGIN_ALIAS_FALLBACKS: ReadonlyArray<readonly [alias: string, pluginId: string]> = [
  ["google-gemini-cli", "google"],
  ["minimax-portal", "minimax"],
  ["minimax-portal-auth", "minimax"],
] as const;
const BUILT_IN_PLUGIN_ALIAS_LOOKUP = new Map<string, string>([
  ...BUILT_IN_PLUGIN_ALIAS_FALLBACKS,
  ...BUILT_IN_PLUGIN_ALIAS_FALLBACKS.map(([, pluginId]) => [pluginId, pluginId] as const),
]);

function getBundledPluginAliasLookup(): ReadonlyMap<string, string> {
  const lookup = new Map<string, string>();
  for (const [alias, pluginId] of BUILT_IN_PLUGIN_ALIAS_FALLBACKS) {
    lookup.set(alias, pluginId);
  }
  return lookup;
}

function normalizePluginIdWithLookup(
  id: string,
  getAliasLookup: () => ReadonlyMap<string, string>,
): string {
  const trimmed = normalizeOptionalString(id) ?? "";
  const normalized = normalizeOptionalLowercaseString(trimmed) ?? "";
  const builtInAlias = BUILT_IN_PLUGIN_ALIAS_LOOKUP.get(normalized);
  if (builtInAlias) {
    return builtInAlias;
  }
  return getAliasLookup().get(normalized) ?? trimmed;
}

function createScopedPluginIdNormalizer(): NormalizePluginId {
  let lookup: ReadonlyMap<string, string> | undefined;
  return (id) =>
    normalizePluginIdWithLookup(id, () => {
      lookup ??= getBundledPluginAliasLookup();
      return lookup;
    });
}

const LOSSLESS_CONTEXT_ENGINE_ID = "lossless-claw";

/**
 * Auto-populate the lossless-claw plugin's {@code llm} policy from
 * {@code config.summaryModel} when the plugin entry exists but no explicit
 * {@code llm} block is configured.
 *
 * This mirrors the legacy migration path ({@code ensureLosslessLlmPolicy} in
 * {@code codex-route-warnings.ts}) but runs during every normal config load,
 * not just during {@code doctor --fix}.  Without this, a correctly configured
 * {@code summaryModel} is silently ignored at gateway startup: the runtime
 * LLM policy resolver sees no {@code llm} block and denies every compaction
 * model-override request until an incidental config hot-reload triggers the
 * legacy migration.
 *
 * Only auto-populates when no explicit {@code llm} block exists — any
 * operator-configured block (including {@code allowModelOverride: false})
 * is preserved verbatim so explicit operator intent always wins.
 */
function normalizeLosslessLlmPolicy(
  normalized: NormalizedPluginsConfig,
  rawConfig?: OpenClawConfig["plugins"],
): void {
  const entry = normalized.entries[LOSSLESS_CONTEXT_ENGINE_ID];
  if (!entry) {
    return;
  }

  // Preserve any explicit llm block — operator intent wins.
  if (entry.llm) {
    return;
  }

  const rawEntries = rawConfig?.entries;
  if (!rawEntries || typeof rawEntries !== "object") {
    return;
  }
  const rawEntry = (rawEntries as Record<string, unknown>)[LOSSLESS_CONTEXT_ENGINE_ID];
  if (!rawEntry || typeof rawEntry !== "object") {
    return;
  }
  const rawPluginConfig = (rawEntry as Record<string, unknown>).config;
  if (!rawPluginConfig || typeof rawPluginConfig !== "object") {
    return;
  }
  const summaryModel =
    typeof (rawPluginConfig as Record<string, unknown>).summaryModel === "string"
      ? ((rawPluginConfig as Record<string, unknown>).summaryModel as string).trim()
      : "";
  if (!summaryModel) {
    return;
  }

  entry.llm = {
    allowModelOverride: true,
    hasAllowedModelsConfig: true,
    allowedModels: [summaryModel],
  };
}

/** Normalizes user/config plugin ids into the canonical lowercase key form. */
export function normalizePluginId(id: string): string {
  return normalizePluginIdWithLookup(id, getBundledPluginAliasLookup);
}

export const normalizePluginsConfig = (
  config?: OpenClawConfig["plugins"],
): NormalizedPluginsConfig => {
  const normalized = normalizePluginsConfigWithResolver(config, createScopedPluginIdNormalizer());
  normalizeLosslessLlmPolicy(normalized, config);
  return normalized;
};

export function createPluginActivationSource(params: {
  config?: OpenClawConfig;
  plugins?: NormalizedPluginsConfig;
}): PluginActivationConfigSource {
  return {
    plugins: params.plugins ?? normalizePluginsConfig(params.config?.plugins),
    rootConfig: params.config,
  };
}

const hasExplicitMemorySlot = (plugins?: OpenClawConfig["plugins"]) =>
  Boolean(plugins?.slots && Object.hasOwn(plugins.slots, "memory"));

const hasExplicitMemoryEntry = (plugins?: OpenClawConfig["plugins"]) =>
  Boolean(plugins?.entries && Object.hasOwn(plugins.entries, defaultSlotIdForKey("memory")));

export const hasExplicitPluginConfig = (plugins?: OpenClawConfig["plugins"]) =>
  hasExplicitPluginConfigShared(plugins);

export function applyTestPluginDefaults(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): OpenClawConfig {
  if (!env.VITEST) {
    return cfg;
  }
  const plugins = cfg.plugins;
  const explicitConfig = hasExplicitPluginConfig(plugins);
  if (explicitConfig) {
    if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) {
      return cfg;
    }
    return {
      ...cfg,
      plugins: {
        ...plugins,
        slots: {
          ...plugins?.slots,
          memory: "none",
        },
      },
    };
  }

  return {
    ...cfg,
    plugins: {
      ...plugins,
      enabled: false,
      slots: {
        ...plugins?.slots,
        memory: "none",
      },
    },
  };
}

export function isTestDefaultMemorySlotDisabled(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!env.VITEST) {
    return false;
  }
  const plugins = cfg.plugins;
  if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) {
    return false;
  }
  return true;
}

export function resolvePluginActivationState(params: {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  activationSource?: PluginActivationConfigSource;
  autoEnabledReason?: string;
}): PluginActivationState {
  return toPluginActivationState(
    resolvePluginActivationDecisionShared({
      ...params,
      activationSource:
        params.activationSource ??
        createPluginActivationSource({
          config: params.rootConfig,
          plugins: params.config,
        }),
      allowBundledChannelExplicitBypassesAllowlist: true,
      isBundledChannelEnabledByChannelConfig,
    }),
  );
}

export const resolveEnableState = createPluginEnableStateResolver<
  NormalizedPluginsConfig,
  PluginOrigin
>(resolvePluginActivationState);

export const isBundledChannelEnabledByChannelConfig = isBundledChannelEnabledByChannelConfigShared;

type EffectiveActivationParams = {
  id: string;
  origin: PluginOrigin;
  config: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
  enabledByDefault?: boolean;
  activationSource?: PluginActivationConfigSource;
};

export const resolveEffectiveEnableState =
  createEffectiveEnableStateResolver<EffectiveActivationParams>(
    resolveEffectivePluginActivationState,
  );

export function resolveEffectivePluginActivationState(params: {
  id: EffectiveActivationParams["id"];
  origin: EffectiveActivationParams["origin"];
  config: EffectiveActivationParams["config"];
  rootConfig?: EffectiveActivationParams["rootConfig"];
  enabledByDefault?: EffectiveActivationParams["enabledByDefault"];
  activationSource?: EffectiveActivationParams["activationSource"];
  autoEnabledReason?: string;
}): PluginActivationState {
  return resolvePluginActivationState(params);
}

export function resolveMemorySlotDecision(params: {
  id: string;
  kind?: string | string[];
  slot: string | null | undefined;
  selectedId: string | null;
}): { enabled: boolean; reason?: string; selected?: boolean } {
  return resolveMemorySlotDecisionShared(params);
}
