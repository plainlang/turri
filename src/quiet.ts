/**
 * Keeps library chatter out of the terminal while a tool runs.
 *
 * A skill run spawns many nested agent sessions - an executor, two judges per gate, a fix
 * agent, each queued render - and libraries underneath them write to the console. In the
 * TUI every one of those writes interrupts the differential renderer, which abandons the
 * current frame and leaves it stranded in scrollback. Dozens of "Working" lines pile up.
 *
 * Only the `console` methods are intercepted, never `process.stdout.write` itself: that is
 * how pi draws the TUI, and silencing it would blank the screen. Library noise goes
 * through `console`; pi's rendering does not.
 */

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug" | "trace";

const METHODS: ConsoleMethod[] = ["log", "info", "warn", "error", "debug", "trace"];

/** Buffers currently collecting. Nested and concurrent captures all see the same writes. */
const active = new Set<string[]>();
const original = new Map<ConsoleMethod, (...args: unknown[]) => void>();

function install(): void {
  if (original.size > 0) return;
  for (const method of METHODS) {
    original.set(method, console[method] as (...args: unknown[]) => void);
    console[method] = (...args: unknown[]) => {
      const line = args
        .map((arg) => (typeof arg === "string" ? arg : safeStringify(arg)))
        .join(" ");
      for (const buffer of active) buffer.push(line);
    };
  }
}

function restore(): void {
  if (active.size > 0 || original.size === 0) return;
  for (const [method, fn] of original) console[method] = fn as typeof console.log;
  original.clear();
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}

export interface Captured<T> {
  result: T;
  /** Whatever the libraries tried to print, in order. */
  output: string[];
}

/** Run `fn` with console output collected instead of printed. */
export async function captureConsole<T>(fn: () => Promise<T>): Promise<Captured<T>> {
  // An escape hatch for debugging: with this set, library output goes to the terminal as
  // it used to, which is how the capture itself can be measured.
  if (process.env.FORGE_NO_CAPTURE === "1") return { result: await fn(), output: [] };

  const buffer: string[] = [];
  active.add(buffer);
  install();
  try {
    return { result: await fn(), output: buffer };
  } finally {
    active.delete(buffer);
    restore();
  }
}

/**
 * Capture that spans something other than one promise - a whole agent turn, say.
 *
 * `captureConsole` covers work it can wrap. A conversation's own model calls happen inside
 * pi's agent loop, where there is nothing to wrap, so those are bracketed by hand instead.
 * `end` is safe to call twice and safe to skip: an unbalanced `begin` leaves the console
 * patched, so callers must end it from a handler that always runs.
 */
export function beginCapture(): { end: () => string[] } {
  if (process.env.FORGE_NO_CAPTURE === "1") return { end: () => [] };

  const buffer: string[] = [];
  active.add(buffer);
  install();

  let ended = false;
  return {
    end: () => {
      if (ended) return buffer;
      ended = true;
      active.delete(buffer);
      restore();
      return buffer;
    },
  };
}

/** One line noting what was swallowed, or nothing when it was quiet. */
export function describeCaptured(output: string[]): string | null {
  if (output.length === 0) return null;
  const unique = [...new Set(output.map((line) => line.trim()).filter(Boolean))];
  const shown = unique.slice(0, 3);
  const rest = unique.length - shown.length;
  return (
    `(${output.length} line${output.length === 1 ? "" : "s"} of library output suppressed: ` +
    shown.join(" | ") +
    (rest > 0 ? ` | and ${rest} more` : "") +
    ")"
  );
}
