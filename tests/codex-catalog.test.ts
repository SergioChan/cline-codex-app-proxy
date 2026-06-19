import { describe, expect, test } from "bun:test";
import { buildCatalogEntries, normalizeRoutedCatalogEntry } from "../src/codex-catalog";

function nativeTemplate(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.\nUse tools carefully.",
    model_messages: {
      instructions_template: "You are Codex, a coding agent based on GPT-5.",
    },
    tool_mode: "code",
    multi_agent_version: "v2",
    use_responses_lite: true,
    supports_websockets: true,
    additional_speed_tiers: [{ id: "priority" }],
    service_tier: "fast",
    service_tiers: [{ id: "fast" }],
    default_service_tier: "priority",
    supported_reasoning_levels: [
      { effort: "low", description: "native low" },
      { effort: "medium", description: "native medium" },
      { effort: "high", description: "native high" },
      { effort: "xhigh", description: "native xhigh" },
    ],
  };
}

describe("Codex catalog routed normalization", () => {
  test("normalizeRoutedCatalogEntry strips native-only routed selectors", () => {
    const entry = nativeTemplate();

    normalizeRoutedCatalogEntry(entry);

    expect(entry).not.toHaveProperty("model_messages");
    expect(entry).not.toHaveProperty("tool_mode");
    expect(entry).not.toHaveProperty("multi_agent_version");
    expect(entry).not.toHaveProperty("use_responses_lite");
    expect(entry).not.toHaveProperty("supports_websockets");
    expect(entry).not.toHaveProperty("additional_speed_tiers");
    expect(entry).not.toHaveProperty("service_tier");
    expect(entry).not.toHaveProperty("service_tiers");
    expect(entry).not.toHaveProperty("default_service_tier");
  });

  test("buildCatalogEntries strips routed entries cloned from native templates", () => {
    const entries = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], [
      { provider: "anthropic", id: "claude-sonnet-4-6", owned_by: "anthropic" },
    ]);
    const routed = entries.find(e => e.slug === "anthropic/claude-sonnet-4-6");

    expect(routed).toBeDefined();
    expect(routed).not.toHaveProperty("model_messages");
    expect(routed).not.toHaveProperty("tool_mode");
    expect(routed).not.toHaveProperty("multi_agent_version");
    expect(routed).not.toHaveProperty("use_responses_lite");
    expect(routed).not.toHaveProperty("supports_websockets");
    expect(routed).not.toHaveProperty("additional_speed_tiers");
    expect(routed).not.toHaveProperty("service_tier");
    expect(routed).not.toHaveProperty("service_tiers");
    expect(routed).not.toHaveProperty("default_service_tier");
    expect(routed?.base_instructions).not.toBe(nativeTemplate().base_instructions);
    expect(routed?.base_instructions).toContain("claude-sonnet-4-6");
    expect(routed?.default_reasoning_level).toBe("medium");
  });

  test("buildCatalogEntries preserves native bare GPT template fields", () => {
    const entries = buildCatalogEntries(nativeTemplate(), ["gpt-5.5"], []);
    const native = entries.find(e => e.slug === "gpt-5.5");

    expect(native).toBeDefined();
    expect(native).toHaveProperty("model_messages");
    expect(native?.tool_mode).toBe("code");
    expect(native?.multi_agent_version).toBe("v2");
    expect(native?.use_responses_lite).toBe(true);
    expect(native?.supports_websockets).toBe(true);
    expect(native?.service_tier).toBe("priority");
    expect(native?.service_tiers).toEqual([{ id: "priority" }]);
  });
});
