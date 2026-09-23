import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rendered: Array<{ frid: string; tryIt?: boolean }> = [];

vi.mock("../../src/render/render.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/render/render.ts")>();
  return {
    ...actual,
    renderFunctionality: async (options: { frid: string; tryIt?: boolean; buildDir?: string }) => {
      rendered.push({ frid: options.frid, tryIt: options.tryIt });
      return {
        moduleName: "app", frid: options.frid, buildDir: options.buildDir ?? "", prompt: "", response: "", files: [], added: [],
        functionality: "", runs: [{ command: "true", exitCode: 0 }], passed: true, testRemovals: [],
      };
    },
  };
});

const { createRenderQueue } = await import("../../src/render/queue.ts");
const { createJobRegistry } = await import("../../src/render/jobs.ts");
const { recordFunctionality, specStateFor } = await import("../../src/render/state.ts");
const { plainFileParser } = await import("../../src/plain/parser.ts");
const { resolveTemplateDirs } = await import("../../src/render/render.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plainwright-prereq-"));
  writeFileSync(join(dir, "app.plain"), "***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n- One.\n\n- Two.\n\n- Three.\n");
  mkdirSync(join(dir, "build"));
  rendered.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a queued render whose earlier functionalities are not built", () => {
  it("builds them first, in order, and asks for try-it only on the one queued", async () => {
    const queue = createRenderQueue({ registry: createJobRegistry(), cwd: dir, buildDir: join(dir, "build") });
    queue.enqueue({ plainFile: "app.plain", frid: "3" });
    await queue.drain();
    expect(rendered).toEqual([
      { frid: "1", tryIt: undefined },
      { frid: "2", tryIt: undefined },
      { frid: "3", tryIt: true },
    ]);
  });

  it("builds only what is missing", async () => {
    const [, tree] = plainFileParser("app.plain", resolveTemplateDirs(join(dir, "app.plain")));
    recordFunctionality(join(dir, "build"), "app", { frid: "1", ...specStateFor(tree, "1"), unitTests: "passed" });
    const queue = createRenderQueue({ registry: createJobRegistry(), cwd: dir, buildDir: join(dir, "build") });
    queue.enqueue({ plainFile: "app.plain", frid: "3" });
    await queue.drain();
    expect(rendered.map((r) => r.frid)).toEqual(["2", "3"]);
  });
});
