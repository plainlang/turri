import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeAllVms, runInVm, runningVms, setVmIdleForTests, vmSupported, withVmLease } from "../../src/render/vm.ts";

const roots: string[] = [];
/** A project of its own, in a folder of its own, with a module `a` and a module `b`. */
function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-vm-lease-")));
  roots.push(root);
  const modules = join(root, "plain_modules");
  const scratch = join(modules, ".plainwright", "staging");
  for (const dir of ["a/code", "b/code", ".plainwright/staging"]) mkdirSync(join(modules, dir), { recursive: true });
  return { a: join(modules, "a"), b: join(modules, "b"), aCode: join(modules, "a", "code"), bCode: join(modules, "b", "code"), scratch };
}

const run = async (command: string, cwd: string, extra: { for?: string } = {}) => (await runInVm(command, { cwd, ...extra })).output.trim();

afterEach(async () => {
  setVmIdleForTests(undefined);
  await closeAllVms();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.runIf(vmSupported())("a module's VM", { timeout: 120_000 }, () => {
  it("is reused by the module's jobs one after another, and shut down once the project moves on", async () => {
    const p = project();
    // Two jobs of module a, one after the other: the second finds what the first left in the VM.
    await withVmLease(() => run("echo hello > /tmp/mark", p.aCode));
    expect(runningVms()).toEqual([p.a]);
    expect(await withVmLease(() => run("cat /tmp/mark", p.aCode))).toBe("hello");

    // It holds its module and nothing of the others.
    expect(await withVmLease(() => run(`ls ${p.b} 2>&1 || true`, p.aCode))).toContain("No such file or directory");

    // The next module: a's VM goes, b's comes - one VM for the project at a time.
    await withVmLease(() => run("true", p.bCode));
    expect(runningVms()).toEqual([p.b]);

    // A test run staged in the scratch for a build runs in that build's module's VM.
    expect(await withVmLease(() => run(`ls ${p.bCode} > /dev/null && echo seen`, p.scratch, { for: p.bCode }))).toBe("seen");
    expect(runningVms()).toEqual([p.b]);
  });

  it("moves on within a job too: a chain of modules has one VM at a time", async () => {
    const p = project();
    await withVmLease(async () => {
      await run("true", p.aCode);
      expect(runningVms()).toEqual([p.a]);
      await run("true", p.bCode);
      expect(runningVms()).toEqual([p.b]);
    });
  });

  it("stays up for two modules rendering at once, and for each of several projects", async () => {
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
      expect(runningVms().sort()).toEqual([p.a, p.b, q.a].sort());
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
