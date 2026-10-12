import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerTurriConfig, type LiveHooks } from "../src/config-command.ts";
import { modelSpec, projectModels, readProjectConfig } from "../src/config.ts";
import { createJobRegistry } from "../src/grow/jobs.ts";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "turri-config-command-")));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** /turri-config registered on a stand-in pi, with a chat that answers its dialogs from `answers` in turn. */
function setUp(answers: string[] = []) {
  let command: { handler: (args: string, ctx: never) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown } | undefined;
  const pi = {
    on: () => {},
    registerCommand: (_name: string, options: typeof command) => {
      command = options;
    },
  };
  const said: string[] = [];
  const asked: Array<{ title: string; options?: string[] }> = [];
  const live: Array<[string, unknown]> = [];
  const hooks: LiveHooks = {
    chatModel: async (spec) => (live.push(["chat", spec]), `The conversation runs on ${spec} now.`),
    codingModel: () => (live.push(["coding", undefined]), "Chosen this session, and given way to the config: the engine's model x."),
    parallelJobs: (count) => (live.push(["parallel", count]), `Up to ${count} pulses run at once now.`),
  };
  registerTurriConfig(pi as never, { cwd: dir, rules: () => ["concise-specs", "integrations"], chatSpec: () => modelSpec(projectModels(readProjectConfig(dir)).harness), live: hooks });
  const ctx = {
    hasUI: true,
    modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-6-astra" }, { provider: "openai", id: "gpt-6-luna" }] },
    ui: {
      notify: (message: string) => said.push(message),
      select: async (title: string, options: string[]) => (asked.push({ title, options }), answers.shift()),
      input: async (title: string) => (asked.push({ title }), answers.shift()),
    },
  };
  return { run: (args: string) => command!.handler(args, ctx as never), complete: (prefix: string) => command!.getArgumentCompletions!(prefix), said, asked, live };
}

describe("/turri-config", () => {
  it("sets a setting given whole, in config.turri.yaml, and says when it takes effect", async () => {
    const { run, said } = setUp();
    await run("review false");
    expect(readFileSync(join(dir, "config.turri.yaml"), "utf8")).toBe("review: false\n");
    expect(said[0]).toBe("review: false - written to config.turri.yaml, in effect from the next pulse - one running now keeps what it started with.");
    await run("review unset");
    expect(readProjectConfig(dir).review).toBeUndefined();
    expect(said[1]).toContain("review unset - true");
  });

  it("copies the config.yaml turri read until now to config.turri.yaml before its first setting, and says so", async () => {
    writeFileSync(join(dir, "config.yaml"), "conformance-tests: false\n");
    const { run, said } = setUp();
    await run("review false");
    expect(readFileSync(join(dir, "config.yaml"), "utf8")).toBe("conformance-tests: false\n");
    expect(readFileSync(join(dir, "config.turri.yaml"), "utf8")).toBe("conformance-tests: false\nreview: false\n");
    expect(said[0]).toContain("config.yaml was copied to config.turri.yaml first");
  });

  it("lists every setting with what it is now, then asks for the value as the setting takes it", async () => {
    writeFileSync(join(dir, "config.yaml"), "review: false\n");
    const { run, asked, said } = setUp(["conformance-tests: (unset - all, where a module has test reqs)", "chosen"]);
    await run("");
    expect(asked[0]!.options).toContain("review: false");
    expect(asked[0]!.options!.at(-1)).toContain("models.<role>");
    expect(asked[1]!.options).toEqual(["all", "chosen", "false", "unset - all, where a module has test reqs"]);
    expect(readProjectConfig(dir).conformanceTests).toBe("chosen");
    expect(said[0]).toContain("in effect the next time the work is planned");
  });

  it("switches the conversation's model now, offering the models this machine can reach and how hard it thinks", async () => {
    const { run, asked, live, said } = setUp(["openai/gpt-6-astra", "medium"]);
    await run("harness-model");
    expect(asked[0]!.options!.slice(0, 2)).toEqual(["openai/gpt-6-astra", "openai/gpt-6-luna"]);
    expect(projectModels(readProjectConfig(dir)).harness).toEqual({ model: "openai/gpt-6-astra", thinking: "medium" });
    expect(live).toEqual([["chat", "openai/gpt-6-astra:medium"]]);
    expect(said[0]).toContain("in effect now");
    expect(said[0]).toContain("The conversation runs on openai/gpt-6-astra:medium now.");
  });

  it("refuses a model this machine cannot reach, and writes nothing", async () => {
    const { run, said } = setUp();
    await run("coding-model acme/robot");
    expect(said[0]).toContain("acme/robot is not a model turri can reach here");
    expect(() => readFileSync(join(dir, "config.yaml"))).toThrow();
  });

  it("lets the coding model chosen this session give way, and changes how many pulses run at once now", async () => {
    const { run, live, said } = setUp();
    await run("models.coding openai/gpt-6-luna:low");
    expect(live[0]).toEqual(["coding", undefined]);
    expect(said[0]).toContain("given way to the config");
    await run("parallel-jobs 3");
    expect(live[1]).toEqual(["parallel", 3]);
    expect(said[1]).toContain("in effect now");
  });

  it("turns rules on and off one at a time, a tick on each left out, then done", async () => {
    const { run, asked } = setUp(["  integrations", "done"]);
    await run("rules-off");
    expect(asked[0]!.options).toEqual(["done", "  concise-specs", "  integrations", "unset - none"]);
    expect(asked[1]!.options).toContain("✓ integrations");
    expect(readProjectConfig(dir).rulesOff).toEqual(["integrations"]);
  });

  it("completes a setting's name, then the values it takes", () => {
    const { complete } = setUp();
    expect((complete("rev") as Array<{ value: string }>).map((item) => item.value)).toEqual(["review "]);
    expect((complete("review ") as Array<{ value: string }>).map((item) => item.value)).toEqual(["review true", "review false", "review unset"]);
    expect((complete("conformance-tests c") as Array<{ value: string }>).map((item) => item.value)).toEqual(["conformance-tests chosen"]);
  });

  it("says when there is no such setting, and which it may have meant", async () => {
    const { run, said } = setUp();
    await run("reviews false");
    expect(said[0]).toBe("No setting reviews. /turri-config alone lists them.");
    await run("model false");
    expect(said[1]).toContain("Did you mean harness-model, coding-model, judge-model");
  });
});

describe("the job registry's slots", () => {
  it("starts the pulses waiting for a slot once there are more slots", async () => {
    const jobs = createJobRegistry({ maxRunning: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    jobs.start({ kind: "regenerate", summary: "a", lanes: ["a"], run: async () => (await gate, { report: "" }) });
    const second = jobs.start({ kind: "regenerate", summary: "b", lanes: ["b"], run: async () => ({ report: "" }) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(jobs.get(second.id)!.status).toBe("queued");
    jobs.setMaxRunning(2);
    await jobs.wait(second.id);
    expect(jobs.get(second.id)!.status).toBe("succeeded");
    release();
  });
});
