import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { plainFileParser } from "../../src/plain/parser.ts";
import { listFiles } from "../../src/render/testing.ts";
import { resolveTemplateDirs } from "../../src/render/render.ts";
import {
  describePending,
  isModuleUpToDate,
  pendingFrids,
  readState,
  recordFunctionality,
  specStateFor,
  STATE_FILE,
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

function build_(t: ReturnType<typeof tree>, frid: string, status: "passed" | "failed" = "passed") {
  recordFunctionality(build, "app", { frid, ...specStateFor(t, frid), unitTests: status });
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

  it("rebuilds a functionality whose unit tests were failing", () => {
    const t = tree();
    build_(t, "1", "failed");
    expect(pendingFrids(t, build, "1")[0]!.reason).toBe("unit tests were failing");
  });
});

describe("the state file", () => {
  it("stores the shared sections once and each functional spec as it is built", () => {
    const t = tree();
    build_(t, "1");
    build_(t, "2");

    const stored = JSON.parse(readFileSync(join(build, STATE_FILE), "utf8"));
    expect(stored.version).toBe(2);
    expect(stored["implementation reqs"]).toEqual(["- A requirement."]);
    expect(stored["functional specs"].map((e: { frid: string; spec: string }) => [e.frid, e.spec])).toEqual([
      ["1", "- One."],
      ["2", "- Two."],
    ]);
    expect(stored["functional specs"][1].specHash).toHaveLength(64);
    expect(stored["functional specs"][1].renderedAt).toMatch(/^\d{4}-/);
    // No per-functionality copy of the whole context any more.
    expect(stored["functional specs"][1].specifications).toBeUndefined();
  });

  it("puts the required modules' functional specs first, without build details", () => {
    const t = tree();
    recordFunctionality(build, "app", {
      frid: "1", ...specStateFor(t, "1"), unitTests: "passed",
      required: [
        { module: "c", frid: "1", spec: "- From c." },
        { module: "b", frid: "1", spec: "- From b.", acceptanceTests: ["- b works."] },
      ],
    });

    const stored = JSON.parse(readFileSync(join(build, STATE_FILE), "utf8"));
    expect(stored["functional specs"]).toEqual([
      { module: "c", frid: "1", spec: "- From c." },
      { module: "b", frid: "1", spec: "- From b.", "acceptance tests": ["- b works."] },
      expect.objectContaining({ module: "app", frid: "1", spec: "- One.", unitTests: "passed" }),
    ]);
    const state = readState(build)!;
    expect(state.required.map((r) => r.module)).toEqual(["c", "b"]);
    expect(Object.keys(state.functionalities)).toEqual(["1"]);
  });

  it("reads a build recorded in the first format, so it is not mistaken for unbuilt", () => {
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
    expect(readState(build)!.sections["implementation reqs"]).toEqual(["- A requirement."]);
  });

  it("updates one functionality without disturbing the others", () => {
    const t = tree();
    build_(t, "1");
    build_(t, "2");
    recordFunctionality(build, "app", {
      frid: "1",
      ...specStateFor(t, "1"),
      unitTests: "passed",
      conformance: "passed",
    });

    const state = readState(build)!;
    expect(Object.keys(state.functionalities).sort()).toEqual(["1", "2"]);
    expect(state.functionalities["1"]!.conformance).toBe("passed");
    expect(state.functionalities["2"]!.conformance).toBeUndefined();
  });

  it("lives beside the code it describes", () => {
    const t = tree();
    build_(t, "1");
    expect(JSON.parse(readFileSync(join(build, STATE_FILE), "utf8")).module).toBe("app");
  });

  it("treats an unreadable state file as nothing built", () => {
    writeFileSync(join(dir, "app.plain"), THREE);
    const t = tree();
    rmSync(build, { recursive: true, force: true });
    expect(readState(build)).toBeNull();
    expect(pendingFrids(t, build)).toHaveLength(3);
  });

  it("rejects a functionality that does not exist", () => {
    expect(() => pendingFrids(tree(), build, "9")).toThrow("Functionality 9 does not exist");
  });
});

describe("describePending", () => {
  it("names each functionality and why it is pending", () => {
    const t = tree();
    build_(t, "1", "failed");
    expect(describePending(pendingFrids(t, build, "2"))).toBe(
      "1 (unit tests were failing), 2 (never built)",
    );
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
    recordFunctionality(build, "demo", {
      frid: "1",
      specHash: "h",
      specifications: {},
      unitTests: "passed",
    });

    expect(existsSync(join(build, STATE_FILE))).toBe(true);
    expect(listFiles(build)).toEqual(["app.py"]);
  });
});
