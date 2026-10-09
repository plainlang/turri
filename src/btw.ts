/**
 * /btw: a question on the side, answered while the conversation is busy - a skill's interview, its long steps - without
 * waiting for it, and without changing it.
 *
 * A skill runs inside one tool call, so the chat model can answer nothing until the skill returns, and whatever the
 * person types meanwhile waits for it as a message. pi runs an extension's command at once, even mid-turn: /btw starts
 * an agent of its own - fresh, read only - that is shown the conversation, what the running skill has done and said so
 * far, and what is growing, and answers. Its answer is shown and kept out of every model's context: the conversation
 * and the skill go on as if nothing was asked. While a question of the skill's has the keys, the same is typed into its
 * "Something else…" - answered, and the question asked again with the answer above it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AskUser, AskUserRequest } from "./ask.ts";
import { confinedTools } from "./grow/confine.ts";
import { ask, BEGIN, createExecutor } from "./pi.ts";

/** How many tool calls the side agent may make before it is told to answer. */
export const SIDE_CALLS = 20;

/** How much of a transcript the side agent is shown, from its end. */
const CONVERSATION_CHARS = 24_000;
const SKILL_SESSION_CHARS = 16_000;

/** "/btw what is a frid?" -> "what is a frid?"; "/btw" alone -> ""; anything else is not a side question. */
export function sideQuestionOf(text: string): string | undefined {
  const match = /^\s*\/btw(?:\s+|$)([\s\S]*)$/i.exec(text);
  return match === null ? undefined : match[1]!.trim();
}

/** The skill running now, as the side agent is told of it. */
export interface SkillRunNow {
  skill: string;
  /** Its folder: turri's own, or the project's. */
  dir: string;
  /** The step it is in, and its attempt - "" before the first. */
  step(): string;
  /** Its trace so far: steps, gates, each question and answer. */
  trace(): string[];
  /** Its run folder: run.json there names the agent's saved session. */
  runDir: string;
}

let running: SkillRunNow | undefined;

/** Says a skill is running, until the function it returns is called. */
export function skillRunStarted(run: SkillRunNow): () => void {
  running = run;
  return () => {
    if (running === run) running = undefined;
  };
}

export function runningSkill(): SkillRunNow | undefined {
  return running;
}

/**
 * A session's messages as plain text - who said what, tool calls named - its last `maxChars`. Thinking and tool
 * results are left out: what was said, and what was done, is what a side question is about.
 */
export function transcriptOf(entries: unknown[], maxChars: number): string {
  const lines: string[] = [];
  for (const entry of entries) {
    const { type, message } = entry as { type?: string; message?: { role?: string; content?: unknown } };
    if (type !== "message" || message === undefined) continue;
    const who = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : undefined;
    if (who === undefined) continue;
    const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
    for (const part of parts as { type?: string; text?: string; name?: string }[]) {
      if (part.type === "text" && part.text !== undefined && part.text.trim() !== "") lines.push(`${who}: ${part.text.trim()}`);
      else if (part.type === "toolCall" && part.name !== undefined) lines.push(`${who} called ${part.name}`);
    }
  }
  const text = lines.join("\n\n");
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}

/** The running skill's agent's session, as text: its last turns, read from the session file run.json names. */
export function skillSessionText(runDir: string, maxChars = SKILL_SESSION_CHARS): string {
  try {
    const manifest = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")) as { sessionFile?: string };
    if (manifest.sessionFile === undefined) return "";
    const entries = readFileSync(manifest.sessionFile, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      });
    return transcriptOf(entries, maxChars);
  } catch {
    return "";
  }
}

export interface SideQuestion {
  question: string;
  /** The conversation so far, as text. */
  conversation: string;
  /** The skill running now, if one is. */
  skill?: { name: string; dir: string; step: string; trace: string[]; session: string };
  /** What is growing and has grown this session, a line a pulse. */
  pulses: string[];
  projectDir: string;
  /** turri's own folder: its source, skills, rules and docs. */
  harnessDir: string;
}

export function sideQuestionPrompt(side: SideQuestion): string {
  return [
    "The person you are talking to is in the middle of something with turri - a harness that builds code from ***plain",
    "specs - and has a question on the side. Answer it: briefly, plainly, from what is below and what you can read. You",
    "can read the project and turri itself, and change nothing. Nothing you say reaches the conversation or the skill:",
    "they go on as they were. If the question is really a change of course - do something else, stop, change an answer -",
    "say how: answer the skill's next question that way, /halt a pulse, or tell turri once the skill is done.",
    "",
    `The project is ${side.projectDir}: its .plain specs, config.yaml, plain_modules. turri is ${side.harnessDir}: its`,
    "source (src/), its skills (genome/skills/), the ***plain authoring rules (genome/rules/) and its docs (docs/).",
    "",
    "Reply with the answer alone, as you would say it - no preamble about how you found it.",
    "",
    "<conversation>",
    side.conversation.trim() !== "" ? side.conversation : "(nothing yet)",
    "</conversation>",
    ...(side.skill !== undefined
      ? [
          "",
          `A skill is running now: ${side.skill.name}${side.skill.step !== "" ? `, in its ${side.skill.step}` : ""}. Its own folder is`,
          `${side.skill.dir}. What it has done - steps, gates, every question and answer:`,
          "<skill-trace>",
          ...side.skill.trace,
          "</skill-trace>",
          ...(side.skill.session.trim() !== ""
            ? ["", "Its agent's own session, the end of it - what it said and did:", "<skill-session>", side.skill.session, "</skill-session>"]
            : []),
        ]
      : []),
    ...(side.pulses.length > 0 ? ["", "Pulses this session:", ...side.pulses.map((line) => `- ${line}`)] : []),
    "",
    "<question>",
    side.question,
    "</question>",
  ].join("\n");
}

/** Answers a side question with an agent of its own, read only, on `model`. */
export async function answerSideQuestion(side: SideQuestion, model?: string): Promise<string> {
  const fence = confinedTools({ workdir: side.projectDir, read: [side.projectDir, side.harnessDir], write: [], noBash: true });
  const session = await createExecutor({
    cwd: side.projectDir,
    customTools: fence.tools,
    tools: fence.names,
    model,
    label: "side question",
    role: "chat",
    system: fence.note,
    task: sideQuestionPrompt(side),
    budget: { calls: SIDE_CALLS, finish: [] },
  });
  try {
    const answer = (await ask(session, BEGIN)).trim();
    return answer !== "" ? answer : "(no answer came back)";
  } finally {
    session.dispose();
  }
}

/** The answer to a side question, as it is shown above the question it was asked under. */
export function asideBlock(question: string, answer: string): string {
  return `btw: ${question}\n${answer}`;
}

export const BTW_HOW = "Type your question after /btw - /btw what does this step do?";

/**
 * A question put to the person, where "/btw ..." typed as the answer is a side question: answered, and the same
 * question asked again with the answer above it - the asker never sees it. Only the latest is kept above the question.
 */
export async function askWithAsides(request: AskUserRequest, askUser: AskUser, aside: (question: string) => Promise<string>): Promise<string> {
  let current = request;
  for (;;) {
    const answer = await askUser(current);
    const side = sideQuestionOf(answer);
    if (side === undefined) return answer;
    let reply: string;
    try {
      reply = side === "" ? BTW_HOW : await aside(side);
    } catch (error) {
      reply = `The side question could not be answered: ${error instanceof Error ? error.message : String(error)}`;
    }
    const above = side === "" ? reply : asideBlock(side, reply);
    current = { ...request, context: [above, request.context?.trim() ?? ""].filter((part) => part !== "").join("\n\n") };
  }
}
