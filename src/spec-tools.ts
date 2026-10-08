import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { IMPORT_DIRECTIVE, PLAIN_SOURCE_FILE_EXTENSION, plainFileParser, readPlainSourceMetadata } from "./plain/parser.ts";
import { resolveTemplateDirs } from "./grow/paths.ts";
import { applySpecDiff, plainFilesOf, revertSpecDiff } from "./grow/regrow.ts";
import { MissingFunctionalitiesError } from "./plain/errors.ts";
import { describeModules, type WorkLoop } from "./grow/loop.ts";
import { reviewNote, type LiveReviewer } from "./tools.ts";

/** Whether a question has been answered since the last new spec change was written. */
export interface SpecPace {
  answered(): void;
}

type AnyTool = ToolDefinition<any, any, any>;

/**
 * Writing a spec change as a diff, and building it, as one step.
 *
 * In an interview whose unit of work is a spec change, every change is meant to be built the
 * moment it is written. Left to two tool calls - change the file, then start the render - the
 * second is the one that gets forgotten, and nothing notices. So the diff is applied and its
 * build queued in the same call: a change cannot reach the specs without its render being
 * started. A new change needs an answer since the last one; a correction does not.
 */
export function createSpecDiffTools(options: {
  loop: WorkLoop;
  cwd: string;
  liveReview?: LiveReviewer;
  /** One new change per answer (the default); false, for a skill that writes the specs on its own. */
  paced?: boolean;
}): { tools: AnyTool[]; pace: SpecPace } {
  const { loop, cwd, liveReview } = options;
  const paced = options.paced !== false;
  let answeredSinceLastDiff = true;

  const writeDiff = defineTool({
    name: "write_spec_diff",
    label: "Write spec diff",
    description:
      "Apply a change to the ***plain specs, given as a git diff of the .plain files, and start building it in " +
      "the background. The diff is applied with git; if the specs no longer parse, it is undone and nothing is " +
      "built. Any section may change - definitions, implementation reqs, functional specs, added, changed or removed - and " +
      "every change is built, whatever it touches.",
    promptSnippet: "apply a git diff of the .plain specs and start building it",
    promptGuidelines: [
      "Every change to a .plain file in the product phase goes through write_spec_diff, as a git diff with paths relative to the project root. It writes the change and starts its build in one step.",
      paced
        ? "One change per answer, and a new one only after the user has answered a question about it. Set fixes_earlier to correct something already written."
        : "Write the changes one after another, on your own: no answer is needed between them, and none is asked for. Set fixes_earlier to correct something already written.",
      "To take something out of what is already written and queued - the user drops a page or a feature - write the diff that removes it from every spec that names it, with fixes_earlier. What is left to build is worked out from the spec each time, and a build the change undoes is stopped by itself; never stop builds to drop a change - it stays in the files.",
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "The .plain file of the module the change is built for" }),
      diff: Type.String({ description: "The change, as a git diff (diff --git a/<file> b/<file> ...)" }),
      fixes_earlier: Type.Optional(
        Type.Boolean({ description: "This corrects something already written - a contradiction, a review finding" }),
      ),
      guidance: Type.Optional(
        Type.String({
          description:
            "How to plan the queue for this change, in a sentence or two - which functional specs go together, what first - as the " +
            "user said it or as the interview settled it. A strong preference for the planner. Omit when there is none.",
        }),
      ),
    }),
    async execute(_id, params) {
      if (paced && params.fixes_earlier !== true && !answeredSinceLastDiff) {
        throw new Error(
          "No question has been answered since the last spec change. Each change comes from its own answer: ask " +
            "the user with ask_user first. To correct something already written, set fixes_earlier.",
        );
      }

      const touched = plainFilesOf(params.diff);
      if (touched.length === 0) throw new Error("The diff changes no .plain file. Nothing was written.");

      const result = applySpecDiff(params.diff, cwd);
      // A change that breaks a spec is not written at all, so nothing is ever built from a
      // file that cannot be parsed. A module with no functional specs yet is not broken. An import
      // module - definitions only, say - is not a module of its own: it is parsed as the modules
      // that import it read it, the one the change is built for among them.
      const importers = (file: string) => {
        const name = basename(file, ".plain");
        const dir = dirname(resolve(cwd, file));
        return readdirSync(dir)
          .filter((entry) => entry.endsWith(".plain"))
          .map((entry) => join(dir, entry))
          .filter((path) => {
            try {
              return ((readPlainSourceMetadata(readFileSync(path, "utf8")).metadata[IMPORT_DIRECTIVE] as string[] | undefined) ?? []).includes(name);
            } catch {
              return false;
            }
          });
      };
      const imported = importedNames(resolveTemplateDirs(resolve(cwd, params.plain_file)));
      const toParse = [
        ...new Set(
          [params.plain_file, ...touched].flatMap((file) =>
            imported.has(basename(file, ".plain")) ? importers(file).filter((path) => !imported.has(basename(path, ".plain"))) : [resolve(cwd, file)],
          ),
        ),
      ];
      for (const path of toParse) {
        const file = relative(cwd, path);
        try {
          plainFileParser(basename(path), resolveTemplateDirs(path), { allowNoFunctionalities: true });
        } catch (error) {
          if (error instanceof MissingFunctionalitiesError) continue;
          if (result === "applied") revertSpecDiff(params.diff, cwd);
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Nothing was written: with this change ${file} no longer parses. ${reason}`);
        }
      }
      if (params.fixes_earlier !== true) answeredSinceLastDiff = false;
      liveReview?.notice(`${params.plain_file}, after the change to ${touched.join(", ")}`);

      // In the files, the change is work: the loop works out what is left to build and plans it.
      const statuses = await loop.bringUp(params.plain_file, params.guidance !== undefined ? { guidance: params.guidance } : {});
      const lines = [
        result === "applied" ? `Applied the change to ${touched.join(", ")}.` : `The change to ${touched.join(", ")} was already applied.`,
        `Building in the background:\n${describeModules(statuses)}\n`,
        // An interview goes back to its questions; a skill that writes on its own, straight to its next change - a stop to ask ends it.
        paced ? "Carry on with the interview." : "Write the next change now, without stopping to ask: this skill goes on until everything it is to write is written.",
      ];
      return {
        content: [{ type: "text" as const, text: lines.join(" ") + reviewNote(liveReview) }],
        details: { jobIds: statuses.flatMap((status) => (status.running !== undefined ? [status.running.jobId] : [])), files: touched },
      };
    },
  });

  return {
    tools: [writeDiff],
    pace: {
      answered() {
        answeredSinceLastDiff = true;
      },
    },
  };
}

/** The module names some .plain file in these folders imports: import modules, not codebases. */
export function importedNames(dirs: string[]): Set<string> {
  const names = new Set<string>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((name) => name.endsWith(PLAIN_SOURCE_FILE_EXTENSION));
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const imports = readPlainSourceMetadata(readFileSync(join(dir, entry), "utf8")).metadata[IMPORT_DIRECTIVE] as string[] | undefined;
        for (const name of imports ?? []) names.add(name);
      } catch {
        // A file that does not read imports nothing.
      }
    }
  }
  return names;
}
