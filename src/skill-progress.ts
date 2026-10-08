import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * A skill's run as one line above the input: every phase by name, in order - the ones done ticked, the one it is in
 * marked, the rest to come - and where that is, phase 2 of 4. `brood` and `spawn` take many turns of
 * questions and spec changes; without it, nothing on the screen says how far through they are.
 *
 *   brood       ✓ intent ━━━━ ⠋ stack ──── ○ testing ──── ○ product       phase 2 of 4
 *                 stack - the language, frameworks, storage and architecture
 *
 * The second line says what the phase it is in does: a phase's name alone - `groundwork` - says little to someone
 * who has not read the skill.
 */

export interface SkillProgress {
  /** The skill's name. */
  skill: string;
  /** Its phases, in order: the `###` headings under its `## Steps`. */
  phases: string[];
  /** The phase it is in, by its place in `phases`; -1 before the first has started. */
  current: number;
  /** The attempt at the current phase - more than 1 after a gate sent it back. */
  attempt: number;
  /** The spinner's frame, for the phase it is in. */
  frame: string;
  /** What the phase it is in does, in a line - from the skill's `metadata.phases`. */
  about?: string;
}

export interface ProgressStyle {
  heading(text: string): string;
  done(text: string): string;
  now(text: string): string;
  muted(text: string): string;
}

const PLAIN: ProgressStyle = { heading: (t) => t, done: (t) => t, now: (t) => t, muted: (t) => t };

/** The shortest a join between two phases is drawn: ` ━━ `. */
const JOIN = 2;

/** How much of the width the phases take, centred in it - stretched across it, the joins read as a ruler. */
const SHARE = 0.6;
/** The least room between the phases and the skill's name on the left, or where it is on the right. */
const GAP = 3;
/** Below this width the line is drawn compact, from the left: there is no room to spare. */
const NARROW = 60;

/**
 * The line across `width`: the skill's name at the left edge, where it is at the right edge, and between them its
 * phases, centred in the whole width across its share of it, the joins stretched to fill it - clear of both ends. Too
 * narrow for that, compact from the left, the phases first, as many as fit.
 */
export function skillProgressLine(progress: SkillProgress, width: number, style: ProgressStyle = PLAIN): string {
  const head = style.heading(progress.skill);
  const tail = style.muted(whereItIs(progress));
  const steps = stepsOf(progress, style);
  const shortest = visibleWidth(phasesAcross(progress, steps, 0, style));
  const sides = visibleWidth(head) + visibleWidth(tail) + 2 * GAP;
  if (width < NARROW || sides + shortest > width) return compact(progress, steps, width, style);
  // Its share, or as little as the ends leave it - kept centred while that keeps it clear of them.
  const room = width - 2 * (Math.max(visibleWidth(head), visibleWidth(tail)) + GAP);
  const across = Math.max(shortest, Math.min(Math.floor(width * SHARE), room));
  const bar = phasesAcross(progress, steps, across, style);
  const barWidth = visibleWidth(bar);
  const from = Math.min(Math.max(Math.floor((width - barWidth) / 2), visibleWidth(head) + GAP), width - visibleWidth(tail) - GAP - barWidth);
  const after = width - from - barWidth - visibleWidth(tail);
  return `${head}${" ".repeat(from - visibleWidth(head))}${bar}${" ".repeat(Math.max(0, after))}${tail}`;
}

/** Where it is: the phase it is in, of how many - and the attempt, after a gate sent it back. */
function whereItIs(progress: SkillProgress): string {
  if (progress.current < 0) return "starting";
  return `phase ${progress.current + 1} of ${progress.phases.length}${progress.attempt > 1 ? `, attempt ${progress.attempt}` : ""}`;
}

/** Each phase as it is drawn: done ticked, the one it is in marked, the rest to come. */
function stepsOf(progress: SkillProgress, style: ProgressStyle): string[] {
  const { phases, current } = progress;
  return phases.map((phase, at) =>
    at < current ? style.done(`✓ ${phase}`) : at === current ? style.now(`${progress.frame} ${phase}`) : style.muted(`○ ${phase}`),
  );
}

/** A join between two phases, `length` long: a stretch walked heavy, in the colour of what is done; one to come, light. */
function joinOf(at: number, length: number, current: number, style: ProgressStyle): string {
  return at <= current ? style.done(` ${"━".repeat(length)} `) : style.muted(` ${"─".repeat(length)} `);
}

/** The phases across `width`, the joins stretched to fill it - at their shortest, when it is less than that takes. */
function phasesAcross(progress: SkillProgress, steps: string[], width: number, style: ProgressStyle): string {
  const joins = Math.max(0, steps.length - 1);
  const fixed = steps.reduce((sum, step) => sum + visibleWidth(step), 0) + joins * (JOIN + 2);
  const spare = Math.max(0, width - fixed);
  const length = (at: number) => JOIN + (joins === 0 ? 0 : Math.floor(spare / joins) + (at <= spare % joins ? 1 : 0));
  return steps.map((step, at) => (at === 0 ? step : `${joinOf(at, length(at), progress.current, style)}${step}`)).join("");
}

/** The line from the left, every join at its shortest - where it is left out first, then the phases cut, to fit `width`. */
function compact(progress: SkillProgress, steps: string[], width: number, style: ProgressStyle): string {
  const line = `${style.heading(progress.skill)}  ${phasesAcross(progress, steps, 0, style)}`;
  const full = `${line}   ${style.muted(whereItIs(progress))}`;
  return visibleWidth(full) <= width ? full : truncateToWidth(line, width, "…");
}

/**
 * The line under it: the phase it is in, and what that phase does - centred under the phases, cut short where it
 * does not fit. Nothing before the first phase starts, or for a phase the skill does not describe.
 */
export function skillAboutLine(progress: SkillProgress, width: number, style: ProgressStyle = PLAIN): string | undefined {
  const phase = progress.phases[progress.current];
  if (phase === undefined || progress.about === undefined || progress.about === "") return undefined;
  const text = truncateToWidth(`${phase} - ${progress.about}`, width, "…");
  const left = width < NARROW ? 0 : Math.floor((width - visibleWidth(text)) / 2);
  return `${" ".repeat(left)}${style.muted(text)}`;
}
