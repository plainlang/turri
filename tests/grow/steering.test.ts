import { describe, expect, it } from "vitest";
import { createSteering, markTold, steer, steerableChanges, waitingSteer } from "../../src/grow/steering.ts";
import { changesBetween, serializeTree, type SpecChange } from "../../src/grow/spec-steps.ts";

const item = (markdown: string) => JSON.stringify({ markdown });
const change = (section: string, before: string, after: string, position = 1): SpecChange => ({ id: `${section}-${position}`, section, kind: "change", before: item(before), after: item(after), position });

describe("what steers a running job", () => {
  it("is a change to a functional spec it grows - a sub-bullet added under it too - but not to one built before it", () => {
    const mine = new Set([item("- Say hello.")]);
    const { steer } = steerableChanges(
      [change("functional specs", "- Say hello.", "- Say hello.\n  - In French."), change("functional specs", "- Count to ten.", "- Count to twenty.", 2)],
      mine,
      [],
    );
    expect(steer.map((one) => one.after)).toEqual([item("- Say hello.\n  - In French.")]);
  });

  it("is never an item added or removed", () => {
    const added: SpecChange = { id: "d", section: "definitions", kind: "add", after: item("- :B: is a letter."), position: 2 };
    expect(steerableChanges([added], new Set(), []).steer).toEqual([]);
  });

  it("is a definition or an implementation req it is given - kept out of the record when what was built before uses it", () => {
    const definition = change("definitions", "- :A: is a letter.", "- :A: is a letter.\n  - :A: should be used to write words.");
    const req = change("implementation reqs", "- :Implementation: is Python.", "- :Implementation: is Python 3.12.");
    const unshared = steerableChanges([definition, req], new Set(), []);
    expect(unshared.steer).toHaveLength(2);
    expect(unshared.shared).toEqual([]);
    // Built before the job: a spec that uses :A:.
    const shared = steerableChanges([definition, req], new Set(), [item("- Write :A: twice.")]);
    expect(shared.steer).toHaveLength(2);
    expect(shared.shared).toEqual([definition, req]);
  });
});

describe("steering a running job", () => {
  /** A tree of definitions, implementation reqs and functional specs, an item a line. */
  const tree = (sections: { definitions?: string[]; impl?: string[]; specs?: string[] }) =>
    ({
      ...(sections.definitions ? { definitions: sections.definitions.map((markdown) => ({ markdown })) } : {}),
      ...(sections.impl ? { "implementation reqs": sections.impl.map((markdown) => ({ markdown })) } : {}),
      ...(sections.specs ? { "functional specs": sections.specs.map((markdown) => ({ markdown })) } : {}),
    }) as never;
  const between = (a: unknown, b: unknown) => changesBetween(serializeTree(a as never), serializeTree(b as never));
  const specsOf = (one: unknown) => ((one as { "functional specs"?: Array<{ markdown: string }> })["functional specs"] ?? []).map((spec) => spec.markdown);
  const definitionsOf = (one: unknown) => ((one as { definitions?: Array<{ markdown: string }> }).definitions ?? []).map((definition) => definition.markdown);
  const implOf = (one: unknown) => ((one as { "implementation reqs"?: Array<{ markdown: string }> })["implementation reqs"] ?? []).map((req) => req.markdown);

  /**
   * A job that grows `target` from its record `from`, steered towards `spec` - as the work loop steers one: the job's own
   * changes from its record to what it grows, and the work from a tree to the spec.
   */
  function steered(from: unknown, target: unknown, spec: unknown) {
    const steering = createSteering(target as never);
    return steer(steering, from as never, between(from, target), (one) => between(one, spec));
  }

  it("moves its record and its agent to a functional spec it grows, reworded", () => {
    const from = tree({ specs: ["- Say hello."] });
    const target = tree({ specs: ["- Say hello.", "- Say goodbye."] });
    const moved = steered(from, target, tree({ specs: ["- Say hello.", "- Say goodbye politely."] }))!;
    expect(specsOf(moved.target)).toEqual(["- Say hello.", "- Say goodbye politely."]);
    expect(specsOf(moved.agent)).toEqual(["- Say hello.", "- Say goodbye politely."]);
    expect(moved.steered).toHaveLength(1);
  });

  it("is not steered by a change to a functional spec built before it, which it does not grow", () => {
    const from = tree({ specs: ["- Say hello."] });
    const target = tree({ specs: ["- Say hello.", "- Say goodbye."] });
    expect(steered(from, target, tree({ specs: ["- Say hello loudly.", "- Say goodbye."] }))).toBeUndefined();
  });

  it("takes a definition only its own functional specs use into its record", () => {
    const from = tree({ definitions: ["- :A: is a letter."], specs: ["- Say hello."] });
    const target = tree({ definitions: ["- :A: is a letter."], specs: ["- Say hello.", "- Write :A:."] });
    const moved = steered(from, target, tree({ definitions: ["- :A: is a capital letter."], specs: ["- Say hello.", "- Write :A:."] }))!;
    expect(definitionsOf(moved.target)).toEqual(["- :A: is a capital letter."]);
    expect(definitionsOf(moved.agent)).toEqual(["- :A: is a capital letter."]);
  });

  it("tells its agent of a definition a functional spec built before it uses too, but keeps the record as that was built", () => {
    const from = tree({ definitions: ["- :A: is a letter."], specs: ["- Read :A:."] });
    const target = tree({ definitions: ["- :A: is a letter."], specs: ["- Read :A:.", "- Write :A:."] });
    const moved = steered(from, target, tree({ definitions: ["- :A: is a capital letter."], specs: ["- Read :A:.", "- Write :A:."] }))!;
    expect(definitionsOf(moved.agent)).toEqual(["- :A: is a capital letter."]);
    expect(definitionsOf(moved.target)).toEqual(["- :A: is a letter."]);
  });

  it("counts a definition renamed into another concept as the one built before uses, by the concept it had", () => {
    const from = tree({ definitions: ["- :A: is a letter."], specs: ["- Read :A:."] });
    const target = tree({ definitions: ["- :A: is a letter."], specs: ["- Read :A:.", "- Write a letter."] });
    const moved = steered(from, target, tree({ definitions: ["- :Alpha: is a letter."], specs: ["- Read :A:.", "- Write a letter."] }))!;
    expect(definitionsOf(moved.agent)).toEqual(["- :Alpha: is a letter."]);
    expect(definitionsOf(moved.target)).toEqual(["- :A: is a letter."]);
  });

  it("takes into its record a definition a functional spec built before uses, when the job is changing that functional spec itself", () => {
    const from = tree({ definitions: ["- :A: is a letter."], specs: ["- Read :A:."] });
    const target = tree({ definitions: ["- :A: is a letter."], specs: ["- Read :A: aloud."] });
    const moved = steered(from, target, tree({ definitions: ["- :A: is a capital letter."], specs: ["- Read :A: aloud."] }))!;
    expect(definitionsOf(moved.target)).toEqual(["- :A: is a capital letter."]);
  });

  it("takes an implementation req into its record when nothing was built before it, and only tells its agent when something was", () => {
    const req = { impl: ["- :Implementation: is Python."] };
    const newer = { impl: ["- :Implementation: is Python 3.12."] };
    const fresh = steered(tree({}), tree({ ...req, specs: ["- Say hello."] }), tree({ ...newer, specs: ["- Say hello."] }))!;
    expect(implOf(fresh.target)).toEqual(newer.impl);
    const onTop = steered(tree({ ...req, specs: ["- Say hello."] }), tree({ ...req, specs: ["- Say hello.", "- Say goodbye."] }), tree({ ...newer, specs: ["- Say hello.", "- Say goodbye."] }))!;
    expect(implOf(onTop.agent)).toEqual(newer.impl);
    expect(implOf(onTop.target)).toEqual(req.impl);
  });

  it("is not steered by a functional spec added or taken out - the work changes shape, and that is the next job's", () => {
    const from = tree({ specs: ["- Say hello."] });
    const target = tree({ specs: ["- Say hello.", "- Say goodbye."] });
    expect(steered(from, target, tree({ specs: ["- Say hello.", "- Say goodbye.", "- Say thanks."] }))).toBeUndefined();
  });
});

describe("a steer waiting for the agent", () => {
  it("names the functional spec by the module the job grows, and says to make the code match", () => {
    const steering = createSteering({ "functional specs": [{ markdown: "- Say hello." }] } as never, "app");
    steering.agent = { "functional specs": [{ markdown: "- Say hello loudly." }] } as never;
    const text = waitingSteer(steering)!;
    expect(text).toContain("functionality 1 of module `app`");
    expect(text).toContain("Make the code and its unit tests match the spec as it is now");
  });

  it("waits until it is told, and is gone once it is", () => {
    const before = { "functional specs": [{ markdown: "- Say hello." }] };
    const after = { "functional specs": [{ markdown: "- Say hello.\n  - In French." }] };
    const steering = createSteering(before as never);
    expect(waitingSteer(steering)).toBeUndefined();
    steering.agent = after as never;
    expect(waitingSteer(steering)).toContain("The spec changed while you work");
    expect(waitingSteer(steering)).toContain("In French.");
    markTold(steering);
    expect(waitingSteer(steering)).toBeUndefined();
  });
});
