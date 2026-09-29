import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { moduleLanes } from "../../src/render/lanes.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plainwright-lanes-"));
  writeFileSync(join(root, "config.yaml"), "module: asana\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const scaffold = "---\ndescription: x\n---\n\n***definitions***\n\n- :A: is a thing.\n\n***implementation reqs***\n\n- :Implementation: is TypeScript.\n";
const withSpecs = `${scaffold}\n***functional specs***\n\n- Say hello.\n`;

describe("a job's lanes", () => {
  it("are its module's folder from the first job on - the scaffold before any functional spec - so every job on the module waits for the one before", () => {
    const spec = join(root, "asana.plain");
    writeFileSync(spec, scaffold);
    const early = moduleLanes(spec);
    writeFileSync(spec, withSpecs);
    const later = moduleLanes(spec);
    expect(early).toContain(join(root, "plain_modules", "asana"));
    expect(later).toContain(join(root, "plain_modules", "asana"));
  });

  it("still hold the module's folder for a spec that does not parse", () => {
    const spec = join(root, "asana.plain");
    writeFileSync(spec, "***functional specs***\n\n- :Undefined: says hello.\n  broken indentation\n\t- here\n");
    expect(moduleLanes(spec)).toContain(join(root, "plain_modules", "asana"));
  });

  it("take in every module the spec requires", () => {
    writeFileSync(join(root, "base.plain"), withSpecs);
    writeFileSync(join(root, "app.plain"), `---\nrequires: [base]\n---\n\n***implementation reqs***\n\n- :Implementation: is TypeScript.\n\n***functional specs***\n\n- Greet.\n`);
    mkdirSync(join(root, "plain_modules"), { recursive: true });
    // The parser finds a required module from the process's folder, as it does in a project.
    const cwd = process.cwd();
    process.chdir(root);
    const lanes = moduleLanes(join(root, "app.plain"));
    process.chdir(cwd);
    expect(lanes).toEqual(expect.arrayContaining([join(root, "plain_modules", "app"), join(root, "plain_modules", "base")]));
  });
});
