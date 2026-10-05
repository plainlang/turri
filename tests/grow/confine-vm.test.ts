import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAllVms, runInVm, vmSupported } from "../../src/grow/vm.ts";

let root: string;
let code: string;
let tests: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turri-confine-"));
  code = join(root, "plain_modules", "demo", "code");
  tests = join(root, "plain_modules", "demo", "tests", "1");
  outside = join(root, "src");
  for (const dir of [code, tests, outside]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(outside, "secret.ts"), "const secret = 1;\n");
  writeFileSync(join(code, "app.py"), "print('hi')\n");
});

afterEach(async () => {
  // Each test is a project of its own, and so has a VM of its own.
  await closeAllVms();
  rmSync(root, { recursive: true, force: true });
});

// Each project gets one VM; the first ever also fetches the image.
const VM_TIMEOUT = 120_000;

describe.runIf(vmSupported())("the project's VM", { timeout: VM_TIMEOUT }, () => {
  const sh = (command: string, cwd = code) => runInVm(command, { cwd });

  it("lets the agent write its own folder - the code's shell has the code only, the tests' shell the tests and the code read only", async () => {
    const result = await sh(`echo built > out.txt && cat out.txt; ls ${tests} 2>&1 || true`);
    expect(result.output).toContain("built");
    expect(result.output).toContain("No such file or directory");
    expect(existsSync(join(code, "out.txt"))).toBe(true);

    // The tests' shell writes the tests, and reads and runs the code - but never changes it.
    const inTests = await sh(`echo t > t.txt && cat t.txt; python3 ${code}/app.py; echo x > ${code}/hack.txt 2>&1 || echo refused`, tests);
    expect(inTests.output).toContain("t\n");
    expect(inTests.output).toContain("hi");
    expect(inTests.output).toContain("refused");
    expect(existsSync(join(tests, "t.txt"))).toBe(true);
    expect(existsSync(join(code, "hack.txt"))).toBe(false);
  });

  it("does not hold the project above plain_modules at all", async () => {
    writeFileSync(join(root, "app.plain"), "***functional specs***\n");
    const result = await sh(`cat ../../../src/secret.ts ${join(outside, "secret.ts")} ${join(root, "app.plain")} 2>/dev/null; echo ---; ls -A ${root}`);
    expect(result.output).not.toContain("const secret");
    expect(result.output).not.toContain("functional specs");
    // Only the path down to plain_modules exists.
    expect(result.output.split("---\n")[1]).toBe("plain_modules\n");
  });

  it("does not hold the home directory, other projects, or the host's environment", async () => {
    const home = homedir();
    const result = await sh(`ls -A ${home} 2>&1; echo ---; env`);
    const [listing, env] = result.output.split("---\n");
    expect(listing).toMatch(/No such file or directory/);
    expect(env).not.toMatch(/API_KEY|ANTHROPIC|OPENAI/);
  });

  it("stops a write above plain_modules", async () => {
    const result = await sh(`echo bad > ${join(outside, "written.txt")}`);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(outside, "written.txt"))).toBe(false);
  });

  it("runs what is built there - binaries and scripts alike", async () => {
    writeFileSync(join(code, "run.sh"), "#!/bin/sh\necho script-ok\n");
    const result = await sh("chmod +x run.sh && ./run.sh");
    expect(result.output).toContain("script-ok");
  });

});
