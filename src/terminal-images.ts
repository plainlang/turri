import { resetCapabilitiesCache } from "@earendil-works/pi-tui";

/**
 * Whether the terminal turri runs in can show images, settled before pi-tui guesses wrong.
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

export function terminalShowsNoImages(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PI_IMAGE_PROTOCOL !== undefined) return false;
  const term = env.TERM?.toLowerCase() ?? "";
  if (term.includes("kitty") || term.includes("ghostty")) return false;
  const program = env.TERM_PROGRAM?.toLowerCase();
  return program !== undefined && program !== "" && !SHOWS_IMAGES.has(program);
}

if (terminalShowsNoImages()) {
  process.env.PI_IMAGE_PROTOCOL = "none";
  resetCapabilitiesCache();
}
