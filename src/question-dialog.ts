import { Input, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

/**
 * The dialog a question is put to the person in, in the TUI: what they must read to answer - a brief to confirm, a plan
 * to approve - above the question, and the options, or a line to type the answer on.
 *
 * pi's own select puts all of it in its title, so a long brief pushes the options off the screen: the person answers a
 * question they cannot see the choices of. Here the brief scrolls in a window of its own, sized to the terminal, and
 * the question and its options always show below it - PgUp/PgDn or Shift+Up/Down scroll it, and the mouse wheel.
 */

export interface DialogStyle {
  accent(text: string): string;
  muted(text: string): string;
  bold(text: string): string;
}

export interface QuestionDialogOptions {
  /** What to read to answer: shown above the question, scrolling when it is long. Markdown's **bold** and `code` shown as such. */
  context?: string;
  question: string;
  /** The choices. Without them, a line to type the answer on. */
  options?: string[];
  /** The choice the cursor starts on. */
  selected?: number;
  /** The terminal's height, for the window the brief scrolls in. */
  rows: () => number;
  style: DialogStyle;
  /** The answer - an option, or what was typed - or undefined, dismissed. */
  done: (answer: string | undefined) => void;
  /** Draw again: a key changed what shows. */
  requestRender: () => void;
}

/** Lines kept for the conversation above the dialog, so it never takes the whole screen. */
const KEPT_ABOVE = 4;

/** **bold** and `code`, as the brief's markdown means them. */
function styled(text: string, style: DialogStyle): string {
  return text.replace(/\*\*([^*]+)\*\*/g, (_all, inner: string) => style.bold(inner)).replace(/`([^`]+)`/g, (_all, inner: string) => style.accent(inner));
}

export class QuestionDialog implements Component, Focusable {
  private readonly options: QuestionDialogOptions;
  private readonly input: Input | undefined;
  private selected = 0;
  /** The brief's first line in its window. */
  private scroll = 0;
  /** How far the brief scrolls, and its window's height - as last drawn. */
  private maxScroll = 0;
  private window = 0;
  private answered = false;
  private focusedNow = false;

  constructor(options: QuestionDialogOptions) {
    this.options = options;
    if (options.options === undefined || options.options.length === 0) {
      this.input = new Input({ prompt: "> " });
      this.input.onSubmit = (value) => this.finish(value.trim() === "" ? undefined : value);
      this.input.onEscape = () => this.finish(undefined);
    } else {
      this.input = undefined;
      this.selected = Math.min(Math.max(0, options.selected ?? 0), options.options.length - 1);
    }
  }

  get focused(): boolean {
    return this.focusedNow;
  }

  set focused(value: boolean) {
    this.focusedNow = value;
    if (this.input !== undefined) this.input.focused = value;
  }

  private finish(answer: string | undefined): void {
    if (this.answered) return;
    this.answered = true;
    this.options.done(answer);
  }

  private scrollBy(lines: number): void {
    const next = Math.max(0, Math.min(this.maxScroll, this.scroll + lines));
    if (next === this.scroll) return;
    this.scroll = next;
    this.options.requestRender();
  }

  render(width: number): string[] {
    const { style } = this.options;
    const inner = Math.max(10, width - 2);
    const pad = (line: string) => truncateToWidth(`  ${line}`, width);
    const context = (this.options.context ?? "").trim();
    const brief = context === "" ? [] : context.split("\n").flatMap((line) => (line.trim() === "" ? [""] : wrapTextWithAnsi(styled(line, style), inner)));
    const question = wrapTextWithAnsi(style.bold(style.accent(this.options.question)), inner);
    const choices = this.options.options ?? [];
    const body =
      this.input !== undefined
        ? this.input.render(inner)
        : // A long option wraps, its lines under its first, rather than cut off where the person cannot read it.
          choices.flatMap((choice, index) =>
            wrapTextWithAnsi(choice, Math.max(1, inner - 2)).map((line, at) => {
              const shown = `${at === 0 && index === this.selected ? "›" : " "} ${line}`;
              return index === this.selected ? style.accent(shown) : shown;
            }),
          );
    const hint =
      this.input !== undefined
        ? "enter answers · esc dismisses"
        : "↑↓ choose · enter picks · esc dismisses";

    // The brief gets what the question, the options and the hints leave of the screen.
    const fixed = question.length + body.length + 5;
    const room = Math.max(3, this.options.rows() - KEPT_ABOVE - fixed);
    const scrolls = brief.length > room;
    this.window = scrolls ? room - 1 : brief.length;
    this.maxScroll = scrolls ? brief.length - this.window : 0;
    this.scroll = Math.min(this.scroll, this.maxScroll);

    // Set apart from what is drawn above it - the job panel's hints.
    const lines: string[] = [""];
    if (brief.length > 0) {
      lines.push(...brief.slice(this.scroll, this.scroll + this.window).map(pad));
      if (scrolls) {
        const last = Math.min(brief.length, this.scroll + this.window);
        const more = this.scroll === 0 ? " - more below" : last === brief.length ? " - the end" : "";
        lines.push(pad(style.muted(`── lines ${this.scroll + 1}-${last} of ${brief.length}${more} · PgUp/PgDn or shift+↑↓ scroll ──`)));
      }
      lines.push("");
    }
    lines.push(...question.map(pad), ...body.map(pad), "", pad(style.muted(hint)));
    return lines;
  }

  handleInput(data: string): void {
    // The brief scrolls whatever has the keys.
    if (matchesKey(data, "pageDown")) return this.scrollBy(Math.max(1, this.window - 1));
    if (matchesKey(data, "pageUp")) return this.scrollBy(-Math.max(1, this.window - 1));
    if (matchesKey(data, "shift+down")) return this.scrollBy(1);
    if (matchesKey(data, "shift+up")) return this.scrollBy(-1);
    if (this.input !== undefined) {
      this.input.handleInput(data);
      this.options.requestRender();
      return;
    }
    const choices = this.options.options ?? [];
    if (matchesKey(data, "up")) {
      this.selected = (this.selected - 1 + choices.length) % choices.length;
      this.options.requestRender();
    } else if (matchesKey(data, "down")) {
      this.selected = (this.selected + 1) % choices.length;
      this.options.requestRender();
    } else if (matchesKey(data, "enter")) {
      this.finish(choices[this.selected]);
    } else if (matchesKey(data, "escape")) {
      this.finish(undefined);
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel" || event.wheelDelta === undefined || this.maxScroll === 0) return undefined;
    this.scrollBy(event.wheelDelta);
    return { handled: true };
  }

  invalidate(): void {
    this.input?.invalidate();
  }
}
