import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyRequiredCode, describeChain, requiredFunctionalSpecs, resolveRequiresChain } from "../../src/render/requires.ts";
import { isModuleUpToDate, pendingFrids, readBuiltTree, recordBuiltFunctionality } from "../../src/render/state.ts";
import { getFrids, getInheritedFunctionalSpecs, getSpecificationItems } from "../../src/plain/spec.ts";
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

    recordBuiltFunctionality(entry!.buildDir, tree, "1");
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

    const copied = copyRequiredCode(from, to, "middle", "base");

    expect(copied.sort()).toEqual(["app.py", "pkg/helper.py"]);
    expect(readFileSync(join(to, "app.py"), "utf8")).toBe("print('base')");
  });

  it("does not carry the build state across, which would claim the new build is finished", () => {
    const from = join(build, "base");
    const to = join(build, "middle");
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, "app.py"), "print('base')");
    const baseTree = plainFileParser("base.plain", resolveTemplateDirs(join(dir, "base.plain")))[1];
    recordBuiltFunctionality(from, baseTree, "1");

    copyRequiredCode(from, to, "middle", "base");

    const middleTree = plainFileParser("middle.plain", resolveTemplateDirs(join(dir, "middle.plain")))[1];
    expect(isModuleUpToDate(middleTree, to)).toBe(false);
  });

  it("copies nothing when the required build does not exist", () => {
    expect(copyRequiredCode(join(build, "nope"), join(build, "middle"), "middle", "base")).toEqual([]);
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

describe("requiredFunctionalSpecs", () => {
  it("carries every ancestor's functional specs, transitively, bottom of the chain first", () => {
    writeFileSync(join(dir, "base.plain"), spec().replace("- Do the thing.", "- Base one.\n\n- Base two."));
    writeFileSync(join(dir, "middle.plain"), spec("base").replace("- Do the thing.", "- Middle one."));

    expect(requiredFunctionalSpecs(join(dir, "top.plain"))).toEqual([
      { module: "base", frid: "1", spec: "- Base one." },
      { module: "base", frid: "2", spec: "- Base two." },
      { module: "middle", frid: "1", spec: "- Middle one." },
    ]);
  });

  it("is empty for a module that requires nothing", () => {
    expect(requiredFunctionalSpecs(join(dir, "base.plain"))).toEqual([]);
  });
});

describe("the parser's two inheritance rules", () => {
  it("requires: a module inherits every required module's functional specs, transitively, bottom first", () => {
    writeFileSync(join(dir, "base.plain"), spec().replace("- Do the thing.", "- Base one.\n\n- Base two."));
    writeFileSync(join(dir, "middle.plain"), spec("base").replace("- Do the thing.", "- Middle one."));
    const [, tree] = plainFileParser("top.plain", resolveTemplateDirs(join(dir, "top.plain")));

    expect(getInheritedFunctionalSpecs(tree).map((s) => `${s.module} ${s.frid}: ${s.spec}`)).toEqual([
      "base 1: - Base one.",
      "base 2: - Base two.",
      "middle 1: - Middle one.",
    ]);
    // Its own are numbered on their own.
    expect([...getFrids(tree)]).toEqual(["1"]);
  });

  it("counts an ancestor once when requires lists it as well", () => {
    writeFileSync(join(dir, "top.plain"), spec().replace("***implementation reqs***", "---\nrequires:\n  - base\n  - middle\n---\n\n***implementation reqs***"));
    const [, tree] = plainFileParser("top.plain", resolveTemplateDirs(join(dir, "top.plain")));
    expect(getInheritedFunctionalSpecs(tree).map((s) => s.module)).toEqual(["base", "middle"]);
  });

  it("import: a module inherits the imported module's definitions, implementation reqs and test reqs", () => {
    writeFileSync(
      join(dir, "shared.plain"),
      "***definitions***\n\n- :Thing: is a thing.\n\n***implementation reqs***\n\n- Shared req.\n\n***test reqs***\n\n- Shared test req.\n",
    );
    writeFileSync(join(dir, "user.plain"), "---\nimport:\n  - shared\n---\n\n***implementation reqs***\n\n- Own req.\n\n***functional specs***\n\n- Use :Thing:.\n");
    const [, tree] = plainFileParser("user.plain", resolveTemplateDirs(join(dir, "user.plain")));
    const md = (heading: string) => (getSpecificationItems(tree, heading) ?? []).map((item) => item.markdown);

    expect(md("definitions")).toContain("- :Thing: is a thing.");
    expect(md("implementation reqs")).toEqual(expect.arrayContaining(["- Shared req.", "- Own req."]));
    expect(md("test reqs")).toContain("- Shared test req.");
    expect(getInheritedFunctionalSpecs(tree)).toEqual([]);
  });
});

describe("the tree, when code is copied up the chain", () => {
  it("comes with the code as the new module's inheritance - and the new module has built nothing of its own", () => {
    const from = join(dir, "plain_modules", "base", "code");
    const middle = join(dir, "plain_modules", "middle", "code");
    const top = join(dir, "plain_modules", "top", "code");
    const baseTree = plainFileParser("base.plain", resolveTemplateDirs(join(dir, "base.plain")))[1];
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, "app.py"), "print('base')\n");
    recordBuiltFunctionality(from, baseTree, "1");

    copyRequiredCode(from, middle, "middle", "base");
    const carried = readBuiltTree(middle)!;
    expect(carried["functional specs"]).toBeUndefined();
    expect(carried["required functional specs"]).toEqual([{ markdown: "- Do the thing.", module: "base", frid: "1" }]);

    // And on up: what middle inherits and what it built, in the order the code was built.
    const middleTree = plainFileParser("middle.plain", resolveTemplateDirs(join(dir, "middle.plain")))[1];
    recordBuiltFunctionality(middle, middleTree, "1");
    copyRequiredCode(middle, top, "top", "middle");
    expect((readBuiltTree(top)!["required functional specs"] as Array<{ module: string; frid: string }>).map((s) => `${s.module} ${s.frid}`)).toEqual([
      "base 1",
      "middle 1",
    ]);
    // Nothing of top's own is built yet.
    const topTree = plainFileParser("top.plain", resolveTemplateDirs(join(dir, "top.plain")))[1];
    expect(pendingFrids(topTree, top).map((p) => p.frid)).toEqual(["1"]);
  });
});

describe("the conformance tests, when code is copied up the chain", () => {
  it("come with the code, into the new module's tests directory", () => {
    const from = join(build, "base", "code");
    const to = join(build, "middle", "code");
    mkdirSync(from, { recursive: true });
    writeFileSync(join(from, "app.py"), "print('base')");
    mkdirSync(join(build, "base", "tests", "auth"), { recursive: true });
    writeFileSync(join(build, "base", "tests", "auth", "test_login.py"), "def test_login(): pass\n");

    copyRequiredCode(from, to, "middle", "base");

    expect(readFileSync(join(build, "middle", "tests", "auth", "test_login.py"), "utf8")).toBe("def test_login(): pass\n");
    // The code folder holds only code.
    expect(existsSync(join(to, "tests"))).toBe(false);
  });
});
