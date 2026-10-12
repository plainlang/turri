/**
 * How a skill step puts a question to the person running it.
 *
 * The interaction policy lives here rather than in the extension so it is the same from
 * the TUI and the CLI, and so it can be tested without a terminal.
 */

import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import { PANEL_KEY } from "./grow/job-panel.ts";

export interface AskUserRequest {
  question: string;
  /** Concrete choices. Selecting beats typing whenever the answer space is known. */
  options?: string[];
  /** Let the user pick several. Their picks come back comma-separated. */
  multiSelect?: boolean;
  /** Deliberately asking without options, for a genuinely open question. */
  freeForm?: boolean;
  /**
   * What the person must read to answer - the brief to confirm, the plan to approve - shown above the question, as the
   * asker gives it. A skill's agent talks in a session of its own that nobody sees, so without it "Is this the right
   * brief?" arrives with no brief.
   */
  context?: string;
  /**
   * What the asker said last before asking - its account of the work, a probe, a regeneration - kept with the answer in the
   * run's record and the transcript, never shown in the dialog.
   */
  said?: string;
  /**
   * Offer "Chat about this": an agent asked, and can answer what the person says about the question before they answer
   * it. Not for a question the harness asks itself - nobody would answer.
   */
  chattable?: boolean;
}

export type AskUser = (request: AskUserRequest) => Promise<string>;

/**
 * The two dialogs an implementation has to provide. `context` is what to read to answer, given apart from the question so
 * a dialog can show a long one without losing the question and its options under it - the TUI's scrolls it.
 */
export interface AskUserIO {
  select(title: string, options: string[], context?: string): Promise<string | undefined>;
  input(title: string, context?: string): Promise<string | undefined>;
}

export const OTHER_OPTION = "Something else…";
export const CHAT_OPTION = "Chat about this";
export const DONE_OPTION = "Done — that's all of them";
export const DISMISSED = "The user dismissed the question without answering.";

/** How an answer that is no answer starts: the person chose to talk about the question first. */
export const CHAT_PREFIX = "The user has not answered this question yet: they chose to talk about it first.";

/** What comes back when the person chose "Chat about this": what they said, and what they had picked so far. */
export function chatAnswer(said: string, picked: string[] = []): string {
  return [CHAT_PREFIX, `They said: ${said.trim()}`, ...(picked.length > 0 ? [`They had picked so far: ${picked.join(", ")}.`] : [])].join("\n");
}

/** Whether an answer is the person choosing to talk about the question, rather than answering it. */
export function isChat(answer: string): boolean {
  return answer.startsWith(CHAT_PREFIX);
}

/** The input after "Something else…" or "Chat about this": with nothing typed, or Esc, the options again. */
const BACK = "(Esc, or nothing typed: back to the options)";
const typedNothing = (typed: string | undefined): typed is undefined => typed === undefined || typed.trim() === "";

/**
 * A question with no options and no `free_form` is refused rather than asked.
 *
 * Offering choices is the thing that makes an interview quick to answer, and an optional
 * field is one a model quietly skips. Making the free-form case explicit means asking
 * without options is a decision rather than an omission.
 */
export function missingOptions(request: AskUserRequest): string | null {
  const hasOptions = request.options !== undefined && request.options.length > 0;
  if (hasOptions || request.freeForm === true) return null;
  return (
    "This question was not asked. Offer concrete options so the user can pick one, or set " +
    "free_form to true if the answer genuinely cannot be anticipated (\"What is the app?\"). " +
    "Call ask_user again."
  );
}

/**
 * A model's own tool-call syntax, leaked into an argument: `<parameter name="multi_select">false`
 * written inside an option instead of as the argument it is. Never shown to the person.
 */
const TOOL_MARKUP = /<\/?(?:antml:)?(?:parameter|invoke|function_calls|function|tool_call|arg_key|arg_value)\b[^>]*>/i;

/**
 * The request as the person should see it: tool-call markup cut out of the question and the
 * options - an option that was nothing but markup dropped - and a `multi_select` that leaked into
 * the text taken as the argument it was meant to be. `leaked` when there was any.
 */
export function cleanRequest(request: AskUserRequest): { request: AskUserRequest; leaked: boolean } {
  let leaked = false;
  let multiSelect = request.multiSelect;
  const clean = (text: string): string => {
    const flag = /<(?:antml:)?parameter\s+name="multi_select"\s*>\s*(true|false)/i.exec(text);
    if (flag && multiSelect === undefined) multiSelect = flag[1]!.toLowerCase() === "true";
    const at = text.search(TOOL_MARKUP);
    if (at === -1) return text.trim();
    leaked = true;
    return text.slice(0, at).trim();
  };
  const question = clean(request.question);
  const options = request.options === undefined ? undefined : [...new Set(request.options.map(clean).filter((option) => option !== ""))];
  return { request: { ...request, question, options, multiSelect }, leaked };
}

export async function runAsk(asked: AskUserRequest, io: AskUserIO): Promise<string> {
  const { request, leaked } = cleanRequest(asked);
  // What was left once the markup was cut out is not a question worth putting to anyone.
  if (leaked && (request.question === "" || (request.options?.length === 0 && request.freeForm !== true))) {
    return (
      "This question was not asked: its question or options held tool-call markup (<parameter ...>) " +
      "instead of text. Call ask_user again, with question, options and multi_select as separate arguments."
    );
  }
  const refusal = missingOptions(request);
  if (refusal !== null) return refusal;

  // The question, and apart from it what it is about: the dialog shows that above it.
  const trimmed = request.context?.trim() ?? "";
  const context = trimmed !== "" ? trimmed : undefined;
  const options = request.options ?? [];
  if (options.length === 0) {
    return (await io.input(request.question, context)) ?? DISMISSED;
  }

  // Beside the options: typing an answer instead, and - when an agent asked - talking about the question first. Either
  // can be backed out of, to the options again: picked by accident, it costs nothing.
  const extras = [OTHER_OPTION, ...(request.chattable === true ? [CHAT_OPTION] : [])];
  const typeInstead = () => io.input(`${request.question}\n\n${BACK}`, context);
  const chatAbout = () => io.input(`${request.question}\n\nWhat would you like to talk about? ${BACK}`, context);

  if (request.multiSelect !== true) {
    for (;;) {
      const choice = await io.select(request.question, [...options, ...extras], context);
      if (choice === undefined) return DISMISSED;
      if (choice === OTHER_OPTION) {
        const typed = await typeInstead();
        if (typedNothing(typed)) continue;
        return typed;
      }
      if (choice === CHAT_OPTION) {
        const said = await chatAbout();
        if (typedNothing(said)) continue;
        return chatAnswer(said);
      }
      return choice;
    }
  }

  // Pick several: keep offering what is left until they say they are done.
  const chosen: string[] = [];
  let remaining = [...options];
  while (remaining.length > 0) {
    const title = chosen.length === 0 ? request.question : `${request.question}  [so far: ${chosen.join(", ")}]`;
    const choice = await io.select(title, [...remaining, ...extras, DONE_OPTION], context);

    if (choice === undefined) break;
    if (choice === DONE_OPTION) break;
    if (choice === OTHER_OPTION) {
      const typed = await typeInstead();
      if (!typedNothing(typed)) chosen.push(typed.trim());
      continue;
    }
    if (choice === CHAT_OPTION) {
      const said = await chatAbout();
      if (typedNothing(said)) continue;
      return chatAnswer(said, chosen);
    }

    chosen.push(choice);
    remaining = remaining.filter((option) => option !== choice);
  }

  return chosen.length > 0 ? chosen.join(", ") : DISMISSED;
}

/**
 * While a question is open, what catches ctrl+h on the terminal's input: pi gives an extension's shortcut only the keys
 * its editor sees, and a question has the focus. It opens the side panel - the question waits under it - unless the
 * panel shows already: its own listener has ctrl+h then, to close it. A key's release and its repeats are left alone.
 */
export function peekKeyListener(panel: { open(): void; shown(): boolean }): (data: string) => { consume: true } | undefined {
  return (data) => {
    if (isKeyRelease(data) || isKeyRepeat(data) || !matchesKey(data, PANEL_KEY) || panel.shown()) return undefined;
    panel.open();
    return { consume: true };
  };
}
