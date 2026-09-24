import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../../src/render/testing.ts";
import { checkTryIt } from "../../src/render/try-it.ts";
import { closeAllVms, vmSupported } from "../../src/render/vm.ts";

let root: string;
let dir: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-try-server-")));
  dir = join(root, "plain_modules", ".plainwright", "try", "app", "fs-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), "hello from the app\n");
});
afterEach(async () => {
  await closeAllVms();
  rmSync(root, { recursive: true, force: true });
});

describe.runIf(vmSupported())("checking a server the person starts", { timeout: 120_000 }, () => {
  it("starts it, runs the next step against it, and stops it afterwards", async () => {
    const result = await checkTryIt(dir, {
      setup: [],
      steps: [
        { do: "python3 -m http.server 8765", expect: "It serves the page", kind: "long_running" },
        { do: "curl -s localhost:8765/index.html", expect: "It prints hello from the app", kind: "command" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.tryIt.steps.map((step) => step.exitCode)).toEqual([0, 0]);
    expect(result.outputs.get("curl -s localhost:8765/index.html")).toContain("hello from the app");
    // Nothing is left running.
    expect((await runCommand(dir, "curl -s --max-time 2 localhost:8765/index.html")).exitCode).not.toBe(0);
  });

  it("fails a server that falls over as it starts", async () => {
    const result = await checkTryIt(dir, {
      setup: [],
      steps: [{ do: "python3 -c 'import sys; print(\"port taken\"); sys.exit(1)'", expect: "It serves", kind: "long_running" }],
    });
    expect(result.ok).toBe(false);
    expect(result.outputs.get("python3 -c 'import sys; print(\"port taken\"); sys.exit(1)'")).toContain("port taken");
  });
});
