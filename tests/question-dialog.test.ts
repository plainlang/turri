import { describe, expect, it } from "vitest";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { QuestionDialog } from "../src/question-dialog.ts";

/** The keys as a terminal sends them. */
const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", pageDown: "\x1b[6~", pageUp: "\x1b[5~", shiftDown: "\x1b[1;2B" };

const plain = { accent: (text: string) => text, muted: (text: string) => text, bold: (text: string) => text };

function dialog(options: { context?: string; options?: string[]; rows?: number }) {
  const answers: Array<string | undefined> = [];
  let renders = 0;
  const shown = new QuestionDialog({
    question: "Is this the right brief?",
    ...(options.context !== undefined ? { context: options.context } : {}),
    ...(options.options !== undefined ? { options: options.options } : {}),
    rows: () => options.rows ?? 30,
    style: plain,
    done: (answer) => answers.push(answer),
    requestRender: () => (renders += 1),
  });
  const lines = () => shown.render(80).map((line) => stripTerminalSequences(line));
  return { shown, answers, lines, renders: () => renders };
}

const LONG = Array.from({ length: 60 }, (_, index) => `- Feature ${index + 1}: what it does.`).join("\n");

describe("the question dialog", () => {
  it("shows a long brief in a window, with the question and every option below it - all within the screen", () => {
    const { lines } = dialog({ context: LONG, options: ["Build it", "Change something"], rows: 30 });
    const shown = lines();
    expect(shown.length).toBeLessThanOrEqual(30);
    expect(shown.join("\n")).toContain("Feature 1:");
    expect(shown.join("\n")).not.toContain("Feature 60:");
    expect(shown.some((line) => /lines 1-\d+ of 60 - more below/.test(line))).toBe(true);
    expect(shown).toContain("  Is this the right brief?");
    expect(shown).toContain("  › Build it");
    expect(shown).toContain("    Change something");
  });

  it("scrolls the brief with PgUp/PgDn and shift+arrows, to its end and back, the options staying put", () => {
    const { shown, lines } = dialog({ context: LONG, options: ["Build it"], rows: 30 });
    lines();
    shown.handleInput(KEY.shiftDown);
    expect(lines()[0]).toContain("Feature 2:");
    for (let page = 0; page < 10; page += 1) shown.handleInput(KEY.pageDown);
    const end = lines();
    expect(end.join("\n")).toContain("Feature 60:");
    expect(end.some((line) => line.includes("of 60 - the end"))).toBe(true);
    expect(end).toContain("  › Build it");
    for (let page = 0; page < 10; page += 1) shown.handleInput(KEY.pageUp);
    expect(lines()[0]).toContain("Feature 1:");
  });

  it("wraps a long option under its first line instead of cutting it off", () => {
    const long = "Depth 1: 5 fragments, 60 pulses; each depth adds one fragment and has 5 fewer pulses, at least 20; plankton gives 15 pulses back";
    const { lines } = dialog({ options: [long, "Fixed 8 fragments a level"] });
    const shown = lines();
    const first = shown.findIndex((line) => line.startsWith("  › Depth 1:"));
    expect(first).not.toBe(-1);
    expect(shown[first + 1]).toMatch(/^ {4}\S/);
    expect(shown.join(" ").replace(/\s+/g, " ")).toContain("plankton gives 15 pulses back");
    expect(shown.every((line) => line.length <= 80)).toBe(true);
    expect(shown).toContain("    Fixed 8 fragments a level");
  });

  it("scrolls the brief with the mouse wheel", () => {
    const { shown, lines } = dialog({ context: LONG, options: ["Build it"], rows: 30 });
    lines();
    expect(shown.handleMouse({ type: "wheel", button: "none", x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 30, shift: false, alt: false, ctrl: false, wheelDelta: 3 })).toEqual({ handled: true });
    expect(lines()[0]).toContain("Feature 4:");
  });

  it("shows a short brief whole, with nothing to scroll", () => {
    const { lines } = dialog({ context: "- The problem: invoices get lost.", options: ["Build it"] });
    expect(lines().join("\n")).not.toContain("lines ");
    expect(lines()[0]).toBe("  - The problem: invoices get lost.");
  });

  it("picks an option with the arrows and enter, and is dismissed with esc", () => {
    const picking = dialog({ options: ["Build it", "Change something"] });
    picking.shown.handleInput(KEY.down);
    picking.shown.handleInput(KEY.enter);
    expect(picking.answers).toEqual(["Change something"]);
    const dismissing = dialog({ options: ["Build it"] });
    dismissing.shown.handleInput(KEY.escape);
    expect(dismissing.answers).toEqual([undefined]);
  });

  it("takes a typed answer when there are no options, the brief still scrolling above it", () => {
    const { shown, answers, lines } = dialog({ context: LONG, rows: 20 });
    lines();
    shown.handleInput(KEY.pageDown);
    for (const key of "A todo list") shown.handleInput(key);
    expect(lines().join("\n")).toContain("> A todo list");
    shown.handleInput(KEY.enter);
    expect(answers).toEqual(["A todo list"]);
  });
});
