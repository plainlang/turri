import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPlainFile, checkPlainTargets, formatCheckResults } from "../../src/plain/check.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "turri-check-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID = `***implementation reqs***

- A requirement.

***functional specs***

- Do the thing.
`;

describe("checkPlainFile", () => {
  it("passes a valid spec and reports its functionalities", () => {
    writeFileSync(join(dir, "app.plain"), VALID);
    const result = checkPlainFile(join(dir, "app.plain"));

    expect(result.ok).toBe(true);
    expect(result.moduleName).toBe("app");
    expect(result.frids).toEqual(["1"]);
  });

  it("reports a syntax error with the parser's own message", () => {
    writeFileSync(join(dir, "broken.plain"), "***definitions***\n\n***Nope:***\n");
    const result = checkPlainFile(join(dir, "broken.plain"));

    expect(result.ok).toBe(false);
    expect(result.errorType).toBe("PlainSyntaxError");
    expect(result.error).toContain("Syntax error at line 3");
    expect(result.error).toContain("Invalid specification heading");
  });

  it("passes a module with no functional specs yet, and says so", () => {
    writeFileSync(join(dir, "empty.plain"), "***implementation reqs***\n\n- A requirement.\n");
    const result = checkPlainFile(join(dir, "empty.plain"));

    expect(result.ok).toBe(true);
    expect(result.frids).toEqual([]);
    expect(formatCheckResults([result])).toBe("PASS  empty.plain  no functional specs yet");
  });

  it("rejects a file that is not a .plain file", () => {
    expect(checkPlainFile("README.md").error).toContain("Not a .plain file");
  });

  it("rejects a file that does not exist", () => {
    expect(checkPlainFile(join(dir, "nope.plain")).error).toBe("File does not exist.");
  });
});

describe("checking a directory", () => {
  it("checks every .plain file in it", () => {
    writeFileSync(join(dir, "a.plain"), VALID);
    writeFileSync(join(dir, "b.plain"), VALID);
    writeFileSync(join(dir, "notes.md"), "ignored");

    const results = checkPlainTargets(dir);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

describe("formatCheckResults", () => {
  it("puts the failure message under the file it belongs to", () => {
    writeFileSync(join(dir, "broken.plain"), "***definitions***\n\n***Nope:***\n");
    const output = formatCheckResults(checkPlainTargets(dir));

    expect(output).toMatch(/^FAIL {2}broken\.plain {2}PlainSyntaxError/m);
    expect(output).toContain("        Plain syntax error");
  });

  it("counts functionalities in the pass line", () => {
    writeFileSync(join(dir, "app.plain"), VALID);
    expect(formatCheckResults(checkPlainTargets(dir))).toContain("1 functionality (1)");
  });
});
