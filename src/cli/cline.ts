import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  atomicWriteFile,
  getConfigDir,
  readConfigDiagnostics,
  saveConfig,
} from "../config";
import {
  CLINE_MODELS,
  CLINE_PROVIDER_ID,
  configureCline,
  isManagedClineProvider,
  removeCline,
  type ClineSetupState,
} from "../cline/config";
import type { OcxConfig, OcxProviderConfig } from "../types";

const STATE_FILE = "cline-codex-app-proxy-state.json";
const LOCK_FILE = "cline-codex-app-proxy.lock";
const USAGE = `Usage:
  ocx cline setup [--api-key-stdin | --api-key-file <path>] [--adopt-existing-cline] [--json]
  ocx cline status [--json]
  ocx cline remove [--json]`;

function statePath(): string {
  return join(getConfigDir(), STATE_FILE);
}

function lockPath(): string {
  return join(getConfigDir(), LOCK_FILE);
}

function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else if (process.platform !== "win32") chmodSync(dir, 0o700);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function withConfigLock<T>(operation: () => T | Promise<T>): Promise<T> {
  ensureConfigDir();
  const path = lockPath();
  let fd: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      writeFileSync(fd, `${process.pid}\n`, "utf8");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existingPid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
      if (Number.isInteger(existingPid) && existingPid > 0 && processIsAlive(existingPid)) {
        throw new Error(`Another Cline configuration command is running (PID ${existingPid}).`);
      }
      unlinkSync(path);
    }
  }
  if (fd === undefined) throw new Error("Could not acquire the Cline configuration lock.");

  try {
    return await operation();
  } finally {
    closeSync(fd);
    try { unlinkSync(path); } catch { /* stale cleanup is safe on the next invocation */ }
  }
}

function consumeFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function consumeFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  if (index + 1 >= args.length) throw new Error(`${flag} requires a value.`);
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function readHiddenSecret(prompt: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("No interactive TTY. Use --api-key-stdin or --api-key-file.");
  }

  process.stderr.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  let onData: (chunk: string | Buffer) => void = () => {};
  let onError: (error: Error) => void = () => {};
  let onEnd: () => void = () => {};
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value.trim());
      };
      onData = chunk => {
        for (const character of String(chunk)) {
          if (character === "\u0003") return finish(new Error("Cancelled."));
          if (character === "\r" || character === "\n") return finish();
          if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
          else value += character;
        }
      };
      onError = error => finish(error);
      onEnd = () => finish(new Error("Input ended before an API key was provided."));
      input.on("data", onData);
      input.once("error", onError);
      input.once("end", onEnd);
    });
  } finally {
    input.off("data", onData);
    input.off("error", onError);
    input.off("end", onEnd);
    input.setRawMode(false);
    input.pause();
    process.stderr.write("\n");
  }
}

function readKeyFile(path: string): string {
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
  const fd = openSync(path, flags);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("API key path must be a regular file.");
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error("API key file must not be accessible by group or other users (chmod 600).");
    }
    return readFileSync(fd, "utf8").trim();
  } finally {
    closeSync(fd);
  }
}

function saveState(state: ClineSetupState): void {
  ensureConfigDir();
  atomicWriteFile(statePath(), `${JSON.stringify(state, null, 2)}\n`);
}

function isProvider(value: unknown): value is OcxProviderConfig {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).adapter === "string"
    && typeof (value as Record<string, unknown>).baseUrl === "string";
}

function loadState(): ClineSetupState | undefined {
  if (!existsSync(statePath())) return undefined;
  const parsed = JSON.parse(readFileSync(statePath(), "utf8")) as Record<string, unknown>;
  const validPreviousProvider = parsed.previousProvider === null || isProvider(parsed.previousProvider);
  if (
    parsed.schemaVersion !== 1
    || typeof parsed.installedAt !== "string"
    || Number.isNaN(Date.parse(parsed.installedAt))
    || !validPreviousProvider
    || typeof parsed.installedProviderFingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(parsed.installedProviderFingerprint)
  ) {
    throw new Error("Cline setup state is invalid; refusing to change configuration.");
  }
  return parsed as unknown as ClineSetupState;
}

function readStrictConfig(): OcxConfig {
  const diagnostics = readConfigDiagnostics();
  if (diagnostics.source === "fallback" || diagnostics.error) {
    throw new Error(
      `OpenCodex config is invalid (${diagnostics.error ?? "unknown error"}); fix it before running this command.`,
    );
  }
  return diagnostics.config;
}

function statusPayload() {
  const config = readStrictConfig();
  const provider = config.providers[CLINE_PROVIDER_ID];
  return {
    configured: isManagedClineProvider(provider),
    baseUrl: provider?.baseUrl ?? null,
    credentialStored: typeof provider?.apiKey === "string" && provider.apiKey.trim().length > 0,
    models: CLINE_MODELS.map(model => ({
      id: model.id,
      slug: model.slug,
      displayName: provider?.modelDisplayNames?.[model.id] ?? null,
      selected: provider?.selectedModels?.includes(model.id) ?? false,
    })),
    stateFile: existsSync(statePath()),
  };
}

async function handleSetup(args: string[]): Promise<void> {
  const wantsJson = consumeFlag(args, "--json");
  const fromStdin = consumeFlag(args, "--api-key-stdin");
  const keyFile = consumeFlagValue(args, "--api-key-file");
  const adoptExisting = consumeFlag(args, "--adopt-existing-cline");
  if (args.length > 0) throw new Error(`Unknown argument(s): ${args.join(" ")}\n${USAGE}`);
  if (fromStdin && keyFile) throw new Error("Choose only one API key input method.");

  const payload = await withConfigLock(async () => {
    const current = readStrictConfig();
    const existingState = loadState();
    const existingKey = (existingState || adoptExisting) && isManagedClineProvider(current.providers[CLINE_PROVIDER_ID])
      ? current.providers[CLINE_PROVIDER_ID]?.apiKey?.trim()
      : undefined;
    const apiKey = fromStdin
      ? await readAllStdin()
      : keyFile
        ? readKeyFile(keyFile)
        : existingKey || await readHiddenSecret("Cline API key: ");

    const result = configureCline(current, apiKey, { adoptExisting, existingState });
    const previousState = existsSync(statePath()) ? readFileSync(statePath(), "utf8") : null;
    saveState(result.state);
    try {
      saveConfig(result.config);
    } catch (error) {
      if (previousState === null) {
        try { unlinkSync(statePath()); } catch { /* preserve the original write failure */ }
      } else {
        try { atomicWriteFile(statePath(), previousState); } catch { /* preserve the original write failure */ }
      }
      throw error;
    }
    return statusPayload();
  });

  if (wantsJson) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log("Cline provider configured without changing other providers or global preferences.");
    console.log(`Models: ${CLINE_MODELS.map(model => model.displayName).join(", ")}`);
    console.log("Next: run `ocx service install`, then fully quit (Command-Q) and reopen Codex App.");
  }
}

function handleStatus(args: string[]): void {
  const wantsJson = consumeFlag(args, "--json");
  if (args.length > 0) throw new Error(`Unknown argument(s): ${args.join(" ")}\n${USAGE}`);
  const payload = statusPayload();
  if (wantsJson) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(payload.configured ? "Cline provider is configured." : "Cline provider is not configured.");
    console.log(`Base URL: ${payload.baseUrl ?? "not set"}`);
    console.log(`Credential stored: ${payload.credentialStored ? "yes" : "no"}`);
    console.log(`Managed setup state: ${payload.stateFile ? "yes" : "no"}`);
    for (const model of payload.models) {
      console.log(`- ${model.displayName ?? model.id} (${model.slug})`);
    }
  }
}

async function handleRemove(args: string[]): Promise<void> {
  const wantsJson = consumeFlag(args, "--json");
  if (args.length > 0) throw new Error(`Unknown argument(s): ${args.join(" ")}\n${USAGE}`);
  const payload = await withConfigLock(() => {
    const config = readStrictConfig();
    const state = loadState();
    if (!state) throw new Error("No managed Cline setup state exists; refusing to remove an unowned provider.");
    saveConfig(removeCline(config, state));
    unlinkSync(statePath());
    return { removed: true, restoredPreviousProvider: !!state.previousProvider };
  });
  if (wantsJson) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log("Managed Cline provider removed; all unrelated configuration was preserved.");
    console.log("Next: run `ocx sync`, then fully quit (Command-Q) and reopen Codex App.");
  }
}

export async function handleClineCommand(args: string[]): Promise<void> {
  const command = args[0];
  switch (command) {
    case "setup":
      await handleSetup(args.slice(1));
      return;
    case "status":
      handleStatus(args.slice(1));
      return;
    case "remove":
      await handleRemove(args.slice(1));
      return;
    default:
      throw new Error(USAGE);
  }
}
