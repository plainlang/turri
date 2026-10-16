import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { prepareListArguments } from "../../src/regenerate/list-arguments.ts";

/** submit_exploration's shape: text, and two lists of objects. */
const exploration = Type.Object({
  build_and_run: Type.String(),
  tests_reach_it: Type.String(),
  interfaces: Type.Array(Type.Object({ module: Type.Optional(Type.String()), id: Type.Optional(Type.String()), how: Type.String() })),
  environment: Type.String(),
  plan: Type.Array(Type.Object({ module: Type.Optional(Type.String()), id: Type.Optional(Type.String()), tests: Type.String() })),
  other: Type.Optional(Type.String()),
});
const prepare = (args: unknown) => prepareListArguments("submit_exploration", exploration, args) as Record<string, unknown>;
const base = { build_and_run: "go build", tests_reach_it: "the binary at ./bin/app", environment: "none" };
const interfaces = [{ id: "1", how: "app index <dir>" }];
const plan = [{ id: "1", tests: "index a folder and check the output" }];

describe("a list argument a small model sends in another shape", () => {
  it("is taken as the list when it is sent as JSON text", () => {
    expect(prepare({ ...base, interfaces: JSON.stringify(interfaces), plan: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` })).toEqual({ ...base, interfaces, plan });
  });

  it("is taken as the list when each entry is JSON text, or the list is one object", () => {
    expect(prepare({ ...base, interfaces: interfaces.map((entry) => JSON.stringify(entry)), plan: plan[0] })).toEqual({ ...base, interfaces, plan });
  });

  it("is taken out of another argument's text it was written inside - as haiku wrote the whole exploration into tests_reach_it", () => {
    const tucked = `the binary at ./bin/app</tests_reach_it>\n<interfaces>${JSON.stringify(interfaces)}</interfaces>\n<environment>none</environment>\n<plan>${JSON.stringify(plan)}`;
    expect(prepare({ build_and_run: "go build", tests_reach_it: tucked })).toEqual({ ...base, interfaces, plan });
  });

  it("leaves arguments already in shape as they are", () => {
    const args = { ...base, interfaces, plan };
    expect(prepare(args)).toEqual(args);
  });
});

describe("a list argument that cannot be taken as a list", () => {
  it("is refused saying what it is, each entry's fields and an example - not 'must be object'", () => {
    let message = "";
    try {
      prepare({ ...base, interfaces: "app index <dir> runs the indexer", plan: ["index a folder"] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("`interfaces`: you sent it as text, not a list");
    expect(message).toContain('each {"module"?: string, "id"?: string, "how": string}');
    expect(message).toContain('e.g. "interfaces": [{"how": "..."}]');
    expect(message).toContain("`plan`: entry 1 is text, not an object");
    expect(message).toContain("never written inside another argument's text");
  });

  it("is refused naming the argument it was written inside, and a list left out as left out", () => {
    expect(() => prepare({ ...base, tests_reach_it: "the binary</tests_reach_it><interfaces>app index, app search</interfaces>" })).toThrow(
      /`interfaces`: you wrote it inside `tests_reach_it`[\s\S]*`plan`: you left it out/,
    );
  });
});
