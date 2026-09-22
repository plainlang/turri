import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

/**
 * Personal tools.
 *
 * `write_artifact` is the executor's only way to produce output: it can read the
 * repo, but everything it makes lands in one sandboxed directory under a name the
 * graph chose. That is what lets the gate know exactly what to review - there is
 * no "find the thing the agent probably changed" step.
 */
export function createWriteArtifactTool(runDir: string) {
  const root = resolve(runDir);
  return defineTool({
    name: "write_artifact",
    label: "Write artifact",
    description:
      "Write this step's deliverable. Path must be the artifact path given in the step instructions. " +
      "Overwrites any previous attempt.",
    promptSnippet: "write_artifact: write the current step's deliverable to its artifact path",
    parameters: Type.Object({
      path: Type.String({ description: "Artifact path, exactly as given in the step instructions" }),
      content: Type.String({ description: "Full contents of the artifact" }),
    }),
    async execute(_id, params) {
      const target = resolve(root, params.path);
      if (relative(root, target).startsWith("..")) {
        throw new Error(`write_artifact: '${params.path}' escapes the artifact directory`);
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, params.content, "utf8");
      return {
        content: [{ type: "text" as const, text: `Wrote ${params.content.length} bytes to ${params.path}` }],
        details: { path: params.path, bytes: params.content.length },
      };
    },
  });
}

export const VerdictSchema = Type.Object({
  verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")], {
    description: "'fail' if ANY rubric criterion is violated. There is no partial credit.",
  }),
  violations: Type.Array(
    Type.Object({
      criterion: Type.String({ description: "The rubric criterion, quoted" }),
      evidence: Type.String({ description: "The exact text from the artifact that violates it" }),
      fix: Type.String({ description: "One concrete instruction that would resolve it" }),
    }),
    { description: "Empty when verdict is 'pass'. Never empty when verdict is 'fail'." },
  ),
});

export type Verdict = Static<typeof VerdictSchema>;

/**
 * The judge's only tool. Forcing the verdict through a schema is the difference
 * between a decision the graph can branch on and a paragraph someone has to read.
 * `terminate` stops the judge session as soon as the verdict lands.
 */
export function createVerdictTool(onVerdict: (v: Verdict) => void) {
  return defineTool({
    name: "submit_verdict",
    label: "Submit verdict",
    description: "Submit your review verdict. Call this exactly once. Do not reply with prose.",
    parameters: VerdictSchema,
    async execute(_id, params) {
      onVerdict(params as Verdict);
      return {
        content: [{ type: "text" as const, text: "Verdict recorded." }],
        details: params,
        terminate: true,
      };
    },
  });
}


import { runAsk, type AskUser, type AskUserRequest } from "./ask.ts";
import type { RenderQueue } from "./render/queue.ts";

export type { AskUser, AskUserRequest };

/**
 * Lets a skill step put a question to the person running it.
 *
 * A gated skill otherwise runs to completion with nobody to ask, which is fine for work
 * that is fully specified and useless for an interview. The harness still owns the
 * sequence - the step decides what to ask, not whether the gate afterwards runs.
 */
export function createAskUserTool(ask: AskUser) {
  return defineTool({
    name: "ask_user",
    label: "Ask the user",
    description:
      "Put one question to the user and wait for their answer. Ask exactly one thing at a time. " +
      "Offer concrete options in `options` so the user can pick rather than type - that is the " +
      "normal case, and a question with neither options nor free_form is refused rather than asked.",
    promptSnippet: "ask_user: ask the user one question, offering options to pick from",
    promptGuidelines: [
      "Every ask_user call should carry `options` unless the answer genuinely cannot be anticipated; picking from a list is far quicker for the user than typing. A free-form question needs free_form: true.",
      "Use multi_select: true when several answers can apply at once, rather than asking the same question repeatedly.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "One question. Never bundle two." }),
      options: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Concrete choices to offer. The user can always pick \"Something else…\" and type instead, " +
            "so offering options never traps them.",
        }),
      ),
      multi_select: Type.Optional(
        Type.Boolean({ description: "Let the user pick several of the options." }),
      ),
      free_form: Type.Optional(
        Type.Boolean({
          description:
            "Ask without options, for a genuinely open question. Required when options is omitted.",
        }),
      ),
    }),
    async execute(_id, params) {
      const answer = await ask({
        question: params.question,
        options: params.options,
        multiSelect: params.multi_select,
        freeForm: params.free_form,
      });
      return {
        content: [{ type: "text" as const, text: answer }],
        details: { question: params.question, answer },
      };
    },
  });
}

export { runAsk };


/**
 * Lets a step start building a functionality and carry straight on.
 *
 * The interview is the thing the person is waiting on, so it never waits for a render.
 * The queue keeps the renders themselves in order behind it.
 */
export function createRenderTools(queue: RenderQueue) {
  const start = defineTool({
    name: "start_render",
    label: "Start render",
    description:
      "Start building one functionality in the background and return immediately. Queued behind any " +
      "render already running, so functionalities are built in the order you ask for them. Use " +
      "regenerate when the functionality was already built and its specification has since changed.",
    promptSnippet: "start_render: build a functionality in the background, then carry on",
    parameters: Type.Object({
      plain_file: Type.String({ description: "Path to the .plain file" }),
      frid: Type.String({ description: 'Functionality id, e.g. "1" or "2.3"' }),
      regenerate: Type.Optional(
        Type.Boolean({ description: "The functionality was already built and its spec has changed" }),
      ),
    }),
    async execute(_id, params) {
      const entry = queue.enqueue({
        plainFile: params.plain_file,
        frid: params.frid,
        regenerate: params.regenerate,
      });
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Queued functionality ${entry.frid} as job ${entry.jobId} (position ${entry.position}). ` +
              "It builds in the background. Carry on with the interview - do not wait for it.",
          },
        ],
        details: { jobId: entry.jobId, position: entry.position },
      };
    },
  });

  const status = defineTool({
    name: "render_status",
    label: "Render status",
    description: "What has been queued for building so far, in order, and how each one is doing.",
    promptSnippet: "render_status: how the background builds are doing",
    parameters: Type.Object({}),
    async execute() {
      const entries = queue.status();
      const text =
        entries.length === 0
          ? "Nothing has been queued for building yet."
          : entries
              .map((e) => `${e.position}. functionality ${e.frid}  ${e.status}  (job ${e.jobId})`)
              .join("\n");
      return { content: [{ type: "text" as const, text }], details: { queued: entries.length } };
    },
  });

  return [start, status];
}
