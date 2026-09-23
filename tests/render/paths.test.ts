import { describe, expect, it } from "vitest";
import { conformanceDirFor } from "../../src/render/conformance.ts";
import { buildDirUnder, defaultBuildDir, defaultTestsDir, testsDirUnder } from "../../src/render/paths.ts";

describe("module layout", () => {
  it("puts code and unit tests under plain_modules/<module>/code", () => {
    expect(defaultBuildDir("demo", "/proj")).toBe("/proj/plain_modules/demo/code");
  });

  it("puts conformance tests under plain_modules/<module>/tests", () => {
    expect(defaultTestsDir("demo", "/proj")).toBe("/proj/plain_modules/demo/tests");
    expect(conformanceDirFor("demo", "/proj/plain_modules")).toBe("/proj/plain_modules/demo/tests");
  });

  it("keeps the same layout under an overridden root", () => {
    expect(buildDirUnder("/sandbox", "demo")).toBe("/sandbox/demo/code");
    expect(testsDirUnder("/sandbox", "demo")).toBe("/sandbox/demo/tests");
  });
});
