/**
 * How many questions an interview may put to the person in each phase it caps, and how broad each is - the
 * questioning level, the first thing a skill with `metadata.questioning` asks. Light, medium and thorough cap each such
 * phase at 3, 5 and 10 questions; best judgement leaves it to the agent, which says when it has asked enough. Every
 * level covers the same ground: fewer questions are broader ones, and what they leave open the agent decides itself.
 * The level limits the questions, never the spec changes. The phase's closing confirmation, asked with
 * `confirms_phase`, is never counted.
 */

export interface QuestioningLevel {
  name: string;
  /** Questions a capped phase may ask; none for best judgement. */
  cap?: number;
  /** As the person is offered it. */
  option: string;
  /** How broad each question is, as the agent is told. */
  breadth: string;
}

export const QUESTIONING_LEVELS: QuestioningLevel[] = [
  {
    name: "light",
    cap: 3,
    option: "Light - at most 3 broad questions a phase, turri decides the details",
    breadth:
      "Ask broad questions: each settles a whole area of the phase at once - the features and their order, what the product does end to end - proposing what fits the brief for the person to confirm or correct. The details are yours.",
  },
  {
    name: "medium",
    cap: 5,
    option: "Medium - at most 5 questions a phase, each a feature or topic",
    breadth:
      "Ask about one feature or topic a question, with its main rules in the same question. The edge cases are yours.",
  },
  {
    name: "thorough",
    cap: 10,
    option: "Thorough - at most 10 narrow questions a phase, edge cases included",
    breadth:
      "Ask narrow questions: one feature, rule or edge case a question, with follow-ups on the ones that matter most.",
  },
  {
    name: "best judgement",
    option: "Best judgement - turri decides how much each phase asks",
    breadth:
      "Ask as broadly or as narrowly as each area needs - narrow where the person's answer changes the product, broad or not at all where the brief already says.",
  },
];

const BEST_JUDGEMENT = QUESTIONING_LEVELS.at(-1)!;

/** The level an answer picks: by its name, wherever it is in the answer; anything else is best judgement. */
export function levelOf(answer: string): QuestioningLevel {
  const said = answer.toLowerCase();
  return QUESTIONING_LEVELS.find((level) => said.startsWith(level.name)) ?? QUESTIONING_LEVELS.find((level) => said.includes(level.name.split(" ")[0]!)) ?? BEST_JUDGEMENT;
}

/** The question the harness puts first, and what the person reads above it. */
export function questioningQuestion(phases: string[]): { question: string; options: string[]; context: string } {
  const named = phases.length === 1 ? `the ${phases[0]} phase` : `the ${phases.slice(0, -1).join(", ")} and ${phases.at(-1)} phases`;
  return {
    question: `How many questions should I ask you in ${named}?`,
    options: QUESTIONING_LEVELS.map((level) => level.option),
    context:
      `Light, medium and thorough cap each of ${named} at 3, 5 and 10 questions - broader with fewer, so every level ` +
      "covers the same ground, only in less or more depth. What the questions leave open, turri decides itself and " +
      "says what it chose. With best judgement, turri asks as much as it judges each phase needs. Each phase still " +
      "ends with your confirmation of its summary.",
  };
}

/** What a resumed run picks up: the level, and how far each phase's questions went. */
export interface QuestioningState {
  level: string;
  asked: Record<string, number>;
  /** Phases whose questions are over. */
  over: string[];
}

export interface Questioning {
  level: QuestioningLevel;
  /** The phase now running. */
  enter(phase: string): void;
  /** Why a question may not be asked now, or undefined when it may. */
  refusal(confirmsPhase: boolean): string | undefined;
  /** A question was answered. */
  answered(confirmsPhase: boolean): void;
  /** The agent ends this phase's questions itself; what to tell it. */
  end(): string;
  /** What the agent is told of the level as a phase starts. */
  note(phase: string, first: boolean): string | undefined;
  state(): QuestioningState;
}

export function createQuestioning(options: {
  level: QuestioningLevel;
  /** The phases the level caps. */
  phases: string[];
  from?: QuestioningState;
  /** Called whenever the state changes, to keep it for a resume. */
  onChange?: (state: QuestioningState) => void;
}): Questioning {
  const { level, phases } = options;
  const asked: Record<string, number> = { ...(options.from?.asked ?? {}) };
  const over = new Set(options.from?.over ?? []);
  let phase = "";
  const capped = () => phases.includes(phase);
  const state = (): QuestioningState => ({ level: level.name, asked: { ...asked }, over: [...over] });
  const changed = () => options.onChange?.(state());
  const decideTheRest =
    "Decide what is left yourself, as a careful engineer would, in the light of the intent brief, and say in one line what you chose.";

  return {
    level,
    enter(next) {
      phase = next;
    },
    refusal(confirmsPhase) {
      if (!capped() || confirmsPhase || !over.has(phase)) return undefined;
      const why =
        level.cap !== undefined && (asked[phase] ?? 0) >= level.cap
          ? `${level.name} questioning allows ${level.cap} questions in the ${phase} phase, and all ${level.cap} are asked`
          : `you ended the ${phase} phase's questions`;
      return `This question was not asked: ${why}. ${decideTheRest} Only the phase's closing confirmation, with confirms_phase, may still be asked.`;
    },
    answered(confirmsPhase) {
      if (!capped() || confirmsPhase) return;
      asked[phase] = (asked[phase] ?? 0) + 1;
      if (level.cap !== undefined && asked[phase]! >= level.cap) over.add(phase);
      changed();
    },
    end() {
      if (!capped()) return `The ${phase} phase's questions are not capped: ask what it needs.`;
      over.add(phase);
      changed();
      return `The ${phase} phase's questions are over. ${decideTheRest} End the phase with its summary and its confirmation, asked with confirms_phase.`;
    },
    note(next, first) {
      const chosen = `The person chose ${level.name} questioning${first ? " - the harness asked it, so do not ask it again" : ""}.`;
      if (!phases.includes(next)) {
        return first ? `${chosen} It caps the questions of the ${phases.join(" and ")} phases, not this one.` : undefined;
      }
      const limit =
        level.cap !== undefined
          ? `Ask at most ${level.cap} questions with ask_user in this phase, follow-ups included; past them ask_user refuses. To stop sooner, call end_questions.`
          : "Stop asking once the phase is settled enough to build: call end_questions.";
      return [
        chosen,
        limit,
        level.breadth,
        "Whatever the level, the questions cover all of the phase's topics: the level sets their depth, not their reach.",
        "The phase's closing confirmation is asked with confirms_phase: true and is not counted.",
        `What the questions leave open: ${decideTheRest}`,
        "The level limits the questions, never the spec changes: write as many as the phase needs, decided ones included.",
      ].join(" ");
    },
    state,
  };
}
