import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confinedTools } from "../../src/grow/confine.ts";
import { withActivity } from "../../src/grow/activity.ts";

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

  it("stops a command that runs past its time limit - in the VM too - and says what to do instead", async () => {
    // A server it put in the background, and the command in the foreground that never ends.
    const result = await runInVm("sleep 301 > /dev/null 2>&1 & sleep 300", { cwd: code, timeoutMs: 2000 });
    expect(result.exitCode).toBe(124);
    expect(result.output).toContain("stopped after 2s, the time limit");
    expect(result.output).toContain("in the background");
    // Gone from the VM, not only given up on - and what it started with it.
    expect((await sh("ps -o stat,args | grep -v ' Z ' | grep -c 'sleep 30[01]$' || true")).output.trim()).toBe("0");
  });

  it("ends a command at once when its job is stopped - the agent's, a test run, the harness's", async () => {
    const stop = new AbortController();
    const quiet = { stage() {}, activity() {}, now() {}, usage() {}, transcript() {}, signal: stop.signal };
    const started = Date.now();
    const run = withActivity(quiet, () => runInVm("sleep 300", { cwd: code }));
    setTimeout(() => stop.abort(), 1500);
    await expect(run).rejects.toThrow("aborted");
    // Well short of the command's 300s: at once, even with the other test files' VMs taking the machine (alone, 2-3s).
    expect(Date.now() - started).toBeLessThan(30_000);
    expect((await sh("ps -o stat,args | grep -v ' Z ' | grep -c 'sleep 300$' || true")).output.trim()).toBe("0");
  });

  it("runs several commands at once", async () => {
    const results = await Promise.all([1, 2, 3].map((n) => sh(`sleep 1; echo ${n}`)));
    expect(results.map((r) => r.output.trim())).toEqual(["1", "2", "3"]);
  });
});
