import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { IMPORT_DIRECTIVE, plainFileParser, readPlainSourceMetadata } from "./plain/parser.ts";
import { importedNames } from "./render/spec-diff-parts.ts";
import { resolveTemplateDirs } from "./render/render.ts";
import { applySpecDiff, plainFilesOf, revertSpecDiff, snapshotSpec } from "./render/spec-change.ts";
import { MissingFunctionalitiesError } from "./plain/errors.ts";
import type { QueuedSpecDiffPart, RenderQueue } from "./render/queue.ts";
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
/** What a spec change was queued as, in a sentence or two: a job per codebase it lands in. */
export function describeQueuedParts(parts: QueuedSpecDiffPart[]): string {
  const one = (part: QueuedSpecDiffPart) => {
    if (part.what === "restructure") return `job ${part.jobId} records it in ${part.module}'s codebase: the specs are only laid out differently, so there is nothing to render`;
    if (part.what === "rebuild") {
      return `job ${part.jobId} builds ${part.newlyRequired!.join(", ")} and then ${part.module} again from scratch on it: ${part.module} now requires a module its code was not built on, which no spec diff can bring in`;
    }
    return `job ${part.jobId} renders it in ${part.module}'s codebase${part.fromNothing ? " - nothing is built there yet, so it is given the whole spec as the change, everything written so far" : ""}`;
  };
  if (parts.length === 1) return `In the background, ${one(parts[0]!)}.`;
  return `It lands in ${parts.length} codebases, so it is split into a job for each, bottom of the chain first - each module's part in its own codebase, the one above starting from the code below: ${parts
    .map((part, index) => `${index + 1}. ${part.files.join(", ")}: ${one(part)}`)
    .join("; ")}.`;
}

export function createSpecDiffTools(options: {
  queue: RenderQueue;
  cwd: string;
  liveReview?: LiveReviewer;
  /** One new change per answer (the default); false, for a skill that writes the specs on its own. */
  paced?: boolean;
}): { tools: AnyTool[]; pace: SpecPace } {
  const { queue, cwd, liveReview } = options;
  const paced = options.paced !== false;
  let answeredSinceLastDiff = true;

  const writeDiff = defineTool({
    name: "write_spec_diff",
    label: "Write spec diff",
    description:
      "Apply a change to the ***plain specs, given as a git diff of the .plain files, and start building it in " +
      "the background. The diff is applied with git; if the specs no longer parse, it is undone and nothing is " +
      "built. Any section may change - definitions, reqs, functional specs, added, changed or removed - and " +
      "every change is built, whatever it touches.",
    promptSnippet: "write_spec_diff: apply a git diff of the .plain specs and start building it",
    promptGuidelines: [
      "Every change to a .plain file in the product phase goes through write_spec_diff, as a git diff with paths relative to the project root. It writes the change and starts its build in one step.",
      "One change per answer, and a new one only after the user has answered a question about it. Set fixes_earlier to correct something already written.",
      "To take something out of what is already written and queued - the user drops a page or a feature - write the diff that removes it from every spec that names it, with fixes_earlier. The queue master takes out the queued builds it undoes and rewrites the ones it touches; never stop builds to drop a change - it stays in the files.",
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "The .plain file of the module the change is built for" }),
      diff: Type.String({ description: "The change, as a git diff (diff --git a/<file> b/<file> ...)" }),
      fixes_earlier: Type.Optional(
        Type.Boolean({ description: "This corrects something already written - a contradiction, a review finding" }),
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

      // The spec as it stands with this change in is what its render builds and records.
      const spec = snapshotSpec(params.plain_file, { cwd });
      // The first change built into a codebase that holds nothing yet is built from nothing: its
      // build is told the whole spec as the change - what the earlier phases wrote with the file
      // tools, as well as this answer - not only the lines this answer changed. The queue works that
      // out for each codebase the change lands in.
      const queued = queue.enqueueSpecDiff({ plainFile: params.plain_file, diff: params.diff, applied: result, spec, wholeIfUnbuilt: true });
      // The queue master reworks the queued builds around it first: what it made of them is what to tell the user.
      const reports = await Promise.all(queued.parts.filter((part) => part.what === "render").map((part) => queue.afterRework(part.jobId)));
      const reworked = [...new Set(reports.filter((report): report is string => report !== undefined))];
      const lines = [
        result === "applied" ? `Applied the change to ${touched.join(", ")}.` : `The change to ${touched.join(", ")} was already applied.`,
        // One build the master reworked: what it made of it is the whole story.
        ...(reworked.length > 0 && queued.parts.length === 1 ? [] : [describeQueuedParts(queued.parts)]),
        ...(reworked.length > 0 ? [`\n\n${reworked.join("\n\n")}\n\nTell the user what became of it, as said here.`] : []),
        "Carry on with the interview.",
      ];
      return {
        content: [{ type: "text" as const, text: lines.join(" ") + reviewNote(liveReview) }],
        details: { jobId: queued.jobId, jobIds: queued.parts.map((part) => part.jobId), files: touched },
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
