import type { DiffPaint } from "./diff-view.ts";
import type { DiffStyle } from "./job-panel.ts";

/**
 * How the side panel colours things. Plain text when there is no theme, as in tests.
 *
 * The panel no longer shows a job's agents at work - every prompt, reply, thought and tool call: that is in each
 * pulse's log (job-log.ts), streamed as it happens.
 */
export interface TranscriptStyle extends DiffStyle {
  heading(text: string): string;
  muted(text: string): string;
  accent(text: string): string;
  error(text: string): string;
  /** A pulse that passed, and one stopped: not given, the added colour and the accent. */
  success?(text: string): string;
  warning?(text: string): string;
  /** How a spec diff is painted - ***plain highlighted, added and removed lines filled (`plain-palette.ts`). Not given: the +/- coloured alone. */
  diff?: DiffPaint;
  /** A functional spec its conformance tests pass for - regen's ◆: brand blue. */
  conforms?: (text: string) => string;
}
