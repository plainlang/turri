import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { plainFileParser } from "../../src/plain/parser.ts";
import { listFiles } from "../../src/render/testing.ts";
import { resolveTemplateDirs } from "../../src/render/render.ts";
import {
  describePending,
  inheritBuiltTree,
  isModuleUpToDate,
  pendingFrids,
  readBuiltTree,
  recordBuiltFunctionality,
  specStateFor,
  STATE_FILE,
  withBuiltFunctionality,
  writeBuiltTree,
} from "../../src/render/state.ts";

let dir: string;
let build: string;

const THREE = `***implementation reqs***

- A requirement.

***functional specs***

- One.

- Two.

- Three.
`;

function tree(source = THREE) {
  writeFileSync(join(dir, "app.plain"), source);
  return plainFileParser("app.plain", resolveTemplateDirs(join(dir, "app.plain")))[1];
}

function build_(t: ReturnType<typeof tree>, frid: string) {
  recordBuiltFunctionality(build, t, frid);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plainwright-state-"));
  build = join(dir, "build");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("what needs building", () => {
  it("is everything when nothing has been built", () => {
    const t = tree();
    expect(pendingFrids(t, build).map((p) => p.frid)).toEqual(["1", "2", "3"]);
    expect(pendingFrids(t, build)[0]!.reason).toBe("never built");
  });

  it("stops at the functionality asked for, inclusive", () => {
    const t = tree();
    expect(pendingFrids(t, build, "2").map((p) => p.frid)).toEqual(["1", "2"]);
  });

  it("skips what is already built from the same specification", () => {
    const t = tree();
    build_(t, "1");
    expect(pendingFrids(t, build, "2").map((p) => p.frid)).toEqual(["2"]);
  });

  it("is written per functionality, so a part-built module resumes where it stopped", () => {
    const t = tree();
    build_(t, "1");
    build_(t, "2");
    // Functionality 3 never ran: the module is part-built, not unbuilt.
    expect(pendingFrids(t, build).map((p) => p.frid)).toEqual(["3"]);
    expect(isModuleUpToDate(t, build)).toBe(false);
  });

  it("rebuilds a functionality whose specification changed", () => {
    const t = tree();
    build_(t, "1");
    build_(t, "2");
    build_(t, "3");
    expect(isModuleUpToDate(t, build)).toBe(true);

    const changed = tree(THREE.replace("- Two.", "- Two, but differently."));
    const pending = pendingFrids(changed, build);

    // Only 2 itself changed. 3 was rendered with the old 2 in its context, but 3's own spec
    // is the same, so it is left alone - the regression suite checks it still works.
    expect(pending.map((p) => p.frid)).toEqual(["2"]);
    expect(pending[0]!.reason).toBe("specification changed");
  });

  it("does not rebuild anything when only the reqs around the specs change", () => {
    const t = tree();
    for (const frid of ["1", "2", "3"]) build_(t, frid);
    const changed = tree(THREE.replace("***implementation reqs***\n", "***implementation reqs***\n\n- Log every request.\n"));
    expect(pendingFrids(changed, build)).toEqual([]);
  });

  it("rejects a functionality that does not exist", () => {
    expect(() => pendingFrids(tree(), build, "9")).toThrow("Functionality 9 does not exist");
  });
});

describe("the tree the code is built from", () => {
  const SPEC = `***definitions***

- :User: is a person.

- :Order: is something a :User: bought.

- :Refund: is money back for an :Order:.

***implementation reqs***

- Python.

- :Refund: is paid out within a day.

***functional specs***

- A :User: can sign up.

- A :User: can see an :Order:.

- A :User: can ask for a :Refund:.
`;

  it("is all the file holds, as JSON", () => {
    const t = tree(SPEC);
    build_(t, "1");
    const stored = JSON.parse(readFileSync(join(build, STATE_FILE), "utf8"));
    expect(Object.keys(stored).sort()).toEqual(["definitions", "functional specs", "implementation reqs"]);
    expect(stored["functional specs"]).toEqual([{ markdown: "- A :User: can sign up." }]);
    expect(readBuiltTree(build)).toEqual(stored);
  });

  it("starts with the spec's sections and the first functional spec - the first build is built with all of them", () => {
    const t = tree(SPEC);
    const built = withBuiltFunctionality(null, t, "1");
    expect(built["implementation reqs"]).toEqual(t["implementation reqs"]);
    expect(built.definitions).toEqual(t.definitions);
    expect(built["functional specs"]).toEqual([(t["functional specs"] as unknown[])[0]]);
  });

  it("then gains each functional spec, with the definitions and reqs it is the first to need - and keeps what was built as built", () => {
    // The first build: a spec that had only its first functional spec, and what that needs.
    const first = tree("***definitions***\n\n- :User: is a person.\n\n***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n- A :User: can sign up.\n");
    let built = withBuiltFunctionality(null, first, "1");
    expect((built.definitions as Array<{ markdown: string }>).map((d) => d.markdown)).toEqual(["- :User: is a person."]);

    // Since the first build, :User:'s definition changed and two concepts came in.
    const now = tree(SPEC.replace("- :User: is a person.", "- :User: is a person with an email."));
    built = withBuiltFunctionality(built, now, "2");
    expect((built.definitions as Array<{ markdown: string }>).map((d) => d.markdown)).toEqual([
      // As built: the change to :User: is not built yet.
      "- :User: is a person.",
      "- :Order: is something a :User: bought.",
    ]);
    // The refund req names a concept functionality 2 did not bring.
    expect((built["implementation reqs"] as Array<{ markdown: string }>).map((r) => r.markdown)).toEqual(["- Python."]);

    built = withBuiltFunctionality(built, now, "3");
    expect((built.definitions as Array<{ markdown: string }>).map((d) => d.markdown)).toEqual([
      "- :User: is a person.",
      "- :Order: is something a :User: bought.",
      "- :Refund: is money back for an :Order:.",
    ]);
    expect((built["implementation reqs"] as Array<{ markdown: string }>).map((r) => r.markdown)).toEqual(["- Python.", "- :Refund: is paid out within a day."]);
    expect((built["functional specs"] as unknown[]).length).toBe(3);
  });

  it("replaces a functional spec rebuilt from a changed spec, in its place", () => {
    const t = tree();
    for (const frid of ["1", "2", "3"]) build_(t, frid);
    const changed = tree(THREE.replace("- Two.", "- Two, reworded."));
    build_(changed, "2");
    expect((readBuiltTree(build)!["functional specs"] as Array<{ markdown: string }>).map((s) => s.markdown)).toEqual(["- One.", "- Two, reworded.", "- Three."]);
  });

  it("comes with the code into a module built on it, as what that module inherits", () => {
    const t = tree();
    build_(t, "1");
    build_(t, "2");
    const next = join(dir, "next");
    inheritBuiltTree(build, next, "app");
    const inherited = readBuiltTree(next)!;
    expect(inherited["functional specs"]).toBeUndefined();
    expect(inherited["required functional specs"]).toEqual([
      { markdown: "- One.", module: "app", frid: "1" },
      { markdown: "- Two.", module: "app", frid: "2" },
    ]);
  });

  it("is read from a record in the earlier format, up to the first functionality that did not build", () => {
    const t = tree();
    mkdirSync(build, { recursive: true });
    writeFileSync(
      join(build, STATE_FILE),
      JSON.stringify({
        version: 2,
        module: "app",
        updatedAt: "2026-09-22T00:00:00.000Z",
        definitions: [],
        "implementation reqs": ["- A requirement."],
        "test reqs": [],
        "functional specs": [
          { module: "base", frid: "1", spec: "- Base one.", "acceptance tests": ["- It works."] },
          { module: "app", frid: "1", spec: "- One.", unitTests: "passed" },
          { module: "app", frid: "2", spec: "- Two.", unitTests: "failed" },
          { module: "app", frid: "3", spec: "- Three.", unitTests: "passed" },
        ],
      }),
    );
    expect(readBuiltTree(build)).toEqual({
      "implementation reqs": [{ markdown: "- A requirement." }],
      "functional specs": [{ markdown: "- One." }],
      "required functional specs": [{ markdown: "- Base one.", acceptance_tests: [{ markdown: "- It works." }], module: "base", frid: "1" }],
    });
    expect(pendingFrids(t, build).map((p) => [p.frid, p.reason])).toEqual([["2", "never built"], ["3", "never built"]]);
  });

  it("is read from a record in the first format, so an existing build is not mistaken for none", () => {
    const t = tree();
    const { specHash } = specStateFor(t, "1");
    mkdirSync(build, { recursive: true });
    writeFileSync(
      join(build, STATE_FILE),
      JSON.stringify({
        module: "app",
        updatedAt: "2026-09-22T00:00:00.000Z",
        functionalities: {
          "1": {
            frid: "1", specHash, renderedAt: "2026-09-22T00:00:00.000Z", unitTests: "passed",
            specifications: {
              definitions: [], "implementation reqs": ["- A requirement."], "test reqs": [], "functional specs": ["- One."],
            },
          },
        },
      }),
    );

    expect(pendingFrids(t, build, "1")).toEqual([]);
    expect(readBuiltTree(build)!["implementation reqs"]).toEqual([{ markdown: "- A requirement." }]);
  });

  it("is nothing built when there is no file, or it does not read", () => {
    const t = tree();
    expect(readBuiltTree(build)).toBeNull();
    mkdirSync(build, { recursive: true });
    writeFileSync(join(build, STATE_FILE), "not json");
    expect(readBuiltTree(build)).toBeNull();
    expect(pendingFrids(t, build)).toHaveLength(3);
  });

  it("is written without the sections it has nothing in", () => {
    writeBuiltTree(build, { definitions: [], "functional specs": [{ markdown: "- One." }] });
    expect(JSON.parse(readFileSync(join(build, STATE_FILE), "utf8"))).toEqual({ "functional specs": [{ markdown: "- One." }] });
  });
});

describe("describePending", () => {
  it("names each functionality and why it is pending", () => {
    const t = tree();
    build_(t, "1");
    const changed = tree(THREE.replace("- One.", "- One, changed."));
    expect(describePending(pendingFrids(changed, build, "2"))).toBe("1 (specification changed), 2 (never built)");
  });

  it("says so when there is nothing to do", () => {
    expect(describePending([])).toBe("everything is up to date");
  });
});

describe("conformance is optional", () => {
  const NO_TEST_REQS = `***implementation reqs***\n\n- A requirement.\n\n***functional specs***\n\n- One.\n`;
  const WITH_TEST_REQS = `***implementation reqs***\n\n- A requirement.\n\n***test reqs***\n\n- Conformance tests run with pytest.\n\n***functional specs***\n\n- One.\n`;

  it("is off by default for a module with no test reqs", async () => {
    const { renderModule } = await import("../../src/render/module.ts");
    writeFileSync(join(dir, "app.plain"), NO_TEST_REQS);

    // Asking for it anyway is refused rather than guessed at.
    await expect(
      renderModule({ plainFile: join(dir, "app.plain"), buildDir: build, conformance: true }),
    ).rejects.toThrow(/has no test reqs/);
  });

  it("refuses to write conformance tests without test reqs", async () => {
    const { renderConformanceTests } = await import("../../src/render/conformance.ts");
    writeFileSync(join(dir, "app.plain"), NO_TEST_REQS);
    writeFileSync(join(build_dir(), "placeholder.txt"), "code");

    await expect(
      renderConformanceTests({ plainFile: join(dir, "app.plain"), frid: "1", buildDir: build, dryRun: true }),
    ).rejects.toThrow(/has no test reqs/);
  });

  it("is available when the module has test reqs", () => {
    writeFileSync(join(dir, "app.plain"), WITH_TEST_REQS);
    const t = plainFileParser("app.plain", resolveTemplateDirs(join(dir, "app.plain")))[1];
    expect(t["test reqs"]).toHaveLength(1);
  });

  function build_dir() {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(build, { recursive: true });
    return build;
  }
});

describe("the state file is not part of the codebase", () => {
  it("is left out of the build manifest", () => {
    mkdirSync(build, { recursive: true });
    writeFileSync(join(build, "app.py"), "print('hi')\n");
    build_(tree(), "1");

    expect(existsSync(join(build, STATE_FILE))).toBe(true);
    expect(listFiles(build)).toEqual(["app.py"]);
  });
});
