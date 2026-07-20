import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const updateSource = readFileSync(join(import.meta.dir, "..", "src", "update", "index.ts"), "utf8");
const launcherSource = readFileSync(join(import.meta.dir, "..", "bin", "ocx.mjs"), "utf8");
const serverSource = readFileSync(join(import.meta.dir, "..", "src", "server", "index.ts"), "utf8");
const cliSource = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf8");

describe("registry update safety path", () => {
  test("bun/source update path gates on the pid file and spawns 'stop' before the package manager", () => {
    expect(updateSource).toContain('spawnSync(process.execPath, [process.argv[1], "stop"]');
    const stopAt = updateSource.indexOf('[process.argv[1], "stop"]');
    const updateAt = updateSource.indexOf("const { bin, args: cmdArgs } = updateCommand(installer, tag, latest);");
    expect(stopAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(updateAt);
    expect(updateSource).toContain("if (serviceWasInstalled || readPid() || readRuntimePort())");
  });

  test("integrity pre-flight runs BEFORE the stop so anomalous metadata never unloads the proxy", () => {
    const gateAt = updateSource.indexOf("const integrity = checkUpdatePackageIntegrity(latest);");
    const abortAt = updateSource.indexOf("aborting the update before stopping the proxy");
    const stopAt = updateSource.indexOf('[process.argv[1], "stop"]');
    expect(gateAt).toBeGreaterThan(-1);
    expect(abortAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(stopAt);
    expect(abortAt).toBeLessThan(stopAt);
  });

  test("the dormant registry path aborts when stop fails and reinstalls a managed service after success", () => {
    expect(updateSource).toContain("aborting the update");
    expect(updateSource).toContain("serviceReinstallArgs()");
  });

  test("the dormant registry path surfaces a skipped history restore after the stop", () => {
    // A codex-history-backup-*.json surviving `ocx stop` means the native-history restore
    // was skipped (locked state DB) — users must be told or their threads silently stay
    // hidden in the Codex app.
    expect(updateSource).toContain("export function historyRestoreIncomplete(");
    expect(updateSource).toContain('name.startsWith("codex-history-backup-") && name.endsWith(".json")');
    expect(updateSource).toContain("if (historyRestoreIncomplete())");
  });

  test("the dormant registry path covers service-managed and orphaned proxies whose pid file is stale/missing", () => {
    expect(updateSource).toContain("if (serviceWasInstalled || readPid() || readRuntimePort())");
  });

  test("GUI worker update children use pipe stdio so Windows npm.cmd does not open consoles", () => {
    expect(updateSource).toContain("function updateChildStdio()");
    expect(updateSource).toContain('process.env.OCX_SERVICE === "1"');
    expect(updateSource).toContain('return "pipe"');
    // All three update children (stop, installer, service reinstall) go through it.
    expect(updateSource).toContain("stdio: stopStdio");
    expect(updateSource).toContain("stdio: installStdio");
    expect(updateSource).toContain("stdio: svcStdio");
    expect(updateSource).toContain("windowsHide: true");
  });
});

describe("ocx update --help has no side effects (#168)", () => {
  test("the Bun CLI short-circuits help before importing the update runner", () => {
    const caseAt = cliSource.indexOf('case "update"');
    const helpAt = cliSource.indexOf('printSubcommandUsage("update")');
    const runAt = cliSource.indexOf("await runUpdate()");
    expect(caseAt).toBeGreaterThan(-1);
    expect(helpAt).toBeGreaterThan(caseAt);
    expect(helpAt).toBeLessThan(runAt);
  });

  test("the npm launcher intercepts update --help before the source-update notice", () => {
    const helpAt = launcherSource.indexOf("updateHelpRequested");
    const updateAt = launcherSource.indexOf('if (process.argv[2] === "update")');
    const bunAt = launcherSource.indexOf("const bun = resolveBun();");
    expect(helpAt).toBeGreaterThan(-1);
    expect(launcherSource).toContain('process.argv[2] === "update" &&');
    expect(updateAt).toBeGreaterThan(helpAt);
    expect(updateAt).toBeLessThan(bunAt);
    expect(launcherSource).toContain("This fork is not published to npm");
  });
});

describe("/healthz identity fields", () => {
  test("healthz advertises service identity, pid, and port", () => {
    expect(serverSource).toContain('service: "opencodex"');
    expect(serverSource).toContain("pid: process.pid");
    expect(serverSource).toContain("port: listenPort");
  });
});
