import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { plainFileParser } from "../../src/plain/parser.ts";
import { recordHistory } from "../../src/render/history.ts";
import { resolveTemplateDirs } from "../../src/render/paths.ts";
import { chainTree, inheritedRecord, readRecord, RECORD_FILE, writeCodeRecord } from "../../src/render/records.ts";
import { listFiles } from "../../src/render/testing.ts";

let dir: string;
let build: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plainwright-records-"));
  build = join(dir, "build");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const items = (texts: string[]) => texts.map((markdown) => ({ markdown }));

describe("a codebase built on another's code", () => {
  const base = { definitions: items(["- :User: is a person."]), "implementation reqs": items(["- :Implementation: is Python."]), "functional specs": items(["- A :User: registers."]) };

  it("starts from that code's record as a lower module's: its definitions and reqs tagged with it, its functional specs inherited - none of its own", () => {
    expect(inheritedRecord(base, "base")).toEqual({
      definitions: [{ markdown: "- :User: is a person.", module: "base" }],
      "implementation reqs": [{ markdown: "- :Implementation: is Python.", module: "base" }],
      "required functional specs": [{ markdown: "- A :User: registers.", module: "base", frid: "1" }],
    });
  });

  it("is built from the whole chain's definitions and reqs - the lower modules' tagged, bottom first, and one the module shares with them only once", () => {
    const top = { definitions: items(["- :User: is a person.", "- :Page: is a screen."]), "implementation reqs": items(["- Uses Flask."]), "functional specs": items(["- Show a :Page:."]) };
    expect(chainTree([{ module: "base", tree: base }, { module: "top", tree: top }])).toEqual({
      definitions: [{ markdown: "- :User: is a person.", module: "base" }, { markdown: "- :Page: is a screen." }],
      "implementation reqs": [{ markdown: "- :Implementation: is Python.", module: "base" }, { markdown: "- Uses Flask." }],
      "functional specs": items(["- Show a :Page:."]),
    });
  });
});

describe("a record written by an earlier plainwright", () => {
  it("is read from a record in the earlier format, up to the first functionality that did not build", () => {
    mkdirSync(build, { recursive: true });
    writeFileSync(
      join(build, RECORD_FILE),
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
    expect(readRecord(build)).toEqual({
      "implementation reqs": [{ markdown: "- A requirement." }],
      "functional specs": [{ markdown: "- One." }],
      "required functional specs": [{ markdown: "- Base one.", acceptance_tests: [{ markdown: "- It works." }], module: "base", frid: "1" }],
    });
  });

  it("is read from a record in the first format, so an existing build is not mistaken for none", () => {
    mkdirSync(build, { recursive: true });
    writeFileSync(
      join(build, RECORD_FILE),
      JSON.stringify({
        module: "app",
        updatedAt: "2026-09-22T00:00:00.000Z",
        functionalities: {
          "1": {
            frid: "1", renderedAt: "2026-09-22T00:00:00.000Z", unitTests: "passed",
            specifications: {
              definitions: [], "implementation reqs": ["- A requirement."], "test reqs": [], "functional specs": ["- One."],
            },
          },
        },
      }),
    );

    expect(readRecord(build)).toEqual({ "implementation reqs": [{ markdown: "- A requirement." }], "functional specs": [{ markdown: "- One." }] });
  });

  it("is nothing built when it does not read", () => {
    mkdirSync(build, { recursive: true });
    writeFileSync(join(build, RECORD_FILE), "not json");
    expect(readRecord(build)).toBeNull();
  });
});

describe("the code record on disk", () => {
  it("is written without the sections it has nothing in", () => {
    writeCodeRecord(build, { definitions: [], "functional specs": [{ markdown: "- One." }] });
    expect(JSON.parse(readFileSync(join(build, RECORD_FILE), "utf8"))).toEqual({ "functional specs": [{ markdown: "- One." }] });
  });

  it("is left out of the build manifest", () => {
    mkdirSync(build, { recursive: true });
    writeFileSync(join(build, "app.py"), "print('hi')\n");
    writeCodeRecord(build, { "functional specs": [{ markdown: "- One." }] });

    expect(existsSync(join(build, RECORD_FILE))).toBe(true);
    expect(listFiles(build)).toEqual(["app.py"]);
  });

  it("is read as the harness last committed it - a change an agent's shell made to the file is not carried on", () => {
    const code = join(dir, "plain_modules", "app", "code");
    const spec = (items: string[]) => ({ "implementation reqs": [{ markdown: "- Python." }], "functional specs": items.map((markdown) => ({ markdown })) });
    writeCodeRecord(code, spec(["- Say hello."]));
    writeFileSync(join(code, "app.py"), "print('hello')\n");
    recordHistory(code, "render app fs 1");
    // An agent's shell rewrites the record mid-render: it claims a functionality nobody built.
    writeFileSync(join(code, RECORD_FILE), JSON.stringify(spec(["- Say hello.", "- Launch the rockets."])));
    expect(readRecord(code)).toEqual(spec(["- Say hello."]));
    expect(readRecord(code, { onDisk: true })!["functional specs"]).toHaveLength(2);
  });
});

describe("conformance is optional", () => {
  const NO_TEST_REQS = `***implementation reqs***\n\n- A requirement.\n\n***functional specs***\n\n- One.\n`;
  const WITH_TEST_REQS = `***implementation reqs***\n\n- A requirement.\n\n***test reqs***\n\n- Conformance tests run with pytest.\n\n***functional specs***\n\n- One.\n`;

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
