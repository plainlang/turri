import type { ChainEntry } from "./requires.ts";
import type { ChainEvent } from "./module.ts";
import type { ModuleEvent } from "./module.ts";

/**
 * A live picture of a render in progress.
 *
 * A render runs as a background job, so the tool result is gone long before the work is.
 * The tracker turns the two event streams - the chain walking modules, each module walking
 * functionalities - into a few lines that can be dropped into a widget and replaced as
 * they change.
 */

export type Phase = "render" | "conformance" | "regression";

interface ModuleProgress {
  module: string;
  frids: string[];
  done: string[];
  current?: string;
  /** The text of the functional spec being built now. */
  spec?: string;
  phase?: Phase;
  state: "queued" | "building" | "built" | "skipped" | "stopped";
  copied?: number;
  repairs: number;
}

export interface ProgressTracker {
  onChainEvent(event: ChainEvent): void;
  onModuleEvent(event: ModuleEvent): void;
  /** Every module, one line each. Empty before the chain is known. */
  lines(): string[];
  /**
   * The same, sized for a long chain: finished modules counted rather than listed, the
   * waiting ones on one counted line. Nothing that matters is dropped - the module being
   * built and any that stopped keep their full line - and a short chain is shown in full.
   */
  compactLines(): string[];
  /** One line for the status bar. */
  summary(): string;
  done(): boolean;
}

const MARK = { built: "✓", building: "•", queued: " ", skipped: "–", stopped: "✗" } as const;

/** A chain this short is shown in full even when compact. */
const COMPACT_THRESHOLD = 6;

export function createProgressTracker(): ProgressTracker {
  let modules: ModuleProgress[] = [];
  let finished = false;

  const current = () => modules.find((m) => m.state === "building");

  /**
   * Each module's lines: one, and for the module being built the text of the functional spec
   * it is on - its first line, or all of it when expanded.
   */
  const rowsFor = (expanded: boolean): string[][] => {
    if (modules.length === 0) return [];
    const width = Math.max(...modules.map((x) => x.module.length));
    return modules.map((m) => {
      const mark = MARK[m.state];
      const name = m.module.padEnd(width);

      if (m.state === "skipped") return [`${mark} ${name}  already built`];
      if (m.state === "queued") return [`${mark} ${name}  queued`];

      const bar = progressBar(m.done.length, m.frids.length);
      const detail =
        m.state === "building"
          ? `${bar} ${m.done.length}/${m.frids.length}` +
            (m.current !== undefined ? `  functionality ${m.current}${m.phase ? ` · ${m.phase}` : ""}` : "") +
            (m.copied !== undefined && m.done.length === 0 ? `  (${m.copied} files copied in)` : "")
          : `${bar} ${m.done.length}/${m.frids.length}`;
      const repairs = m.repairs > 0 ? `  ${m.repairs} repair${m.repairs === 1 ? "" : "s"}` : "";
      const row = [`${mark} ${name}  ${detail}${repairs}`];

      if (m.state === "building" && m.spec !== undefined) {
        const text = m.spec.split("\n").filter((line) => line.trim() !== "");
        if (expanded) row.push(...text.map((line) => `    │ ${line}`));
        else row.push(`    │ ${(text[0] ?? "").trim()}${text.length > 1 ? `  (+${text.length - 1} line${text.length === 2 ? "" : "s"} · ctrl+o)` : ""}`);
      }
      return row;
    });
  };

  return {
    onChainEvent(event) {
      if (event.type === "chain") {
        modules = (event.chain as ChainEntry[]).map((entry) => ({
          module: entry.moduleName,
          frids: entry.frids,
          done: [],
          state: "queued",
          repairs: 0,
        }));
        return;
      }

      // A copied event names two modules and neither of them is `module`, so it is
      // handled before the lookup the others share.
      if (event.type === "copied") {
        const to = modules.find((m) => m.module === event.to);
        if (to !== undefined) to.copied = event.files;
        return;
      }

      const target = modules.find((m) => m.module === event.module);
      if (target === undefined) return;

      if (event.type === "module_start") target.state = "building";
      else if (event.type === "module_skipped") target.state = "skipped";
      else if (event.type === "module_done") target.state = event.passed ? "built" : "stopped";

      finished = modules.every((m) => m.state !== "queued" && m.state !== "building");
    },

    onModuleEvent(event) {
      const target = current();
      if (target === undefined) return;

      if (event.type === "functionality_start") {
        target.current = event.frid;
        target.spec = event.spec;
        target.phase = undefined;
      } else if (event.type === "phase") {
        target.phase = event.phase;
      } else if (event.type === "repair") {
        target.repairs += 1;
      } else if (event.type === "functionality_skipped") {
        if (!target.done.includes(event.frid)) target.done.push(event.frid);
      } else if (event.type === "functionality_done") {
        if (!target.done.includes(event.frid)) target.done.push(event.frid);
        target.current = undefined;
        target.spec = undefined;
        target.phase = undefined;
      } else if (event.type === "stopped") {
        target.state = "stopped";
      }
    },

    lines() {
      return rowsFor(true).flat();
    },

    compactLines() {
      const rows = rowsFor(false);
      if (modules.length <= COMPACT_THRESHOLD) return rows.flat();

      const finished = modules.filter((m) => m.state === "built" || m.state === "skipped").length;
      const lines = [`${finished}/${modules.length} modules built`];
      const waiting: string[] = [];
      modules.forEach((m, index) => {
        if (m.state === "building" || m.state === "stopped") lines.push(...rows[index]!);
        else if (m.state === "queued") waiting.push(m.module);
      });
      if (waiting.length > 0) lines.push(`  queued (${waiting.length}): ${waiting.join(" → ")}`);
      lines.push("  ctrl+o shows every module");
      return lines;
    },

    summary() {
      const active = current();
      if (modules.length === 0) return "starting";
      if (finished) {
        const built = modules.filter((m) => m.state === "built" || m.state === "skipped").length;
        return `${built}/${modules.length} modules`;
      }
      if (active === undefined) return "starting";
      const index = modules.indexOf(active) + 1;
      return (
        `${active.module} (${index}/${modules.length})` +
        (active.current !== undefined ? ` · functionality ${active.current}` : "") +
        (active.phase !== undefined ? ` · ${active.phase}` : "")
      );
    },

    done() {
      return finished;
    },
  };
}

/** A fixed-width bar, so the lines do not jump around as the numbers change. */
export function progressBar(done: number, total: number, width = 10): string {
  if (total <= 0) return "";
  const filled = Math.round((done / total) * width);
  return `[${"█".repeat(filled)}${"·".repeat(Math.max(0, width - filled))}]`;
}
