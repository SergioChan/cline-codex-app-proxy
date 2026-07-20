#!/usr/bin/env node
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const packDir = mkdtempSync(join(tmpdir(), "cline-codex-app-proxy-"));

class InstallError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  return spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
}

try {
  const packed = runNpm(["pack", "--silent", "--pack-destination", packDir]);
  if (packed.status !== 0) {
    throw new InstallError(
      (packed.stderr || packed.stdout || "npm pack failed.").trim(),
      packed.status ?? 1,
    );
  }

  const tarballName = packed.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .findLast(line => line.endsWith(".tgz"));
  if (!tarballName) throw new Error("npm pack did not report a tarball name.");

  const tarball = join(packDir, basename(tarballName));
  if (!existsSync(tarball)) throw new Error(`Packed tarball is missing: ${tarball}`);

  const installed = runNpm(["install", "-g", tarball], { stdio: "inherit", encoding: undefined });
  if (installed.status !== 0) throw new InstallError("npm global install failed.", installed.status ?? 1);
  console.log("Installed cline-codex-app-proxy as a durable global package.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof InstallError ? error.exitCode : 1;
} finally {
  rmSync(packDir, { recursive: true, force: true });
}
