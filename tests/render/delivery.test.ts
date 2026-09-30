import { describe, expect, it } from "vitest";
import { describeDelivery, TRY_IT_LINE, tryItCommand, withTryItLine } from "../../src/render/delivery.ts";

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
};

describe("the notification when a functionality lands", () => {
  it("leads with what the software does now", () => {
    const text = describeDelivery(base);
    expect(text).toContain("greeter: functionality 2 is ready to try.");
    expect(text).toContain("What's new");
    expect(text).toContain("- Accept an optional name and greet it.");
  });

  it("ends by offering to set it up for the person to try", () => {
    expect(describeDelivery(base).split("\n").at(-1)).toBe(TRY_IT_LINE);
  });

  it("leaves the offer to the conformance job that follows, when one does", () => {
    const text = describeDelivery({ ...base, offerTry: false });
    expect(text).not.toContain(TRY_IT_LINE);
    expect(text).toContain("greeter: functionality 2 is built - its conformance tests come next.");
  });

  it("keeps the tests to a footnote, with the command that actually passed", () => {
    const lines = describeDelivery(base).split("\n");
    const footnote = lines.at(-3)!;
    expect(footnote).toContain("unit tests pass (python3 -m unittest discover)");
    expect(footnote).toContain("2 new files (greeter.py, tests/test_greeter.py)");
    expect(lines.join("\n")).not.toContain("python -m unittest discover)");
  });

  it("offers nothing to try when the tests are not passing", () => {
    const text = describeDelivery({ ...base, passed: false });
    expect(text).toContain("its tests are not passing");
    expect(text).not.toContain(TRY_IT_LINE);
  });

  it("shortens a long file list", () => {
    const added = Array.from({ length: 20 }, (_, i) => `file${i}.py`);
    expect(describeDelivery({ ...base, added })).toContain("20 new files (file0.py, file1.py, file2.py, …)");
  });
});

describe("the offer to try what a job built", () => {
  it("ends a report that landed, and leaves one that did not as it was", () => {
    expect(withTryItLine("Rendered the spec change.", true)).toBe(`Rendered the spec change.\n\n${TRY_IT_LINE}`);
    expect(withTryItLine("Conformance tests are NOT passing.", false)).toBe("Conformance tests are NOT passing.");
  });

  it("names the command on the command line, which has no one to ask", () => {
    expect(tryItCommand(`${process.cwd()}/app.plain`)).toBe("To try it: plainwright deploy app.plain");
  });
});
