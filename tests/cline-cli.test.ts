import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLINEPASS_MODELS, clineProviderFingerprint } from "../src/cline/config";
import { parseInteractiveModelSelection } from "../src/cli/cline";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliPath = join(repoRoot, "src", "cli", "index.ts");

function runCli(args: string[], home: string, input?: string) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    env: { ...process.env, OPENCODEX_HOME: home },
    input,
    encoding: "utf8",
  });
}

function baseConfig() {
  return {
    port: 10100,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
      custom: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        apiKey: "unrelated-secret",
      },
    },
    defaultProvider: "custom",
    codexAutoStart: false,
    websockets: true,
    subagentModels: ["custom/model"],
  };
}

describe("ocx cline", () => {
  test("interactive selection accepts official numbers, all, defaults, and custom IDs", () => {
    expect(parseInteractiveModelSelection("", ["cline-pass/minimax-m3"]))
      .toBeUndefined();
    expect(parseInteractiveModelSelection("6, 9", ["cline-pass/kimi-k3"]))
      .toEqual(["cline-pass/deepseek-v4-flash", "cline-pass/minimax-m3"]);
    expect(parseInteractiveModelSelection("all", ["cline-pass/kimi-k3"]))
      .toEqual(CLINEPASS_MODELS.map(model => model.id));
    expect(parseInteractiveModelSelection("default", ["cline-pass/minimax-m3"]))
      .toEqual(["cline-pass/kimi-k3", "cline-pass/glm-5.2"]);
    expect(parseInteractiveModelSelection("deepseek/deepseek-chat", ["cline-pass/kimi-k3"]))
      .toEqual(["deepseek/deepseek-chat"]);
  });

  test("setup and remove are reversible and never print the key", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-cline-cli-"));
    const configPath = join(home, "config.json");
    const statePath = join(home, "cline-codex-app-proxy-state.json");
    const original = baseConfig();
    writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o600 });
    try {
      const setup = runCli(["cline", "setup", "--api-key-stdin", "--json"], home, "super-secret-key\n");
      expect(setup.status).toBe(0);
      expect(setup.stdout).not.toContain("super-secret-key");
      expect(setup.stderr).not.toContain("super-secret-key");

      const configured = JSON.parse(readFileSync(configPath, "utf8"));
      expect(configured.providers.custom).toEqual(original.providers.custom);
      expect(configured.defaultProvider).toBe("custom");
      expect(configured.codexAutoStart).toBe(false);
      expect(configured.websockets).toBe(true);
      expect(configured.subagentModels).toEqual(["custom/model"]);
      expect(configured.providers.cline.apiKey).toBe("super-secret-key");
      if (process.platform !== "win32") {
        expect(statSync(configPath).mode & 0o777).toBe(0o600);
        expect(statSync(statePath).mode & 0o777).toBe(0o600);
      }

      const remove = runCli(["cline", "remove", "--json"], home);
      expect(remove.status).toBe(0);
      const restored = JSON.parse(readFileSync(configPath, "utf8"));
      expect(restored.providers.cline).toBeUndefined();
      expect(restored.providers.custom).toEqual(original.providers.custom);
      expect(restored.defaultProvider).toBe(original.defaultProvider);
      expect(restored.codexAutoStart).toBe(original.codexAutoStart);
      expect(restored.websockets).toBe(original.websockets);
      expect(restored.subagentModels).toEqual(original.subagentModels);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("setup accepts repeatable model IDs and key-only reruns preserve the selection", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-cline-models-"));
    const configPath = join(home, "config.json");
    writeFileSync(configPath, `${JSON.stringify(baseConfig(), null, 2)}\n`, { mode: 0o600 });
    try {
      const setup = runCli([
        "cline", "setup", "--api-key-stdin", "--json",
        "--model", "cline-pass/deepseek-v4-flash",
        "--model", "cline-pass/minimax-m3, deepseek/deepseek-chat",
        "--default-model", "cline-pass/minimax-m3",
      ], home, "first-secret\n");
      expect(setup.status).toBe(0);
      expect(setup.stdout).not.toContain("first-secret");
      const payload = JSON.parse(setup.stdout);
      expect(payload.defaultModel).toBe("cline-pass/minimax-m3");
      expect(payload.models.map((model: { id: string }) => model.id)).toEqual([
        "cline-pass/deepseek-v4-flash",
        "cline-pass/minimax-m3",
        "deepseek/deepseek-chat",
      ]);

      const configured = JSON.parse(readFileSync(configPath, "utf8"));
      expect(configured.providers.cline.models).toEqual(payload.models.map((model: { id: string }) => model.id));
      expect(configured.providers.cline.defaultModel).toBe("cline-pass/minimax-m3");
      expect(configured.providers.cline.modelDisplayNames["cline-pass/minimax-m3"]).toBe("Cline · MiniMax M3");
      expect(configured.providers.cline.modelDisplayNames["deepseek/deepseek-chat"]).toBe("Cline · deepseek/deepseek-chat");

      const rotate = runCli(["cline", "setup", "--api-key-stdin", "--json"], home, "second-secret\n");
      expect(rotate.status).toBe(0);
      const rotated = JSON.parse(readFileSync(configPath, "utf8"));
      expect(rotated.providers.cline.apiKey).toBe("second-secret");
      expect(rotated.providers.cline.models).toEqual(configured.providers.cline.models);
      expect(rotated.providers.cline.defaultModel).toBe(configured.providers.cline.defaultModel);

      const status = runCli(["cline", "status", "--json"], home);
      expect(status.status).toBe(0);
      expect(JSON.parse(status.stdout).models).toHaveLength(3);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("all-model setup and model listing expose the 11-model ClinePass snapshot", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-cline-all-models-"));
    const configPath = join(home, "config.json");
    writeFileSync(configPath, `${JSON.stringify(baseConfig(), null, 2)}\n`, { mode: 0o600 });
    try {
      const before = runCli(["cline", "models", "--json"], home);
      expect(before.status).toBe(0);
      expect(JSON.parse(before.stdout).models).toHaveLength(11);

      const setup = runCli([
        "cline", "setup", "--api-key-stdin", "--all-clinepass-models", "--json",
      ], home, "secret\n");
      expect(setup.status).toBe(0);
      const configured = JSON.parse(readFileSync(configPath, "utf8"));
      expect(configured.providers.cline.models).toEqual(CLINEPASS_MODELS.map(model => model.id));
      expect(JSON.parse(setup.stdout).models.every((model: { selected: boolean }) => model.selected)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reset and default-only updates preserve the intended managed configuration", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-cline-reset-models-"));
    const configPath = join(home, "config.json");
    writeFileSync(configPath, `${JSON.stringify(baseConfig(), null, 2)}\n`, { mode: 0o600 });
    try {
      const setup = runCli([
        "cline", "setup", "--api-key-stdin", "--model", "cline-pass/minimax-m3",
      ], home, "secret\n");
      expect(setup.status).toBe(0);

      const reset = runCli([
        "cline", "setup", "--reset-models", "--default-model", "cline-pass/glm-5.2", "--json",
      ], home);
      expect(reset.status).toBe(0);
      const afterReset = JSON.parse(readFileSync(configPath, "utf8"));
      expect(afterReset.providers.cline.models).toEqual([
        "cline-pass/kimi-k3",
        "cline-pass/glm-5.2",
      ]);
      expect(afterReset.providers.cline.defaultModel).toBe("cline-pass/glm-5.2");

      afterReset.providers.cline.note = "preserve-this-managed-field";
      writeFileSync(configPath, `${JSON.stringify(afterReset, null, 2)}\n`, { mode: 0o600 });
      const statePath = join(home, "cline-codex-app-proxy-state.json");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state.installedProviderFingerprint = clineProviderFingerprint(afterReset.providers.cline);
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

      const defaultOnly = runCli([
        "cline", "setup", "--default-model", "cline-pass/kimi-k3", "--json",
      ], home);
      expect(defaultOnly.status).toBe(0);
      const afterDefaultOnly = JSON.parse(readFileSync(configPath, "utf8"));
      expect(afterDefaultOnly.providers.cline).toEqual({
        ...afterReset.providers.cline,
        defaultModel: "cline-pass/kimi-k3",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("conflicting model sources fail before changing config or state", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-cline-model-conflict-"));
    const configPath = join(home, "config.json");
    const original = `${JSON.stringify(baseConfig(), null, 2)}\n`;
    writeFileSync(configPath, original, { mode: 0o600 });
    try {
      const result = runCli([
        "cline", "setup", "--api-key-stdin", "--all-clinepass-models",
        "--model", "cline-pass/minimax-m3",
      ], home, "secret\n");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Choose only one model source");
      expect(readFileSync(configPath, "utf8")).toBe(original);

      const interactive = runCli([
        "cline", "setup", "--api-key-stdin", "--configure-models",
      ], home, "secret\n");
      expect(interactive.status).toBe(1);
      expect(interactive.stderr).toContain("cannot be combined");

      const swallowedFlag = runCli([
        "cline", "setup", "--api-key-stdin", "--model", "--reset-models",
      ], home, "secret\n");
      expect(swallowedFlag.status).toBe(1);
      expect(swallowedFlag.stderr).toContain("--model requires a value");
      expect(readFileSync(configPath, "utf8")).toBe(original);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("invalid JSON is rejected without overwriting the file", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-cline-invalid-"));
    const configPath = join(home, "config.json");
    const invalid = "{ definitely not json\n";
    writeFileSync(configPath, invalid, { mode: 0o600 });
    try {
      const result = runCli(["cline", "setup", "--api-key-stdin"], home, "secret\n");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("config is invalid");
      expect(readFileSync(configPath, "utf8")).toBe(invalid);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("POSIX API key files must be private", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-cline-key-file-"));
    const configPath = join(home, "config.json");
    const keyPath = join(home, "cline.key");
    writeFileSync(configPath, `${JSON.stringify(baseConfig())}\n`, { mode: 0o600 });
    writeFileSync(keyPath, "secret\n", { mode: 0o644 });
    chmodSync(keyPath, 0o644);
    try {
      const result = runCli(["cline", "setup", "--api-key-file", keyPath], home);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("chmod 600");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      expect(config.providers.cline).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("remove refuses an unowned or modified provider", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-cline-owned-"));
    const configPath = join(home, "config.json");
    writeFileSync(configPath, `${JSON.stringify(baseConfig())}\n`, { mode: 0o600 });
    try {
      const unowned = runCli(["cline", "remove"], home);
      expect(unowned.status).toBe(1);
      expect(unowned.stderr).toContain("No managed Cline setup state");

      expect(runCli(["cline", "setup", "--api-key-stdin"], home, "secret\n").status).toBe(0);
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      config.providers.cline.note = "user-owned edit";
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

      const modified = runCli(["cline", "remove"], home);
      expect(modified.status).toBe(1);
      expect(modified.stderr).toContain("changed after setup");
      expect(JSON.parse(readFileSync(configPath, "utf8")).providers.cline.note).toBe("user-owned edit");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
