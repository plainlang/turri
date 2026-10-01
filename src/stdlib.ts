import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { STDLIB_DIR } from "./grow/paths.ts";

/**
 * The ***plain standard library, as the agents that write specs are told it: every stack's import name,
 * its conformance template and what it is, and where the files are - read from `stdlib/` each time, so
 * what they are told is what is there. Sorted, so the rules block it goes into is the same every turn and
 * stays cached.
 */

export interface StdlibTemplate {
  /** What a spec imports it as: `stdlib/backend/python-fastapi`. */
  name: string;
  description: string;
  text: string;
}

export function stdlibTemplates(dir: string = STDLIB_DIR): StdlibTemplate[] {
  const found: string[] = [];
  const walk = (at: string) => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(at, entry.name));
      else if (entry.name.endsWith(".plain")) found.push(join(at, entry.name));
    }
  };
  walk(dir);
  return found
    .map((file) => {
      const text = readFileSync(file, "utf8").trim();
      return {
        name: `stdlib/${relative(dir, file).split(sep).join("/").replace(/\.plain$/, "")}`,
        description: /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "",
        text,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A stack to import - not a kind's `common`, not a conformance template, and not a language's. */
export function isStack(template: StdlibTemplate): boolean {
  return !template.name.endsWith("/common") && !template.name.includes("/conformance/") && !template.name.startsWith("stdlib/lang/");
}

/** A stack's conformance template: `stdlib/backend/python-fastapi` has `stdlib/backend/conformance/python-fastapi`. */
export function conformanceOf(stack: string): string {
  const slash = stack.lastIndexOf("/");
  return `${stack.slice(0, slash)}/conformance/${stack.slice(slash + 1)}`;
}

const KINDS: Array<{ kind: string; title: string }> = [
  { kind: "backend", title: "Backends" },
  { kind: "frontend", title: "Frontends" },
  { kind: "cli", title: "Command-line tools" },
  { kind: "library", title: "Libraries" },
];

/**
 * The catalogue appended to the stdlib rule: every stack with its conformance template and what it is, the
 * shared templates, and the folder they are all in - an absolute path, so an agent reads the one it imports
 * instead of looking for it. The text of each is not in it: there are too many to carry in every prompt.
 */
export function stdlibCatalogue(templates: StdlibTemplate[] = stdlibTemplates(), dir: string = STDLIB_DIR): string {
  if (templates.length === 0) return "";
  const names = new Set(templates.map((template) => template.name));
  const row = (template: StdlibTemplate) =>
    `| \`${template.name}\` | ${names.has(conformanceOf(template.name)) ? `\`${conformanceOf(template.name)}\`` : "none"} | ${template.description} |`;
  const shared = templates.filter((template) => !isStack(template) && !template.name.includes("/conformance/") );
  return [
    "## What there is",
    "",
    `Every template is a file in ${dir}: \`stdlib/backend/python-fastapi\` is \`${dir}/backend/python-fastapi.plain\`. Read the ones a module imports - the stack, its language, its kind's \`common\`, and their conformance templates - before writing its specs.`,
    "",
    ...KINDS.flatMap(({ kind, title }) => {
      const stacks = templates.filter((template) => isStack(template) && template.name.startsWith(`stdlib/${kind}/`));
      return stacks.length === 0 ? [] : [`### ${title}`, "", "| import | its conformance tests | what it is |", "| --- | --- | --- |", ...stacks.map(row), ""];
    }),
    "### What the stacks import",
    "",
    "| template | what it is |",
    "| --- | --- |",
    ...shared.map((template) => `| \`${template.name}\` | ${template.description} |`),
  ]
    .join("\n")
    .trim();
}

/** How many stacks the standard library has, for the banner. */
export function stdlibStackCount(templates: StdlibTemplate[] = stdlibTemplates()): number {
  return templates.filter(isStack).length;
}

/** The standard library as the person reads it, with `/stdlib`: each kind's stacks, what each is, and how to import one. */
export function describeStdlib(templates: StdlibTemplate[] = stdlibTemplates(), dir: string = STDLIB_DIR): string {
  if (templates.length === 0) return "The standard library is empty: turri's stdlib/ folder holds no templates.";
  const width = Math.max(...templates.filter(isStack).map((template) => template.name.length));
  return [
    `The ***plain standard library - ${stdlibStackCount(templates)} stacks a spec can import instead of writing its implementation reqs:`,
    ...KINDS.flatMap(({ kind, title }) => {
      const stacks = templates.filter((template) => isStack(template) && template.name.startsWith(`stdlib/${kind}/`));
      return stacks.length === 0 ? [] : ["", `${title}:`, ...stacks.map((template) => `  ${template.name.padEnd(width)}  ${template.description}`)];
    }),
    "",
    "Import one in a spec's frontmatter, and its conformance tests beside it when you want them:",
    "  import:",
    "    - stdlib/backend/python-flask",
    "    - stdlib/backend/conformance/python-flask",
    "",
    `The templates are in ${dir}. Or ask - "build this as a Flask backend" - and the agent imports it.`,
  ].join("\n");
}
