import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      expect(statSync(statePath).mode & 0o777).toBe(0o600);

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

  test("API key files must be private", () => {
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
