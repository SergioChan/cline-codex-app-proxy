#!/usr/bin/env node
/**
 * opencodex npm bin launcher.
 *
 * The package source is TypeScript that runs on the Bun runtime. To let
 * global tarball installs work without a separately-installed Bun,
 * we bundle the runtime via the `bun` npm dependency and exec it from this
 * Node shim. (Dev still runs `bun run src/cli/index.ts` directly via the shebang on
 * src/cli/index.ts — only the published npm `bin` routes through here.)
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "src", "cli", "index.ts");

function bunBinDir() {
  // Resolve the `bun` dependency's directory without hardcoding the platform
  // package — npm's os/cpu/libc resolution already picked the right @oven/bun-*.
  return dirname(require.resolve("bun/package.json"));
}

// The `bun` package ships a tiny ASCII placeholder at bin/bun.exe until its
// postinstall downloads the real ~60MB binary. --ignore-scripts / pnpm leave
// the ~450-byte stub in place, which is NOT executable (ENOEXEC). A size gate
// cleanly distinguishes the stub from a real binary on every platform.
const REAL_BUN_MIN_BYTES = 1_000_000;

function findBunBinary(bunDir) {
  // The npm `bun` package ships the binary as bin/bun.exe on every platform;
  // probe bin/bun too for forward compatibility.
  for (const name of ["bun.exe", "bun"]) {
    const p = join(bunDir, "bin", name);
    if (existsSync(p) && statSync(p).size >= REAL_BUN_MIN_BYTES) return p;
  }
  return null;
}

function fail(msg) {
  console.error(
    `opencodex: ${msg}\n` +
      "The bundled Bun runtime could not be prepared. This usually means the\n" +
      "install skipped lifecycle scripts (e.g. npm blocked bun's postinstall\n" +
      "under allowScripts) or optional dependencies. Reinstall with:\n" +
      "  npm install -g --allow-scripts=bun .\n" +
      "(use sudo if the original install used sudo; without --ignore-scripts\n" +
      "and without --omit=optional / optional=false)"
  );
  process.exit(1);
}

function resolveBun() {
  let bunDir;
  try {
    bunDir = bunBinDir();
  } catch {
    fail("the `bun` dependency is not installed.");
  }

  let bin = findBunBinary(bunDir);
  if (bin) return bin;

  // Lazy fallback: --ignore-scripts (or a failed postinstall) leaves the
  // ~450-byte placeholder stub. Run the bun package's own installer once.
  const installJs = join(bunDir, "install.js");
  if (existsSync(installJs)) {
    const r = spawnSync(process.execPath, [installJs], { stdio: "inherit" });
    if (r.status === 0) bin = findBunBinary(bunDir);
  }
  if (!bin) fail("Bun binary missing after install attempt.");
  return bin;
}

// `ocx update --help` prints usage and exits WITHOUT side effects. The npm launcher
// intercepts `update` before the Bun CLI starts, so the help short-circuit must live
// here too — otherwise --help runs the real self-update, stops the proxy, and drops
// in-flight routed streams (issue #168).
const updateHelpRequested = process.argv[2] === "update" &&
  process.argv.slice(3).some(a => a === "--help" || a === "-h" || a === "help");
if (updateHelpRequested) {
  console.log("Usage: ocx update\n\nThis source-distributed fork is updated with git pull, npm install, npm run build:gui, and npm run install:global.");
  process.exit(0);
}

if (process.argv[2] === "update") {
  console.log("This fork is not published to npm. Update from its Git checkout:\n  git pull\n  npm install\n  npm run build:gui\n  npm run install:global");
  process.exit(0);
}

const bun = resolveBun();

// Run the Bun child asynchronously and FORWARD termination signals to it, then wait
// for its graceful shutdown before this launcher exits. The previous blocking
// spawnSync() could not run JS signal handlers and did not forward signals, so a
// signal delivered only to this launcher (Codex app, IDE terminal, service wrapper,
// or `kill -INT <launcherPid>`) killed the launcher and ORPHANED the Bun proxy —
// port left bound, pid/runtime-port files left behind, Codex config not restored.
const child = spawn(bun, [cliPath, ...process.argv.slice(2)], { stdio: "inherit" });

// Windows has no real POSIX signals (no SIGHUP); forwarding is best-effort there.
const FORWARDED = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
const handlers = FORWARDED.map(sig => {
  const handler = () => {
    try {
      child.kill(sig);
    } catch {
      /* child already exited */
    }
  };
  process.on(sig, handler);
  return [sig, handler];
});
const clearHandlers = () => {
  for (const [sig, handler] of handlers) process.removeListener(sig, handler);
};

child.on("error", err => {
  clearHandlers();
  console.error(`opencodex: failed to launch Bun runtime: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  clearHandlers();
  // Mirror the child's terminating signal/exit code so this launcher's status matches.
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
