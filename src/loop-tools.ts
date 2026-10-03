import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { defineTool, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CONFIG_FILE, moduleConfigFile, modulesWithConfig, readProjectConfig } from "./config.ts";
import { checkPlainFile } from "./plain/check.ts";
import { describeDrift, describeModules, type ModuleStatus, type WorkLoop } from "./grow/loop.ts";
import type { JobRegistry } from "./grow/jobs.ts";
import { stopDeployed } from "./grow/release.ts";

/**
 * The tools that act on the work loop - `regrow`, `drift` and `halt` - defined once, for the conversation and for the
 * skills alike: a skill that grows what a spec holds, or reads how far it is grown, uses the conversation's own tools,
 * on the conversation's loop, never copies of them.
 */

type AnyTool = ToolDefinition<any, any, any>;

/** How the queue is to be planned, for the work this call queues - see grow/steer.ts. */
export const GUIDANCE_PARAM = Type.Optional(
  Type.String({
    description:
      "How to plan the queue for this work, in a sentence or two - which functional specs go together, what first - as " +
      "the user said it, or as you understood it. A strong preference for the planner, within its limits. Omit when there is none.",
  }),
);

export const WORKING_DIR_PARAM = Type.Optional(
  Type.String({
    description:
      "The folder to render from, relative to where turri was started - as if it had been started there " +
      "(e.g. \"plain\"). plain_file, build_dir and a spec diff's paths are then relative to it - hubspot.plain, not " +
      "plain/hubspot.plain. Default: where " +
      "turri was started.",
  }),
);

export const MODEL_PARAM = Type.Optional(
  Type.String({
    description:
      "The model for the agents of this one call: a provider/model-id, or its name as the user said it. " +
      "Omitted: the model chosen for this kind of work with engine, else the conversation's. " +
      "To change it for every later render, use engine instead.",
  }),
);

export const WAIT_PARAM = Type.Optional(
  Type.Boolean({
    description:
      "Block until the work finishes instead of returning a pulse id. Defaults to false in the " +
      "interactive TUI and true elsewhere, where a pulse would not outlive the turn.",
  }),
);

/**
 * A render tool's arguments as if turri had been started in `working_dir`: the .plain file
 * and the build folder made absolute from there, and that folder as `base`.
 */
export function fromWorkingDir<T extends { working_dir?: string; plain_file?: string; build_dir?: string }>(
  cwd: string,
  params: T,
): T & { base: string } {
  const base = params.working_dir !== undefined && params.working_dir.trim() !== "" ? resolve(cwd, params.working_dir) : cwd;
  let plainFile = params.plain_file !== undefined ? resolve(base, params.plain_file) : undefined;
  if (params.plain_file !== undefined && plainFile !== undefined && !existsSync(plainFile)) {
    // plain/hubspot.plain with working_dir plain: the folder named twice. Taken from where it is.
    const fromSession = resolve(cwd, params.plain_file);
    if (existsSync(fromSession)) plainFile = fromSession;
    else {
      throw new Error(
        `There is no .plain file at ${plainFile}` +
          (base !== cwd ? ` - plain_file is relative to working_dir (${relative(cwd, base) || "."}), so do not repeat the folder in it.` : "."),
      );
    }
  }
  return {
    ...params,
    base,
    ...(plainFile !== undefined ? { plain_file: plainFile } : {}),
    ...(params.build_dir !== undefined ? { build_dir: resolve(base, params.build_dir) } : {}),
  };
}

/** What the loop is doing for a spec's modules, for the conversation - and, waiting, how each module ended. */
export async function loopReply(loop: WorkLoop, statuses: ModuleStatus[], wait: boolean) {
  if (wait) await loop.drain();
  const now = wait ? loop.status().filter((status) => statuses.some((asked) => asked.plainFile === status.plainFile)) : statuses;
  const jobIds = now.flatMap((status) => (status.running !== undefined ? [status.running.jobId] : []));
  const text = [
    describeModules(now),
    "",
    wait
      ? "Tell the user how it went."
      : "It grows in the background: tell the user what runs and what is planned, and carry on. Use growth with a pulse's id if they ask how it is going.",
  ].join("\n");
  return { content: [{ type: "text" as const, text }], details: { jobIds } };
}

/** Halt a pulse by its id, or the start of it: what it was, and what moves up behind it. `reason`: why, kept with it. */
export function stopJob(jobs: JobRegistry, named: string, reason?: string): string {
  const matches = jobs.list().filter((job) => job.id.startsWith(named.trim()));
  if (matches.length === 0) return `No pulse ${named}. /regeneration shows them.`;
  if (matches.length > 1) return `'${named}' matches ${matches.map((job) => job.id).join(", ")}. Give more of the id.`;
  const target = matches[0]!;
  const behind = jobs.list().filter((job) => job.status === "queued" && job.waitingOn.includes(target.id));
  const stopped = jobs.stop(target.id);
  if (stopped === undefined) return `Pulse ${target.id} (${target.summary}) is already ${target.status}.`;
  if (reason !== undefined && reason.trim() !== "") stopped.note = `Halted: ${reason.trim()}`;
  const queued = behind.length > 0 ? ` Queued behind it, now moving up: ${behind.map((job) => `${job.summary} (${job.id})`).join(", ")}.` : "";
  // A spec diff's change is in the .plain files: stopping its render does not take it out of the spec.
  const inSpec =
    target.kind === "regrow"
      ? " Its change is still in the .plain files: nothing more grows in that codebase until the spec changes or it is asked " +
        "for again with regrow - then it grows with the rest. To drop the change, take it out of the spec and regrow; to change " +
        "how the work is cut or ordered, use steer."
      : "";
  return stopped.status === "stopped"
    ? `Stopped ${target.summary} (${target.id}) before it started.${queued}${inSpec}`
    : `Stopping ${target.summary} (${target.id}): its agent is being stopped now.${queued}${inSpec}`;
}

export interface LoopToolsOptions {
  /** Where turri was started: the folder plain_file and working_dir are relative to. */
  cwd: string;
  /** The pulses `halt` stops. Without them - the release agent's - it stops only what activate started. */
  jobs?: JobRegistry;
  /** The work loop the tools act on - the conversation's, for a call in it. */
  loop?: (ctx: ExtensionContext) => WorkLoop;
  /** The model a pulse of this call grows on: the one named, or the one chosen for the work. Default: the one named. */
  model?: (ctx: ExtensionContext, plainFile: string, named?: string) => string | undefined;
  /** Whether a call waits for its work to finish, given what it asked. Default: only when it asked to. */
  wait?: (ctx: ExtensionContext, asked?: boolean) => boolean;
}

/** The module to act on: the .plain file named, or the one the project's config.yaml names. */
function plainFileOf(cwd: string, given: { plain_file?: string; working_dir?: string }, what: string): string {
  const located = fromWorkingDir(cwd, given);
  const named = located.plain_file ?? readProjectConfig(located.base).module;
  if (named === undefined) {
    const stacks = modulesWithConfig(located.base);
    throw new Error(
      stacks.length > 0
        ? `Name the .plain file to ${what}: this project has modules with configs of their own - ${stacks.map((module) => `${module} (${moduleConfigFile(module)})`).join(", ")}.`
        : `Name the .plain file to ${what}, or set module: in ${CONFIG_FILE}.`,
    );
  }
  return resolve(located.base, named);
}

/** regrow: grow a module's code up to its spec as it is now. */
export function regrowTool(options: LoopToolsOptions & { loop: (ctx: ExtensionContext) => WorkLoop }): AnyTool {
  return defineTool({
    name: "regrow",
    label: "Regrow",
    description:
      "Regrow a .plain module's code from its spec as the files have it now - and every module it requires, bottom of the " +
      "requires chain first. Call it after any change to the spec, by any means: the file tools, a skill, the user in an " +
      "editor. It takes no diff: what is left to grow - from what each module's code was grown from to its spec now - is " +
      "worked out and planned into pulses, and a pulse running that grows something the spec no longer wants is stopped and " +
      "rolled back. Nothing to do where the code is grown from the spec as it is. To grow again what is grown already, " +
      "use rejuvenate.",
    promptSnippet: "regrow a module's code from its spec as it is now - after any change to the spec",
    promptGuidelines: [
      "Call regrow after editing a .plain file with the file tools - or when the user says they changed one - instead of working out a diff: turri compares what is grown with the spec now.",
      "regrow returns at once with what runs and what is planned. Report it, keep talking, and use growth when the user asks; the pulses report when they finish.",
      "When the user wants a functionality to come out differently, change its spec - the spec is what persists - then regrow. When they want what is grown grown again as its spec stands - better made, on another model - that is rejuvenate.",
      "A change to a file the spec links - an API surface, a mapping document - is a change to the spec: regrow sees it by itself, and grows again every functional spec that uses what links it.",
      "Never stop pulses and start them again yourself to follow a spec change: regrow does it.",
    ],
    parameters: Type.Object({
      plain_file: Type.Optional(Type.String({ description: "Path to the .plain file. Omitted: the module the project's config.yaml names" })),
      working_dir: WORKING_DIR_PARAM,
      guidance: GUIDANCE_PARAM,
      model: MODEL_PARAM,
      wait: WAIT_PARAM,
    }),
    async execute(_id, given, _signal, _onUpdate, ctx) {
      const plainFile = plainFileOf(options.cwd, given, "regrow");
      const check = checkPlainFile(plainFile);
      if (!check.ok) throw new Error(`${relative(options.cwd, plainFile) || plainFile} does not parse, so nothing can grow from it yet: ${check.error}`);
      const model = options.model !== undefined ? options.model(ctx, plainFile, given.model) : given.model;
      const loop = options.loop(ctx);
      const request = { ...(model !== undefined ? { model } : {}), ...(given.guidance !== undefined ? { guidance: given.guidance } : {}) };
      const statuses = await loop.bringUp(plainFile, request);
      return loopReply(loop, statuses, options.wait !== undefined ? options.wait(ctx, given.wait) : given.wait === true);
    },
  });
}

/** drift: what is left to grow - planning nothing, starting nothing. */
export function driftTool(options: LoopToolsOptions & { loop: (ctx: ExtensionContext) => WorkLoop }): AnyTool {
  return defineTool({
    name: "drift",
    label: "Drift",
    description:
      "How far a module's code has drifted from its spec: in each codebase where it lives, what is left to grow - the " +
      "functional specs to add, change, grow again or take out, and reqs or definitions alone - and the conformance tests " +
      "left to write, those bound ahead of their code, what is growing now, and why nothing grows where nothing does; " +
      "with nothing left, it says the module is fully grown. It plans nothing and starts nothing, and calls no model.",
    promptSnippet: "drift: what is left to grow in a module, code and conformance tests - starting nothing",
    promptGuidelines: [
      "Use drift when the user asks what is left to build, whether a module is up to date with its spec, or what changed since it was last grown. To see the next pulse's prompt as well, use glimpse.",
    ],
    parameters: Type.Object({
      plain_file: Type.Optional(Type.String({ description: "Path to the .plain file. Omitted: the module the project's config.yaml names" })),
      working_dir: WORKING_DIR_PARAM,
    }),
    async execute(_id, given, _signal, _onUpdate, ctx) {
      const reports = options.loop(ctx).drift(plainFileOf(options.cwd, given, "look at"));
      return { content: [{ type: "text" as const, text: describeDrift(reports) }], details: { modules: reports.length } };
    },
  });
}

const ACTIVATED_PARAM = Type.Optional(Type.String({ description: 'What activate started, by name - or "all" for every one' }));
const HALT_PULSE_PARAMS = Type.Object({
  job_id: Type.Optional(Type.String({ description: "The pulse's id, or the start of it" })),
  reason: Type.Optional(Type.String({ description: "Why it is halted, kept with it - what the spec now says that it did not, say" })),
  activated: ACTIVATED_PARAM,
});
/** With no pulses - the release agent's halt - only what activate started. */
const HALT_ACTIVATED_PARAMS = Type.Object({ activated: ACTIVATED_PARAM });

/** halt: stop a pulse, or what activate started. */
export function haltTool(options: Pick<LoopToolsOptions, "jobs">): AnyTool {
  const { jobs } = options;
  return defineTool({
    name: "halt",
    label: "Halt",
    description:
      jobs !== undefined
        ? "Halt a pulse, or what activate started. A pulse: a queued one never starts, a running one has its agent stopped at once, " +
          "and the pulses queued behind it move up - what a running pulse already changed is rolled back, and what it was growing " +
          "counts as not grown. What activate started: the one named, or every one."
        : "Stop what activate started: the one named, or every one.",
    promptSnippet: jobs !== undefined ? "halt a pulse, or what activate started" : "stop a deployed server, or all of them",
    promptGuidelines:
      jobs !== undefined ? ["Halt a pulse only when the user asks, or your instructions say to. Name which one, and say which pulses were queued behind it - they will now run."] : [],
    parameters: (jobs !== undefined ? HALT_PULSE_PARAMS : HALT_ACTIVATED_PARAMS) as typeof HALT_PULSE_PARAMS,
    async execute(_id, params) {
      if (params.job_id === undefined && params.activated === undefined) {
        throw new Error(jobs !== undefined ? "Say what to halt: a job_id, or what activate started (activated)." : 'Say what to stop: its name, or "all" (activated).');
      }
      const lines: string[] = [];
      if (params.job_id !== undefined && jobs !== undefined) lines.push(stopJob(jobs, params.job_id, params.reason));
      if (params.activated !== undefined) {
        const stopped = await stopDeployed(params.activated === "all" ? {} : { name: params.activated });
        lines.push(stopped.length > 0 ? `Halted ${stopped.join(", ")}.` : `Nothing activate started is running${params.activated === "all" ? "" : ` as ${params.activated}`}.`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
    },
  });
}
