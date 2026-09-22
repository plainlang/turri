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
  phase?: Phase;
  state: "queued" | "building" | "built" | "skipped" | "stopped";
  copied?: number;
  repairs: number;
}

export interface ProgressTracker {
  onChainEvent(event: ChainEvent): void;
  onModuleEvent(event: ModuleEvent): void;
  /** The widget's contents. Empty before the chain is known. */
  lines(): string[];
  /** One line for the status bar. */
  summary(): string;
  done(): boolean;
}

const MARK = { built: "✓", building: "•", queued: " ", skipped: "–", stopped: "✗" } as const;

export function createProgressTracker(): ProgressTracker {
  let modules: ModuleProgress[] = [];
  let finished = false;

  const current = () => modules.find((m) => m.state === "building");

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
        target.phase = undefined;
      } else if (event.type === "stopped") {
        target.state = "stopped";
      }
    },

    lines() {
      if (modules.length === 0) return [];

      return modules.map((m) => {
        const mark = MARK[m.state];
        const name = m.module.padEnd(Math.max(...modules.map((x) => x.module.length)));

        if (m.state === "skipped") return `${mark} ${name}  already built`;
        if (m.state === "queued") return `${mark} ${name}  queued`;

        const bar = progressBar(m.done.length, m.frids.length);
        const detail =
          m.state === "building"
            ? `${bar} ${m.done.length}/${m.frids.length}` +
              (m.current !== undefined ? `  functionality ${m.current}${m.phase ? ` · ${m.phase}` : ""}` : "") +
              (m.copied !== undefined && m.done.length === 0 ? `  (${m.copied} files copied in)` : "")
            : `${bar} ${m.done.length}/${m.frids.length}`;

        const repairs = m.repairs > 0 ? `  ${m.repairs} repair${m.repairs === 1 ? "" : "s"}` : "";
        return `${mark} ${name}  ${detail}${repairs}`;
      });
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
