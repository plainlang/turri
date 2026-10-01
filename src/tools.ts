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
    promptSnippet: "write the current step's deliverable to its artifact path",
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
import { describeModules, type WorkLoop } from "./grow/loop.ts";
import { describeFindings, describeQuestions, type LiveReviewer } from "./review/live.ts";

export type { AskUser, AskUserRequest };

/**
 * Lets a skill step put a question to the person running it.
 *
 * A gated skill otherwise runs to completion with nobody to ask, which is fine for work
 * that is fully specified and useless for an interview. The harness still owns the
 * sequence - the step decides what to ask, not whether the gate afterwards runs.
 */
export function createAskUserTool(ask: AskUser, onAnswered?: () => void, said?: () => string) {
  return defineTool({
    name: "ask_user",
    label: "Ask the user",
    description:
      "Put one question to the user and wait for their answer. Ask exactly one thing at a time. " +
      "Offer concrete options in `options` so the user can pick rather than type - that is the " +
      "normal case, and a question with neither options nor free_form is refused rather than asked.",
    promptSnippet: "ask the user one question, offering options to pick from",
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
        ...(said !== undefined ? { context: said() } : {}),
      });
      onAnswered?.();
      return {
        content: [{ type: "text" as const, text: answer }],
        details: { question: params.question, answer },
      };
    },
  });
}

export { runAsk };


/**
 * Everything the reviewer has to say since the last tool call.
 *
 * It rides along on the tool results the interviewer is already getting, so a finding
 * lands between two questions without the interviewer having to remember to go looking
 * for one.
 */
export function reviewNote(liveReview: LiveReviewer | undefined): string {
  if (liveReview === undefined) return "";
  const parts: string[] = [];
  const findings = liveReview.take();
  if (findings.length > 0) parts.push(describeFindings(findings));
  const questions = liveReview.takeQuestions();
  if (questions.length > 0) parts.push(describeQuestions(questions));
  return parts.length === 0 ? "" : `\n\n${parts.join("\n\n")}`;
}

export type { LiveReviewer };

/**
 * What a skill run is told about its builds: the render queue behind it, and - with a live
 * reviewer - a way to answer the reviewer's questions.
 *
 * The builds themselves are started by the tool that writes the spec change (`write_spec_diff`):
 * the interview never waits for one, and never starts one on its own.
 */
export function createRenderTools(loop: WorkLoop, liveReview?: LiveReviewer) {
  const status = defineTool({
    name: "render_status",
    label: "Render status",
    description: "What is being built, module by module: the job running, the jobs planned after it, and why nothing runs where nothing does.",
    promptSnippet: "how the background builds are doing",
    parameters: Type.Object({}),
    async execute() {
      const statuses = loop.status();
      const text = statuses.length === 0 ? "Nothing has been asked to build yet." : describeModules(statuses);
      return {
        content: [{ type: "text" as const, text: text + reviewNote(liveReview) }],
        details: { modules: statuses.length },
      };
    },
  });

  if (liveReview === undefined) return [status];

  const reply = defineTool({
    name: "reply_to_review",
    label: "Reply to review",
    description:
      "Answer a question the reviewer asked, after putting it to the user. The answer is carried " +
      "into the reviewer's next pass. Use this only for questions the reviewer raised by id.",
    promptSnippet: "hand the user's answer back to the reviewer",
    parameters: Type.Object({
      question_id: Type.String({ description: 'The id the reviewer gave, e.g. "q1"' }),
      answer: Type.String({ description: "What the user decided, in their terms" }),
    }),
    async execute(_id, params) {
      const accepted = liveReview.reply(params.question_id, params.answer);
      return {
        content: [
          {
            type: "text" as const,
            text: accepted
              ? `Answer to ${params.question_id} passed to the reviewer. Make sure the specs say the same thing.`
              : `No open review question with id '${params.question_id}'.`,
          },
        ],
        details: { accepted },
      };
    },
  });

  return [status, reply];
}
