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
import { createInterface } from "node:readline/promises";
import {
  atomicWriteFile,
  getConfigDir,
  readConfigDiagnostics,
  saveConfig,
} from "../config";
import {
  CLINEPASS_CATALOG_UPDATED_AT,
  CLINEPASS_MODELS,
  CLINE_MODELS,
  CLINE_PROVIDER_ID,
  configureCline,
  isManagedClineProvider,
  normalizeClineModelIds,
  removeCline,
  type ClineSetupState,
} from "../cline/config";
import { routedSlug } from "../providers/slug-codec";
import type { OcxConfig, OcxProviderConfig } from "../types";

const STATE_FILE = "cline-codex-app-proxy-state.json";
const LOCK_FILE = "cline-codex-app-proxy.lock";
const USAGE = `Usage:
  ocx cline setup [--api-key-stdin | --api-key-file <path>] [model options] [--adopt-existing-cline] [--json]
  ocx cline status [--json]
  ocx cline models [--json]
  ocx cline remove [--json]`;

const MODEL_OPTIONS_HELP = `Model options (choose at most one source):
  --configure-models         Interactive ClinePass model picker
  --model <provider/model>   Configure one model; repeat or use comma-separated IDs
  --all-clinepass-models     Configure every model in the bundled ClinePass snapshot
  --reset-models             Restore the Kimi K3 + GLM 5.2 defaults
  --default-model <id>       Set the provider fallback; must be in the configured list`;

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
  if (value.startsWith("-")) throw new Error(`${flag} requires a value.`);
  args.splice(index, 2);
  return value;
}

function consumeFlagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (;;) {
    const index = args.indexOf(flag);
    if (index === -1) return values;
    if (index + 1 >= args.length) throw new Error(`${flag} requires a value.`);
    const value = args[index + 1];
    if (value.startsWith("-")) throw new Error(`${flag} requires a value.`);
    values.push(value);
    args.splice(index, 2);
  }
}

function configuredModelIds(provider: OcxProviderConfig | undefined): string[] {
  const ids = provider?.models?.length
    ? provider.models
    : provider?.selectedModels?.length
      ? provider.selectedModels
      : CLINE_MODELS.map(model => model.id);
  return [...ids];
}

function interactiveCandidates(currentIds: readonly string[]) {
  const known = new Set(CLINEPASS_MODELS.map(model => model.id));
  return [
    ...CLINEPASS_MODELS.map(model => ({ id: model.id, displayName: model.displayName })),
    ...currentIds
      .filter(id => !known.has(id))
      .map(id => ({ id, displayName: `Cline · ${id}` })),
  ];
}

export function parseInteractiveModelSelection(
  answer: string,
  currentIds: readonly string[],
): string[] | undefined {
  const trimmed = answer.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() === "all") {
    return normalizeClineModelIds(CLINEPASS_MODELS.map(model => model.id));
  }
  if (trimmed.toLowerCase() === "default") {
    return normalizeClineModelIds(CLINE_MODELS.map(model => model.id));
  }

  const candidates = interactiveCandidates(currentIds);
  const ids = trimmed
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(token => {
      if (!/^\d+$/.test(token)) return token;
      const index = Number.parseInt(token, 10) - 1;
      const candidate = candidates[index];
      if (!candidate) throw new Error(`Unknown Cline model number: ${token}.`);
      return candidate.id;
    });
  return normalizeClineModelIds([...new Set(ids)]);
}

async function readInteractiveModelSelection(currentIds: readonly string[]): Promise<string[] | undefined> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error("--configure-models requires an interactive TTY. Use --model for automation.");
  }
  const selected = new Set(currentIds);
  const candidates = interactiveCandidates(currentIds);
  process.stderr.write(`\nClinePass models (official snapshot ${CLINEPASS_CATALOG_UPDATED_AT}):\n`);
  candidates.forEach((model, index) => {
    process.stderr.write(`  ${index + 1}. ${model.displayName} (${model.id})${selected.has(model.id) ? " [selected]" : ""}\n`);
  });
  process.stderr.write("You may also enter any Cline API provider/model ID. Unknown models use conservative text-only metadata.\n");
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await readline.question(
      'Models (numbers or IDs, comma-separated; "all"; "default"; Enter keeps selected): ',
    );
    return parseInteractiveModelSelection(answer, currentIds);
  } finally {
    readline.close();
  }
}

function readAllStdin(): string {
  // `spawnSync(..., { input })` can present an already-buffered, EOF-terminated fd 0
  // that Bun's async stdin iterator misses on Linux. This option is explicitly a
  // one-shot pipe, so a synchronous read is both portable and the intended contract.
  return readFileSync(0, "utf8").trim();
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
  const ids = configuredModelIds(provider);
  return {
    configured: isManagedClineProvider(provider),
    baseUrl: provider?.baseUrl ?? null,
    credentialStored: typeof provider?.apiKey === "string" && provider.apiKey.trim().length > 0,
    defaultModel: provider?.defaultModel ?? null,
    catalogUpdatedAt: CLINEPASS_CATALOG_UPDATED_AT,
    models: ids.map(id => ({
      id,
      slug: routedSlug(CLINE_PROVIDER_ID, id),
      displayName: provider?.modelDisplayNames?.[id] ?? `Cline · ${id}`,
      selected: provider?.selectedModels?.includes(id) ?? false,
      officialClinePass: CLINEPASS_MODELS.some(model => model.id === id),
    })),
    stateFile: existsSync(statePath()),
  };
}

async function handleSetup(args: string[]): Promise<void> {
  const wantsJson = consumeFlag(args, "--json");
  const fromStdin = consumeFlag(args, "--api-key-stdin");
  const keyFile = consumeFlagValue(args, "--api-key-file");
  const adoptExisting = consumeFlag(args, "--adopt-existing-cline");
  const configureModels = consumeFlag(args, "--configure-models");
  const allClinePassModels = consumeFlag(args, "--all-clinepass-models");
  const resetModels = consumeFlag(args, "--reset-models");
  const modelValues = consumeFlagValues(args, "--model");
  const requestedDefaultModel = consumeFlagValue(args, "--default-model");
  if (args.length > 0) throw new Error(`Unknown argument(s): ${args.join(" ")}\n${USAGE}\n${MODEL_OPTIONS_HELP}`);
  if (fromStdin && keyFile) throw new Error("Choose only one API key input method.");
  const modelSourceCount = Number(configureModels)
    + Number(allClinePassModels)
    + Number(resetModels)
    + Number(modelValues.length > 0);
  if (modelSourceCount > 1) throw new Error(`Choose only one model source.\n${MODEL_OPTIONS_HELP}`);
  if (configureModels && (fromStdin || wantsJson)) {
    throw new Error("--configure-models cannot be combined with --api-key-stdin or --json. Use --model for automation.");
  }

  const payload = await withConfigLock(async () => {
    const current = readStrictConfig();
    const existingState = loadState();
    const currentProvider = current.providers[CLINE_PROVIDER_ID];
    const existingKey = (existingState || adoptExisting) && isManagedClineProvider(currentProvider)
      ? currentProvider?.apiKey?.trim()
      : undefined;
    const apiKey = fromStdin
      ? await readAllStdin()
      : keyFile
        ? readKeyFile(keyFile)
        : existingKey || await readHiddenSecret("Cline API key: ");

    const currentIds = existingState && isManagedClineProvider(currentProvider)
      ? configuredModelIds(currentProvider)
      : CLINE_MODELS.map(model => model.id);
    let modelIds: string[] | undefined;
    if (configureModels) modelIds = await readInteractiveModelSelection(currentIds);
    else if (allClinePassModels) modelIds = CLINEPASS_MODELS.map(model => model.id);
    else if (resetModels) modelIds = CLINE_MODELS.map(model => model.id);
    else if (modelValues.length > 0) {
      modelIds = normalizeClineModelIds(
        modelValues.flatMap(value => value.split(",").map(id => id.trim())),
      );
    }
    const result = configureCline(current, apiKey, {
      adoptExisting,
      existingState,
      modelIds,
      defaultModel: requestedDefaultModel,
    });
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
    console.log(`Models: ${payload.models.filter(model => model.selected).map(model => model.displayName).join(", ")}`);
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
      console.log(`- ${model.displayName} (${model.slug})${model.id === payload.defaultModel ? " [default]" : ""}`);
    }
  }
}

function handleModels(args: string[]): void {
  const wantsJson = consumeFlag(args, "--json");
  if (args.length > 0) throw new Error(`Unknown argument(s): ${args.join(" ")}\n${USAGE}`);
  const config = readStrictConfig();
  const provider = config.providers[CLINE_PROVIDER_ID];
  const selected = new Set(provider?.selectedModels ?? []);
  const officialIds = new Set(CLINEPASS_MODELS.map(model => model.id));
  const rows = [
    ...CLINEPASS_MODELS.map(model => ({
      id: model.id,
      slug: model.slug,
      displayName: model.displayName,
      selected: selected.has(model.id),
      officialClinePass: true,
    })),
    ...configuredModelIds(provider)
      .filter(id => !officialIds.has(id))
      .map(id => ({
        id,
        slug: routedSlug(CLINE_PROVIDER_ID, id),
        displayName: provider?.modelDisplayNames?.[id] ?? `Cline · ${id}`,
        selected: selected.has(id),
        officialClinePass: false,
      })),
  ];
  if (wantsJson) {
    console.log(JSON.stringify({ catalogUpdatedAt: CLINEPASS_CATALOG_UPDATED_AT, models: rows }, null, 2));
    return;
  }
  console.log(`Official ClinePass snapshot (${CLINEPASS_CATALOG_UPDATED_AT}):`);
  for (const model of rows) {
    console.log(`- ${model.displayName} (${model.id})${model.selected ? " [selected]" : ""}${model.officialClinePass ? "" : " [custom]"}`);
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
    case "models":
      handleModels(args.slice(1));
      return;
    case "remove":
      await handleRemove(args.slice(1));
      return;
    default:
      throw new Error(USAGE);
  }
}
