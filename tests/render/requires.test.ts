import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyRequiredCode, describeChain, resolveRequiresChain } from "../../src/render/requires.ts";
import { isModuleUpToDate, recordFunctionality, specStateFor } from "../../src/render/state.ts";
import { plainFileParser } from "../../src/plain/parser.ts";
import { resolveTemplateDirs } from "../../src/render/render.ts";

let dir: string;
let build: string;

const spec = (requires?: string) =>
  `${requires ? `---\nrequires:\n  - ${requires}\n---\n\n` : ""}***implementation reqs***\n\n- A requirement.\n\n***functional specs***\n\n- Do the thing.\n`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plainwright-requires-"));
  build = join(dir, "build");
  // bottom -> top: base <- middle <- top
  writeFileSync(join(dir, "base.plain"), spec());
  writeFileSync(join(dir, "middle.plain"), spec("base"));
  writeFileSync(join(dir, "top.plain"), spec("middle"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveRequiresChain", () => {
  it("returns the chain bottom first", () => {
    const chain = resolveRequiresChain(join(dir, "top.plain"), [], build);
    expect(chain.map((e) => e.moduleName)).toEqual(["base", "middle", "top"]);
  });

  it("says whose code each module is built on top of", () => {
    const chain = resolveRequiresChain(join(dir, "top.plain"), [], build);
    expect(chain.map((e) => e.requires)).toEqual([null, "base", "middle"]);
  });

  it("gives each module its own build directory", () => {
    const chain = resolveRequiresChain(join(dir, "top.plain"), [], build);
    expect(chain.map((e) => e.buildDir)).toEqual([
      join(build, "base", "code"),
      join(build, "middle", "code"),
      join(build, "top", "code"),
    ]);
  });

  it("is just the module itself when nothing is required", () => {
    expect(resolveRequiresChain(join(dir, "base.plain"), [], build).map((e) => e.moduleName)).toEqual(["base"]);
  });

  it("reports a required module that does not exist", () => {
    writeFileSync(join(dir, "orphan.plain"), spec("missing"));
    // The parser resolves requires itself, so it rejects this before the chain walk does.
    expect(() => resolveRequiresChain(join(dir, "orphan.plain"), [], build)).toThrow(
      "Module does not exist (missing).",
    );
  });
});

describe("build state", () => {
  const treeFor = (file: string) =>
    plainFileParser(`${file}.plain`, resolveTemplateDirs(join(dir, `${file}.plain`)))[1];

  it("counts a module as built only when every functionality is recorded", () => {
    const [entry] = resolveRequiresChain(join(dir, "base.plain"), [], build);
    const tree = treeFor("base");
    expect(isModuleUpToDate(tree, entry!.buildDir)).toBe(false);

    recordFunctionality(entry!.buildDir, "base", {
      frid: "1",
      ...specStateFor(tree, "1"),
      unitTests: "passed",
    });
    expect(isModuleUpToDate(tree, entry!.buildDir)).toBe(true);
  });
});

describe("copyRequiredCode", () => {
  it("copies the required module's codebase into the new build", () => {
    const from = join(build, "base");
    const to = join(build, "middle");
    mkdirSync(join(from, "pkg"), { recursive: true });
    writeFileSync(join(from, "app.py"), "print('base')");
    writeFileSync(join(from, "pkg", "helper.py"), "x = 1");

    const copied = copyRequiredCode(from, to);

    expect(copied.sort()).toEqual(["app.py", "pkg/helper.py"]);
    expect(readFileSync(join(to, "app.py"), "utf8")).toBe("print('base')");
  });

  it("does not carry the build state across, which would claim the new build is finished", () => {
    const from = join(build, "base");
    const to = join(build, "middle");
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, "app.py"), "print('base')");
    const baseTree = plainFileParser("base.plain", resolveTemplateDirs(join(dir, "base.plain")))[1];
    recordFunctionality(from, "base", { frid: "1", ...specStateFor(baseTree, "1"), unitTests: "passed" });

    copyRequiredCode(from, to);

    const middleTree = plainFileParser("middle.plain", resolveTemplateDirs(join(dir, "middle.plain")))[1];
    expect(isModuleUpToDate(middleTree, to)).toBe(false);
  });

  it("copies nothing when the required build does not exist", () => {
    expect(copyRequiredCode(join(build, "nope"), join(build, "middle"))).toEqual([]);
  });
});

describe("describeChain", () => {
  it("shows the order, the counts and where the code comes from", () => {
    const text = describeChain(resolveRequiresChain(join(dir, "top.plain"), [], build));
    expect(text).toContain("1. base");
    expect(text).toContain("3. top");
    expect(text).toContain("code from middle");
  });
});
