import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { plainFileParser } from "../../src/plain/parser.ts";
import { buildRegeneratePrompt } from "../../src/render/prompt.ts";
import { renderFunctionality, resolveTemplateDirs } from "../../src/render/render.ts";
import { recordBuiltFunctionality } from "../../src/render/state.ts";

let dir: string;
let build: string;
const plain = (two: string) =>
  `***implementation reqs***\n\n- Python.\n\n***functional specs***\n\n- One.\n\n- ${two}\n`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plainwright-redo-"));
  build = join(dir, "build");
  mkdirSync(build);
  writeFileSync(join(build, "app.py"), "x\n");
  writeFileSync(join(dir, "app.plain"), plain("Two."));
  const [, tree] = plainFileParser("app.plain", resolveTemplateDirs(join(dir, "app.plain")));
  for (const frid of ["1", "2"]) recordBuiltFunctionality(build, tree, frid);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const prompt = async () =>
  (await renderFunctionality({ plainFile: join(dir, "app.plain"), frid: "2", buildDir: build, dryRun: true, regenerate: {} }))
    .prompt;

describe("regenerating a functionality whose spec has not changed", () => {
  it("is recognised as a redo, not a change of nothing", async () => {
    const text = await prompt();
    expect(text).toContain("is to be regenerated. Its spec has not changed since it was built.");
    expect(text).toContain("Replace its code rather than patching it");
    expect(text).not.toContain('version="as built"');
  });

  it("is still a change when the spec did move", async () => {
    writeFileSync(join(dir, "app.plain"), plain("Two, changed."));
    const text = await prompt();
    expect(text).toContain("has changed since it was built");
    expect(text).toContain('<functionality id="2" version="as built">\n- Two.\n</functionality>');
  });
});

describe("the redo prompt on its own", () => {
  it("keeps the functionality's interface to the rest of the code", () => {
    const text = buildRegeneratePrompt({
      moduleName: "app", frid: "2", linkedResources: [], unchanged: true, implemented: [{ module: "app", frid: "1", spec: "- One." }],
      specifications: { definitions: [], "implementation reqs": [], "test reqs": [], "functional specs": ["- One.", "- Two."] },
    });
    expect(text).toContain("Keep its interface");
    expect(text).toContain("Rewrite the unit tests for this functionality from its spec.");
    expect(text).toContain('<functionality module="app" id="1" status="implemented">');
  });
});
