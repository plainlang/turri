import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ frid: string; tryIt: boolean | undefined }> = [];

vi.mock("../../src/render/render.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/render/render.ts")>();
  return {
    ...actual,
    renderFunctionality: async (options: { frid: string; tryIt?: boolean; buildDir: string }) => {
      calls.push({ frid: options.frid, tryIt: options.tryIt });
      return {
        moduleName: "app", frid: options.frid, buildDir: options.buildDir, prompt: "", response: "",
        files: [], added: [], functionality: "", runs: [{ command: "true", exitCode: 0 }], passed: true, testRemovals: [],
      };
    },
  };
});

const { renderModule } = await import("../../src/render/module.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plainwright-try-scope-"));
  writeFileSync(join(dir, "app.plain"), "***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n- One.\n\n- Two.\n\n- Three.\n");
  calls.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("how to try it, on a module render", () => {
  it("is not worked out at all unless asked for", async () => {
    await renderModule({ plainFile: join(dir, "app.plain"), buildDir: join(dir, "build") });
    expect(calls.map((call) => call.tryIt)).toEqual([false, false, false]);
  });

  it("is worked out for the last functionality built only", async () => {
    await renderModule({ plainFile: join(dir, "app.plain"), buildDir: join(dir, "build"), tryIt: true });
    expect(calls).toEqual([
      { frid: "1", tryIt: false },
      { frid: "2", tryIt: false },
      { frid: "3", tryIt: true },
    ]);
  });

  it("follows where the run stops, not the end of the module", async () => {
    await renderModule({ plainFile: join(dir, "app.plain"), buildDir: join(dir, "build"), tryIt: true, to: "2" });
    expect(calls).toEqual([
      { frid: "1", tryIt: false },
      { frid: "2", tryIt: true },
    ]);
  });
});

describe("conformance on a module render", () => {
  it("is off for a module with no test reqs, and says why", async () => {
    const result = await renderModule({ plainFile: join(dir, "app.plain"), buildDir: join(dir, "build") });
    expect(result.conformance).toBe("off: no test reqs");
    expect(result.outcomes.every((o) => o.conformanceSkipped)).toBe(true);
  });

  it("is off when asked, even for a module that has test reqs", async () => {
    writeFileSync(
      join(dir, "app.plain"),
      "***implementation reqs***\n\n- Python.\n\n***test reqs***\n\n- pytest.\n\n***functional specs***\n\n- One.\n\n- Two.\n",
    );
    const result = await renderModule({ plainFile: join(dir, "app.plain"), buildDir: join(dir, "build"), conformance: false });
    expect(result.conformance).toBe("off: asked");
    expect(result.outcomes.map((o) => [o.frid, o.stoppedAt, o.conformanceSkipped])).toEqual([
      ["1", null, true],
      ["2", null, true],
    ]);
  });
});
