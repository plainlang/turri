import type { PlainRole } from "../plain/highlight.ts";
import type { DiffPaint } from "./diff-view.ts";

/**
 * The colours a spec diff is painted in: ***plain's own, and the diff's fills - turri's, not a theme's
 * slots. A theme's colours for code are made for code, and the turri themes paint every background their
 * surface colour, so a diff drawn with them has no fills and hardly any highlighting. So each piece of
 * ***plain gets a hue of its own, legible on the theme's surface, and an added or removed line a fill
 * that shows - a highlighter's, with the text on top.
 */

interface Ink {
  colour: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

interface Palette {
  roles: Record<PlainRole, Ink>;
  /** The +/- of an added and a removed line. */
  added: string;
  removed: string;
  /** The fill behind an added and a removed line. */
  addedFill: string;
  removedFill: string;
  muted: string;
}

/** On a dark surface - turri-dark's #0f0f0f, pi's dark ones. Every colour at least 7:1 on it, and 4.5:1 on the fills. */
const DARK: Palette = {
  roles: {
    section: { colour: "#fcd34d", bold: true },
    concept: { colour: "#7dd3fc" },
    link: { colour: "#c4b5fd", underline: true },
    literal: { colour: "#fdba74" },
    keyword: { colour: "#f9a8d4", bold: true },
    module: { colour: "#5eead4" },
    comment: { colour: "#b4bfcf", italic: true },
    bullet: { colour: "#b4bfcf" },
  },
  added: "#86efac",
  removed: "#fca5a5",
  addedFill: "#1f4d2e",
  removedFill: "#5c2323",
  muted: "#808080",
};

/** On a light surface - turri-light's white, pi's light ones. Every colour at least 7:1 on it, and 5:1 on the fills. */
const LIGHT: Palette = {
  roles: {
    section: { colour: "#0a1fd4", bold: true },
    concept: { colour: "#155e75" },
    link: { colour: "#6d28d9", underline: true },
    literal: { colour: "#92400e" },
    keyword: { colour: "#9d174d", bold: true },
    module: { colour: "#065f46" },
    comment: { colour: "#475569", italic: true },
    bullet: { colour: "#475569" },
  },
  added: "#166534",
  removed: "#991b1b",
  addedFill: "#d3f5dc",
  removedFill: "#fcd9d9",
  muted: "#6b7280",
};

const rgb = (hex: string): [number, number, number] => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** A colour's SGR parameters: 24-bit, or the nearest of the 256 where the terminal has no more. */
function sgr(hex: string, background: boolean, truecolor: boolean): string {
  const [r, g, b] = rgb(hex);
  if (truecolor) return `${background ? 48 : 38};2;${r};${g};${b}`;
  const step = (value: number) => (value < 48 ? 0 : value < 115 ? 1 : Math.min(5, Math.floor((value - 35) / 40)));
  return `${background ? 48 : 38};5;${16 + 36 * step(r) + 6 * step(g) + step(b)}`;
}

const paintWith = (ink: Ink, text: string, truecolor: boolean): string => {
  const on = [sgr(ink.colour, false, truecolor), ...(ink.bold ? ["1"] : []), ...(ink.italic ? ["3"] : []), ...(ink.underline ? ["4"] : [])].join(";");
  const off = ["39", ...(ink.bold ? ["22"] : []), ...(ink.italic ? ["23"] : []), ...(ink.underline ? ["24"] : [])].join(";");
  return `\x1b[${on}m${text}\x1b[${off}m`;
};

/** A fill behind a whole row: set again after every reset inside it, so nothing in the row ends it early. */
const fillWith = (hex: string, text: string, truecolor: boolean): string => {
  const on = `\x1b[${sgr(hex, true, truecolor)}m`;
  return `${on}${text.replace(/\x1b\[(?:0|49)?m/g, (reset) => `${reset}${on}`)}\x1b[49m`;
};

/**
 * Brand blue, for what is shown to do what its spec says - the regeneration's ⊨. Brand blue itself on a light surface, 9.72:1
 * on white; on a dark one, where it is illegible (1.97:1 on brand black - see docs/theming.md), its tint 55% of the way
 * to white, 7.34:1 on brand black.
 */
export const BRAND_BLUE = { light: "#0a1fd4", dark: "#919aec" };

/** Text in brand blue on a theme - its tint on a dark one - in as many colours as the terminal has. */
export function brandBlue(theme: { appearance?: "dark" | "light"; getColorMode?(): string }): (text: string) => string {
  const colour = theme.appearance === "light" ? BRAND_BLUE.light : BRAND_BLUE.dark;
  const truecolor = (theme.getColorMode?.() ?? "truecolor") === "truecolor";
  return (text) => paintWith({ colour, bold: true }, text, truecolor);
}

/** How a spec diff is painted on a theme: its palette by whether the theme is dark or light, in as many colours as the terminal has. */
export function plainPaint(theme: { appearance?: "dark" | "light"; getColorMode?(): string }): DiffPaint {
  const palette = theme.appearance === "light" ? LIGHT : DARK;
  const truecolor = (theme.getColorMode?.() ?? "truecolor") === "truecolor";
  return {
    syntax: (role, text) => paintWith(palette.roles[role], text, truecolor),
    added: (text) => paintWith({ colour: palette.added, bold: true }, text, truecolor),
    removed: (text) => paintWith({ colour: palette.removed, bold: true }, text, truecolor),
    addedBand: (text) => fillWith(palette.addedFill, text, truecolor),
    removedBand: (text) => fillWith(palette.removedFill, text, truecolor),
    muted: (text) => paintWith({ colour: palette.muted }, text, truecolor),
  };
}
