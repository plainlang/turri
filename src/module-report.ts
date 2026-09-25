import type { ModuleEvent } from "./render/module.ts";

export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

export function reportEvent(event: ModuleEvent): void {
  switch (event.type) {
    case "functionality_start":
      console.log(
        `\n${c.bold(c.cyan(`── functionality ${event.frid}`))} ${c.dim(`(${event.index}/${event.total})`)}`,
      );
      if (event.spec) console.log(event.spec.split("\n").map((line) => `   ${c.dim("│")} ${line}`).join("\n"));
      break;
    case "phase":
      console.log(`\n${c.bold(`> ${event.phase}`)} ${c.dim(event.frid)}`);
      break;
    case "run":
      console.log(
        `\n${event.exitCode === 0 ? c.green("pass") : c.red(`exit ${event.exitCode}`)} ${c.dim(
          event.frids ? `${event.command}  [regression over ${event.frids.join(", ")}]` : event.command,
        )}`,
      );
      break;
    case "repair":
      console.log(`\n${c.yellow(c.bold("repairing regression"))} ${c.dim(event.frids.join(", "))}`);
      break;
    case "functionality_done":
      console.log(`\n${c.green(c.bold(`functionality ${event.frid} complete`))}`);
      break;
    case "stopped":
      console.log(`\n${c.red(c.bold(`stopped at ${event.at}`))} ${c.dim(`functionality ${event.frid}`)}`);
      break;
  }
}
