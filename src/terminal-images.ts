import { resetCapabilitiesCache } from "@earendil-works/pi-tui";

/**
 * Whether the terminal turri runs in can show images, and how, settled before pi-tui guesses wrong.
 *
 * pi-tui reads it from the environment, and a terminal started from another inherits that one's
 * variables: Zed opened from Ghostty still has GHOSTTY_RESOURCES_DIR, which pi-tui takes for Ghostty,
 * so it sends images Zed draws as nothing. The terminal a process is really in is the one that set
 * TERM_PROGRAM - or, for Kitty and Ghostty, TERM - last. When that one shows no images, pi-tui is told
 * so through its own PI_IMAGE_PROTOCOL, which it reads each time it looks again (pi re-applies its
 * settings' overrides, so one set in code would not last). A PI_IMAGE_PROTOCOL the person set is kept.
 */

/** TERM_PROGRAM as the terminals that show images set it: Kitty's graphics protocol, or iTerm2's. */
const SHOWS_IMAGES = new Set(["kitty", "ghostty", "wezterm", "warpterminal", "iterm.app"]);

/** The first iTerm2 that speaks the Kitty graphics protocol */
const ITERM2_KITTY_FROM = [3, 7];

/** What PI_IMAGE_PROTOCOL turri sets for this terminal: none where it shows no images, kitty for an iTerm2 that speaks it, else nothing. */
export function imageProtocolFor(env: NodeJS.ProcessEnv = process.env): "none" | "kitty" | undefined {
  if (env.PI_IMAGE_PROTOCOL !== undefined) return undefined;
  const term = env.TERM?.toLowerCase() ?? "";
  if (term.includes("kitty") || term.includes("ghostty")) return undefined;
  const program = env.TERM_PROGRAM?.toLowerCase();
  if (program === undefined || program === "") return undefined;
  if (!SHOWS_IMAGES.has(program)) return "none";
  // pi-tui shows no images under tmux or screen; telling it Kitty's would override that.
  const multiplexed = env.TMUX !== undefined || env.STY !== undefined || term.startsWith("tmux") || term.startsWith("screen");
  if (program === "iterm.app" && !multiplexed && atLeast(env.TERM_PROGRAM_VERSION, ITERM2_KITTY_FROM)) return "kitty";
  return undefined;
}

/** Whether a version such as `3.7.4beta1` is `from` or later; an unreadable one is not. */
function atLeast(version: string | undefined, from: number[]): boolean {
  const parts = /^(\d+)\.(\d+)/.exec(version ?? "");
  if (parts === null) return false;
  const [major, minor] = [Number(parts[1]), Number(parts[2])];
  return major > from[0]! || (major === from[0] && minor >= from[1]!);
}

const protocol = imageProtocolFor();
if (protocol !== undefined) {
  process.env.PI_IMAGE_PROTOCOL = protocol;
  resetCapabilitiesCache();
}
