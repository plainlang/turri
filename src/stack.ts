import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { plainFileParser } from "./plain/parser.ts";
import { resolveTemplateDirs } from "./grow/paths.ts";
import { sectionsOf } from "./grow/state.ts";
import { onThisMachine } from "./grow/test-scripts.ts";

/**
 * What a project's specs need of this machine: the toolchains its implementation reqs name, and whether the machine
 * has them - the agents use this machine's toolchains and install none.
 *
 * The implementation reqs say what the code is written in and built with - "Python 3.12 and FastAPI", "a React app
 * built with Vite", "Java 21 with Spring Boot". This reads them, and says which toolchain each needs and by which word -
 * a hint for the person, not a verdict: a req can name a technology it does not use.
 */

/** A toolchain the reqs name: its name, the commands any one of which shows it is there, and the words that named it. */
export interface StackNeed {
  toolchain: string;
  commands: string[];
  words: string[];
}

/** Words in implementation reqs, and the toolchain each means. */
const STACKS: Array<{ toolchain: string; commands: string[]; words: RegExp }> = [
  { toolchain: "Python", commands: ["python3", "python"], words: /\b(python|fastapi|django|flask|pytest|pydantic|sqlalchemy|uvicorn)\b/gi },
  { toolchain: "Node", commands: ["node"], words: /\b(node(\.js)?|typescript|javascript|react|vite|next\.js|express|vue|svelte|npm|vitest|jest|playwright)\b/gi },
  { toolchain: "Java", commands: ["java"], words: /\b(java|spring( boot)?|maven|gradle|junit|kotlin)\b/gi },
  { toolchain: "Go", commands: ["go"], words: /\b(golang|go \d+\.\d+|go modules?|written in go)\b/gi },
  { toolchain: "Rust", commands: ["cargo"], words: /\b(rust|cargo|tokio|axum)\b/gi },
  { toolchain: "C/C++", commands: ["cc", "gcc", "clang"], words: /(\bc\+\+|\bcmake\b|\bgcc\b|\bclang\b|\bwritten in c\b)/gi },
  { toolchain: "Zig", commands: ["zig"], words: /\bzig\b/gi },
  { toolchain: "Odin", commands: ["odin"], words: /\bodin\b/gi },
  { toolchain: "Ruby", commands: ["ruby"], words: /\b(ruby|rails)\b/gi },
  { toolchain: "PHP", commands: ["php"], words: /\b(php|laravel|symfony)\b/gi },
  { toolchain: "Elixir", commands: ["elixir"], words: /\b(elixir|phoenix)\b/gi },
];

/** The toolchains a text of implementation reqs names. */
export function stackOf(text: string): StackNeed[] {
  const needs: StackNeed[] = [];
  for (const stack of STACKS) {
    const words = [...new Set([...text.matchAll(stack.words)].map((match) => match[0].toLowerCase()))];
    if (words.length > 0) needs.push({ toolchain: stack.toolchain, commands: stack.commands, words });
  }
  return needs;
}

/** The implementation reqs of every module in a project's folder, as the parser has them - imports in. */
export function projectImplementationReqs(project: string): Array<{ module: string; reqs: string[] }> {
  let files: string[];
  try {
    files = readdirSync(project).filter((name) => name.endsWith(".plain"));
  } catch {
    return [];
  }
  const modules: Array<{ module: string; reqs: string[] }> = [];
  for (const name of files) {
    const path = join(project, name);
    try {
      const [module, tree] = plainFileParser(basename(path), resolveTemplateDirs(path), { allowNoFunctionalities: true });
      modules.push({ module, reqs: sectionsOf(tree)["implementation reqs"] });
    } catch {
      // A file that does not parse, or an import module read on its own, names nothing here.
    }
  }
  return modules;
}

/** Whether a command is on this machine's PATH. */
const onPath = (command: string) => onThisMachine(command) !== undefined;

/** What a project's modules need of this machine, and which of it the machine lacks. */
export function stackOnMachine(project: string, has: (command: string) => boolean = onPath): Array<{ module: string; needs: StackNeed[]; missing: StackNeed[] }> {
  return projectImplementationReqs(project).map(({ module, reqs }) => {
    const needs = stackOf(reqs.join("\n"));
    return { module, needs, missing: needs.filter((need) => !need.commands.some(has)) };
  });
}

/** The toolchain commands a testing script is checked for. */
const SCRIPT_COMMANDS = new Set([
  "python3", "python", "pip", "pip3", "pytest", "uv", "poetry", "node", "npm", "npx", "yarn", "pnpm", "bun", "deno", "java", "javac",
  "mvn", "gradle", "go", "cargo", "rustc", "cc", "gcc", "clang", "make", "cmake", "zig", "ruby", "bundle", "php", "composer", "elixir",
  "mix", "dotnet", "flutter", "dart", "swift",
]);

/** Folders of the system a script names a program in by its whole path. */
const SYSTEM_PATH = /(?:^|[\s"'`$(=])(\/(?:usr|opt|Library|Applications|bin|sbin|lib|etc)\/[\w.+/-]+)/g;

/**
 * What in a testing script this machine does not have: a program named by a whole path that is not there - a
 * macOS-only `/usr/libexec/java_home` on Linux - and a toolchain it runs that is not on the PATH. The script is the
 * person's: this is for them to fix, before an agent ever sees it fail.
 */
export function scriptAgainstMachine(
  text: string,
  machine: { has?: (command: string) => boolean; exists?: (path: string) => boolean } = {},
): string[] {
  const has = machine.has ?? onPath;
  const exists = machine.exists ?? existsSync;
  const found: string[] = [];
  const lines = text.split("\n").map((line) => line.replace(/(^|\s)#.*$/, ""));
  for (const line of lines) {
    for (const match of line.matchAll(SYSTEM_PATH)) {
      const path = match[1]!;
      if (!exists(path) && !found.some((item) => item.includes(`\`${path}\``))) found.push(`names \`${path}\`, which this machine does not have`);
    }
    for (const part of line.split(/&&|\|\||[;|]|\$\(|`/)) {
      const words = part.trim().split(/\s+/).filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) && word !== "exec" && word !== "export" && word !== "timeout" && !/^\d+[smh]?$/.test(word));
      const command = words[0];
      if (command === undefined || !SCRIPT_COMMANDS.has(command) || has(command)) continue;
      const said = `runs \`${command}\`, which is not on this machine's PATH`;
      if (!found.includes(said)) found.push(said);
    }
  }
  return found;
}

/** A testing script's text, or nothing when it cannot be read. */
export function readScript(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
