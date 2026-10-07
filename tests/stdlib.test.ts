import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPlainFile } from "../src/plain/check.ts";
import { plainFileParser } from "../src/plain/parser.ts";
import { resolveTemplateDirs } from "../src/grow/paths.ts";
import { loadRules } from "../src/rules.ts";
import { conformanceOf, describeStdlib, isStack, stdlibTemplates } from "../src/stdlib.ts";
import { chatRulesBlock } from "../src/extension.ts";

let root: string;
let cwd: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turri-stdlib-"));
  cwd = process.cwd();
  // The parser reads linked resources from the process's folder, as it does in a project.
  process.chdir(root);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(root, { recursive: true, force: true });
});

const templates = stdlibTemplates();
const stacks = templates.filter(isStack);
const text = (name: string) => templates.find((template) => template.name === name)!.text;
const kindOf = (name: string) => name.split("/")[1]!;
const importing = (...names: string[]) =>
  `---\nimport:\n${names.map((name) => `  - ${name}\n`).join("")}---\n\n***definitions***\n\n- :Greeting: is the text \`hello\`.\n\n***functional specs***\n\n- The app answers with :Greeting:.\n`;
const parse = (file: string) => plainFileParser(file, resolveTemplateDirs(join(root, file)))[1];

describe("the standard library", () => {
  it("has a backend, a frontend, a command-line tool and a library, each on several stacks, all named under stdlib/ and described", () => {
    for (const name of ["stdlib/backend/python-flask", "stdlib/cli/python-typer", "stdlib/cli/python-click"]) expect(stacks.map((template) => template.name)).toContain(name);
    for (const kind of ["backend", "frontend", "cli", "library"]) {
      expect(templates.map((template) => template.name)).toEqual(expect.arrayContaining([`stdlib/${kind}/common`, `stdlib/${kind}/conformance/common`]));
      expect(stacks.filter((template) => kindOf(template.name) === kind).length).toBeGreaterThanOrEqual(2);
    }
    for (const template of templates) {
      expect(template.name).toMatch(/^stdlib\//);
      expect(template.description, template.name).not.toBe("");
    }
  });

  it.each(stacks.map((template) => template.name))("gives a spec importing %s its stack's, its language's and its kind's implementation reqs, no test reqs, and no concept of its own", (name) => {
    writeFileSync(join(root, "app.plain"), importing(name));
    const result = checkPlainFile(join(root, "app.plain"));
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    const tree = parse("app.plain");
    const reqs = (tree["implementation reqs"] ?? []).map((item) => item.markdown).join("\n");
    expect(reqs).toContain(/- :Implementation: [^\n]+/.exec(text(`stdlib/${kindOf(name)}/common`))![0]);
    expect(reqs).toContain(/- :Implementation: [^\n]+/.exec(text(name))![0]);
    const language = /stdlib\/lang\/[\w-]+/.exec(text(name))?.[0];
    expect(language, `${name} imports no stdlib/lang/ template`).toBeDefined();
    expect(reqs).toContain(/- :Implementation: [^\n]+/.exec(text(language!))![0]);
    // Conformance tests are the module's choice: without the conformance template it has none.
    expect(tree["test reqs"] ?? []).toEqual([]);
    for (const template of [name, `stdlib/${kindOf(name)}/common`, language!]) {
      expect(text(template)).not.toContain("***definitions***");
      expect(text(template)).not.toContain("***test reqs***");
    }
  });

  it.each(stacks.map((template) => template.name))("has conformance tests for %s apart, as test reqs only - its own and its kind's", (name) => {
    const conformance = conformanceOf(name);
    expect(templates.map((template) => template.name)).toContain(conformance);
    writeFileSync(join(root, "app.plain"), importing(name, conformance));
    const result = checkPlainFile(join(root, "app.plain"));
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    const tests = (parse("app.plain")["test reqs"] ?? []).map((item) => item.markdown).join("\n");
    expect(tests).toContain(/- :ConformanceTests: [^\n]+/.exec(text(`stdlib/${kindOf(name)}/conformance/common`))![0]);
    expect(text(conformance)).not.toContain("***implementation reqs***");
    expect(text(conformance)).not.toContain("***definitions***");
  });

  it.each([
    ["beside the spec", ""],
    ["in its template folder", "template"],
  ])("refuses a project module at a stdlib/ path %s - the name is reserved", (_where, folder) => {
    mkdirSync(join(root, folder, "stdlib", "backend"), { recursive: true });
    writeFileSync(join(root, folder, "stdlib", "backend", "python-fastapi.plain"), "***implementation reqs***\n\n- :Implementation: is the project's own FastAPI stack.\n");
    writeFileSync(join(root, "app.plain"), importing("stdlib/backend/python-fastapi"));
    const result = checkPlainFile(join(root, "app.plain"));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toMatch(/'stdlib\/backend\/python-fastapi' is a reserved name .* but .*stdlib\/backend\/python-fastapi\.plain is a module of that name/);
  });

  it("says a stdlib/ name it does not have is not in the standard library, whatever the project holds", () => {
    writeFileSync(join(root, "app.plain"), importing("stdlib/backend/cobol-cics"));
    const result = checkPlainFile(join(root, "app.plain"));
    expect(result.ok ? "" : result.error).toContain("the standard library has no stdlib/backend/cobol-cics");
  });

  it("leaves every other import to the project's own folders", () => {
    mkdirSync(join(root, "template", "backend"), { recursive: true });
    writeFileSync(join(root, "template", "backend", "python-fastapi.plain"), "***implementation reqs***\n\n- :Implementation: is the project's own FastAPI stack.\n");
    writeFileSync(join(root, "app.plain"), importing("backend/python-fastapi"));
    expect(parse("app.plain")["implementation reqs"]!.map((item) => item.markdown)).toEqual(["- :Implementation: is the project's own FastAPI stack."]);
  });

  it("is in the spec-writing agents' rules - every stack with its conformance template, every template they import, and the folder to read them in", () => {
    const rule = loadRules(join(cwd, "genome", "rules")).find((entry) => entry.name === "stdlib")!;
    for (const template of stacks) expect(rule.content).toContain(`| \`${template.name}\` | \`${conformanceOf(template.name)}\` | ${template.description} |`);
    for (const template of templates.filter((entry) => !isStack(entry) && !entry.name.includes("/conformance/"))) expect(rule.content).toContain(`| \`${template.name}\` | ${template.description} |`);
    expect(rule.content).toContain(`Every template is a file in ${join(cwd, "stdlib")}`);
  });

  it("is known to the conversation from its start - the inventory in its rules, every turn - and to the person with /stdlib", () => {
    const block = chatRulesBlock();
    expect(block).toContain('<rule name="stdlib">');
    const listing = describeStdlib();
    for (const template of stacks) {
      expect(block).toContain(`\`${template.name}\``);
      expect(listing).toContain(template.name);
    }
    expect(listing).toContain(`${stacks.length} stacks`);
  });

  it("names Rust and C++ paths without the double colon the concept syntax would read as a concept", () => {
    for (const template of templates) expect(template.text, template.name).not.toMatch(/\w::\w+::/);
  });
  it("gives every stack what its tests need to import and run the code - the setup an agent would otherwise go looking for", () => {
    // Every Python stack: pytest imports the package whether or not uv installs the project.
    expect(text("stdlib/lang/python")).toMatch(/\[tool\.pytest\.ini_options\][^\n]*pythonpath/);
    // A Python command-line tool: uv installs its command only from a project with a build system.
    for (const name of ["stdlib/cli/python-argparse", "stdlib/cli/python-click", "stdlib/cli/python-typer"]) {
      expect(text(name), name).toContain("declares a build system - hatchling");
      expect(text(name.replace("stdlib/cli/", "stdlib/cli/conformance/")), name).toContain("uv run --project <the built code> <tool>");
    }
    expect(text("stdlib/backend/python-django")).toContain('DJANGO_SETTINGS_MODULE = "config.settings"');
    // In-memory SQLite in tests: one connection, or every request sees an empty database; the package is not the application.
    for (const name of ["stdlib/backend/python-fastapi", "stdlib/backend/python-flask"]) {
      expect(text(name), name).toContain("`poolclass=StaticPool`");
      expect(text(name), name).toContain("anything but `app`, which is the package");
    }
    // Node.js runs what tsc emits only with NodeNext and .js imports; NestJS stays CommonJS.
    for (const name of ["stdlib/backend/typescript-express", "stdlib/backend/typescript-fastify", "stdlib/cli/typescript-commander", "stdlib/library/typescript"]) {
      expect(text(name), name).toContain("`moduleResolution` `NodeNext`");
    }
    expect(text("stdlib/backend/typescript-nestjs")).toContain("compiles to CommonJS");
    expect(text("stdlib/frontend/sveltekit-spa")).toContain('`resolve.conditions` to `["browser"]`');
    // A jar whose name the tests can run.
    expect(text("stdlib/cli/java-picocli")).toContain("maven-shade-plugin");
    expect(text("stdlib/backend/java-springboot")).toContain("<finalName>${project.artifactId}</finalName>");
    // Black-box tests start and run the software as its stack says, from wherever they are.
    expect(text("stdlib/backend/conformance/common")).toContain("exactly as its stack's implementation reqs say");
    expect(text("stdlib/cli/conformance/common")).toContain("by its absolute path in the built code");
  });
});
