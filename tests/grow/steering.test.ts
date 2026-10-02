import { describe, expect, it } from "vitest";
import { createSteering, markTold, steerableChanges, waitingSteer } from "../../src/grow/steering.ts";
import type { SpecChange } from "../../src/grow/spec-steps.ts";

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

describe("a steer waiting for the agent", () => {
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
