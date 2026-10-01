import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSteeringStore, EVERY_MODULE, queueSectionOf, steeringFor } from "../../src/grow/steer.ts";
import { groupPrompt, placePrompt } from "../../src/grow/chunk-plan.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-steering-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("steering the queue", () => {
  it("reads from AGENTS.md every section whose heading names the queue - and nothing else", () => {
    const text = [
      "# Project",
      "Use Java.",
      "## Queue guidance",
      "- Build a component's models and helpers with it.",
      "### Order",
      "- Models first.",
      "## Testing",
      "- Use JUnit.",
    ].join("\n");
    expect(queueSectionOf(text)).toBe("- Build a component's models and helpers with it.\n### Order\n- Models first.");
    expect(queueSectionOf("# Project\nNothing here.")).toBe("");
  });

  it("gives a plan AGENTS.md's, then the conversation's for every module and for its own - each saying where it came from", () => {
    writeFileSync(join(dir, "AGENTS.md"), "## How the render queue is planned\n\nModels first.\n");
    writeFileSync(join(dir, "config.yaml"), "conformance-tests: false\n");
    const store = createSteeringStore();
    store.set(EVERY_MODULE, ["Keep jobs small."]);
    store.set("batch", ["The worker's helpers go with the worker."]);
    store.set("other", ["Not this one."]);
    expect(steeringFor(join(dir, "batch.plain"), dir, store)).toEqual([
      { source: `AGENTS.md (${dir.split("/").at(-1)})`, text: "Models first." },
      { source: "the conversation", text: "Keep jobs small." },
      { source: "the conversation, for batch", text: "The worker's helpers go with the worker." },
    ]);
  });

  it("reaches the grouping and the placement agents as a strong preference within their limits", () => {
    const steering = [{ source: "the conversation", text: "The worker's helpers go with the worker." }];
    for (const prompt of [
      groupPrompt([{ number: 1, text: "- One." }], steering),
      placePrompt({ groups: [], built: false, implementationReqs: [], testReqs: [], steering }),
    ]) {
      expect(prompt).toContain('<from source="the conversation">\nThe worker\'s helpers go with the worker.\n</from>');
      expect(prompt).toContain("Follow these as a strong preference");
      expect(prompt).toContain("never override the");
    }
    expect(groupPrompt([{ number: 1, text: "- One." }])).not.toContain("strong preference");
  });
});
