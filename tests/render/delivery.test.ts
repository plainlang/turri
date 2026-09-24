import { describe, expect, it } from "vitest";
import { describeDelivery } from "../../src/render/delivery.ts";

const base = {
  moduleName: "greeter",
  frid: "2",
  functionality: "- Accept an optional name and greet it.",
  buildDir: `${process.cwd()}/build/greeter`,
  added: ["greeter.py", "tests/test_greeter.py"],
  runs: [
    { command: "python -m unittest discover", exitCode: 127 },
    { command: "python3 -m unittest discover", exitCode: 0 },
  ],
  passed: true,
  tryIt: {
    setup: ["pip install -r requirements.txt"],
    steps: [
      { do: "python3 greeter.py Ana", expect: 'prints "Hello, Ana!"', kind: "command" as const, exitCode: 0 },
      { do: "python3 server.py", expect: "listens on port 8000", kind: "long_running" as const },
      { do: "open http://localhost:8000/?name=Ana", expect: "the page says Hello, Ana!", kind: "manual" as const },
    ],
  },
};

describe("the notification when a functionality lands", () => {
  it("leads with what the software does now", () => {
    const text = describeDelivery(base);
    expect(text).toContain("greeter: functionality 2 is ready to try.");
    expect(text).toContain("What's new");
    expect(text).toContain("- Accept an optional name and greet it.");
  });

  it("says how to run it, from where, with setup first", () => {
    const text = describeDelivery(base);
    expect(text).toContain("$ cd build/greeter");
    expect(text.indexOf("Set up once:")).toBeLessThan(text.indexOf("pip install"));
    expect(text.indexOf("pip install")).toBeLessThan(text.indexOf("python3 greeter.py Ana"));
    expect(text).toContain('You should see: prints "Hello, Ana!"');
  });

  it("numbers the steps, marks the ones the harness ran, and says how each kind is used", () => {
    const text = describeDelivery(base);
    expect(text).toContain("  1. $ python3 greeter.py Ana   ✓");
    expect(text).toContain("  2. Start it - it keeps running, so do the next steps in a second terminal:");
    expect(text).toContain("  3. open http://localhost:8000/?name=Ana");
  });

  it("says when a step did not work when checked", () => {
    const steps = [{ ...base.tryIt.steps[0]!, exitCode: 1 }];
    const text = describeDelivery({ ...base, tryIt: { setup: [], steps } });
    expect(text).toContain("✗ did not work when checked");
    expect(text).toContain("Some of these did not work when checked");
  });

  it("admits when the build did not say how to run it", () => {
    expect(describeDelivery({ ...base, tryIt: undefined })).toContain("how to try it was not worked out");
  });

  it("keeps the tests to a footnote, with the command that actually passed", () => {
    const text = describeDelivery(base);
    const last = text.split("\n").at(-1)!;
    expect(last).toContain("unit tests pass (python3 -m unittest discover)");
    expect(last).toContain("2 new files (greeter.py, tests/test_greeter.py)");
    expect(text).not.toContain("python -m unittest discover)");
  });

  it("offers no instructions when the tests are not passing", () => {
    const text = describeDelivery({ ...base, passed: false });
    expect(text).toContain("its tests are not passing");
    expect(text).not.toContain("Try it");
  });

  it("shortens a long file list", () => {
    const added = Array.from({ length: 20 }, (_, i) => `file${i}.py`);
    expect(describeDelivery({ ...base, added })).toContain("20 new files (file0.py, file1.py, file2.py, …)");
  });
});
