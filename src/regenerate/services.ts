import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { agentShell, type AgentShell } from "./agent-shell.ts";
import { maskSecrets } from "./masking.ts";
import { modulesScratchDir } from "./paths.ts";
import { isRunning, startInBackground, stopGroup } from "./shell.ts";

/**
 * What an agent starts and keeps running while it works - a server, a worker - to try the software as someone would,
 * from outside: with curl, or what the stack's own client is. Whatever the stack: the agent gives the command that
 * starts it, and how to tell it is up - a port that answers, or a line in its log. It runs on this machine behind the
 * same walls as the agent's own shell - the command check, the module's environment, the OS sandbox, the audit while it
 * starts - in a process group of its own, so it outlives the command that started it; it is stopped - it and everything
 * it started - when the agent asks, when the agent's session ends, and in any case when its pulse ends.
 */

/** How many services one agent may have running at once. */
export const MAX_SERVICES = 3;
const DEFAULT_READY_SECONDS = 60;
const MAX_READY_SECONDS = 300;
const LOG_LINES = 80;

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

/** Whether something on this machine answers on `port`. */
function answers(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    const end = (up: boolean) => {
      socket.destroy();
      done(up);
    };
    socket.once("connect", () => end(true));
    socket.once("error", () => end(false));
    socket.setTimeout(1000, () => end(false));
  });
}

/** The last `lines` of a log, masked. */
function tail(log: string, lines = LOG_LINES): string {
  if (!existsSync(log)) return "";
  return maskSecrets(readFileSync(log, "utf8").trimEnd().split("\n").slice(-lines).join("\n"));
}

/**
 * Start, read and stop services from `dir` - the folder the agent works in - fenced as its role is: what it may read and
 * write (its workdir when not given), or the shell given.
 */
export function createServiceTools(options: { dir: string; read?: string[]; write?: string[]; shell?: AgentShell }): ServiceTools {
  let shell = options.shell;
  const shellOf = () =>
    (shell ??= agentShell({ workdir: options.dir, ...(options.read !== undefined ? { read: options.read } : {}), ...(options.write !== undefined ? { write: options.write } : {}) }));
  const running = new Map<string, Service>();
  const say = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
  const logsDir = join(modulesScratchDir(options.dir), "services");
  const stop = async (service: Service) => {
    running.delete(service.name);
    await stopGroup(service.pid);
  };

  const start = defineTool({
    name: "start_service",
    label: "Start a service",
    description:
      "Start something that keeps running - a server, a worker - in the background, behind the same walls as your shell, to " +
      "try what is built from outside: then reach it with curl (or the stack's own client) in bash. Give the command that " +
      "starts it, from the code folder, and how to tell it is up: the port it listens on, or a line its log prints once it is " +
      `ready. It returns once it is up - or, if it exits or is not up in time, what it printed. ${MAX_SERVICES} at once at ` +
      "most; each runs until you stop it with stop_service, and is stopped in any case when you finish. A port something " +
      "else holds is not yours: choose another.",
    promptSnippet: "start_service: run a server in the background, to try it from outside with curl",
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
      const fenced = shellOf();
      const checked = fenced.check(command);
      if (!checked.ok) return say(`Not started: ${checked.reason}`);
      mkdirSync(logsDir, { recursive: true });
      const log = join(logsDir, `${name.replace(/[^\w.-]+/g, "_")}-${randomUUID().slice(0, 8)}.log`);
      const limit = Math.min(Math.max(seconds ?? DEFAULT_READY_SECONDS, 1), MAX_READY_SECONDS);

      // Started and waited on under the audit: what it writes while it comes up, outside its role, is put back.
      const { value: outcome, note } = await fenced.audited(async () => {
        const { pid } = startInBackground(command, { cwd: options.dir, env: fenced.env, wrap: (argv) => fenced.wrap(argv), logFile: log });
        running.set(name, { name, command, pid, log });
        for (let i = 0; i < limit * 4; i += 1) {
          if (!isRunning(pid)) return "EXITED";
          if (port !== undefined ? await answers(Math.trunc(port)) : readyLog !== undefined ? tail(log, 10_000).includes(readyLog) : i >= 8) {
            // Up - and still running a moment later: a port someone else holds answers too, while this one exits.
            await new Promise((done) => setTimeout(done, 100));
            return isRunning(pid) ? "READY" : "EXITED";
          }
          await new Promise((done) => setTimeout(done, 250));
        }
        return "TIMEOUT";
      });
      const service = running.get(name)!;
      const printed = tail(log);
      const audit = note !== undefined ? `\n\n${note}` : "";
      if (outcome === "READY") {
        const where = port !== undefined ? ` on port ${Math.trunc(port)} - reach it with curl http://127.0.0.1:${Math.trunc(port)}/...` : "";
        return say(`${name} is up${where}. stop_service stops it; service_logs reads what it prints.\n\n<its log so far>\n${printed}\n</its log so far>${audit}`);
      }
      await stop(service);
      const why = outcome === "EXITED" ? "It exited before it was up" : `It was not up after ${limit} seconds, and was stopped`;
      return say(`${why}. What it printed:\n\n${printed || "(nothing)"}${audit}`);
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
      const printed = tail(service.log, Math.min(Math.max(Math.trunc(lines ?? LOG_LINES), 1), 1000));
      return say(`${isRunning(service.pid) ? `${name} is running.` : `${name} has exited.`}\n\n${printed || "(nothing printed)"}`);
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
