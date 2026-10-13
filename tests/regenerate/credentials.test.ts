import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialFiles, isCredentialFile, restoreCredentialFiles } from "../../src/regenerate/credentials.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-credentials-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("credential files", () => {
  it("are a .env and its variants, never a template of one", () => {
    expect([".env", ".env.local", ".env.test"].map(isCredentialFile)).toEqual([true, true, true]);
    expect([".env.example", ".env.sample", ".env.template", "env.py", ".envrc"].map(isCredentialFile)).toEqual([false, false, false, false, false]);
  });

  it("are put back as they were after a command: one it made is removed, one it changed or removed restored", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, ".env"), "HUBSPOT_ACCESS_TOKEN=the-persons\n");
    writeFileSync(join(dir, "src", ".env.local"), "A=1\n");
    const before = credentialFiles([dir]);
    // What a command did: a dummy over the person's, one removed, one made - and one in node_modules, which is not looked at.
    writeFileSync(join(dir, ".env"), "HUBSPOT_ACCESS_TOKEN=dummy-token-for-offline-mapping-tests\n");
    rmSync(join(dir, "src", ".env.local"));
    writeFileSync(join(dir, "src", ".env.test"), "B=2\n");
    writeFileSync(join(dir, "node_modules", "pkg", ".env"), "C=3\n");
    writeFileSync(join(dir, ".env.example"), "HUBSPOT_ACCESS_TOKEN=\n");

    expect(restoreCredentialFiles(before, [dir]).sort()).toEqual([join(dir, ".env"), join(dir, "src", ".env.local"), join(dir, "src", ".env.test")].sort());
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("HUBSPOT_ACCESS_TOKEN=the-persons\n");
    expect(readFileSync(join(dir, "src", ".env.local"), "utf8")).toBe("A=1\n");
    expect(existsSync(join(dir, "src", ".env.test"))).toBe(false);
    expect(existsSync(join(dir, ".env.example"))).toBe(true);
    // Nothing done: nothing put back.
    expect(restoreCredentialFiles(credentialFiles([dir]), [dir])).toEqual([]);
  });
});
