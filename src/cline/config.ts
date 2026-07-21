import { createHash } from "node:crypto";
import { routedSlug } from "../providers/slug-codec";
import type { OcxConfig, OcxProviderConfig } from "../types";

export const CLINE_PROVIDER_ID = "cline";
export const CLINE_BASE_URL = "https://api.cline.bot/api/v1";
export const CLINEPASS_CATALOG_UPDATED_AT = "2026-07-21";

const VERIFIED_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface ClineModelDefinition {
  id: string;
  slug: string;
  displayName: string;
  contextWindow?: number;
  maxInputTokens?: number;
  inputModalities: readonly string[];
  reasoningEfforts: readonly string[];
  defaultReasoningEffort?: string;
}

function defineClinePassModel(
  definition: Omit<ClineModelDefinition, "slug">,
): ClineModelDefinition {
  return Object.freeze({
    ...definition,
    slug: routedSlug(CLINE_PROVIDER_ID, definition.id),
  });
}

/**
 * Versioned fallback from Cline's public ClinePass page. The public API does not
 * document a stable HTTP model-list endpoint, so setup never treats live discovery
 * as authoritative. Only Kimi K3 and GLM 5.2 carry metadata verified by this project;
 * every other entry is intentionally text-only with no advertised effort ladder.
 */
export const CLINEPASS_MODELS: readonly ClineModelDefinition[] = Object.freeze([
  defineClinePassModel({
    id: "cline-pass/kimi-k3",
    displayName: "Cline · Kimi K3",
    contextWindow: 262_144,
    maxInputTokens: 235_929,
    inputModalities: ["text", "image"],
    reasoningEfforts: VERIFIED_REASONING_EFFORTS,
    defaultReasoningEffort: "high",
  }),
  defineClinePassModel({
    id: "cline-pass/glm-5.2",
    displayName: "Cline · GLM 5.2",
    contextWindow: 202_752,
    maxInputTokens: 182_476,
    inputModalities: ["text"],
    reasoningEfforts: VERIFIED_REASONING_EFFORTS,
    defaultReasoningEffort: "high",
  }),
  defineClinePassModel({
    id: "cline-pass/kimi-k2.7-code",
    displayName: "Cline · Kimi K2.7 Code",
    inputModalities: ["text"],
    reasoningEfforts: [],
  }),
  defineClinePassModel({
    id: "cline-pass/kimi-k2.6",
    displayName: "Cline · Kimi K2.6",
    inputModalities: ["text"],
    reasoningEfforts: [],
  }),
  defineClinePassModel({
    id: "cline-pass/deepseek-v4-pro",
    displayName: "Cline · DeepSeek V4 Pro",
    inputModalities: ["text"],
    reasoningEfforts: [],
  }),
  defineClinePassModel({
    id: "cline-pass/deepseek-v4-flash",
    displayName: "Cline · DeepSeek V4 Flash",
    inputModalities: ["text"],
    reasoningEfforts: [],
  }),
  defineClinePassModel({
    id: "cline-pass/mimo-v2.5",
    displayName: "Cline · MiMo V2.5",
    inputModalities: ["text"],
    reasoningEfforts: [],
  }),
  defineClinePassModel({
    id: "cline-pass/mimo-v2.5-pro",
    displayName: "Cline · MiMo V2.5 Pro",
    inputModalities: ["text"],
    reasoningEfforts: [],
  }),
  defineClinePassModel({
    id: "cline-pass/minimax-m3",
    displayName: "Cline · MiniMax M3",
    inputModalities: ["text"],
    reasoningEfforts: [],
  }),
  defineClinePassModel({
    id: "cline-pass/qwen3.7-max",
    displayName: "Cline · Qwen3.7 Max",
    inputModalities: ["text"],
    reasoningEfforts: [],
  }),
  defineClinePassModel({
    id: "cline-pass/qwen3.7-plus",
    displayName: "Cline · Qwen3.7 Plus",
    inputModalities: ["text"],
    reasoningEfforts: [],
  }),
]);

export const DEFAULT_CLINE_MODEL_IDS = Object.freeze([
  "cline-pass/kimi-k3",
  "cline-pass/glm-5.2",
]);

/** Backward-compatible name for the two-model default selection. */
export const CLINE_MODELS = Object.freeze(
  DEFAULT_CLINE_MODEL_IDS.map(id => CLINEPASS_MODELS.find(model => model.id === id)!),
);

const CLINEPASS_BY_ID = new Map(CLINEPASS_MODELS.map(model => [model.id, model]));
const CLINE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:+-]*$/;
const MAX_CONFIGURED_CLINE_MODELS = 64;

export type ClineSetupState = {
  schemaVersion: 1;
  installedAt: string;
  previousProvider: OcxProviderConfig | null;
  installedProviderFingerprint: string;
};

function normalizedBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function clineProviderFingerprint(provider: OcxProviderConfig): string {
  return createHash("sha256").update(stableJson(provider)).digest("hex");
}

export function isManagedClineProvider(provider: OcxProviderConfig | undefined): boolean {
  return provider?.adapter === "openai-chat"
    && normalizedBaseUrl(provider.baseUrl) === CLINE_BASE_URL;
}

export function normalizeClineModelIds(modelIds: readonly string[]): string[] {
  if (modelIds.length === 0) throw new Error("Configure at least one Cline model.");
  if (modelIds.length > MAX_CONFIGURED_CLINE_MODELS) {
    throw new Error(`Configure at most ${MAX_CONFIGURED_CLINE_MODELS} Cline models.`);
  }

  const seenIds = new Set<string>();
  const routedIds = new Map<string, string>();
  const normalized: string[] = [];
  for (const raw of modelIds) {
    const id = raw.trim();
    if (id !== raw || id.length > 256 || !CLINE_MODEL_ID_PATTERN.test(id)) {
      throw new Error(`Invalid Cline model ID: ${JSON.stringify(raw)}. Expected provider/model-name.`);
    }
    if (seenIds.has(id)) throw new Error(`Duplicate Cline model ID: ${id}.`);
    seenIds.add(id);

    const slug = routedSlug(CLINE_PROVIDER_ID, id);
    const collision = routedIds.get(slug);
    if (collision) {
      throw new Error(`Cline model IDs ${collision} and ${id} collide on Codex slug ${slug}.`);
    }
    routedIds.set(slug, id);
    normalized.push(id);
  }
  return normalized;
}

export function clineModelDefinition(id: string): ClineModelDefinition {
  const known = CLINEPASS_BY_ID.get(id);
  if (known) return known;
  return {
    id,
    slug: routedSlug(CLINE_PROVIDER_ID, id),
    displayName: `Cline · ${id}`,
    inputModalities: ["text"],
    reasoningEfforts: [],
  };
}

export function buildClineProvider(
  apiKey: string,
  options: { modelIds?: readonly string[]; defaultModel?: string } = {},
): OcxProviderConfig {
  const credential = apiKey.trim();
  if (!credential) throw new Error("Cline API key must be nonblank.");

  const ids = normalizeClineModelIds(options.modelIds ?? DEFAULT_CLINE_MODEL_IDS);
  const models = ids.map(clineModelDefinition);
  const defaultModel = options.defaultModel?.trim() || ids[0];
  if (!ids.includes(defaultModel)) {
    throw new Error(`Default Cline model ${defaultModel} is not in the configured model list.`);
  }

  const contextWindows = models.flatMap(model => model.contextWindow === undefined ? [] : [[model.id, model.contextWindow] as const]);
  const maxInputTokens = models.flatMap(model => model.maxInputTokens === undefined ? [] : [[model.id, model.maxInputTokens] as const]);
  const defaultReasoningEfforts = models.flatMap(model => model.defaultReasoningEffort === undefined
    ? []
    : [[model.id, model.defaultReasoningEffort] as const]);
  const reasoningModels = models.filter(model => model.reasoningEfforts.length > 0).map(model => model.id);
  const nonReasoningModels = models.filter(model => model.reasoningEfforts.length === 0).map(model => model.id);

  return {
    adapter: "openai-chat",
    baseUrl: CLINE_BASE_URL,
    authMode: "key",
    apiKey: credential,
    defaultModel,
    models: [...ids],
    liveModels: false,
    selectedModels: [...ids],
    modelReasoningEfforts: Object.fromEntries(
      models.map(model => [model.id, [...model.reasoningEfforts]]),
    ),
    ...(defaultReasoningEfforts.length > 0
      ? { modelDefaultReasoningEfforts: Object.fromEntries(defaultReasoningEfforts) }
      : {}),
    ...(contextWindows.length > 0 ? { modelContextWindows: Object.fromEntries(contextWindows) } : {}),
    ...(maxInputTokens.length > 0 ? { modelMaxInputTokens: Object.fromEntries(maxInputTokens) } : {}),
    modelInputModalities: Object.fromEntries(
      models.map(model => [model.id, [...model.inputModalities]]),
    ),
    parallelToolCalls: true,
    ...(nonReasoningModels.length > 0 ? { noReasoningModels: nonReasoningModels } : {}),
    ...(reasoningModels.length > 0 ? { preserveReasoningContentModels: reasoningModels } : {}),
    modelDisplayNames: Object.fromEntries(
      models.map(model => [model.id, model.displayName]),
    ),
  };
}

export function configureCline(
  config: OcxConfig,
  apiKey: string,
  options: {
    adoptExisting?: boolean;
    existingState?: ClineSetupState;
    modelIds?: readonly string[];
    defaultModel?: string;
  } = {},
): { config: OcxConfig; state: ClineSetupState } {
  const currentProvider = config.providers[CLINE_PROVIDER_ID];
  const existingState = options.existingState;

  if (existingState) {
    if (!currentProvider) {
      throw new Error("Cline setup state exists, but providers.cline is missing; refusing to overwrite configuration.");
    }
    if (clineProviderFingerprint(currentProvider) !== existingState.installedProviderFingerprint) {
      throw new Error("providers.cline changed after setup; refusing to overwrite user changes.");
    }
  } else if (currentProvider && !options.adoptExisting) {
    throw new Error(
      "providers.cline already exists. Re-run with --adopt-existing-cline only if this project may manage it.",
    );
  }

  const credential = apiKey.trim();
  if (!credential) throw new Error("Cline API key must be nonblank.");
  let provider: OcxProviderConfig;
  if (existingState && options.modelIds === undefined) {
    const currentIds = normalizeClineModelIds(
      currentProvider!.models?.length
        ? currentProvider!.models
        : currentProvider!.selectedModels?.length
          ? currentProvider!.selectedModels
          : DEFAULT_CLINE_MODEL_IDS,
    );
    const defaultModel = options.defaultModel?.trim() || currentProvider!.defaultModel || currentIds[0];
    if (!currentIds.includes(defaultModel)) {
      throw new Error(`Default Cline model ${defaultModel} is not in the configured model list.`);
    }
    provider = {
      ...currentProvider!,
      apiKey: credential,
      defaultModel,
    };
  } else {
    const modelIds = options.modelIds;
    const preservedDefault = existingState
      && modelIds
      && currentProvider?.defaultModel
      && modelIds.includes(currentProvider.defaultModel)
      ? currentProvider.defaultModel
      : undefined;
    provider = buildClineProvider(apiKey, {
      modelIds,
      defaultModel: options.defaultModel ?? preservedDefault,
    });
  }
  const previousProvider = existingState
    ? existingState.previousProvider
    : currentProvider ?? null;
  return {
    config: {
      ...config,
      providers: {
        ...config.providers,
        [CLINE_PROVIDER_ID]: provider,
      },
    },
    state: {
      schemaVersion: 1,
      installedAt: existingState?.installedAt ?? new Date().toISOString(),
      previousProvider,
      installedProviderFingerprint: clineProviderFingerprint(provider),
    },
  };
}

export function removeCline(config: OcxConfig, state: ClineSetupState): OcxConfig {
  const currentProvider = config.providers[CLINE_PROVIDER_ID];
  if (!currentProvider) {
    throw new Error("providers.cline is already absent; refusing to consume setup state.");
  }
  if (clineProviderFingerprint(currentProvider) !== state.installedProviderFingerprint) {
    throw new Error("providers.cline changed after setup; refusing to remove user changes.");
  }

  const providers = { ...config.providers };
  if (state.previousProvider) providers[CLINE_PROVIDER_ID] = state.previousProvider;
  else delete providers[CLINE_PROVIDER_ID];

  if (Object.keys(providers).length === 0) {
    throw new Error("Removing Cline would leave no providers; refusing to write an invalid config.");
  }

  let defaultProvider = config.defaultProvider;
  if (!(defaultProvider in providers)) {
    if (providers.openai) defaultProvider = "openai";
    else defaultProvider = Object.keys(providers)[0];
  }

  return {
    ...config,
    providers,
    defaultProvider,
  };
}
