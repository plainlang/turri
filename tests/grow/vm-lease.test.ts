import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeAllVms, runInVm, runningVms, setVmIdleForTests, vmSupported, withVmLease } from "../../src/grow/vm.ts";

const roots: string[] = [];
/** A project of its own, in a folder of its own, with a module `a` and a module `b`, each with its code and tests. */
function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "turri-vm-lease-")));
  roots.push(root);
  const modules = join(root, "plain_modules");
  const scratch = join(modules, ".turri", "staging");
  for (const dir of ["a/code", "a/tests", "b/code", "b/tests", ".turri/staging"]) mkdirSync(join(modules, dir), { recursive: true });
  const at = (module: string, part: string) => join(modules, module, part);
  return { aCode: at("a", "code"), aTests: at("a", "tests"), bCode: at("b", "code"), bTests: at("b", "tests"), scratch };
}

const run = async (command: string, cwd: string, extra: { for?: string } = {}) => (await runInVm(command, { cwd, ...extra })).output.trim();

afterEach(async () => {
  setVmIdleForTests(undefined);
  await closeAllVms();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.runIf(vmSupported())("a module's VMs", { timeout: 180_000 }, () => {
  it("are two - its code's and its tests' - each holding its own folder, reused by its jobs, and shut down once the project moves on", async () => {
    const p = project();
    // Two jobs in module a's code, one after the other: the second finds what the first left in the VM.
    await withVmLease(() => run("echo hello > /tmp/mark", p.aCode));
    expect(runningVms()).toEqual([p.aCode]);
    expect(await withVmLease(() => run("cat /tmp/mark", p.aCode))).toBe("hello");

    // The code's VM holds the code and nothing of the tests, or of the other modules.
    expect(await withVmLease(() => run(`ls ${p.aTests} 2>&1 || true`, p.aCode))).toContain("No such file or directory");
    expect(await withVmLease(() => run(`ls ${p.bCode} 2>&1 || true`, p.aCode))).toContain("No such file or directory");

    // The tests have a VM of their own, holding the tests and nothing of the code - and a job in
    // the module keeps both.
    await withVmLease(async () => {
      // The tests' VM holds the code too, read only: it can be run, never changed.
      expect(await run(`touch ${p.aCode}/x 2>&1 || echo refused`, p.aTests)).toContain("refused");
      await run("true", p.aCode);
      expect(runningVms().sort()).toEqual([p.aCode, p.aTests].sort());
    });

    // The next module: a's VMs go, b's come.
    await withVmLease(() => run("true", p.bCode));
    expect(runningVms()).toEqual([p.bCode]);

    // A test run staged in the scratch runs in the VM of the folder it is for: the conformance
    // suite in the tests' VM, the unit tests in the code's.
    expect(await withVmLease(() => run(`ls ${p.bTests} > /dev/null && echo seen`, p.scratch, { for: p.bTests }))).toBe("seen");
    expect(runningVms().sort()).toEqual([p.bCode, p.bTests].sort());
  });

  it("move on within a job too: a chain of modules has one module's VMs at a time", async () => {
    const p = project();
    await withVmLease(async () => {
      await run("true", p.aCode);
      await run("true", p.aTests);
      expect(runningVms().sort()).toEqual([p.aCode, p.aTests].sort());
      await run("true", p.bCode);
      expect(runningVms()).toEqual([p.bCode]);
    });
  });

  it("stay up for two modules rendering at once, and for each of several projects", async () => {
    const p = project();
    const q = project();
    let finishA!: () => void;
    const aHolds = new Promise<void>((resolve) => (finishA = resolve));
    const jobA = withVmLease(async () => {
      await run("true", p.aCode);
      await aHolds;
      await run("true", p.aCode);
    });
    await withVmLease(async () => {
      await run("true", p.bCode);
      await run("true", q.aCode);
      expect(runningVms().sort()).toEqual([p.aCode, p.bCode, q.aCode].sort());
    });
    finishA();
    await jobA;
  });

  it("is shut down when it has been idle long enough", async () => {
    const p = project();
    setVmIdleForTests(0);
    await withVmLease(() => run("true", p.aCode));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(runningVms()).toEqual([]);
  });
});
