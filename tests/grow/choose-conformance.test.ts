import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BEGIN } from "../../src/pi.ts";

/** The chooser's answer, as the stub agent gives it - or none. */
let answers: Array<{ frids: string[]; why: string }> = [];
const tasks: string[] = [];
const models: Array<string | undefined> = [];
type StubSession = { tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> };
vi.mock("../../src/pi.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/pi.ts")>();
  return {
    ...actual,
    createExecutor: async (opts: { customTools: StubSession["tools"]; task: string; model?: string }) => {
      tasks.push(opts.task);
      models.push(opts.model);
      return { tools: opts.customTools, dispose() {} };
    },
    ask: async (session: StubSession, prompt: string) => {
      const answer = answers.shift();
      if (answer !== undefined) {
        const result = await session.tools[0]!.execute("id", answer);
        return result.content[0]!.text;
      }
      return prompt === BEGIN ? "Thinking." : "Still thinking.";
    },
  };
});
const { chooseConformance } = await import("../../src/grow/choose-conformance.ts");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-choose-"));
  writeFileSync(join(dir, "app.plain"), "***functional specs***\n\n- Say hello.\n- Log every greeting.\n");
  answers = [];
  tasks.length = 0;
  models.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const specs = [
  { frid: "1", text: "Say hello." },
  { frid: "2", text: "Log every greeting." },
];

describe("choosing the conformance tests without a conversation", () => {
  it("asks the harness model with the module's spec and what to choose from, and takes what it chose and why", async () => {
    answers = [{ frids: ["1"], why: "a client relies on the greeting; the log is internal" }];
    const chosen = await chooseConformance({ plainFile: join(dir, "app.plain"), specs, model: "amazon-bedrock/eu.anthropic.claude-opus-5-5" });
    expect(chosen).toEqual({ frids: ["1"], why: "a client relies on the greeting; the log is internal" });
    expect(models).toEqual(["amazon-bedrock/eu.anthropic.claude-opus-5-5"]);
    expect(tasks[0]).toContain("- fs 2: Log every greeting.");
    expect(tasks[0]).toContain('<spec file="app.plain">\n***functional specs***');
  });

  it("refuses a number it was not offered, and takes the answer given again", async () => {
    answers = [{ frids: ["7"], why: "wrong" }, { frids: ["2"], why: "right" }];
    expect(await chooseConformance({ plainFile: join(dir, "app.plain"), specs })).toEqual({ frids: ["2"], why: "right" });
  });

  it("refuses more than the module's budget, and takes the answer that fits", async () => {
    answers = [{ frids: ["1", "2"], why: "both" }, { frids: ["1"], why: "the greeting matters most" }];
    expect(await chooseConformance({ plainFile: join(dir, "app.plain"), specs, budget: 1 })).toEqual({ frids: ["1"], why: "the greeting matters most" });
    expect(tasks[0]).toContain("Choose at most 1 - the module's conformance budget");
  });

  it("chooses none when the agent never answers", async () => {
    expect((await chooseConformance({ plainFile: join(dir, "app.plain"), specs })).frids).toEqual([]);
  });
});
