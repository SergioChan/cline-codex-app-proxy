import * as readline from "node:readline";
import { injectCodexConfig } from "./codex-inject";
import { getDefaultConfig, saveConfig } from "./config";
import type { OcxConfig, OcxProviderConfig } from "./types";

function createPrompt(): { ask(question: string): Promise<string>; close(): void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask(question: string): Promise<string> {
      return new Promise(resolve => rl.question(question, resolve));
    },
    close() { rl.close(); },
  };
}

const PRESETS: Record<string, { adapter: string; baseUrl: string; envKey: string; models: string[] }> = {
  "opencode-go": {
    adapter: "openai-chat",
    baseUrl: "https://opencode.ai/zen/go/v1",
    envKey: "OPENCODE_API_KEY",
    models: ["kimi-k2.5", "kimi-k2.6", "deepseek-v4-flash", "qwen3.5-plus"],
  },
  "anthropic": {
    adapter: "anthropic",
    baseUrl: "https://api.anthropic.com",
    envKey: "ANTHROPIC_API_KEY",
    models: ["claude-sonnet-4-20250514", "claude-opus-4-20250916"],
  },
  "openai": {
    adapter: "openai-responses",
    baseUrl: "https://api.openai.com",
    envKey: "OPENAI_API_KEY",
    models: ["gpt-5.5", "o3-pro"],
  },
  "openrouter": {
    adapter: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    models: ["anthropic/claude-sonnet-4", "google/gemini-3-pro"],
  },
  "groq": {
    adapter: "openai-chat",
    baseUrl: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    models: ["llama-4-scout-17b", "llama-4-maverick-17b"],
  },
  "google": {
    adapter: "google",
    baseUrl: "https://generativelanguage.googleapis.com",
    envKey: "GOOGLE_API_KEY",
    models: ["gemini-3-pro", "gemini-3-flash"],
  },
  "azure-openai": {
    adapter: "azure-openai",
    baseUrl: "https://{your-resource}.openai.azure.com/openai/deployments/{deployment}",
    envKey: "AZURE_OPENAI_API_KEY",
    models: ["gpt-5.5"],
  },
};

export async function runInit(): Promise<void> {
  const prompt = createPrompt();

  console.log("\n🔧 opencodex (ocx) setup\n");

  const presetNames = Object.keys(PRESETS);
  console.log("Available providers:");
  presetNames.forEach((name, i) => console.log(`  ${i + 1}. ${name}`));
  console.log(`  ${presetNames.length + 1}. custom (enter URL manually)`);

  const choice = await prompt.ask("\nSelect provider (number): ");
  const idx = parseInt(choice, 10) - 1;

  let providerName: string;
  let providerConfig: OcxProviderConfig;

  if (idx >= 0 && idx < presetNames.length) {
    providerName = presetNames[idx];
    const preset = PRESETS[providerName];

    console.log(`\n📡 ${providerName} selected`);
    console.log(`   Base URL: ${preset.baseUrl}`);
    console.log(`   Models: ${preset.models.join(", ")}`);

    const apiKey = await prompt.ask(`\nAPI key (or env var ${preset.envKey}): `);
    const resolvedKey = apiKey.trim() || `\${${preset.envKey}}`;

    const modelChoice = await prompt.ask(`Default model [${preset.models[0]}]: `);
    const defaultModel = modelChoice.trim() || preset.models[0];

    providerConfig = {
      adapter: preset.adapter,
      baseUrl: preset.baseUrl,
      apiKey: resolvedKey,
      defaultModel,
    };
  } else {
    providerName = await prompt.ask("Provider name: ");
    const baseUrl = await prompt.ask("Base URL (e.g. http://localhost:11434/v1): ");
    const adapter = await prompt.ask("Adapter [openai-chat]: ") || "openai-chat";
    const apiKey = await prompt.ask("API key (optional): ");
    const defaultModel = await prompt.ask("Default model: ");

    providerConfig = {
      adapter: adapter.trim(),
      baseUrl: baseUrl.trim(),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(defaultModel.trim() ? { defaultModel: defaultModel.trim() } : {}),
    };
  }

  const portStr = await prompt.ask("Proxy port [10100]: ");
  const port = parseInt(portStr, 10) || 10100;

  const config: OcxConfig = {
    ...getDefaultConfig(),
    port,
    providers: { [providerName]: providerConfig },
    defaultProvider: providerName,
  };

  saveConfig(config);
  console.log(`\n✅ Config saved to ~/.opencodex/config.json`);

  const injectAnswer = await prompt.ask("Inject into Codex config.toml? [Y/n]: ");
  if (injectAnswer.trim().toLowerCase() !== "n") {
    const result = injectCodexConfig(port);
    console.log(result.success ? `✅ ${result.message}` : `⚠️  ${result.message}`);
  }

  console.log(`\n🚀 Setup complete! Run 'ocx start' to start the proxy.`);
  prompt.close();
}
