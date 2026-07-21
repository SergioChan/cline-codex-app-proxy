import { describe, expect, test } from "bun:test";
import {
  CLINE_BASE_URL,
  CLINEPASS_MODELS,
  CLINE_MODELS,
  buildClineProvider,
  clineProviderFingerprint,
  configureCline,
  isManagedClineProvider,
  normalizeClineModelIds,
  removeCline,
} from "../src/cline/config";
import { getDefaultConfig } from "../src/config";

describe("Cline Codex App provider configuration", () => {
  test("adds Cline without mutating other providers, defaults, or global preferences", () => {
    const original = {
      ...getDefaultConfig(),
      providers: {
        ...getDefaultConfig().providers,
        custom: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "custom-secret" },
      },
      defaultProvider: "custom",
      subagentModels: ["custom/model"],
      codexAutoStart: false,
      websockets: true,
    };

    const result = configureCline(original, "cline-secret");

    expect(result.config).not.toBe(original);
    expect(result.config.defaultProvider).toBe("custom");
    expect(result.config.providers.custom).toEqual(original.providers.custom);
    expect(result.config.subagentModels).toEqual(["custom/model"]);
    expect(result.config.codexAutoStart).toBe(false);
    expect(result.config.websockets).toBe(true);
    expect(result.config.providers.cline).toMatchObject({
      adapter: "openai-chat",
      baseUrl: CLINE_BASE_URL,
      apiKey: "cline-secret",
      liveModels: false,
      models: CLINE_MODELS.map(model => model.id),
      selectedModels: CLINE_MODELS.map(model => model.id),
      modelDisplayNames: Object.fromEntries(CLINE_MODELS.map(model => [model.id, model.displayName])),
    });
    expect(result.config.providers.cline.modelInputModalities?.[CLINE_MODELS[0].id]).toEqual(["text", "image"]);
    expect(result.config.providers.cline.modelInputModalities?.[CLINE_MODELS[1].id]).toEqual(["text"]);
    expect(result.state.previousProvider).toBeNull();
    expect(result.state.installedProviderFingerprint)
      .toBe(clineProviderFingerprint(result.config.providers.cline));
  });

  test("requires explicit adoption for every pre-existing providers.cline", () => {
    const config = getDefaultConfig();
    config.providers.cline = { adapter: "anthropic", baseUrl: "https://example.test", disabled: true };

    expect(() => configureCline(config, "cline-secret")).toThrow("--adopt-existing-cline");
    const adopted = configureCline(config, "cline-secret", { adoptExisting: true });
    expect(isManagedClineProvider(adopted.config.providers.cline)).toBe(true);
    expect(adopted.config.providers.cline.disabled).toBeUndefined();
    expect(adopted.state.previousProvider).toEqual(config.providers.cline);
  });

  test("bundles every unique ClinePass model from the official snapshot", () => {
    expect(CLINEPASS_MODELS).toHaveLength(11);
    expect(new Set(CLINEPASS_MODELS.map(model => model.id)).size).toBe(11);
    expect(CLINEPASS_MODELS.map(model => model.id)).toContain("cline-pass/deepseek-v4-pro");
    expect(CLINEPASS_MODELS.map(model => model.id)).toContain("cline-pass/deepseek-v4-flash");
    expect(CLINEPASS_MODELS.map(model => model.id)).toContain("cline-pass/minimax-m3");
    expect(CLINEPASS_MODELS.map(model => model.id)).toContain("cline-pass/qwen3.7-plus");
  });

  test("builds a selected official and custom model set with conservative unknown metadata", () => {
    const ids = [
      "cline-pass/deepseek-v4-flash",
      "cline-pass/minimax-m3",
      "deepseek/deepseek-chat",
    ];
    const provider = buildClineProvider("cline-secret", {
      modelIds: ids,
      defaultModel: "cline-pass/minimax-m3",
    });

    expect(provider.models).toEqual(ids);
    expect(provider.selectedModels).toEqual(ids);
    expect(provider.defaultModel).toBe("cline-pass/minimax-m3");
    expect(provider.modelDisplayNames?.["cline-pass/deepseek-v4-flash"]).toBe("Cline · DeepSeek V4 Flash");
    expect(provider.modelDisplayNames?.["cline-pass/minimax-m3"]).toBe("Cline · MiniMax M3");
    expect(provider.modelDisplayNames?.["deepseek/deepseek-chat"]).toBe("Cline · deepseek/deepseek-chat");
    expect(provider.modelInputModalities?.["deepseek/deepseek-chat"]).toEqual(["text"]);
    expect(provider.modelReasoningEfforts?.["deepseek/deepseek-chat"]).toEqual([]);
    expect(provider.noReasoningModels).toEqual(ids);
    expect(provider.modelContextWindows).toBeUndefined();
  });

  test("rejects malformed, duplicate, missing-default, and Codex-slug-colliding model IDs", () => {
    expect(() => normalizeClineModelIds([])).toThrow("at least one");
    expect(() => normalizeClineModelIds(["not-a-provider-model"])).toThrow("provider/model-name");
    expect(() => normalizeClineModelIds(["a/b/"])).toThrow("provider/model-name");
    expect(() => normalizeClineModelIds(["a/b//c"])).toThrow("provider/model-name");
    expect(() => normalizeClineModelIds(["a/b", "a/b"])).toThrow("Duplicate");
    expect(() => normalizeClineModelIds(["a/b-c", "a-b/c"])).toThrow("collide on Codex slug");
    expect(() => buildClineProvider("secret", { modelIds: ["a/b"], defaultModel: "a/c" }))
      .toThrow("not in the configured model list");
  });

  test("repeat setup updates the key while preserving the original rollback provider", () => {
    const config = getDefaultConfig();
    config.providers.cline = { adapter: "anthropic", baseUrl: "https://example.test" };
    const first = configureCline(config, "first-secret", { adoptExisting: true });
    const second = configureCline(first.config, "second-secret", { existingState: first.state });

    expect(second.config.providers.cline.apiKey).toBe("second-secret");
    expect(second.state.previousProvider).toEqual(config.providers.cline);
    expect(second.state.installedAt).toBe(first.state.installedAt);
  });

  test("key-only repeat setup preserves an explicitly configured model set", () => {
    const ids = ["cline-pass/minimax-m3", "deepseek/deepseek-chat"];
    const first = configureCline(getDefaultConfig(), "first-secret", {
      modelIds: ids,
      defaultModel: "deepseek/deepseek-chat",
    });
    const second = configureCline(first.config, "second-secret", { existingState: first.state });

    expect(second.config.providers.cline.apiKey).toBe("second-secret");
    expect(second.config.providers.cline.models).toEqual(ids);
    expect(second.config.providers.cline.defaultModel).toBe("deepseek/deepseek-chat");
    expect(second.config.providers.cline.modelDisplayNames).toEqual(first.config.providers.cline.modelDisplayNames);
    expect(second.state.previousProvider).toBeNull();
    expect(second.state.installedAt).toBe(first.state.installedAt);
  });

  test("explicit repeat setup replaces models and updates the ownership fingerprint", () => {
    const first = configureCline(getDefaultConfig(), "secret", {
      defaultModel: "cline-pass/glm-5.2",
    });
    const second = configureCline(first.config, "secret", {
      existingState: first.state,
      modelIds: ["cline-pass/glm-5.2", "cline-pass/minimax-m3"],
    });

    expect(second.config.providers.cline.models).toEqual(["cline-pass/glm-5.2", "cline-pass/minimax-m3"]);
    expect(second.config.providers.cline.defaultModel).toBe("cline-pass/glm-5.2");
    expect(second.state.installedProviderFingerprint).not.toBe(first.state.installedProviderFingerprint);
    expect(removeCline(second.config, second.state).providers.cline).toBeUndefined();
  });

  test("default-only repeat setup preserves the managed provider metadata", () => {
    const first = configureCline(getDefaultConfig(), "first-secret", {
      modelIds: ["cline-pass/kimi-k3", "cline-pass/glm-5.2"],
    });
    first.config.providers.cline.note = "managed metadata";
    first.state.installedProviderFingerprint = clineProviderFingerprint(first.config.providers.cline);

    const second = configureCline(first.config, "second-secret", {
      existingState: first.state,
      defaultModel: "cline-pass/glm-5.2",
    });

    expect(second.config.providers.cline).toEqual({
      ...first.config.providers.cline,
      apiKey: "second-secret",
      defaultModel: "cline-pass/glm-5.2",
    });
    expect(second.state.previousProvider).toBeNull();
  });

  test("repeat setup refuses a provider changed outside this integration", () => {
    const first = configureCline(getDefaultConfig(), "first-secret");
    first.config.providers.cline.note = "user change";
    expect(() => configureCline(first.config, "second-secret", { existingState: first.state }))
      .toThrow("changed after setup");
  });

  test("remove restores a prior provider and preserves unrelated configuration", () => {
    const config = getDefaultConfig();
    config.providers.cline = { adapter: "anthropic", baseUrl: "https://example.test" };
    config.defaultProvider = "cline";
    config.subagentModels = [CLINE_MODELS[0].slug, "openai/model"];
    const installed = configureCline(config, "cline-secret", { adoptExisting: true });

    const removed = removeCline(installed.config, installed.state);

    expect(removed.providers.cline).toEqual(config.providers.cline);
    expect(removed.defaultProvider).toBe("cline");
    expect(removed.subagentModels).toEqual(config.subagentModels);
  });

  test("remove deletes an owned provider and falls back to openai", () => {
    const installed = configureCline(getDefaultConfig(), "cline-secret");
    installed.config.defaultProvider = "cline";

    const removed = removeCline(installed.config, installed.state);

    expect(removed.providers.cline).toBeUndefined();
    expect(removed.defaultProvider).toBe("openai");
  });

  test("remove refuses to delete a provider changed after setup", () => {
    const installed = configureCline(getDefaultConfig(), "cline-secret");
    installed.config.providers.cline.apiKey = "user-replaced-secret";
    expect(() => removeCline(installed.config, installed.state)).toThrow("changed after setup");
  });
});
