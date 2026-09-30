import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rendered: Array<{ frid: string }> = [];

vi.mock("../../src/render/render.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/render/render.ts")>();
  return {
    ...actual,
    renderFunctionality: async (options: { frid: string; buildDir?: string }) => {
      rendered.push({ frid: options.frid });
      return {
        moduleName: "app", frid: options.frid, buildDir: options.buildDir ?? "", prompt: "", response: "", files: [], added: [],
        functionality: "", runs: [{ command: "true", exitCode: 0 }], passed: true, testRemovals: [],
      };
    },
  };
});

const { createRenderQueue } = await import("../../src/render/queue.ts");
const { createJobRegistry } = await import("../../src/render/jobs.ts");
const { recordBuiltFunctionality } = await import("../../src/render/state.ts");
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
  it("builds them first, in order, and offers to try only the one queued once it lands", async () => {
    const { TRY_IT_LINE } = await import("../../src/render/delivery.ts");
    const registry = createJobRegistry();
    const queue = createRenderQueue({ registry, cwd: dir, buildDir: join(dir, "build") });
    const { jobId } = queue.enqueue({ plainFile: "app.plain", frid: "3" });
    await queue.drain();
    expect(rendered).toEqual([{ frid: "1" }, { frid: "2" }, { frid: "3" }]);
    expect(registry.get(jobId)!.report).toContain(TRY_IT_LINE);
    expect(registry.get(jobId)!.report!.split(TRY_IT_LINE)).toHaveLength(2);
  });

  it("carries, while it waits, the diff of what it will build - not only its number", async () => {
    const registry = createJobRegistry();
    const queue = createRenderQueue({ registry, cwd: dir, buildDir: join(dir, "build") });
    const { jobId } = queue.enqueue({ plainFile: "app.plain", frid: "1" });
    const diff = registry.get(jobId)!.diff ?? "";
    expect(diff).toContain("+- One.");
    expect(diff).not.toContain("+- Two.");
    await queue.drain();
  });

  it("builds only what is missing", async () => {
    const [, tree] = plainFileParser("app.plain", resolveTemplateDirs(join(dir, "app.plain")));
    recordBuiltFunctionality(join(dir, "build"), tree, "1");
    const queue = createRenderQueue({ registry: createJobRegistry(), cwd: dir, buildDir: join(dir, "build") });
    queue.enqueue({ plainFile: "app.plain", frid: "3" });
    await queue.drain();
    expect(rendered.map((r) => r.frid)).toEqual(["2", "3"]);
  });
});
