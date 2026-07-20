import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** bin/ocx.mjs executes top-level logic on import, so guard it at the source level. */
const source = readFileSync(join(import.meta.dir, "..", "bin", "ocx.mjs"), "utf8");

describe("ocx.mjs source-distributed launcher", () => {
  test("update exits with source instructions before resolving or launching Bun", () => {
    const updateAt = source.indexOf('if (process.argv[2] === "update")');
    const resolveAt = source.indexOf("const bun = resolveBun();");
    expect(updateAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(updateAt);
    expect(source).toContain("git pull");
    expect(source).toContain("npm run install:global");
  });

  test("contains no npm registry self-update path", () => {
    expect(source).not.toContain("runNpmSelfUpdate");
    expect(source).not.toContain("npm view");
    expect(source).not.toContain("serviceReinstallArgs");
  });
});
