import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * A skill's run as one line above the input: every phase by name, in order - the ones done ticked, the one it is in
 * marked, the rest to come - and where that is, phase 2 of 4. `brood` and `spawn` take many turns of
 * questions and spec changes; without it, nothing on the screen says how far through they are.
 *
 *   brood  ✓ intent ━━ ⠋ stack ── ○ testing ── ○ product   phase 2 of 4
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

/** How much of the width the line takes, centred in it - stretched across all of it, the joins read as a ruler. */
const SHARE = 0.8;
/** Below this width the line takes all of it: there is no room to spare. */
const NARROW = 60;

/**
 * The line, centred in `width`, across most of it: the joins between the phases stretched to fill its share, where it is
 * at the end. Too narrow for that, the whole width, the phases first, as many as fit.
 */
export function skillProgressLine(progress: SkillProgress, width: number, style: ProgressStyle = PLAIN): string {
  if (width < NARROW) return progressAcross(progress, width, style);
  // Its share - or, where that leaves no room for where it is, as much more as that takes.
  const inner = Math.min(width, Math.max(Math.floor(width * SHARE), visibleWidth(progressAcross(progress, 0, style, true))));
  const line = progressAcross(progress, inner, style);
  const left = Math.floor((width - visibleWidth(line)) / 2);
  return `${" ".repeat(Math.max(0, left))}${line}`;
}

/** The line across exactly `width`, when it fits: the joins stretched, where it is at the end. `whole`: never cut. */
function progressAcross(progress: SkillProgress, width: number, style: ProgressStyle, whole = false): string {
  const { phases, current } = progress;
  const steps = phases.map((phase, at) =>
    at < current ? style.done(`✓ ${phase}`) : at === current ? style.now(`${progress.frame} ${phase}`) : style.muted(`○ ${phase}`),
  );
  const where = current < 0 ? "starting" : `phase ${current + 1} of ${phases.length}${progress.attempt > 1 ? `, attempt ${progress.attempt}` : ""}`;
  const head = `${style.heading(progress.skill)}  `;
  const tail = `   ${style.muted(where)}`;
  const joins = Math.max(0, phases.length - 1);
  // What the line takes with each join at its shortest; what is left of the width is shared out among the joins.
  const fixed = visibleWidth(head) + steps.reduce((sum, step) => sum + visibleWidth(step), 0) + joins * (JOIN + 2) + visibleWidth(tail);
  const spare = Math.max(0, width - fixed);
  const join = (at: number) => {
    const length = JOIN + (joins === 0 ? 0 : Math.floor(spare / joins) + (at <= spare % joins ? 1 : 0));
    // A stretch walked is drawn heavy, in the colour of what is done; one to come, light.
    return at <= current ? style.done(` ${"━".repeat(length)} `) : style.muted(` ${"─".repeat(length)} `);
  };
  const line = steps.map((step, at) => (at === 0 ? step : `${join(at)}${step}`)).join("");
  // No joins to stretch - one phase: where it is goes to the right edge all the same.
  const pad = joins === 0 ? " ".repeat(spare) : "";
  const full = `${head}${line}${pad}${tail}`;
  return whole || visibleWidth(full) <= width ? full : truncateToWidth(`${head}${steps.map((step, at) => (at === 0 ? step : `${at <= current ? style.done(" ━━ ") : style.muted(" ── ")}${step}`)).join("")}`, width, "…");
}
