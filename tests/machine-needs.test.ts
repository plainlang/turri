import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { machineNeeds } from "../src/extension.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-machine-needs-"));
  writeFileSync(join(dir, "app.plain"), "");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("what a project's modules need of this machine", () => {
  it("is worked out once and then told from memory, turn after turn - a message never waits for the specs to be parsed again", () => {
    const work = vi.fn(() => [{ module: "app", needs: [], missing: [] }]);
    const machine = machineNeeds(dir, work);
    expect(machine.now()).toEqual([{ module: "app", needs: [], missing: [] }]);
    machine.now();
    machine.now();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("is worked out again after a turn only when a spec changed, and the turn before is told what was known last", async () => {
    let calls = 0;
    const work = vi.fn(() => [{ module: `app ${++calls}`, needs: [], missing: [] }]);
    const machine = machineNeeds(dir, work);
    machine.refreshSoon();
    await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(1));
    // Nothing changed: not again.
    machine.refreshSoon();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(work).toHaveBeenCalledTimes(1);
    // A spec changed: told what was known until the refresh after the turn has run.
    utimesSync(join(dir, "app.plain"), new Date(), new Date(Date.now() + 5_000));
    expect(machine.now()[0]!.module).toBe("app 1");
    machine.refreshSoon();
    await vi.waitFor(() => expect(machine.now()[0]!.module).toBe("app 2"));
  });
});
