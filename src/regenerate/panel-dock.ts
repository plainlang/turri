import { type Component, HStack } from "@earendil-works/pi-tui";

/**
 * The side panel beside the chat rather than over it: the chat drawn on the left in what the panel leaves it, the panel
 * laid over the columns on the right.
 *
 * pi draws its screen one of two ways, and the chat is narrowed in each as it is drawn: full screen (pi's default), a
 * layout - its root put in a row beside a filler as wide as the panel; the regular screen, the lines its render gives -
 * asked for in fewer columns.
 */

/** Narrower than this, the chat and the panel have no room side by side: the panel takes the whole screen. */
const SHARED_FROM = 100;

/** The columns the panel takes beside the chat - 0 when the terminal is too narrow to share. */
export function dockedWidth(columns: number): number {
  return columns < SHARED_FROM ? 0 : Math.max(48, Math.floor(columns * 0.45));
}

/** What of pi's screen narrowing the chat reaches: not among what pi-tui declares. */
interface Screen {
  layoutRoot?: Component;
  setLayoutRoot?(root: Component | undefined): void;
  render(width: number): string[];
}

/**
 * The chat narrowed by `panelWidth()` columns, read at each frame - 0 gives it the whole width. Returns what gives it the
 * whole width back for good.
 */
export function narrowChat(tui: object, panelWidth: () => number): () => void {
  const screen = tui as Screen;
  if (typeof screen.setLayoutRoot === "function" && screen.layoutRoot !== undefined) {
    const root = screen.layoutRoot;
    // A line as wide as the panel: the row gives the filler what it measures, the chat the rest.
    const filler: Component = { render: () => [" ".repeat(panelWidth())], invalidate() {} };
    screen.setLayoutRoot(new HStack([{ component: root, basis: 0, grow: 1 }, { component: filler }]));
    return () => screen.setLayoutRoot!(root);
  }
  // Read from the prototype: the screen's own render, not one laid over it.
  const render = (Object.getPrototypeOf(tui) as Screen).render;
  screen.render = function (this: Screen, width: number) {
    return render.call(this, Math.max(1, width - panelWidth()));
  };
  return () => {
    screen.render = render;
  };
}

/** A mouse event as pi's full screen reads it from the terminal, before it is dispatched: x from 0. */
interface RawMouse {
  button: number;
  x: number;
  y: number;
  release?: boolean;
}

/**
 * A press of a mouse button, as pi's full screen takes it - `side` told whether it was in the chat, left of `chatWidth()`
 * columns, or in the panel - before the press goes on as it would have. Motion and the wheel are not presses. pi's
 * regular screen reads no mouse: nothing is done there. Returns what takes the watch off.
 */
export function clickToFocus(tui: object, chatWidth: () => number, side: (side: "chat" | "panel") => void): () => void {
  const screen = tui as { handleMouseEvent?: (raw: RawMouse) => void };
  const handle = screen.handleMouseEvent;
  if (typeof handle !== "function") return () => {};
  screen.handleMouseEvent = function (this: unknown, raw: RawMouse) {
    // 32: motion; 64: the wheel.
    if (raw.release !== true && (raw.button & (32 | 64)) === 0) side(raw.x < chatWidth() ? "chat" : "panel");
    return handle.call(this, raw);
  };
  return () => {
    screen.handleMouseEvent = handle;
  };
}
