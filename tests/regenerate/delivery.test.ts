import { describe, expect, it } from "vitest";
import { TRY_IT_LINE, tryItCommand, withTryItLine } from "../../src/regenerate/delivery.ts";

describe("the offer to try what a job built", () => {
  it("ends a report that landed, and leaves one that did not as it was", () => {
    expect(withTryItLine("Rendered the spec change.", true)).toBe(`Rendered the spec change.\n\n${TRY_IT_LINE}`);
    expect(withTryItLine("Conformance tests are NOT passing.", false)).toBe("Conformance tests are NOT passing.");
  });

  it("names the command on the command line, which has no one to ask", () => {
    expect(tryItCommand(`${process.cwd()}/app.plain`)).toBe("To try it: turri release app.plain");
  });
});
