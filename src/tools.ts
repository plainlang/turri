import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { Questioning } from "./questioning.ts";

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


import { isChat, runAsk, type AskUser, type AskUserRequest } from "./ask.ts";
import { describeFindings, describeQuestions, type LiveReviewer } from "./review/live.ts";

export type { AskUser, AskUserRequest };

/**
 * Lets a skill step put a question to the person running it.
 *
 * A gated skill otherwise runs to completion with nobody to ask, which is fine for work
 * that is fully specified and useless for an interview. The harness still owns the
 * sequence - the step decides what to ask, not whether the gate afterwards runs.
 */
/**
 * `gate`, for an interview that holds its questions to rules - the questioning level's cap (questioning.ts), an answer
 * written as a spec change before the next question: a question it refuses is not asked, and `confirms_phase` marks a
 * phase's closing confirmation, which the cap never counts.
 *
 * `talks`: where the asker answers a person who chose "Chat about this" - `"reply"`, the conversation's agent, in its
 * reply; `"context"`, a skill's agent, whose replies nobody sees, as the `context` of the question asked again. Such a
 * choice is no answer: neither the cap nor `onAnswered` counts it.
 */
export function createAskUserTool(
  ask: AskUser,
  onAnswered?: (answer: string, confirmsPhase: boolean) => void,
  said?: () => string,
  gate?: Pick<Questioning, "refusal" | "answered">,
  talks: "reply" | "context" = "context",
) {
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
      "The dialog shows the question, its options and `context` alone - nothing you wrote before it. When the user must read something to answer - the brief to confirm, the plan to approve - pass it as `context`; never put an account of your work there (what a probe returned, what a regrow did).",
      "Keep `context` short enough to take in at a glance - a heading or two and short bullets, a line each, about fifteen lines at most: what the person decides on, not every detail. The details are in the spec; say where, and they can ask.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "One question. Never bundle two." }),
      options: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Concrete choices to offer. The user can always pick \"Something else…\" and type instead, or " +
            "\"Chat about this\" to talk the question over with you first, so offering options never traps them.",
        }),
      ),
      multi_select: Type.Optional(
        Type.Boolean({ description: "Let the user pick several of the options." }),
      ),
      context: Type.Optional(
        Type.String({
          description:
            "What the user must read to answer, shown above the question - the brief to confirm, the plan to approve. Only that: never an account of what you did.",
        }),
      ),
      free_form: Type.Optional(
        Type.Boolean({
          description:
            "Ask without options, for a genuinely open question. Required when options is omitted.",
        }),
      ),
      ...(gate !== undefined
        ? {
            confirms_phase: Type.Optional(
              Type.Boolean({
                description:
                  "This asks the person to confirm the phase's summary before it ends. It is not counted among the phase's questions.",
              }),
            ),
          }
        : {}),
    }),
    async execute(_id, params) {
      const confirmsPhase = (params as { confirms_phase?: boolean }).confirms_phase === true;
      const refusal = gate?.refusal(confirmsPhase);
      if (refusal !== undefined) {
        return { content: [{ type: "text" as const, text: refusal }], details: { question: params.question, answer: "" } };
      }
      const answer = await ask({
        question: params.question,
        options: params.options,
        multiSelect: params.multi_select,
        freeForm: params.free_form,
        ...(params.context !== undefined && params.context.trim() !== "" ? { context: params.context } : {}),
        ...(said !== undefined ? { said: said() } : {}),
        chattable: true,
      });
      if (isChat(answer)) {
        return { content: [{ type: "text" as const, text: `${answer}\n\n${talkBack(talks)}` }], details: { question: params.question, answer } };
      }
      gate?.answered(confirmsPhase);
      onAnswered?.(answer, confirmsPhase);
      return {
        content: [{ type: "text" as const, text: answer }],
        details: { question: params.question, answer },
      };
    },
  });
}

export { runAsk };

/** What the asker is told to do when the person chose to talk about its question rather than answer it. */
function talkBack(talks: "reply" | "context"): string {
  return talks === "reply"
    ? "Answer what they said in your reply, and end your turn there: they go on in the chat. Ask the question again " +
        "with ask_user only once it is settled - changed, if what they said calls for it. It was not counted as answered."
    : "Answer what they said, then ask the question again with ask_user - changed, if what they said calls for it. Put " +
        "your answer to them in the question's `context`: nothing else you write reaches them. It was not counted as a " +
        "question, and nothing is owed for it.";
}

/** Ends the questions of a phase the questioning level caps: what is left, the agent decides itself. */
export function createEndQuestionsTool(questioning: Pick<Questioning, "end">) {
  return defineTool({
    name: "end_questions",
    label: "End questions",
    description:
      "End this phase's questions: you have asked what the person must decide, and you decide what is left " +
      "yourself, saying what you chose. Afterwards ask_user asks only the phase's closing confirmation, and " +
      "write_spec_diff needs no answer between changes.",
    promptSnippet: "end this phase's questions and decide what is left yourself",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text" as const, text: questioning.end() }], details: {} };
    },
  });
}


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
 * With a live reviewer, a way to answer the reviewer's questions. How the builds stand, a skill reads with the
 * conversation's own drift (loop-tools.ts), the reviewer's findings riding along on it (`withReviewNote`).
 */
export function createReviewTools(liveReview?: LiveReviewer) {
  if (liveReview === undefined) return [];

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

  return [reply];
}

/** A tool whose every result carries what the reviewer has said since the last one. */
export function withReviewNote(tool: ToolDefinition<any, any, any>, liveReview: LiveReviewer | undefined): ToolDefinition<any, any, any> {
  if (liveReview === undefined) return tool;
  return {
    ...tool,
    async execute(id, params, signal, onUpdate, ctx) {
      const result = await tool.execute(id, params, signal, onUpdate, ctx);
      const note = reviewNote(liveReview);
      if (note === "") return result;
      return { ...result, content: [...result.content, { type: "text" as const, text: note.trimStart() }] };
    },
  };
}
