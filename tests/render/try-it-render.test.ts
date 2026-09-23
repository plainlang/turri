import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The agent is stubbed: it runs the unit tests, and when asked how to try what it built, it
 * answers with `answers` in turn. The steps themselves are run for real, in the project's VM.
 */
type StubSession = { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> };
const prompts: string[] = [];
let answers: Array<{ setup: string[]; steps: Array<{ do: string; expect: string; kind: string }> }> = [];

vi.mock("../../src/pi.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi.ts")>();
  return {
    ...actual,
    createExecutor: async (opts: { customTools: StubSession["tools"] }) => ({ tools: opts.customTools, dispose() {} }),
    ask: vi.fn(async (session: StubSession, prompt: string) => {
      prompts.push(prompt);
      const tool = (name: string) => session.tools.find((candidate) => candidate.name === name)!;
      if (prompt.includes("describe_how_to_try_it")) {
        const answer = answers.shift();
        if (answer !== undefined) await tool("describe_how_to_try_it").execute("id", answer);
      } else {
        await tool("run_unit_tests").execute("id", { command: "true" });
      }
      return "Done.";
    }),
  };
});

const { renderFunctionality } = await import("../../src/render/render.ts");
const { describeSpecDiff, renderSpecDiff } = await import("../../src/render/spec-change.ts");
const { describeDelivery } = await import("../../src/render/delivery.ts");
const { vmSupported } = await import("../../src/render/vm.ts");

let dir: string;
let cwd: string;
const plain = (fs: string[]) => `***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n${fs.join("\n\n")}\n`;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-try-render-")));
  cwd = process.cwd();
  process.chdir(dir);
  prompts.length = 0;
  answers = [];
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

const working = {
  setup: ["echo setting up > setup.log"],
  steps: [
    { do: "python3 -c 'print(40 + 2)'", expect: "prints 42", kind: "command" },
    { do: "python3 -m http.server", expect: "serves the page", kind: "long_running" },
  ],
};

describe.runIf(vmSupported())("trying what a render built", { timeout: 120_000 }, () => {
  it("is worked out and checked for a functionality, in a copy inside plain_modules", async () => {
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    answers = [working];

    const result = await renderFunctionality({ plainFile: "app.plain", frid: "1", tryIt: true });

    expect(prompts.some((prompt) => prompt.startsWith("Functionality 1 is built"))).toBe(true);
    expect(result.tryIt?.dir).toBe(join(dir, "plain_modules", ".plainwright", "try", "app", "fs-1"));
    expect(existsSync(join(result.tryIt!.dir!, "setup.log"))).toBe(true);
    expect(result.tryIt?.steps.map((step) => step.exitCode)).toEqual([0, undefined]);
    const delivery = describeDelivery({ ...result, passed: true });
    expect(delivery).toContain("Try it");
    expect(delivery).toContain("python3 -c 'print(40 + 2)'  ✓ checked");
  });

  it("is worked out and checked for a spec change too", async () => {
    const before = plain(["- One."]);
    const after = plain(["- One.", "- Two."]);
    writeFileSync(join(dir, "app.plain"), before);
    const diff = [
      "diff --git a/app.plain b/app.plain",
      "--- a/app.plain",
      "+++ b/app.plain",
      "@@ -6 +6,3 @@",
      " - One.",
      "+",
      "+- Two.",
      "",
    ].join("\n");
    answers = [working];

    const result = await renderSpecDiff({ plainFile: "app.plain", diff, cwd: dir, tryIt: true });

    expect(prompts.some((prompt) => prompt.startsWith("The spec change is built"))).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.tryIt?.dir).toBe(join(dir, "plain_modules", ".plainwright", "try", "app", "spec-change"));
    expect(result.tryIt?.steps[0]?.exitCode).toBe(0);
    const report = describeSpecDiff(result);
    expect(report).toContain("Try it");
    expect(report).toContain("✓ checked");
    // Its report is the change it made, not its answer about trying it.
    expect(prompts.filter((prompt) => prompt.includes("describe_how_to_try_it"))).toHaveLength(1);
  });

  it("sends a step that fails back to the agent once, and checks the fix", async () => {
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    answers = [
      { setup: [], steps: [{ do: "exit 3", expect: "works", kind: "command" }] },
      { setup: [], steps: [{ do: "echo works", expect: "works", kind: "command" }] },
    ];

    const result = await renderFunctionality({ plainFile: "app.plain", frid: "1", tryIt: true });

    expect(prompts.some((prompt) => prompt.startsWith("These did not work"))).toBe(true);
    expect(result.tryIt?.steps).toEqual([{ do: "echo works", expect: "works", kind: "command", exitCode: 0 }]);
  });

  it("is not asked for when not wanted", async () => {
    writeFileSync(join(dir, "app.plain"), plain(["- One."]));
    const result = await renderFunctionality({ plainFile: "app.plain", frid: "1" });
    expect(result.tryIt).toBeUndefined();
    expect(prompts.some((prompt) => prompt.includes("describe_how_to_try_it"))).toBe(false);
  });
});
