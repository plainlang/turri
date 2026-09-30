import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, MemorySaver } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { interruptedRun } from "../../src/forge.ts";
import { compileSkill } from "../../src/graph.ts";
import { createJobRegistry } from "../../src/render/jobs.ts";
import { createWorkLoop } from "../../src/render/loop.ts";
import { writeCodeRecord } from "../../src/render/records.ts";
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

describe("a gate the user overrules", () => {
  it("leaves its rejection with its own step: the next step starts fresh, not as a retry", async () => {
    writeFileSync(join(dir, "rubric.md"), "- [ ] It is done.\n");
    const gated = {
      ...skill,
      dir,
      steps: [
        {
          name: "product",
          instructions: "Write the product.",
          gate: { after: "product", review: { rubric: "rubric.md", judges: 1, quorum: "all", judgeTools: [], onFail: "retry", maxRetries: 0 } },
        },
        { name: "testing", instructions: "Decide on the tests." },
      ],
    } as unknown as Skill;
    const { prompts, session } = fakeSession();
    const app = compileSkill({
      skill: gated, cwd: dir, runDir: dir, executor: session, report: { step() {}, artifact() {}, gate() {}, judge() {}, outcome() {} },
    }).compile({ checkpointer: new MemorySaver() });
    const thread = { configurable: { thread_id: "t" } };
    // No artifact, no retries left: it goes to the user, who accepts it anyway.
    await app.invoke({}, thread);
    await app.invoke(new Command({ resume: true }), thread);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Decide on the tests.");
    expect(prompts[1]).not.toContain("rejected by review");
  });
});

describe("the builds after a restart", () => {
  it("build what the spec holds that is not built, and nothing twice", async () => {
    writeFileSync(join(dir, "app.plain"), "***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n- One.\n\n- Two.\n");
    const ran: string[][] = [];
    const run = async (job: { buildDir: string; spec: { tree: object }; planned: { cases: { add: Array<{ frid: string }> } } }) => {
      ran.push(job.planned.cases.add.map((spec) => spec.frid));
      mkdirSync(job.buildDir, { recursive: true });
      writeFileSync(join(job.buildDir, "app.py"), "\n");
      writeCodeRecord(job.buildDir, job.spec.tree as never);
      return { landed: true, report: "" };
    };
    const loop = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: run as never });
    await loop.bringUp("app.plain");
    await loop.drain();
    // A new process: what is built is read from the records, so nothing is built again.
    const again = createWorkLoop({ registry: createJobRegistry(), cwd: dir, planner: false, run: run as never });
    await again.bringUp("app.plain");
    await again.drain();
    expect(ran).toEqual([["1"], ["2"]]);
  });
});
