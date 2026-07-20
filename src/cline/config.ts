import { createHash } from "node:crypto";
import type { OcxConfig, OcxProviderConfig } from "../types";

export const CLINE_PROVIDER_ID = "cline";
export const CLINE_BASE_URL = "https://api.cline.bot/api/v1";

export const CLINE_MODELS = Object.freeze([
  {
    id: "cline-pass/kimi-k3",
    slug: "cline/cline-pass-kimi-k3",
    displayName: "Cline · Kimi K3",
    contextWindow: 262_144,
    maxInputTokens: 235_929,
    inputModalities: ["text", "image"],
  },
  {
    id: "cline-pass/glm-5.2",
    slug: "cline/cline-pass-glm-5.2",
    displayName: "Cline · GLM 5.2",
    contextWindow: 202_752,
    maxInputTokens: 182_476,
    inputModalities: ["text"],
  },
] as const);

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

export function buildClineProvider(apiKey: string): OcxProviderConfig {
  const credential = apiKey.trim();
  if (!credential) throw new Error("Cline API key must be nonblank.");

  const ids = CLINE_MODELS.map(model => model.id);
  const reasoningEfforts = ["low", "medium", "high", "xhigh", "max"];
  return {
    adapter: "openai-chat",
    baseUrl: CLINE_BASE_URL,
    authMode: "key",
    apiKey: credential,
    defaultModel: CLINE_MODELS[0].id,
    models: [...ids],
    liveModels: false,
    selectedModels: [...ids],
    reasoningEfforts,
    modelReasoningEfforts: Object.fromEntries(
      CLINE_MODELS.map(model => [model.id, reasoningEfforts]),
    ),
    modelDefaultReasoningEfforts: Object.fromEntries(
      CLINE_MODELS.map(model => [model.id, "high"]),
    ),
    modelContextWindows: Object.fromEntries(
      CLINE_MODELS.map(model => [model.id, model.contextWindow]),
    ),
    modelMaxInputTokens: Object.fromEntries(
      CLINE_MODELS.map(model => [model.id, model.maxInputTokens]),
    ),
    modelInputModalities: Object.fromEntries(
      CLINE_MODELS.map(model => [model.id, [...model.inputModalities]]),
    ),
    parallelToolCalls: true,
    preserveReasoningContentModels: [...ids],
    modelDisplayNames: Object.fromEntries(
      CLINE_MODELS.map(model => [model.id, model.displayName]),
    ),
  };
}

export function configureCline(
  config: OcxConfig,
  apiKey: string,
  options: { adoptExisting?: boolean; existingState?: ClineSetupState } = {},
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

  const provider = buildClineProvider(apiKey);
  const previousProvider = existingState?.previousProvider ?? currentProvider ?? null;
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
