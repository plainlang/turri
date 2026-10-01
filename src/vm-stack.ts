import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { plainFileParser } from "./plain/parser.ts";
import { resolveTemplateDirs } from "./grow/paths.ts";
import { sectionsOf } from "./grow/state.ts";

/**
 * What a project's specs need of its VM: the toolchains its implementation reqs name.
 *
 * The implementation reqs say what the code is written in and built with - "Python 3.12 and FastAPI",
 * "a React app built with Vite", "Java 21 with Spring Boot". Every build runs in the VM, so each of those
 * has to be in its image. This reads them, and says which toolchain each needs and by which word -
 * a hint for whoever manages the image, not a verdict: a req can name a technology it does not use.
 */

/** A toolchain the reqs name: its name, the Alpine package that brings it, and the words that named it. */
export interface StackNeed {
  toolchain: string;
  /** The Alpine package that holds it - what to add to an image that lacks it. */
  package: string;
  words: string[];
}

/** Words in implementation reqs, and the toolchain each means. */
const STACKS: Array<{ toolchain: string; package: string; words: RegExp }> = [
  { toolchain: "Python", package: "python3", words: /\b(python|fastapi|django|flask|pytest|pydantic|sqlalchemy|uvicorn)\b/gi },
  { toolchain: "Node", package: "nodejs", words: /\b(node(\.js)?|typescript|javascript|react|vite|next\.js|express|vue|svelte|npm|vitest|jest|playwright)\b/gi },
  { toolchain: "Java", package: "openjdk21-jdk", words: /\b(java|spring( boot)?|maven|gradle|junit|kotlin)\b/gi },
  { toolchain: "Go", package: "go", words: /\b(golang|go \d+\.\d+|go modules?|written in go)\b/gi },
  { toolchain: "Rust", package: "rust", words: /\b(rust|cargo|tokio|axum)\b/gi },
  { toolchain: "C/C++", package: "build-base", words: /(\bc\+\+|\bcmake\b|\bgcc\b|\bclang\b|\bwritten in c\b)/gi },
  { toolchain: "Zig", package: "zig", words: /\bzig\b/gi },
  { toolchain: "Odin", package: "odin", words: /\bodin\b/gi },
  { toolchain: "Ruby", package: "ruby", words: /\b(ruby|rails)\b/gi },
  { toolchain: "PHP", package: "php83", words: /\b(php|laravel|symfony)\b/gi },
  { toolchain: "Elixir", package: "elixir", words: /\b(elixir|phoenix)\b/gi },
];

/** The toolchains a text of implementation reqs names. */
export function stackOf(text: string): StackNeed[] {
  const needs: StackNeed[] = [];
  for (const stack of STACKS) {
    const words = [...new Set([...text.matchAll(stack.words)].map((match) => match[0].toLowerCase()))];
    if (words.length > 0) needs.push({ toolchain: stack.toolchain, package: stack.package, words });
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

/** What a project's modules need of the VM, and which of it an image holding `packages` lacks. */
export function stackAgainstImage(project: string, packages: string[]): Array<{ module: string; needs: StackNeed[]; missing: StackNeed[] }> {
  return projectImplementationReqs(project).map(({ module, reqs }) => {
    const needs = stackOf(reqs.join("\n"));
    return { module, needs, missing: needs.filter((need) => !packages.includes(need.package)) };
  });
}
