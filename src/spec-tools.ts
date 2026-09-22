import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { plainFileParser } from "./plain/parser.ts";
import { FunctionalSpecError, functionalSpecsText, withFunctionalSpec } from "./plain/functional-section.ts";
import { resolveTemplateDirs } from "./render/render.ts";
import type { RenderQueue } from "./render/queue.ts";
import { reviewNote, type LiveReviewer } from "./tools.ts";

/**
 * Writing a functional spec and building it, as one step.
 *
 * In the functional specs phase every spec is meant to be built the moment it is written.
 * Left to two separate tool calls - write the file, then start the render - the second is
 * the one that gets forgotten, and nothing notices: the spec is on disk, the interview
 * moves on, and the build silently never happens. So there is one tool that does both,
 * and the ordinary file tools refuse to touch the functional specs section at all. The
 * render follows from where the text was written, not from anyone remembering.
 *
 * It also holds the interview to its pace: a new spec needs an answer since the last one.
 * Editing an existing spec - fixing a contradiction, acting on a review finding - does not.
 */

/** Whether a question has been answered since the last new spec was written. */
export interface SpecPace {
  answered(): void;
}

type AnyTool = ToolDefinition<any, any, any>;

export function createFunctionalSpecTools(options: {
  queue: RenderQueue;
  cwd: string;
  liveReview?: LiveReviewer;
}): { tools: AnyTool[]; pace: SpecPace } {
  const { queue, cwd, liveReview } = options;
  // The phase opens after a run of stack questions, so the first spec never needs one more.
  let answeredSinceLastSpec = true;

  const writeSpec = defineTool({
    name: "write_functional_spec",
    label: "Write functional spec",
    description:
      "Write one functional spec into the ***functional specs*** section of a .plain file and start " +
      "building it in the background. Appends a new spec by default; pass `replaces` with a " +
      "functionality id to edit that spec in place instead. Anything already built that the edit " +
      "makes out of date is queued for rebuilding too. This is the only way to change functional " +
      "specs: the ordinary write and edit tools refuse to.",
    promptSnippet: "write_functional_spec: write one functional spec and start building it",
    promptGuidelines: [
      "Every functional spec goes through write_functional_spec - new ones and edits alike. It writes the spec and starts its build in one step, so there is no separate start_render to remember.",
      "One spec per call, and a new one only after the user has answered a question about it.",
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "Path to the .plain file" }),
      spec: Type.String({
        description:
          "Exactly one functional spec: a single `- ` list item, with any detail indented under it.",
      }),
      replaces: Type.Optional(
        Type.String({ description: 'Edit this functionality in place instead of adding one, e.g. "2"' }),
      ),
    }),
    async execute(_id, params) {
      const file = resolve(cwd, params.plain_file);
      if (!existsSync(file)) {
        throw new Error(`${params.plain_file} does not exist. The module file is created in an earlier phase.`);
      }

      if (params.replaces === undefined && !answeredSinceLastSpec) {
        throw new Error(
          "No question has been answered since the last functional spec was written. Each new spec " +
            "comes from its own answer: ask the user about it with ask_user first. To change a spec " +
            "already written, pass `replaces` with its id.",
        );
      }

      const original = readFileSync(file, "utf8");
      let updated: { text: string; frid: string };
      try {
        updated = withFunctionalSpec(original, params.spec, params.replaces);
      } catch (error) {
        if (error instanceof FunctionalSpecError) throw new Error(`Nothing was written. ${error.message}`);
        throw error;
      }

      writeFileSync(file, updated.text);
      try {
        plainFileParser(basename(file), resolveTemplateDirs(file));
      } catch (error) {
        // A spec that breaks the file is not written at all, so nothing is ever queued from
        // a file that cannot be built.
        writeFileSync(file, original);
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Nothing was written: with this spec the file no longer parses. ${reason}`);
      }
      if (params.replaces === undefined) answeredSinceLastSpec = false;

      // Anything built from a spec this edit changed is rebuilt, earliest first, before the
      // new one goes on top of it.
      const regenerated = queue.requeueStale(file);
      const own =
        regenerated.find((entry) => entry.frid === updated.frid) ??
        queue.inFlight(file, updated.frid) ??
        queue.enqueue({ plainFile: file, frid: updated.frid });
      const alsoRebuilt = regenerated.filter((entry) => entry.frid !== updated.frid);

      liveReview?.notice(`${params.plain_file}, up to and including functionality ${updated.frid}`);

      const lines = [
        params.replaces === undefined
          ? `Wrote functional spec ${updated.frid} to ${params.plain_file}.`
          : `Replaced functional spec ${updated.frid} in ${params.plain_file}.`,
        `Building it as job ${own.jobId}, in the background - carry on with the interview.`,
      ];
      if (alsoRebuilt.length > 0) {
        lines.push(
          `Functionality ${alsoRebuilt.map((entry) => entry.frid).join(", ")} ` +
            `${alsoRebuilt.length === 1 ? "was" : "were"} built from the old text and ` +
            `${alsoRebuilt.length === 1 ? "is" : "are"} queued for rebuilding.`,
        );
      }

      return {
        content: [{ type: "text" as const, text: lines.join(" ") + reviewNote(liveReview) }],
        details: {
          frid: updated.frid,
          jobId: own.jobId,
          regenerated: regenerated.map((entry) => entry.frid),
        },
      };
    },
  });

  return {
    tools: [writeSpec, ...guardedFileTools(cwd)],
    pace: {
      answered() {
        answeredSinceLastSpec = true;
      },
    },
  };
}

/** Refuse a write that would change a .plain file's functional specs. */
function refuseFunctionalChange(path: string, content: string): void {
  if (!path.endsWith(".plain")) return;
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (functionalSpecsText(before) !== functionalSpecsText(content)) {
    throw new Error(
      "This would change the ***functional specs*** section, which only write_functional_spec may do - " +
        "it writes the spec and starts its build together. Use it, with `replaces` to edit an " +
        "existing spec. The rest of the file can be changed with this tool as before.",
    );
  }
}

/** pi's write and edit, with the functional specs section of every .plain file fenced off. */
function guardedFileTools(cwd: string): AnyTool[] {
  return [
    createWriteToolDefinition(cwd, {
      operations: {
        writeFile: async (path, content) => {
          refuseFunctionalChange(path, content);
          writeFileSync(path, content);
        },
        mkdir: async (dir) => {
          mkdirSync(dir, { recursive: true });
        },
      },
    }),
    createEditToolDefinition(cwd, {
      operations: {
        readFile: async (path) => readFileSync(path),
        writeFile: async (path, content) => {
          refuseFunctionalChange(path, content);
          writeFileSync(path, content);
        },
        access: async (path) => access(path),
      },
    }),
  ];
}
