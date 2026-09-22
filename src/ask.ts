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

export async function runAsk(request: AskUserRequest, io: AskUserIO): Promise<string> {
  const refusal = missingOptions(request);
  if (refusal !== null) return refusal;

  const options = request.options ?? [];
  if (options.length === 0) {
    return (await io.input(request.question)) ?? DISMISSED;
  }

  if (request.multiSelect !== true) {
    const choice = await io.select(request.question, [...options, OTHER_OPTION]);
    if (choice === undefined) return DISMISSED;
    if (choice !== OTHER_OPTION) return choice;
    return (await io.input(request.question)) ?? DISMISSED;
  }

  // Pick several: keep offering what is left until they say they are done.
  const chosen: string[] = [];
  let remaining = [...options];
  while (remaining.length > 0) {
    const title = chosen.length === 0 ? request.question : `${request.question}  [so far: ${chosen.join(", ")}]`;
    const choice = await io.select(title, [...remaining, OTHER_OPTION, DONE_OPTION]);

    if (choice === undefined) break;
    if (choice === DONE_OPTION) break;
    if (choice === OTHER_OPTION) {
      const typed = await io.input(request.question);
      if (typed !== undefined && typed.trim() !== "") chosen.push(typed.trim());
      continue;
    }

    chosen.push(choice);
    remaining = remaining.filter((option) => option !== choice);
  }

  return chosen.length > 0 ? chosen.join(", ") : DISMISSED;
}
