import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { projectDirOf } from "./paths.ts";

/**
 * How the person wants the queue planned - which functional specs go together, what goes first, how big a job is -
 * given to the planner's agents with every plan, as a strong preference.
 *
 * It comes from three places. The conversation sets it (`steer_queue`), for the whole project or one module, and it
 * holds for the session. The project's AGENTS.md can say it once for good: a section whose heading names the queue
 * ("## Queue guidance") is read with every plan, so an edit to it holds from the next. And whatever queues work can
 * pass guidance for that work (a tool's `guidance`), which the queue keeps with it.
 */

/** Everything the conversation's steering applies to: every module of the project. */
export const EVERY_MODULE = "*";

export interface SteeringStore {
  /** The steering for a scope - a module's name, or EVERY_MODULE - in the order it was given. */
  get(scope: string): string[];
  set(scope: string, texts: string[]): void;
  scopes(): string[];
}

export function createSteeringStore(): SteeringStore {
  const byScope = new Map<string, string[]>();
  return {
    get: (scope) => [...(byScope.get(scope) ?? [])],
    set(scope, texts) {
      if (texts.length === 0) byScope.delete(scope);
      else byScope.set(scope, [...texts]);
    },
    scopes: () => [...byScope.keys()],
  };
}

/** A module's name as the steering names it: its spec file's name, without `.plain`. */
export function moduleNameOf(plainFile: string): string {
  return basename(plainFile, extname(plainFile));
}

/**
 * What an AGENTS.md says of the queue: every section whose heading names it - "Queue", "Queue guidance", "How the
 * render queue is planned" - up to the next heading of its level or above. Empty when there is none.
 */
export function queueSectionOf(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let level = 0;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const depth = heading[1]!.length;
      if (level > 0 && depth <= level) level = 0;
      if (level === 0 && /\bqueue/i.test(heading[2]!)) {
        level = depth;
        continue;
      }
    }
    if (level > 0) out.push(line);
  }
  return out.join("\n").trim();
}

/** The AGENTS.md files a spec's steering is read from: where plainwright runs, and the spec's project - once each. */
function agentsFiles(plainFile: string, cwd: string): string[] {
  const dirs = [resolve(cwd), projectDirOf(resolve(cwd, plainFile))];
  return [...new Set(dirs.map((dir) => join(dir, "AGENTS.md")))].filter((file) => existsSync(file));
}

/** The steering a plan of this spec's codebase follows - AGENTS.md's, then the conversation's for every module and for this one. */
export function steeringFor(plainFile: string, cwd: string, store: SteeringStore): Steering[] {
  const fromFiles = agentsFiles(plainFile, cwd).flatMap((file) => {
    try {
      const text = queueSectionOf(readFileSync(file, "utf8"));
      return text === "" ? [] : [{ source: `AGENTS.md (${basename(dirname(file))})`, text }];
    } catch {
      return [];
    }
  });
  const module = moduleNameOf(plainFile);
  return [
    ...fromFiles,
    ...store.get(EVERY_MODULE).map((text) => ({ source: "the conversation", text })),
    ...store.get(module).map((text) => ({ source: `the conversation, for ${module}`, text })),
  ];
}

/** How the person or the harness wants the queue planned: a strong preference, each with where it came from. */
export interface Steering {
  source: string;
  text: string;
}

/** The steering, for an agent's task: each with where it came from, and how binding it is. */
export function steeringBlock(steering: Steering[] | undefined): string[] {
  if (steering === undefined || steering.length === 0) return [];
  return [
    "<how the queue is to be planned - the person's or the harness's wishes>",
    ...steering.map((entry) => `<from source="${entry.source}">\n${entry.text.trim()}\n</from>`),
    "</how the queue is to be planned>",
    "Follow these as a strong preference: they say how the person wants the work cut and ordered. They never override the",
    "limits and checks the plan is held to; where one would, keep to the limit, and say so where you give your answer.",
    "",
  ];
}
