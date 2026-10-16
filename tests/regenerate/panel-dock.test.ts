import { describe, expect, it } from "vitest";
import { type Component, compositeTuiLine, visibleWidth } from "@earendil-works/pi-tui";
import { clickToFocus, dockedWidth, narrowChat, shade, shadeChat } from "../../src/regenerate/panel-dock.ts";
import { overPictureRow, PICTURE_AT } from "../../src/picture-row.ts";
import { createSidePanel } from "../../src/regenerate/side-panel.ts";
import type { TranscriptStyle } from "../../src/regenerate/transcript-view.ts";

/** A chat that says how wide it was last drawn. */
const chat = () => {
  const drawn = { width: 0 };
  const component: Component = {
    render: (width) => {
      drawn.width = width;
      return ["chat"];
    },
    invalidate() {},
  };
  return { drawn, component };
};

describe("the side panel beside the chat", () => {
  it("takes half a wide terminal, the chat the odd column, and none of one too narrow to share", () => {
    expect(dockedWidth(200)).toBe(100);
    expect(dockedWidth(201)).toBe(100);
    expect(dockedWidth(100)).toBe(50);
    expect(dockedWidth(99)).toBe(0);
  });

  it("draws pi's full screen chat in what the panel leaves it, and gives the layout back as it was", () => {
    const { drawn, component } = chat();
    const screen = {
      layoutRoot: component as Component | undefined,
      setLayoutRoot(root: Component | undefined) {
        this.layoutRoot = root;
      },
      render: () => [],
    };
    const undock = narrowChat(screen, () => 40);
    expect(screen.layoutRoot).not.toBe(component);
    screen.layoutRoot!.render(120);
    expect(drawn.width).toBe(80);
    undock();
    expect(screen.layoutRoot).toBe(component);
  });

  it("follows the panel's width at each frame, the chat whole at none", () => {
    const { drawn, component } = chat();
    const screen = { layoutRoot: component as Component | undefined, setLayoutRoot(root: Component | undefined) { this.layoutRoot = root; }, render: () => [] };
    let beside = 40;
    narrowChat(screen, () => beside);
    beside = 0;
    screen.layoutRoot!.render(120);
    expect(drawn.width).toBe(120);
  });

  it("draws pi's regular screen in fewer columns, and its own render again once undone", () => {
    class Screen {
      widths: number[] = [];
      render(width: number): string[] {
        this.widths.push(width);
        return [];
      }
    }
    const screen = new Screen();
    const undock = narrowChat(screen, () => 40);
    screen.render(120);
    undock();
    screen.render(120);
    expect(screen.widths).toEqual([80, 120]);
  });
});

describe("a click beside the docked panel", () => {
  it("gives the keys to the side it lands on, and the press goes on as it would have", () => {
    const passed: number[] = [];
    const screen = { handleMouseEvent: (raw: { x: number }) => void passed.push(raw.x) };
    const sides: string[] = [];
    const unwatch = clickToFocus(screen, () => 110, (side) => sides.push(side));
    screen.handleMouseEvent({ button: 0, x: 4, y: 3 } as never);
    screen.handleMouseEvent({ button: 0, x: 4, y: 3, release: true } as never);
    screen.handleMouseEvent({ button: 0, x: 150, y: 3 } as never);
    // Motion, and the wheel, are no clicks.
    screen.handleMouseEvent({ button: 32, x: 4, y: 3 } as never);
    screen.handleMouseEvent({ button: 64, x: 4, y: 3 } as never);
    expect(sides).toEqual(["chat", "panel"]);
    expect(passed).toEqual([4, 4, 150, 4, 4]);
    unwatch();
    screen.handleMouseEvent({ button: 0, x: 150, y: 3 } as never);
    expect(sides).toEqual(["chat", "panel"]);
  });
});

describe("the side without the keys, in the shade", () => {
  it("draws a line faint, and faint again after each reset in it - not after a colour", () => {
    expect(shade("plain")).toBe("\x1b[2mplain\x1b[22m");
    expect(shade("\x1b[31mred\x1b[0m after")).toBe("\x1b[2m\x1b[31mred\x1b[0m\x1b[2m after\x1b[22m");
    expect(shade("\x1b[1mbold\x1b[22m after")).toBe("\x1b[2m\x1b[1mbold\x1b[22m\x1b[2m after\x1b[22m");
  });

  it("leaves a line holding a picture as it is", () => {
    const picture = "text\x1b[2G\x1b_Ga=T,f=100;QUJD\x1b\\";
    expect(shade(picture)).toBe(picture);
  });

  it("shades the chat's rows as the panel is laid over them, only while it is to be shaded", () => {
    const bases: string[] = [];
    const screen = { compositeLineAt: (base: string) => (bases.push(base), base) };
    let shaded = true;
    const unshade = shadeChat(screen, () => shaded);
    screen.compositeLineAt("chat", "", 0, 0, 0);
    shaded = false;
    screen.compositeLineAt("chat", "", 0, 0, 0);
    unshade();
    shaded = true;
    screen.compositeLineAt("chat", "", 0, 0, 0);
    expect(bases).toEqual(["\x1b[2mchat\x1b[22m", "chat", "chat"]);
  });
});

describe("the banner's picture row under the docked panel", () => {
  const picture = "\x1b_Ga=T,f=100,i=7;QUJD\x1b\\";

  it("keeps the padding a narrower chat is given before the picture, so nothing is written over the row from its column", () => {
    // The chat's row, as pi lays it out beside the panel: padded after the picture to the chat's width.
    const row = compositeTuiLine("", `  text beside${PICTURE_AT}${picture}`, 0, 110, 200);
    const drawn = overPictureRow(row, "│ regen", 110, 90, 200, 12)!;
    expect(drawn.endsWith(`${PICTURE_AT}${picture}`)).toBe(true);
    const text = drawn.slice(0, drawn.lastIndexOf(PICTURE_AT));
    expect(text).toContain("text beside");
    expect(visibleWidth(text)).toBe(200);
    expect(text.indexOf("│ regen")).toBeGreaterThan(text.indexOf("text beside"));
  });

  it("leaves a row with no picture to pi", () => {
    expect(overPictureRow("just text", "│ regen", 110, 90, 200, 12)).toBeUndefined();
  });
});

describe("the side panel's s key", () => {
  const style: TranscriptStyle = { heading: (text) => text, muted: (text) => text, accent: (text) => text, error: (text) => text, success: (text) => text };

  it("goes from over the screen to beside the chat and back, the keys it shows with it", () => {
    let docked = false;
    const panel = createSidePanel({ jobs: () => [], rows: () => 20, style, back() {}, close() {}, key: "ctrl+h", dock: { docked: () => docked, toggle: () => (docked = !docked) } });
    expect(panel.render(100).join("\n")).toContain("s beside the chat");
    panel.handleInput("s");
    expect(docked).toBe(true);
    const beside = panel.render(100).join("\n");
    expect(beside).toContain("s full screen");
    expect(beside).toContain("ctrl+h or esc to the chat");
    expect(beside).toContain("ctrl+c close");
    panel.handleInput("s");
    expect(docked).toBe(false);
  });

  it("is not offered without a way to dock", () => {
    const panel = createSidePanel({ jobs: () => [], rows: () => 20, style, back() {}, close() {}, key: "ctrl+h" });
    expect(panel.render(100).join("\n")).not.toContain("s beside the chat");
  });
});
