import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describeGates, runSkill } from "./forge.ts";
import type { Reporter } from "./graph.ts";
import { loadSkill, type Skill } from "./skill.ts";
import { listFrids, renderFunctionality } from "./render/render.ts";
import { renderConformanceTests } from "./render/conformance.ts";
import { regenerateFunctionality, renderModule } from "./render/module.ts";
import { checkPlainTargets, formatCheckResults } from "./plain/check.ts";
import { createRenderQueue } from "./render/queue.ts";
import { loadRules, renderRulesBlock, rulesSummary } from "./rules.ts";
import { runAsk, type AskUser } from "./ask.ts";
import {
  createJobRegistry,
  describeJob,
  formatDuration,
  shouldWait,
  type JobOutcome,
  type JobRegistry,
} from "./render/jobs.ts";

/**
 * Makes gated skills reachable from a conversation.
 *
 * The conversational agent keeps ordinary progressive disclosure - it reads the
 * skill descriptions and decides when one applies. What it does not get is the
 * choice of how to run it: `run_skill` hands the work to the graph, which owns
 * the steps, the gates and the judges. The agent asks for the skill; it does not
 * perform it.
 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Skills ship with this package, so they are found relative to it rather than to the
 * working directory - the point is to run them against whatever project you are in.
 *
 * A skill that does not parse is one that has not been converted to the gated format yet;
 * it is reported rather than silently dropped.
 */
function discoverSkills(): { skills: Skill[]; pending: string[] } {
  const root = join(PACKAGE_ROOT, "skills");
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => e.name)
      .sort();
  } catch {
    return { skills: [], pending: [] };
  }

  const skills: Skill[] = [];
  const pending: string[] = [];
  for (const name of entries) {
    try {
      skills.push(loadSkill(join(root, name)));
    } catch {
      pending.push(name);
    }
  }
  return { skills, pending };
}

/** Puts a skill step's question to the person, when there is one to ask. */
function askUserVia(ctx: ExtensionContext): AskUser {
  return async (request) => {
    if (!ctx.hasUI) {
      return "No user is available to answer. Decide yourself, and say in your report what you assumed.";
    }
    return runAsk(request, {
      select: (title, options) => ctx.ui.select(title, options),
      input: (title) => ctx.ui.input(title),
    });
  };
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // Finished work announces itself into the transcript rather than triggering a turn,
  // so a job landing never interrupts what the person is in the middle of saying.
  const jobs = createJobRegistry({
    onFinish: (job) => {
      void pi.sendMessage(
        {
          customType: "forge_job",
          content:
            job.status === "succeeded"
              ? `Background job ${job.id} (${job.kind}) finished after ${formatDuration(job)}.\n\n${job.report ?? ""}`
              : `Background job ${job.id} (${job.kind}) failed after ${formatDuration(job)}.\n\n${job.error ?? ""}`,
          display: true,
          details: { jobId: job.id, status: job.status },
        },
        { deliverAs: "nextTurn" },
      );
    },
  });

  // The ***plain rules go into the system prompt in full, every turn. The block is
  // identical each time, so it sits inside the cached prefix rather than invalidating it.
  const rules = loadRules(join(PACKAGE_ROOT, "forge", "rules"));
  const rulesBlock = renderRulesBlock(rules);
  if (rulesBlock !== "") {
    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt}\n\n${rulesBlock}`,
    }));
  }

  registerJobTools(pi, jobs);
  registerRenderFunctionality(pi, cwd, jobs);
  registerRenderConformanceTests(pi, cwd, jobs);
  registerCheckPlain(pi, cwd);
  registerRenderModule(pi, cwd, jobs);
  registerRegenerateFunctionality(pi, cwd, jobs);

  const { skills, pending } = discoverSkills();
  if (skills.length === 0) return;

  const catalogue = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const pendingNote =
    pending.length > 0
      ? `\n\nNot yet converted to the gated format, and therefore not runnable: ${pending.join(", ")}.`
      : "";

  pi.registerTool({
    name: "run_skill",
    label: "Run gated skill",
    description:
      "Execute one of this project's gated skills end to end. The skill's steps, review gates and " +
      "judges are enforced by the harness, so the result has already passed review when it comes back.\n\n" +
      `Available skills:\n${catalogue}${pendingNote}`,
    promptSnippet: "run_skill: execute a gated project skill (steps and review gates enforced by the harness)",
    promptGuidelines: [
      "When a request matches a skill listed in run_skill's description, call run_skill instead of doing the work yourself. Doing it by hand skips the review gates.",
      "run_skill returns the reviewed artifact and a trace of every gate decision. Report the artifact to the user; do not rewrite it.",
      "If run_skill fails, say so and stop. Never carry out the skill's work yourself in the conversation - the gates and the judges are the point of running it, and an unreviewed hand-run silently drops them.",
    ],
    parameters: Type.Object({
      skill: Type.String({
        description: `Skill name. One of: ${skills.map((s) => s.name).join(", ")}`,
      }),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const skill = skills.find((s) => s.name === params.skill);
      if (!skill) {
        return {
          content: [{ type: "text" as const, text: `Unknown skill '${params.skill}'. Available: ${skills.map((s) => s.name).join(", ")}` }],
          details: {},
        };
      }

      const trace: string[] = [`skill: ${skill.name}`, ...describeGates(skill).map((l) => `  ${l}`)];
      const push = (line: string) => {
        trace.push(line);
        onUpdate?.({ content: [{ type: "text" as const, text: trace.join("\n") }], details: {} });
      };

      const report: Reporter = {
        step: (name, attempt) => push(`step ${name} (attempt ${attempt})`),
        artifact: (path, body) => push(`  ${path}: ${body.split("\n")[0]}${body.includes("\n") ? " ..." : ""}`),
        gate: (name, judges) => push(judges === 0 ? `gate ${name}: no artifact` : `gate ${name}: ${judges} judges`),
        judge: (index, model, verdict, violations) =>
          push(`  judge ${index + 1} (${model}): ${verdict}${violations ? ` (${violations} violations)` : ""}`),
        outcome: (name, decision, critique) => {
          push(`  ${decision} <- gate ${name}`);
          if (critique) for (const line of critique.split("\n")) push(`    ${line}`);
        },
      };

      const result = await runSkill({
        skillDir: skill.dir,
        cwd,
        runDir: resolve(cwd, ".forge/run", skill.name),
        report,
        askUser: askUserVia(ctx),
        model: conversationModel(ctx),
        // Renders queued by a step land in the same registry as everything else, so
        // check_job and list_jobs see them without knowing a skill started them.
        renderQueue: createRenderQueue({ registry: jobs, cwd, model: conversationModel(ctx) }),
        // The escalation becomes a real dialog in the TUI. Without dialog-capable
        // UI there is nobody to ask, so the gate stands.
        escalate: async ({ question, critique }) => {
          if (!ctx.hasUI) {
            push("  no UI available for human review - gate stands");
            return false;
          }
          return ctx.ui.confirm(`Review gate: ${skill.name}`, `${critique}\n\n${question}`);
        },
      });

      const text = result.ok
        ? [`${skill.name}: passed all gates.`, "", "<artifact>", result.output, "</artifact>", "", "<trace>", ...trace, "</trace>"].join("\n")
        : [`${skill.name}: stopped at a gate. No approved artifact.`, "", "<trace>", ...trace, "</trace>"].join("\n");

      return { content: [{ type: "text" as const, text }], details: { ok: result.ok, artifacts: result.artifacts } };
    },
  });
}

/**
 * Hand one functionality of a .plain specification to a coding agent.
 *
 * The specification decides what gets built; the tool decides what the agent is shown.
 * The conversational agent only names the file and the functionality - it never
 * assembles the context itself, so the same functionality is always rendered from the
 * same definitions, reqs and acceptance tests.
 */
function registerRenderFunctionality(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool({
    name: "render_functionality",
    label: "Render functionality",
    description:
      "Implement one functionality of a .plain specification. Parses the file, builds the context for " +
      "the requested functionality ID (definitions, implementation reqs, test reqs, the functionalities " +
      "already built, the target functionality and its acceptance tests) and runs a coding agent in its " +
      "own build directory to write the code and unit tests. Omit `frid` to list the available " +
      "functionality IDs instead of building one.",
    promptSnippet: "render_functionality: implement one functionality of a .plain specification",
    promptGuidelines: [
      "When asked to implement or render a .plain specification, call render_functionality rather than reading the file and writing the code yourself - it assembles the specification context deterministically.",
      "Call render_functionality without a frid first when the user has not said which functionality they mean; it returns the available IDs.",
      "After render_functionality succeeds, offer render_conformance_tests for the same functionality - unit tests are written by the implementer, conformance tests are not.",
      "These tools return a job id and keep working in the background. Say what has started and carry on talking; do not sit waiting for it, and do not claim it finished until the job reports back or check_job says so.",
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "Path to the .plain file" }),
      frid: Type.Optional(
        Type.String({ description: "Functionality ID, e.g. \"1\" or \"2.3\". Omit to list them." }),
      ),
      build_dir: Type.Optional(
        Type.String({ description: "Where the agent works. Default: build/<module>" }),
      ),
      model: MODEL_PARAM,
      wait: WAIT_PARAM,
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const plainFile = resolve(cwd, params.plain_file);
      const model = conversationModel(ctx, params.model);

      if (params.frid === undefined) {
        const { moduleName, frids } = listFrids(plainFile);
        return {
          content: [
            {
              type: "text" as const,
              text: `${moduleName} has ${frids.length} functionalities: ${frids.join(", ")}.\nCall again with one of these as \`frid\`.`,
            },
          ],
          details: { moduleName, frids },
        };
      }

      return deliver(jobs, {
        kind: "render_functionality",
        summary: `${params.plain_file} functionality ${params.frid}`,
        model,
        wait: params.wait,
        mode: ctx.mode,
        onUpdate,
        run: async (onDelta) => {
          const result = await renderFunctionality({
            plainFile,
            frid: params.frid,
            buildDir: params.build_dir ? resolve(cwd, params.build_dir) : undefined,
            model,
            onDelta,
          });
          return { report: renderReport(result), details: { passed: result.passed } };
        },
      });
    },
  });
}

function renderReport(result: Awaited<ReturnType<typeof renderFunctionality>>): string {
  return [
    result.passed
      ? `Built ${result.moduleName} functionality ${result.frid} in ${result.buildDir}; unit tests pass.`
      : `Built ${result.moduleName} functionality ${result.frid} in ${result.buildDir}, but the unit tests are NOT passing.`,
    result.testRemovals.length > 0
      ? `Tests were removed and challenged: ${result.testRemovals.map((r) => r.file).join(", ")}.`
      : "",
    "",
    "<files>",
    ...result.files,
    "</files>",
    "",
    "<agent report>",
    result.response,
    "</agent report>",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Write black-box conformance tests for a functionality that has already been rendered.
 *
 * Separate from render_functionality on purpose: the agent that wrote the code is the
 * wrong one to decide whether the code matches the specification. This one never sees
 * the implementation - its tool surface cannot open it.
 */
function registerRenderConformanceTests(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool({
    name: "render_conformance_tests",
    label: "Render conformance tests",
    description:
      "Write black-box conformance tests for one functionality of a .plain specification, and run them " +
      "against the built code. The test author never sees the implementation: it works from the " +
      "specification and the acceptance tests, invoking the built functionality from the outside. " +
      "Call this after render_functionality has built the functionality.",
    promptSnippet: "render_conformance_tests: black-box tests for a rendered functionality",
    promptGuidelines: [
      "render_conformance_tests requires the functionality to have been rendered first; it fails if the build directory is empty.",
      "Report a failing conformance test as a mismatch between the code and the specification. Do not edit the tests to make them pass.",
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "Path to the .plain file" }),
      frid: Type.String({ description: 'Functionality ID, e.g. "1" or "2.3"' }),
      build_dir: Type.Optional(
        Type.String({ description: "The rendered code under test. Default: build/<module>" }),
      ),
      conformance_dir: Type.Optional(
        Type.String({ description: "Where tests are written. Default: conformance/<module>/<frid>" }),
      ),
      model: MODEL_PARAM,
      wait: WAIT_PARAM,
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const model = conversationModel(ctx, params.model);
      return deliver(jobs, {
        kind: "render_conformance_tests",
        summary: `${params.plain_file} functionality ${params.frid}`,
        model,
        wait: params.wait,
        mode: ctx.mode,
        onUpdate,
        run: async (onDelta) => {
          const result = await renderConformanceTests({
            plainFile: resolve(cwd, params.plain_file),
            frid: params.frid,
            buildDir: params.build_dir ? resolve(cwd, params.build_dir) : undefined,
            conformanceDir: params.conformance_dir ? resolve(cwd, params.conformance_dir) : undefined,
            model,
            onDelta,
          });
          return { report: conformanceReport(result), details: { passed: result.passed } };
        },
      });
    },
  });
}

function conformanceReport(result: Awaited<ReturnType<typeof renderConformanceTests>>): string {
  return [
    result.passed
      ? `Conformance tests pass for ${result.moduleName} functionality ${result.frid}.`
      : `Conformance tests are NOT passing for ${result.moduleName} functionality ${result.frid}.`,
    `Tests in ${result.conformanceDir}, run against ${result.buildDir}.`,
    result.codeFixes.length > 0
      ? `${result.codeFixes.length} triage verdict(s) blamed the code, and the implementation was changed.`
      : "",
    "",
    "<files>",
    ...result.files,
    "</files>",
    "",
    "<runs>",
    ...result.runs.map((run) => `exit ${run.exitCode}: ${run.command}`),
    "</runs>",
    "",
    "<agent report>",
    result.response,
    "</agent report>",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Build a whole module, functionality by functionality.
 *
 * The gate between one functionality and the next is the regression suite: every
 * functionality built so far must still pass together, not merely have passed on its own
 * the day it was written.
 */
function registerRenderModule(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool({
    name: "render_module",
    label: "Render module",
    description:
      "Build every functionality of a .plain specification in order. For each one it renders the code " +
      "and unit tests, writes black-box conformance tests, and then runs the conformance tests of every " +
      "functionality built so far together. It advances to the next functionality only when that whole " +
      "suite passes, repairing the code when it does not. Use this instead of calling " +
      "render_functionality repeatedly.",
    promptSnippet: "render_module: build every functionality of a .plain specification in order",
    promptGuidelines: [
      "Prefer render_module over looping render_functionality yourself: it enforces the regression gate between functionalities.",
      "Report which functionalities completed and where it stopped. Do not describe an incomplete module as finished.",
      "render_module takes a long time and runs in the background. Report the job id, keep talking, and check_job when the user asks.",
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "Path to the .plain file" }),
      from: Type.Optional(Type.String({ description: "Start at this functionality id" })),
      to: Type.Optional(Type.String({ description: "Stop after this functionality id" })),
      build_dir: Type.Optional(Type.String({ description: "Default: build/<module>" })),
      model: MODEL_PARAM,
      wait: WAIT_PARAM,
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const model = conversationModel(ctx, params.model);
      return deliver(jobs, {
        kind: "render_module",
        summary: `${params.plain_file}${params.from ? ` from ${params.from}` : ""}${params.to ? ` to ${params.to}` : ""}`,
        model,
        wait: params.wait,
        mode: ctx.mode,
        onUpdate,
        run: async (onDelta) => {
          const result = await renderModule({
            plainFile: resolve(cwd, params.plain_file),
            from: params.from,
            to: params.to,
            buildDir: params.build_dir ? resolve(cwd, params.build_dir) : undefined,
            model,
            onDelta,
          });
          return {
            report: moduleReport(result),
            details: { passed: result.passed, completed: result.completed },
          };
        },
      });
    },
  });
}

function moduleReport(result: Awaited<ReturnType<typeof renderModule>>): string {
  return [
    result.passed
      ? `Built all of ${result.moduleName}: ${result.completed.join(", ")}.`
      : `${result.moduleName} is incomplete. Completed: ${result.completed.join(", ") || "none"}.`,
    `Build in ${result.buildDir}, tests in ${result.conformanceRoot}/${result.moduleName}/<frid>.`,
    "",
    "<functionalities>",
    ...result.outcomes.map((outcome) => {
      const repairs = outcome.regression?.repairs.length ?? 0;
      return `${outcome.frid}: ${outcome.stoppedAt ? `stopped at ${outcome.stoppedAt}` : "done"}${
        repairs > 0 ? `, ${repairs} regression repair(s)` : ""
      }`;
    }),
    "</functionalities>",
  ].join("\n");
}

/** Rebuild one functionality whose specification changed, then re-run the whole suite. */
function registerRegenerateFunctionality(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool({
    name: "regenerate_functionality",
    label: "Regenerate functionality",
    description:
      "Rebuild one functionality whose specification changed, over code that already exists. Updates the " +
      "code, its unit tests and its conformance tests to the current specification, then runs the whole " +
      "module's conformance suite - because a changed specification can break a functionality built " +
      "later just as easily as an earlier one. Fails if there is no existing build.",
    promptSnippet: "regenerate_functionality: rebuild a functionality after its specification changed",
    promptGuidelines: [
      "Use regenerate_functionality, not render_functionality, when the code already exists and the specification changed.",
      "A regression repair means the implementation was changed beyond the functionality asked for; say so when reporting.",
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "Path to the .plain file" }),
      frid: Type.String({ description: "Functionality id whose specification changed" }),
      build_dir: Type.Optional(Type.String({ description: "Default: build/<module>" })),
      model: MODEL_PARAM,
      wait: WAIT_PARAM,
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const model = conversationModel(ctx, params.model);
      return deliver(jobs, {
        kind: "regenerate_functionality",
        summary: `${params.plain_file} functionality ${params.frid}`,
        model,
        wait: params.wait,
        mode: ctx.mode,
        onUpdate,
        run: async (onDelta) => {
          const result = await regenerateFunctionality({
            plainFile: resolve(cwd, params.plain_file),
            frid: params.frid,
            buildDir: params.build_dir ? resolve(cwd, params.build_dir) : undefined,
            model,
            onDelta,
          });
          return {
            report: regenerateReport(result),
            details: { passed: result.passed, stoppedAt: result.stoppedAt },
          };
        },
      });
    },
  });
}

function regenerateReport(result: Awaited<ReturnType<typeof regenerateFunctionality>>): string {
  const repairs = result.regression?.repairs.length ?? 0;
  return [
    result.passed
      ? `Regenerated ${result.moduleName} functionality ${result.frid}; the whole conformance suite passes.`
      : `Regeneration of ${result.moduleName} functionality ${result.frid} stopped at ${result.stoppedAt}.`,
    repairs > 0 ? `${repairs} regression repair(s) changed the implementation beyond this functionality.` : "",
    `Build in ${result.buildDir}.`,
  ]
    .filter(Boolean)
    .join("\n");
}


const MODEL_PARAM = Type.Optional(
  Type.String({
    description:
      '"provider/model-id" for the agents this tool spawns. Defaults to the model this ' +
      "conversation is using.",
  }),
);

/**
 * The model the spawned agents should use.
 *
 * Without this they fall back to whatever pi is configured to default to, which is not
 * necessarily the model the conversation is on - switching model mid-session would leave
 * every tool still building with the old one, silently.
 */
function conversationModel(ctx: ExtensionContext, override?: string): string | undefined {
  if (override !== undefined) return override;
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

const WAIT_PARAM = Type.Optional(
  Type.Boolean({
    description:
      "Block until the work finishes instead of returning a job id. Defaults to false in the " +
      "interactive TUI and true elsewhere, where a background job would not outlive the turn.",
  }),
);

/**
 * Run the work now, or start it as a background job and hand back an id.
 *
 * Background only makes sense where the session outlives the turn. In print, json and rpc
 * modes the process is gone the moment the answer is written, taking the job with it, so
 * those wait by default.
 */
async function deliver(
  jobs: JobRegistry,
  input: {
    kind: string;
    summary: string;
    model: string | undefined;
    wait: boolean | undefined;
    mode: string;
    onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void;
    run: (onDelta: (delta: string) => void) => Promise<JobOutcome>;
  },
) {
  const wait = shouldWait(input.mode, input.wait);

  if (wait) {
    let streamed = "";
    const outcome = await input.run((delta) => {
      streamed += delta;
      input.onUpdate?.({ content: [{ type: "text" as const, text: streamed }], details: {} });
    });
    return { content: [{ type: "text" as const, text: outcome.report }], details: outcome.details ?? {} };
  }

  const summary = input.model ? `${input.summary} on ${input.model}` : input.summary;
  const job = jobs.start({ kind: input.kind, summary, run: input.run });
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Started ${input.kind} as background job ${job.id}: ${summary}.\n` +
          "It is running now and will report back when it finishes. Tell the user it has started, " +
          `and carry on. Use check_job with "${job.id}" if they ask how it is going.`,
      },
    ],
    details: { jobId: job.id, status: job.status },
  };
}

/** Looking in on work that is still running, and collecting what finished. */
function registerJobTools(pi: ExtensionAPI, jobs: JobRegistry) {
  pi.registerTool({
    name: "check_job",
    label: "Check job",
    description:
      "Look at a background job: whether it is still running, its latest output, and its report once " +
      "it has finished.",
    promptSnippet: "check_job: how is a background job doing",
    parameters: Type.Object({
      job_id: Type.String({ description: "The id returned when the job started" }),
      wait: Type.Optional(
        Type.Boolean({ description: "Block until the job finishes instead of reporting its current state" }),
      ),
    }),
    async execute(_id, params) {
      const existing = jobs.get(params.job_id);
      if (existing === undefined) {
        const known = jobs.list().map((job) => job.id);
        return {
          content: [
            {
              type: "text" as const,
              text: `No job ${params.job_id}. ${known.length > 0 ? `Known jobs: ${known.join(", ")}.` : "No jobs have been started."}`,
            },
          ],
          details: { status: "unknown" },
        };
      }

      const job = params.wait === true ? await jobs.wait(params.job_id) : existing;
      return {
        content: [{ type: "text" as const, text: describeJob(job) }],
        details: { status: job.status as string },
      };
    },
  });

  pi.registerTool({
    name: "list_jobs",
    label: "List jobs",
    description: "List the background jobs started in this session, newest first.",
    promptSnippet: "list_jobs: what background work is running",
    parameters: Type.Object({}),
    async execute() {
      const all = jobs.list();
      const text =
        all.length === 0
          ? "No jobs have been started."
          : all
              .map((job) => `${job.id}  ${job.status.padEnd(9)} ${formatDuration(job).padStart(6)}  ${job.kind}: ${job.summary}`)
              .join("\n");
      return { content: [{ type: "text" as const, text }], details: { count: all.length } };
    },
  });
}


/**
 * Static validation of a ***plain specification.
 *
 * This is the check that used to mean a renderer dry-run. It runs this repo's own parser,
 * so it needs no external tool, no API key and no credits - and it is the only honest way
 * to answer "is this spec valid?" without generating anything.
 */
function registerCheckPlain(pi: ExtensionAPI, cwd: string) {
  pi.registerTool({
    name: "check_plain",
    label: "Check plain spec",
    description:
      "Validate one or more .plain specifications without rendering: parses each file, resolves its " +
      "imports and required modules, and reports every syntax, concept and structure error with the " +
      "line it is on. Pass a directory to check every .plain file in it. Fast, free, and offline.",
    promptSnippet: "check_plain: validate a .plain spec without rendering it",
    promptGuidelines: [
      "Use check_plain to verify a .plain file is valid. Never shell out to another renderer to do it, and never claim a spec is valid without running it.",
      "Run check_plain after editing a .plain file, and before telling the user a spec is ready.",
    ],
    parameters: Type.Object({
      target: Type.String({ description: "A .plain file, or a directory holding .plain files" }),
      template_dir: Type.Optional(
        Type.Array(Type.String(), { description: "Extra template directories" }),
      ),
    }),
    async execute(_id, params) {
      const results = checkPlainTargets(
        resolve(cwd, params.target),
        (params.template_dir ?? []).map((dir) => resolve(cwd, dir)),
      );
      const failed = results.filter((result) => !result.ok).length;
      const text =
        results.length === 0
          ? `No .plain files found in ${params.target}.`
          : `${formatCheckResults(results)}\n\n${failed === 0 ? "All specs valid." : `${failed} of ${results.length} failed.`}`;

      return { content: [{ type: "text" as const, text }], details: { failed, checked: results.length } };
    },
  });
}
