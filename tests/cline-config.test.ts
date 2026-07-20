import { describe, expect, test } from "bun:test";
import {
  CLINE_BASE_URL,
  CLINE_MODELS,
  clineProviderFingerprint,
  configureCline,
  isManagedClineProvider,
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

  test("repeat setup updates the key while preserving the original rollback provider", () => {
    const config = getDefaultConfig();
    config.providers.cline = { adapter: "anthropic", baseUrl: "https://example.test" };
    const first = configureCline(config, "first-secret", { adoptExisting: true });
    const second = configureCline(first.config, "second-secret", { existingState: first.state });

    expect(second.config.providers.cline.apiKey).toBe("second-secret");
    expect(second.state.previousProvider).toEqual(config.providers.cline);
    expect(second.state.installedAt).toBe(first.state.installedAt);
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
