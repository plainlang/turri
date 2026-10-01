import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runInVm } from "./vm.ts";

/**
 * What an agent starts and keeps running in its VM while it works - a server, a worker - to try the software as
 * someone would, from outside: with curl, or what the stack's own client is. Whatever the stack: the agent gives the
 * command that starts it, and how to tell it is up - a port that answers, or a line in its log. The harness owns what
 * runs: each is started in a session of its own, so it outlives the command that started it, and is stopped - it and
 * everything it started - when the agent asks, and in any case when the agent's session ends.
 */

/** How many services one agent may have running at once. */
export const MAX_SERVICES = 3;
const DEFAULT_READY_SECONDS = 60;
const MAX_READY_SECONDS = 300;
const LOG_LINES = 80;

/**
 * Whether a process is alive: there, and not a zombie - an exited one the guest's init has not reaped yet still
 * answers `kill -0`.
 */
const alive = (pid: number) => `[ "$(sed -E 's/.*\\) (.).*/\\1/' /proc/${pid}/stat 2>/dev/null)" ] && [ "$(sed -E 's/.*\\) (.).*/\\1/' /proc/${pid}/stat 2>/dev/null)" != Z ]`;

/** A string as one shell word. */
const word = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

interface Service {
  name: string;
  command: string;
  pid: number;
  log: string;
}

export interface ServiceTools {
  tools: ToolDefinition[];
  names: string[];
  /** Stop everything still running. Called when the agent's session ends, whatever ended it. */
  stopAll(): Promise<void>;
}

/** Start, read and stop services in the VM of `dir` - the folder the agent works in. */
export function createServiceTools(options: { dir: string }): ServiceTools {
  const running = new Map<string, Service>();
  const say = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
  const run = (command: string, timeoutMs = 30_000) => runInVm(command, { cwd: options.dir, timeoutMs });
  const tailOf = async (service: Service, lines = LOG_LINES) => (await run(`tail -n ${lines} ${word(service.log)} 2>/dev/null`)).output.trimEnd();
  const stop = async (service: Service) => {
    running.delete(service.name);
    // The service's session, and anything it started: asked to end, then made to.
    await run(`kill -TERM -- -${service.pid} ${service.pid} 2>/dev/null; sleep 1; kill -KILL -- -${service.pid} ${service.pid} 2>/dev/null; true`).catch(() => undefined);
  };

  const start = defineTool({
    name: "start_service",
    label: "Start a service",
    description:
      "Start something that keeps running - a server, a worker - in the background, in your VM, to try what is built from " +
      "outside: then reach it with curl (or the stack's own client) in bash. Give the command that starts it, from the code " +
      "folder, and how to tell it is up: the port it listens on, or a line its log prints once it is ready. It returns once " +
      `it is up - or, if it exits or is not up in time, what it printed. ${MAX_SERVICES} at once at most; each runs until you ` +
      "stop it with stop_service, and is stopped in any case when you finish.",
    promptSnippet: "start_service: run a server in the background in your VM, to try it from outside with curl",
    parameters: Type.Object({
      name: Type.String({ description: "A short name for it, to read its log and stop it by" }),
      command: Type.String({ description: "The command that starts it, run from the code folder - e.g. `uvicorn src.main:app --port 8000`" }),
      port: Type.Optional(Type.Number({ description: "The port it listens on: it is up once the port answers" })),
      ready_log: Type.Optional(Type.String({ description: "Text its log prints once it is up - used when it has no port" })),
      timeout_seconds: Type.Optional(Type.Number({ description: `How long it may take to come up. Default ${DEFAULT_READY_SECONDS}, at most ${MAX_READY_SECONDS}` })),
    }),
    async execute(_id, params) {
      const { name, command, port, ready_log: readyLog, timeout_seconds: seconds } = params as { name: string; command: string; port?: number; ready_log?: string; timeout_seconds?: number };
      if (running.has(name)) return say(`A service called ${name} is running already: stop it first, or give this one another name.`);
      if (running.size >= MAX_SERVICES) return say(`${MAX_SERVICES} services are running already (${[...running.keys()].join(", ")}): stop one first.`);
      const log = `/tmp/plainwright-service-${randomUUID().slice(0, 8)}.log`;
      // A session of its own: it outlives this command, and is stopped with everything it starts.
      const started = await run(`setsid nohup /bin/bash -c ${word(command)} > ${word(log)} 2>&1 < /dev/null & echo $!`);
      const pid = Number(started.output.trim().split("\n").at(-1));
      if (started.exitCode !== 0 || !Number.isInteger(pid)) return say(`It could not be started:\n${started.output.trimEnd()}`);
      const service: Service = { name, command, pid, log };
      running.set(name, service);
      const limit = Math.min(Math.max(seconds ?? DEFAULT_READY_SECONDS, 1), MAX_READY_SECONDS);
      const check =
        port !== undefined
          ? // Something in the guest listens on it: the VM's network answers any connection itself, so a connect proves nothing.
            `awk -v p=${Math.trunc(port).toString(16).toUpperCase().padStart(4, "0")} '$4 == "0A" && toupper(substr($2, index($2, ":") + 1)) == p { found = 1 } END { exit !found }' /proc/net/tcp /proc/net/tcp6 2>/dev/null`
          : readyLog !== undefined
            ? `grep -qF -- ${word(readyLog)} ${word(log)}`
            : // Nothing to wait for: up, if it is still running a moment later.
              `[ "$i" -ge 4 ]`;
      const waited = await run(
        [
          `for i in $(seq 1 ${limit * 2}); do`,
          `  ${alive(pid)} || { echo EXITED; exit 3; }`,
          `  if ${check}; then echo READY; exit 0; fi`,
          "  sleep 0.5",
          "done",
          "echo TIMEOUT; exit 4",
        ].join("\n"),
        (limit + 15) * 1000,
      );
      const outcome = waited.output.trim().split("\n").at(-1);
      const printed = await tailOf(service);
      if (outcome === "READY") {
        const where = port !== undefined ? ` on port ${Math.trunc(port)} - reach it with curl http://127.0.0.1:${Math.trunc(port)}/...` : "";
        return say(`${name} is up${where}. stop_service stops it; service_logs reads what it prints.\n\n<its log so far>\n${printed}\n</its log so far>`);
      }
      await stop(service);
      const why = outcome === "EXITED" ? "It exited before it was up" : `It was not up after ${limit} seconds, and was stopped`;
      return say(`${why}. What it printed:\n\n${printed || "(nothing)"}`);
    },
  }) as ToolDefinition;

  const logs = defineTool({
    name: "service_logs",
    label: "Service logs",
    description: "The last lines a service started with start_service has printed - its requests, its errors and their traces.",
    promptSnippet: "service_logs: what a service you started has printed",
    parameters: Type.Object({
      name: Type.String({ description: "The service's name" }),
      lines: Type.Optional(Type.Number({ description: `How many of the last lines. Default ${LOG_LINES}` })),
    }),
    async execute(_id, params) {
      const { name, lines } = params as { name: string; lines?: number };
      const service = running.get(name);
      if (service === undefined) return say(`No service called ${name} is running.${running.size > 0 ? ` Running: ${[...running.keys()].join(", ")}.` : ""}`);
      const up = (await run(`${alive(service.pid)} && echo yes || echo no`)).output.trim() === "yes";
      const printed = await tailOf(service, Math.min(Math.max(Math.trunc(lines ?? LOG_LINES), 1), 1000));
      return say(`${up ? `${name} is running.` : `${name} has exited.`}\n\n${printed || "(nothing printed)"}`);
    },
  }) as ToolDefinition;

  const stopTool = defineTool({
    name: "stop_service",
    label: "Stop a service",
    description: "Stop a service started with start_service, and everything it started.",
    promptSnippet: "stop_service: stop a service you started",
    parameters: Type.Object({ name: Type.String({ description: "The service's name" }) }),
    async execute(_id, params) {
      const { name } = params as { name: string };
      const service = running.get(name);
      if (service === undefined) return say(`No service called ${name} is running.`);
      await stop(service);
      return say(`${name} is stopped.`);
    },
  }) as ToolDefinition;

  return {
    tools: [start, logs, stopTool],
    names: ["start_service", "service_logs", "stop_service"],
    async stopAll() {
      await Promise.all([...running.values()].map((service) => stop(service)));
    },
  };
}
