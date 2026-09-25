import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A render lands its work as the real one does - its code, the tree, a commit - and the
 * conformance step fails for functionality 2. Only the agents are stubbed.
 */
vi.mock("../../src/render/render.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/render/render.ts")>();
  const { recordBuiltFunctionality } = await import("../../src/render/state.ts");
  const { recordHistory } = await import("../../src/render/history.ts");
  const { plainFileParser } = await import("../../src/plain/parser.ts");
  return {
    ...actual,
    renderFunctionality: async (options: { plainFile: string; frid: string; buildDir: string }) => {
      const [, tree] = plainFileParser(basename(options.plainFile), actual.resolveTemplateDirs(options.plainFile));
      mkdirSync(options.buildDir, { recursive: true });
      writeFileSync(join(options.buildDir, `fs_${options.frid}.py`), `# functionality ${options.frid}\n`);
      recordBuiltFunctionality(options.buildDir, tree, options.frid);
      recordHistory(options.buildDir, `render app fs ${options.frid}`);
      return {
        moduleName: "app", frid: options.frid, buildDir: options.buildDir, prompt: "", response: "", files: [], added: [],
        functionality: "", runs: [{ command: "true", exitCode: 0 }], passed: true, testRemovals: [],
      };
    },
  };
});
vi.mock("../../src/render/conformance.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/render/conformance.ts")>();
  return {
    ...actual,
    renderConformanceTests: async (options: { frid: string; buildDir: string; conformanceDir: string }) => {
      mkdirSync(options.conformanceDir, { recursive: true });
      writeFileSync(join(options.conformanceDir, `check_${options.frid}.sh`), `# conformance tests of functionality ${options.frid}\nexit 0\n`);
      // As the real one does: what passes is committed.
      const { recordHistory } = await import("../../src/render/history.ts");
      if (options.frid !== "2") recordHistory(options.conformanceDir, `conformance app fs ${options.frid}`);
      return {
        moduleName: "app", frid: options.frid, buildDir: options.buildDir, conformanceDir: options.conformanceDir, prompt: "", response: "",
        files: [], runs: [], passed: options.frid !== "2", codeChanged: false, testRemovals: [],
      };
    },
  };
});

const { renderModule } = await import("../../src/render/module.ts");
const { readBuiltTree } = await import("../../src/render/state.ts");
const { historyLog } = await import("../../src/render/history.ts");

let dir: string;
const code = () => join(dir, "plain_modules", "app", "code");
const tests = () => join(dir, "plain_modules", "app", "tests");

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-units-")));
  writeFileSync(
    join(dir, "app.plain"),
    "***implementation reqs***\n\n- Python.\n\n***test reqs***\n\n- Shell scripts.\n\n***functional specs***\n\n- One.\n\n- Two.\n\n- Three.\n",
  );
  mkdirSync(join(dir, "test_scripts"), { recursive: true });
  writeFileSync(join(dir, "test_scripts", "run_unittests_sh.sh"), "exit 0\n");
  writeFileSync(join(dir, "test_scripts", "run_conformance_tests_sh.sh"), 'cd "$1" || exit 2\nfor check in $(cd "$2" && find . -name "*.sh" | sort); do sh "$2/$check" || exit 1; done\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a functionality in a module build", () => {
  it("is one unit: when its conformance tests fail, its code, its tests, its tree and its commit are undone - and the one before it stays", async () => {
    const result = await renderModule({ plainFile: join(dir, "app.plain") });

    expect(result.completed).toEqual(["1"]);
    expect(result.outcomes.at(-1)).toMatchObject({ frid: "2", stoppedAt: "conformance" });
    // Functionality 1, landed.
    expect(existsSync(join(code(), "fs_1.py"))).toBe(true);
    expect(existsSync(join(tests(), "check_1.sh"))).toBe(true);
    // Functionality 2, undone.
    expect(existsSync(join(code(), "fs_2.py"))).toBe(false);
    expect(existsSync(join(tests(), "check_2.sh"))).toBe(false);
    expect((readBuiltTree(code())!["functional specs"] as Array<{ markdown: string }>).map((spec) => spec.markdown)).toEqual(["- One."]);
    expect(historyLog(code())).not.toContain("render app fs 2");
    expect(historyLog(code())).toContain("render app fs 1");
  });
});
