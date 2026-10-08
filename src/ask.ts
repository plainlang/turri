/**
 * How a skill step puts a question to the person running it.
 *
 * The interaction policy lives here rather than in the extension so it is the same from
 * the TUI and the CLI, and so it can be tested without a terminal.
 */

export interface AskUserRequest {
  question: string;
  /** Concrete choices. Selecting beats typing whenever the answer space is known. */
  options?: string[];
  /** Let the user pick several. Their picks come back comma-separated. */
  multiSelect?: boolean;
  /** Deliberately asking without options, for a genuinely open question. */
  freeForm?: boolean;
  /**
   * What the asker said since its last question - a brief to confirm, the choices it weighed - shown
   * above the question. A skill's agent talks in a session of its own that nobody sees, so without it
   * "Is this the right brief?" arrives with no brief.
   */
  context?: string;
}

export type AskUser = (request: AskUserRequest) => Promise<string>;

/** The two dialogs an implementation has to provide. */
export interface AskUserIO {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string): Promise<string | undefined>;
}

export const OTHER_OPTION = "Something else…";
export const DONE_OPTION = "Done — that's all of them";
const DISMISSED = "The user dismissed the question without answering.";

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

  // The question, below what it is about.
  const context = request.context?.trim() ?? "";
  const titled = (question: string) => (context !== "" ? `${context}\n\n${question}` : question);
  const options = request.options ?? [];
  if (options.length === 0) {
    return (await io.input(titled(request.question))) ?? DISMISSED;
  }

  if (request.multiSelect !== true) {
    const choice = await io.select(titled(request.question), [...options, OTHER_OPTION]);
    if (choice === undefined) return DISMISSED;
    if (choice !== OTHER_OPTION) return choice;
    return (await io.input(titled(request.question))) ?? DISMISSED;
  }

  // Pick several: keep offering what is left until they say they are done.
  const chosen: string[] = [];
  let remaining = [...options];
  while (remaining.length > 0) {
    const title = chosen.length === 0 ? request.question : `${request.question}  [so far: ${chosen.join(", ")}]`;
    const choice = await io.select(titled(title), [...remaining, OTHER_OPTION, DONE_OPTION]);

    if (choice === undefined) break;
    if (choice === DONE_OPTION) break;
    if (choice === OTHER_OPTION) {
      const typed = await io.input(titled(request.question));
      if (typed !== undefined && typed.trim() !== "") chosen.push(typed.trim());
      continue;
    }

    chosen.push(choice);
    remaining = remaining.filter((option) => option !== choice);
  }

  return chosen.length > 0 ? chosen.join(", ") : DISMISSED;
}

/**
 * Peeking while a question waits. The person answering a skill's interview sees `ctrl+h` and `ctrl+o` and presses
 * neither, for fear a key kills the questions - in a terminal a ctrl key so often does. It does not: the panel takes the
 * keys while it shows, and the question waits under it, as it was. So every question says so, and the first one asked
 * once something is growing invites them to look - an option of its own that opens the panel and asks the same
 * question again, waiting underneath: a safe first time teaches the key better than any hint.
 */
export interface Peek {
  /** Whether something is growing now - a pulse running: there is something to look at. */
  growing(): boolean;
  /** Open the panel on what is growing. It takes the keys; the question asked next waits under it. */
  open(): void;
  /** Already invited, this interview: the invitation is made once. */
  invited: boolean;
}

/** Under every question: the key, and that pressing it loses nothing. */
export const PEEK_HINT = "ctrl+h peek at the build - this question waits for you";
/** The first question asked once something is growing: what there is to see, and that looking is safe. */
export const PEEK_INVITE = "Your first feature is growing now. Press ctrl+h any time to peek at it - this question waits for you while you look.";
/** The option the invitation adds: pick it, and the panel opens with this question waiting under it. */
export const PEEK_OPTION = "Peek at what's growing first (ctrl+h) - this question waits";

/** A question asked with the hint under it, and - once something is growing, the first time - the invitation to look. */
export async function askWithPeek(request: AskUserRequest, io: AskUserIO, peek?: Peek): Promise<string> {
  const hinted: AskUserIO = {
    select: (title, options) => io.select(`${title}\n\n${PEEK_HINT}`, options),
    input: (title) => io.input(`${title}\n\n${PEEK_HINT}`),
  };
  if (peek === undefined || peek.invited || !peek.growing()) return runAsk(request, hinted);
  peek.invited = true;
  const context = [PEEK_INVITE, request.context?.trim() ?? ""].filter((part) => part !== "").join("\n\n");
  const choosing = (request.options?.length ?? 0) > 0 && request.multiSelect !== true;
  const answer = await runAsk({ ...request, context, ...(choosing ? { options: [...request.options!, PEEK_OPTION] } : {}) }, hinted);
  if (answer !== PEEK_OPTION) return answer;
  // They looked: the panel shows, and the same question - as it was asked - waits under it for when they come back.
  peek.open();
  return runAsk(request, hinted);
}
