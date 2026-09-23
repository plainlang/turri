import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { interruptedRun } from "../../src/forge.ts";
import { compileSkill } from "../../src/graph.ts";
import { createJobRegistry } from "../../src/render/jobs.ts";
import { createRenderQueue } from "../../src/render/queue.ts";
import type { Skill } from "../../src/skill.ts";

/** An agent session that records what it is asked and answers nothing. */
function fakeSession() {
  const prompts: string[] = [];
  const session = {
    model: undefined,
    subscribe: () => () => {},
    prompt: async (text: string) => {
      prompts.push(text);
    },
  };
  return { prompts, session: session as never };
}

const skill = {
  name: "demo",
  dir: "/nowhere",
  allowedTools: [],
  steps: [
    { name: "intent", instructions: "Ask about intent." },
    { name: "stack", instructions: "Ask about the stack." },
    { name: "specs", instructions: "Write the specs." },
  ],
} as unknown as Skill;

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "plainwright-resume-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function run(startAt?: string, initial: object = {}) {
  const { prompts, session } = fakeSession();
  const started: string[] = [];
  const app = compileSkill({
    skill, cwd: dir, runDir: dir, executor: session, report: { step() {}, artifact() {}, gate() {}, judge() {}, outcome() {} },
    startAt, onStepStart: (step) => started.push(step),
  }).compile({ checkpointer: new MemorySaver() });
  await app.invoke(initial, { configurable: { thread_id: "t" } });
  return { prompts, started };
}

describe("resuming a skill run", () => {
  it("starts from the first step and reports each step as it starts", async () => {
    const { started, prompts } = await run();
    expect(started).toEqual(["intent", "stack", "specs"]);
    expect(prompts[0]).toContain("Ask about intent.");
  });

  it("picks up at the step it stopped in, told it was interrupted, then carries on as usual", async () => {
    const { started, prompts } = await run("stack", { attempts: { intent: 1, stack: 1 } });
    expect(started).toEqual(["stack", "specs"]);
    expect(prompts[0]).toContain("interrupted during step 'stack' and has been resumed");
    expect(prompts[0]).toContain("Check what is already on disk");
    expect(prompts[0]).not.toContain("Ask about the stack.");
    expect(prompts[1]).toContain("Write the specs.");
  });

  it("knows an interrupted run from a finished one", () => {
    const write = (status: string) =>
      writeFileSync(join(dir, "run.json"), JSON.stringify({ skill: "demo", status, step: "stack", artifacts: {}, attempts: {}, updatedAt: "2026-09-23T10:00:00.000Z" }));
    write("running");
    expect(interruptedRun(dir, "demo")).toEqual({ step: "stack", updatedAt: "2026-09-23T10:00:00.000Z" });
    expect(interruptedRun(dir, "other")).toBeUndefined();
    write("finished");
    expect(interruptedRun(dir, "demo")).toBeUndefined();
  });
});

describe("the render queue after a restart", () => {
  it("queues what the spec holds that is not built, and nothing twice", async () => {
    writeFileSync(join(dir, "app.plain"), "***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n- One.\n\n- Two.\n");
    mkdirSync(join(dir, "build"));
    const ran: string[] = [];
    const queue = createRenderQueue({
      registry: createJobRegistry(), cwd: dir, buildDir: join(dir, "build"),
      run: async (request) => (ran.push(request.frid), { report: "" }),
    });
    expect(queue.catchUp("app.plain").map((entry) => entry.frid)).toEqual(["1", "2"]);
    expect(queue.catchUp("app.plain")).toEqual([]);
    await queue.drain();
    expect(ran).toEqual(["1", "2"]);
  });
});
