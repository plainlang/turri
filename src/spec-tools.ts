import { basename, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { plainFileParser } from "./plain/parser.ts";
import { resolveTemplateDirs } from "./render/render.ts";
import { applySpecDiff, plainFilesOf, revertSpecDiff, snapshotSpec, wholeSpecDiff } from "./render/spec-change.ts";
import { readBuiltTree } from "./render/state.ts";
import { listFiles } from "./render/testing.ts";
import { MissingFunctionalitiesError } from "./plain/errors.ts";
import type { RenderQueue } from "./render/queue.ts";
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
  queue: RenderQueue;
  cwd: string;
  liveReview?: LiveReviewer;
}): { tools: AnyTool[]; pace: SpecPace } {
  const { queue, cwd, liveReview } = options;
  let answeredSinceLastDiff = true;
  // The codebases a change of this interview has been queued for: only the first to one that
  // holds nothing yet is given the whole spec.
  const started = new Set<string>();

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
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "The .plain file of the module the change is built for" }),
      diff: Type.String({ description: "The change, as a git diff (diff --git a/<file> b/<file> ...)" }),
      fixes_earlier: Type.Optional(
        Type.Boolean({ description: "This corrects something already written - a contradiction, a review finding" }),
      ),
    }),
    async execute(_id, params) {
      if (params.fixes_earlier !== true && !answeredSinceLastDiff) {
        throw new Error(
          "No question has been answered since the last spec change. Each change comes from its own answer: ask " +
            "the user with ask_user first. To correct something already written, set fixes_earlier.",
        );
      }

      const touched = plainFilesOf(params.diff);
      if (touched.length === 0) throw new Error("The diff changes no .plain file. Nothing was written.");

      const result = applySpecDiff(params.diff, cwd);
      // A change that breaks a spec is not written at all, so nothing is ever built from a
      // file that cannot be parsed. A module with no functional specs yet is not broken.
      for (const file of touched) {
        const path = resolve(cwd, file);
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
      // tools, as well as this answer - not only the lines this answer changed.
      const codebase = spec.chain.at(-1)!.buildDir;
      const fromNothing = !started.has(codebase) && readBuiltTree(codebase) === null && listFiles(codebase).length === 0;
      started.add(codebase);
      const diff = fromNothing ? wholeSpecDiff(spec.plainFile, cwd) : params.diff;
      const jobId = queue.enqueueSpecDiff({ plainFile: params.plain_file, diff, applied: result, spec }).jobId;
      const lines = [
        result === "applied" ? `Applied the change to ${touched.join(", ")}.` : `The change to ${touched.join(", ")} was already applied.`,
        `Rendering it as job ${jobId}, in the background - carry on with the interview.`,
        ...(fromNothing ? ["Nothing is built yet, so this build is given the whole spec as the change - everything written so far, not only this answer."] : []),
      ];
      return {
        content: [{ type: "text" as const, text: lines.join(" ") + reviewNote(liveReview) }],
        details: { jobId, files: touched },
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
