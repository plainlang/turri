import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { Box, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CODING_MODEL_ENV } from "./chat-models.ts";
import { CONFIG_FILE, modelSpec, projectModels, readProjectConfig, splitModelSpec } from "./config.ts";
import { projectDirOf, skillRunDir } from "./render/paths.ts";
import { findTestScripts } from "./render/test-scripts.ts";
import { createAskUserTool } from "./tools.ts";
import { createWebTools } from "./render/web.ts";
import { describeGates, interruptedRun, runSkill } from "./forge.ts";
import type { Reporter } from "./graph.ts";
import { loadSkill, skillStatus, type Skill } from "./skill.ts";
import { listFrids, resolveTemplateDirs } from "./render/render.ts";
import { plainFileParser } from "./plain/parser.ts";
import { TEST_REQUIREMENTS } from "./plain/spec.ts";
import { sectionsOf } from "./render/state.ts";
import { describeConformanceSuite, renderConformanceSuite } from "./render/conformance-suite.ts";
import type { RenderConformanceTestsResult } from "./render/conformance.ts";
import { regenerateFunctionality, renderChain, type RenderModuleResult, describeChainStop, describeRegenerationStop } from "./render/module.ts";
import { describeChain } from "./render/requires.ts";
import { createProgressTracker } from "./render/progress.ts";
import { describeDelivery } from "./render/delivery.ts";
import { vmSummary } from "./render/vm.ts";
import { askedForCommandLine, refusal, selfInvocation, TOOLS_NOT_CLI } from "./self-invocation.ts";
import { describeChoices, describeResolution, type ModelChoices, modelFor, type RenderWork, resolveModel } from "./render/models.ts";
import { checkPlainTargets, formatCheckResults } from "./plain/check.ts";
import { createRenderQueue, type RenderQueue } from "./render/queue.ts";
import { createJobPanel } from "./render/job-panel.ts";
import { createTranscriptView } from "./render/transcript-view.ts";
import { HISTORY_DIR, historyLog, historyShow } from "./render/history.ts";
import { defaultBuildDir } from "./render/paths.ts";
import { describeUsage, type SpecConflict } from "./render/activity.ts";
import { describeSpecConflict } from "./render/stop-report.ts";
import { inheritThinkingLevel } from "./pi.ts";
import { moduleLanes } from "./render/lanes.ts";
import { findCodebaseTip } from "./render/requires.ts";
import { applySpecDiff, describeSpecDiff, renderSpecDiff, snapshotSpec } from "./render/spec-change.ts";
import { describeSpecDiffConformance, renderSpecDiffConformance } from "./render/spec-change-conformance.ts";
import { beginCapture, captureConsole, describeCaptured, dropNoise } from "./quiet.ts";
import { loadRules, renderRulesBlock, rulesSummary } from "./rules.ts";
import { runAsk, type AskUser } from "./ask.ts";
import {
  createJobRegistry,
  describeJob,
  formatDuration,
  shouldWait,
  type Job,
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
      .filter((e) => e.isDirectory() && (!e.name.startsWith("_") || process.env.FORGE_INCLUDE_FIXTURES === "1"))
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

/**
 * Puts a skill step's question to the person, when there is one to ask.
 *
 * A skill runs inside one tool call, in its own session, so its dialogs are not
 * conversation turns and nothing it asks would otherwise reach the transcript. Every
 * exchange is therefore reported back, so the interview is visible while it happens and
 * survives in the tool's result afterwards.
 */
function askUserVia(
  ctx: ExtensionContext,
  onExchange: (question: string, answer: string) => void,
): AskUser {
  return async (request) => {
    if (!ctx.hasUI) {
      return "No user is available to answer. Decide yourself, and say in your report what you assumed.";
    }

    ctx.ui.setWorkingMessage("waiting for your answer");
    try {
      const answer = await runAsk(request, {
        select: (title, options) => ctx.ui.select(title, options),
        input: (title) => ctx.ui.input(title),
      });
      onExchange(request.question, answer);
      return answer;
    } finally {
      ctx.ui.setWorkingMessage();
    }
  };
}

/**
 * ask_user, for the conversation's agent too - the same dialog a skill's interview uses: options to
 * pick from, several at once, "Something else…" to type instead - so a question with a handful of
 * answers is picked, not typed.
 */
export function chatAskUserTool() {
  let conversation: ExtensionContext | undefined;
  const tool = createAskUserTool((request) =>
    conversation !== undefined ? askUserVia(conversation, () => {})(request) : Promise.resolve("No user is available to answer."),
  );
  return {
    ...tool,
    promptGuidelines: [
      ...(tool.promptGuidelines ?? []),
      "When a question to the user has a handful of plausible answers - a choice, yes or no, which of these - ask it with ask_user and offer them as options, rather than in your reply.",
    ],
    async execute(...args: Parameters<typeof tool.execute>) {
      conversation = args[4] as ExtensionContext;
      return tool.execute(...args);
    },
  };
}

export default function (pi: ExtensionAPI) {
  dropNoise();
  const cwd = process.cwd();
  const discoveredSkills = discoverSkills();

  // What the background work is doing right now, drawn above the editor while it runs.
  const panel = createJobPanel(() => jobs.list());

  // Finished work is announced twice, to two audiences, because pi treats them differently.
  // A message - what the agent reads - is held until the current turn ends, and a skill's
  // interview is one long turn: a render finishing mid-interview would say nothing until the
  // interview was over. An entry is drawn the moment it is appended. So the person gets an
  // entry, now, and the agent gets the full report as a hidden message, whenever its turn
  // allows. Neither starts a turn, so nothing talks over the person.
  const jobs: JobRegistry = createJobRegistry({
    onChange: () => panel.refresh(),
    onFinish: (job) => {
      panel.refresh();
      announceJob(pi, job);
      // A spec that contradicts itself is the person's to settle, now: the agent is started on it.
      if (job.specConflict !== undefined) {
        void pi.sendMessage(
          { customType: "forge_spec_conflict", content: specConflictTask(job.specConflict), display: false, details: { jobId: job.id } },
          { triggerTurn: true },
        );
        return;
      }
      void pi.sendMessage(
        {
          customType: "forge_job",
          content:
            job.status === "succeeded"
              ? `Background job ${job.id} (${job.kind}) finished after ${formatDuration(job)}.\n\n${job.report ?? ""}`
              : job.status === "stopped"
                ? `Background job ${job.id} (${job.kind}) was stopped by the user after ${formatDuration(job)}. What it built before it stopped is on disk, but the functionality it was on counts as not built.`
                : `Background job ${job.id} (${job.kind}) failed after ${formatDuration(job)}.\n\n${job.error ?? ""}`,
          display: false,
          details: { jobId: job.id, status: job.status },
        },
        { triggerTurn: false },
      );
    },
  });

  // The ***plain rules go into the system prompt in full, every turn. The block is
  // identical each time, so it sits inside the cached prefix rather than invalidating it.
  // With them, the instruction to do plainwright's work with its tools rather than its command
  // line - enforced below, not only asked for.
  const rules = loadRules(join(PACKAGE_ROOT, "forge", "rules"));
  const rulesBlock = renderRulesBlock(rules);
  // What the project's config.yaml says, read afresh every turn: the agent answers from it, and
  // the tools default to it.
  pi.on("before_agent_start", (event) => ({
    systemPrompt: [event.systemPrompt, TOOLS_NOT_CLI, projectConfigBlock(cwd), rulesBlock].filter((part) => part !== "").join("\n\n"),
  }));

  // The conversation's agent does not run plainwright again through its shell, unless the person
  // asked for the command line in the message it is answering.
  let lastUserMessage = "";
  pi.on("input", (event) => {
    if (event.source !== "extension") lastUserMessage = event.text;
    return { action: "continue" as const };
  });
  pi.on("tool_call", (event) => {
    const command = (event.input as { command?: unknown }).command;
    if (event.toolName !== "bash" || typeof command !== "string") return undefined;
    const what = selfInvocation(command);
    if (what === undefined || askedForCommandLine(lastUserMessage)) return undefined;
    return { block: true, reason: refusal(what) };
  });

  // A turn's own model calls happen inside pi's agent loop, outside any tool, so the
  // capture is bracketed around the turn itself. Without this, every model call writes
  // through the terminal the TUI is drawing on and strands a frame in the scrollback.
  let turnCapture: { end: () => string[] } | undefined;
  pi.on("agent_start", () => {
    turnCapture?.end();
    turnCapture = beginCapture();
  });
  const endTurnCapture = () => {
    turnCapture?.end();
    turnCapture = undefined;
  };
  pi.on("agent_end", endTurnCapture);
  pi.on("agent_settled", endTurnCapture);

  // Whether renders write conformance tests, always in sight: read again as each turn starts and
  // ends, since a turn can change it - forge-plain's testing phase writes it into config.yaml.
  const showConformance = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setStatus("plainwright-conformance", conformanceStatus(cwd));
    } catch {
      // A status line is a convenience; never let it stop a turn.
    }
  };
  pi.on("session_start", (_event, ctx) => showConformance(ctx));
  pi.on("agent_start", (_event, ctx) => showConformance(ctx));
  pi.on("agent_end", (_event, ctx) => showConformance(ctx));

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    const ui = ctx.ui;
    // setWidget is overloaded - lines or a component - and the panel is always a component.
    type ComponentWidget = Extract<Parameters<typeof ui.setWidget>[1], (...args: never[]) => unknown>;
    panel.attach({
      setWidget: (key, content, options) => ui.setWidget(key, content as ComponentWidget | undefined, options),
      getToolsExpanded: () => ui.getToolsExpanded(),
    });
  });

  // Sub-agents think as hard as the conversation that started them, not pi's default.
  inheritThinkingLevel(() => pi.getThinkingLevel());

  registerBranding(pi, rules.length, discoveredSkills);
  registerInterviewLog(pi);
  registerJobTools(pi, jobs, cwd);
  registerRenderFunctionality(pi, cwd, jobs);
  registerRenderFunctionalityConformance(pi, cwd, jobs);
  registerCheckPlain(pi, cwd);
  registerRenderModule(pi, cwd, jobs);
  registerRegenerateFunctionality(pi, cwd, jobs);
  registerRenderSpecDiff(pi, cwd, jobs);
  registerRenderSpecDiffConformance(pi, cwd, jobs);
  registerRenderModels(pi);

  const { skills, pending } = discoveredSkills;
  if (skills.length === 0) return;

  const catalogue = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const pendingNote =
    pending.length > 0 ? `\n\nFailed to load and therefore not runnable: ${pending.join(", ")}.` : "";

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
      "Always pass `context` to run_skill, summarising what the user has already told you. The skill starts with an empty session and will re-ask everything you omit, which reads as it not having listened.",
      "When the user wants to continue a skill that was interrupted - pi restarted, the process died - call run_skill with resume: true. It picks the run up in the step it was in, with its session as it was.",
    ],
    parameters: Type.Object({
      skill: Type.String({
        description: `Skill name. One of: ${skills.map((s) => s.name).join(", ")}`,
      }),
      context: Type.Optional(
        Type.String({
          description:
            "Everything the user has already told you that this skill would otherwise ask for - what " +
            "they are building, for whom, any decisions already made, names they have used. The skill " +
            "runs in its own session and cannot see this conversation, so whatever you leave out it " +
            "will ask again.",
        }),
      ),
      resume: Type.Optional(
        Type.Boolean({
          description:
            "Continue the run of this skill that was interrupted here - by a restart, a crash - from the step " +
            "it was in, with its session as it was. Use when the user wants to carry on where they left off.",
        }),
      ),
      fresh: Type.Optional(
        Type.Boolean({
          description: "Start a new run even though an interrupted one exists here, discarding it.",
        }),
      ),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const skill = skills.find((s) => s.name === params.skill);
      if (!skill) {
        return {
          content: [{ type: "text" as const, text: `Unknown skill '${params.skill}'. Available: ${skills.map((s) => s.name).join(", ")}` }],
          details: {},
        };
      }

      // A new run clears the run folder. An interrupted one is not thrown away by accident:
      // whether to pick it up or start over is the user's call.
      const runDir = skillRunDir(cwd, skill.name);
      const interrupted = interruptedRun(runDir, skill.name);
      if (interrupted !== undefined && params.resume !== true && params.fresh !== true) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `There is an interrupted run of ${skill.name} here${interrupted.step ? `, stopped in its ${interrupted.step} step` : ""} ` +
                `(last active ${interrupted.updatedAt}). Ask the user whether to continue it or start over, then call ` +
                "run_skill again with resume: true or fresh: true. Nothing has been started.",
            },
          ],
          details: { interrupted },
        };
      }

      const trace: string[] = [`skill: ${skill.name}`, ...describeGates(skill).map((l) => `  ${l}`)];
      const push = (line: string) => {
        trace.push(line);
        onUpdate?.({ content: [{ type: "text" as const, text: trace.join("\n") }], details: {} });
      };

      const report: Reporter = {
        step: (name, attempt) => {
          if (ctx.hasUI) ctx.ui.setStatus("forge-skill", skillStatus(skill, name, attempt));
          push(`step ${name} (attempt ${attempt})`);
        },
        artifact: (path, body) => push(`  ${path}: ${body.split("\n")[0]}${body.includes("\n") ? " ..." : ""}`),
        gate: (name, judges) => push(judges === 0 ? `gate ${name}: no artifact` : `gate ${name}: ${judges} judges`),
        livePass: (step, scope, findings) =>
          push(`  review ${step}: ${scope} - ${findings === 0 ? "clean" : `${findings} to fix`}`),
        liveReview: (name, passes, findings) =>
          push(
            findings === 0
              ? `gate ${name}: reviewer read along in ${passes} passes, nothing outstanding`
              : `gate ${name}: ${findings} unresolved from the reviewer`,
          ),
        judge: (index, model, verdict, violations) =>
          push(`  judge ${index + 1} (${model}): ${verdict}${violations ? ` (${violations} violations)` : ""}`),
        outcome: (name, decision, critique) => {
          push(`  ${decision} <- gate ${name}`);
          if (critique) for (const line of critique.split("\n")) push(`    ${line}`);
        },
      };

      const { result, output: captured } = await captureConsole(() =>
        runSkill({
        skillDir: skill.dir,
        cwd,
        runDir,
        resume: params.resume === true && interrupted !== undefined,
        report,
        context: conversationContext(ctx, params.context),
        askUser: askUserVia(ctx, (question, answer) => {
          push(`  Q: ${question}`);
          push(`  A: ${answer}`);
          recordExchange(pi, { skill: skill.name, question, answer });
        }),
        model: conversationModel(ctx),
        // Renders queued by a step land in the same registry as everything else, so
        // check_job and list_jobs see them without knowing a skill started them.
        // Asked per job as it is queued, so a model chosen mid-interview applies from then on.
        renderQueue: renderQueueFor(jobs, cwd, ctx),
        // The person answers the skill's agent while it runs, so it can take "render these with ..." too.
        // check_plain too: a skill validates what it wrote with the same check the conversation has.
        sharedTools: [setRenderModelTool(pi, ctx), checkPlainTool(cwd), renderFunctionalityConformanceTool(cwd, jobs, ctx), ...createWebTools()],
        // The escalation becomes a real dialog in the TUI. Without dialog-capable
        // UI there is nobody to ask, so the gate stands.
        escalate: async ({ question, critique }) => {
          if (!ctx.hasUI) {
            push("  no UI available for human review - gate stands");
            return false;
          }
          return ctx.ui.confirm(`Review gate: ${skill.name}`, `${critique}\n\n${question}`);
        },
        }),
      );
      const noise = describeCaptured(captured);
      if (noise !== null) push(noise);

      const text = result.ok
        ? [`${skill.name}: passed all gates.`, "", "<artifact>", result.output, "</artifact>", "", "<trace>", ...trace, "</trace>"].join("\n")
        : [`${skill.name}: stopped at a gate. No approved artifact.`, "", "<trace>", ...trace, "</trace>"].join("\n");

      if (ctx.hasUI) ctx.ui.setStatus("forge-skill", undefined);
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
      "Build a .plain specification up to and including one functionality. Anything it depends on is " +
      "built first: the modules this one requires, and the earlier functionalities of this module that " +
      "are missing or whose specification has changed since they were built. Work already built from " +
      "the current specification is skipped. Omit `frid` to list the available functionality IDs " +
      "instead of building anything.",
    promptSnippet: "render_functionality: implement one functionality of a .plain specification",
    promptGuidelines: [
      "When asked to implement or render a .plain specification, call render_functionality rather than reading the file and writing the code yourself - it assembles the specification context deterministically.",
      "Call render_functionality without a frid first when the user has not said which functionality they mean; it returns the available IDs.",
      "Asking for one functionality builds its prerequisites too. Do not call render_functionality repeatedly to walk a module - one call with the last functionality does it.",
      "Conformance tests are written as each functionality is built wherever the module has test reqs. Pass conformance: false when the user asks to render without them.",
      "When conformance was off for a module - no test reqs, or the user asked - offer render_functionality_conformance afterwards if the user wants them.",
      "These tools return a job id and keep working in the background. Say what has started and carry on talking; do not sit waiting for it, and do not claim it finished until the job reports back or check_job says so.",
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "Path to the .plain file" }),
      working_dir: WORKING_DIR_PARAM,
      frid: Type.Optional(
        Type.String({ description: "Functionality ID, e.g. \"1\" or \"4\". Omit to list them." }),
      ),
      build_dir: Type.Optional(
        Type.String({ description: "Where the agent works. Default: plain_modules/<module>/code" }),
      ),
      try_it: Type.Optional(
        Type.Boolean({
          description:
            "Work out and check how the user can try the functionality asked for. Default true - they " +
            "asked for this one. Never done for the prerequisites built on the way.",
        }),
      ),
      conformance: CONFORMANCE_PARAM,
      model: MODEL_PARAM,
      wait: WAIT_PARAM,
    }),
    async execute(_id, given, _signal, onUpdate, ctx) {
      const params = fromWorkingDir(cwd, given);
      const plainFile = resolve(cwd, params.plain_file);
      const model = jobModel(ctx, "functionalities", params.model, params.plain_file);

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
        summary: `${basename(params.plain_file)} fs ${params.frid}`,
        model,
        wait: params.wait,
        mode: ctx.mode,
        lanes: moduleLanes(resolve(cwd, params.plain_file), params.build_dir ? resolve(cwd, params.build_dir) : undefined),
        onUpdate,
        run: async (onDelta) => {
          // Prerequisites are the point: functionality 4 is built on 1 to 3, so asking for
          // it asks for them. renderChain resolves both kinds - the modules this one
          // requires, and the earlier functionalities of this module.
          const result = await renderChain({
            plainFile,
            to: params.frid,
            buildDir: params.build_dir ? resolve(cwd, params.build_dir) : undefined,
            model,
            tryIt: params.try_it ?? true,
            conformance: conformanceOption(params.conformance, params.plain_file),
            onDelta,
          });
          return {
            report: chainReport(result),
            announce: chainAnnouncement(result),
            details: { passed: result.passed, modules: result.outcomes.map((o) => o.module) },
          };
        },
      });
    },
  });
}

/**
 * What landed, and how to see it working, for the last functionality a chain built.
 *
 * Leads the report because it is what the person reads when a background render announces
 * itself; the chain and module detail below it is for the agent.
 */
function deliveryReport(result: RenderModuleResult): string | undefined {
  const last = result.outcomes.at(-1);
  if (last === undefined) return undefined;
  // Everything this run added, not just the last functionality's share: asking for 4
  // can build 1 to 3 as well, and their files are just as new to the person.
  const added = [...new Set(result.outcomes.flatMap((outcome) => outcome.render.added))];
  const removals = last.render.testRemovals;
  return [
    describeDelivery({
      moduleName: result.moduleName,
      frid: last.frid,
      functionality: last.render.functionality,
      buildDir: result.buildDir,
      added,
      runs: last.render.runs,
      conformanceRuns: last.conformance?.runs,
      passed: last.stoppedAt === null,
      tryIt: last.render.tryIt,
    }),
    removals.length > 0 ? `\nTests were removed and challenged: ${removals.map((r) => r.file).join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Write black-box conformance tests for a functionality that has already been rendered.
 *
 * Separate from render_functionality on purpose: the agent that wrote the code is the
 * wrong one to decide whether the code matches the specification. This one may read the
 * implementation, but writes only tests, and takes what they expect from the specification.
 */
function registerRenderFunctionalityConformance(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool(renderFunctionalityConformanceTool(cwd, jobs));
}

/**
 * render_functionality_conformance, for the conversation's agent and for a skill's - forge-plain's testing
 * phase starts the conformance tests the person picks. `conversation` is the context to read models
 * and the mode from; omitted, the one the tool is called with.
 */
function renderFunctionalityConformanceTool(cwd: string, jobs: JobRegistry, conversation?: ExtensionContext) {
  return defineTool({
    name: "render_functionality_conformance",
    label: "Render functionality conformance",
    description:
      "Write black-box conformance tests for code that already exists, and run them against it. " +
      "The tests are written and run in the chain's current codebase - the furthest-built module that requires " +
      "the one named - since that is where the code now lives; they are carried up to every module built on it " +
      "later. Rendering and conformance are separate jobs: name one functionality, several, a range, the whole " +
      "module (the default) or the whole requires chain. The test author may read the code but only writes tests - " +
      "it works from the specification and the acceptance tests, invoking the built functionality from " +
      "the outside. Needs test reqs, which is what conformance tests are written from.",
    promptSnippet: "render_functionality_conformance: black-box tests for a rendered functionality",
    promptGuidelines: [
      "render_functionality_conformance requires the functionality to have been rendered first; it fails if the build directory is empty.",
      "Report a failing conformance test as a mismatch between the code and the specification. Do not edit the tests to make them pass.",
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "Path to the .plain file" }),
      working_dir: WORKING_DIR_PARAM,
      frids: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Functionality ids, e.g. ["1", "3"]. Omit for the whole module.',
        }),
      ),
      range: Type.Optional(
        Type.String({ description: 'A range of functionalities, inclusive: "2" or "2,5"' }),
      ),
      chain: Type.Optional(
        Type.Boolean({ description: "Every module this one requires, each in full" }),
      ),
      in_module: Type.Optional(
        Type.String({ description: "The codebase to test in, when modules built on this one branch" }),
      ),
      build_dir: Type.Optional(
        Type.String({ description: "The rendered code under test. Default: plain_modules/<module>/code" }),
      ),
      model: MODEL_PARAM,
      wait: WAIT_PARAM,
    }),
    async execute(_id, given, _signal, onUpdate, called) {
      const params = fromWorkingDir(cwd, given);
      const ctx = conversation ?? called;
      const model = jobModel(ctx, "functionalities", params.model, params.plain_file);
      const scope = params.chain
        ? "whole chain"
        : params.frids !== undefined
          ? `functionality ${params.frids.join(", ")}`
          : params.range !== undefined
            ? `functionalities ${params.range}`
            : "whole module";
      if (!shouldWait(ctx.mode, params.wait)) {
        const queued = renderQueueFor(jobs, cwd, ctx).enqueueConformance({
          plainFile: resolve(cwd, params.plain_file),
          frids: params.frids,
          range: params.range,
          chain: params.chain,
          inModule: params.in_module,
          buildDir: params.build_dir ? resolve(cwd, params.build_dir) : undefined,
          model,
          scope,
        });
        return queuedReport(jobs, queued.jobId, "render_functionality_conformance");
      }
      return deliver(jobs, {
        kind: "render_functionality_conformance",
        summary: `${basename(params.plain_file)} conformance, ${scope}`,
        model,
        wait: params.wait,
        mode: ctx.mode,
        lanes: moduleLanes(
          params.build_dir === undefined ? codebasePlainFile(resolve(cwd, params.plain_file), params.in_module) : resolve(cwd, params.plain_file),
          params.build_dir ? resolve(cwd, params.build_dir) : undefined,
        ),
        onUpdate,
        run: async (onDelta) => {
          const result = await renderConformanceSuite({
            plainFile: resolve(cwd, params.plain_file),
            frids: params.frids,
            range: params.range,
            chain: params.chain,
            inModule: params.in_module,
            buildDir: params.build_dir ? resolve(cwd, params.build_dir) : undefined,
            model,
            onDelta,
          });
          return { report: describeConformanceSuite(result), details: { passed: result.passed } };
        },
      });
    },
  });
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
      "Build a .plain module and everything it requires. A required module's code is copied into the " +
      "build before this module starts, so the chain is built bottom first and modules already complete " +
      "are skipped. Within each module every functionality is built in order: code and unit tests, then " +
      "black-box conformance tests, then the conformance tests of every functionality so far together - " +
      "advancing only when that whole suite passes. Use this instead of calling render_functionality " +
      "repeatedly.",
    promptSnippet: "render_module: build every functionality of a .plain specification in order",
    promptGuidelines: [
      "Prefer render_module over looping render_functionality yourself: it enforces the regression gate between functionalities.",
      "Pass conformance: false when the user asks to render without conformance tests, true when they ask for them; otherwise leave it out, and the project's config.yaml decides.",
      "Report which functionalities completed and where it stopped. Do not describe an incomplete module as finished.",
      "render_module takes a long time and runs in the background. Report the job id, keep talking, and check_job when the user asks.",
    ],
    parameters: Type.Object({
      plain_file: Type.Optional(
        Type.String({ description: "Path to the .plain file. Omitted: the module the project's config.yaml names" }),
      ),
      working_dir: WORKING_DIR_PARAM,
      from: Type.Optional(Type.String({ description: "Start at this functionality id" })),
      to: Type.Optional(Type.String({ description: "Stop after this functionality id" })),
      only: Type.Optional(
        Type.Boolean({ description: "Build just this module, ignoring what it requires" }),
      ),
      force: Type.Optional(
        Type.Boolean({ description: "Rebuild modules that are already complete" }),
      ),
      conformance: CONFORMANCE_PARAM,
      build_dir: Type.Optional(Type.String({ description: "Default: plain_modules/<module>/code" })),
      try_it: Type.Optional(
        Type.Boolean({
          description:
            "Work out and check how the user can try the last functionality built. Default false: a " +
            "module build usually runs unattended for a long time. Set it when the user is waiting.",
        }),
      ),
      model: MODEL_PARAM,
      wait: WAIT_PARAM,
    }),
    async execute(_id, given, _signal, onUpdate, ctx) {
      // No file named: the project's config.yaml says which module.
      const located = fromWorkingDir(cwd, given);
      const named = located.plain_file ?? readProjectConfig(located.base).module;
      if (named === undefined) throw new Error(`Name the .plain file to build, or set module: in ${CONFIG_FILE}.`);
      const params = { ...located, plain_file: resolve(located.base, named) };
      const model = jobModel(ctx, "functionalities", params.model, params.plain_file);
      return deliver(jobs, {
        kind: "render_module",
        summary: `${basename(params.plain_file)} module${params.from ? ` from fs ${params.from}` : ""}${params.to ? ` to fs ${params.to}` : ""}`,
        model,
        wait: params.wait,
        mode: ctx.mode,
        lanes: moduleLanes(resolve(cwd, params.plain_file), params.build_dir ? resolve(cwd, params.build_dir) : undefined),
        onUpdate,
        run: async (onDelta) => {
          // A render runs in the background, so the tool result is long gone before the
          // work is. The widget is what the person actually watches.
          const progress = createProgressTracker();
          // A component rather than lines: pi cuts a list of lines off at ten, and a chain can
          // be far longer. It lays itself out on every render - compact, or every module while
          // ctrl+o has tool output expanded - so it never loses the end of the chain.
          let tui: { requestRender(): void } | undefined;
          let mounted = false;
          const show = () => {
            if (!ctx.hasUI) return;
            try {
              if (!mounted) {
                mounted = true;
                const ui = ctx.ui;
                type ComponentWidget = Extract<Parameters<typeof ui.setWidget>[1], (...args: never[]) => unknown>;
                const widget: ComponentWidget = (next, theme) => {
                  tui = next;
                  // A spec diff being brought in is coloured as the job panel colours one.
                  const diffStyle = {
                    added: (text: string) => theme.fg("toolDiffAdded", text),
                    removed: (text: string) => theme.fg("toolDiffRemoved", text),
                  };
                  return {
                    render: (width: number) =>
                      (ui.getToolsExpanded() ? progress.lines(diffStyle) : progress.compactLines(diffStyle)).map((line) =>
                        truncateToWidth(line, width),
                      ),
                    invalidate() {},
                  };
                };
                ui.setWidget("plainwright-render", widget, { placement: "aboveEditor" });
              } else {
                tui?.requestRender();
              }
              ctx.ui.setStatus("plainwright-render", progress.summary());
            } catch {
              // The widget is a convenience; losing it must not fail the render.
            }
          };

          try {
            // In the background, a spec that moved on is brought in as forge-plain brings in its
            // answers: each spec diff a render spec diff job of its own, queued behind this one.
            const specDiffQueue = shouldWait(ctx.mode, params.wait) ? undefined : renderQueueFor(jobs, cwd, ctx);
            const result = await renderChain({
              queueSpecDiffs: specDiffQueue
                ? (steps) =>
                    steps.map(
                      (step) =>
                        specDiffQueue.enqueueSpecDiff({ plainFile: step.plainFile, diff: step.diff, applied: "already applied", spec: step.spec }).jobId,
                    )
                : undefined,
              plainFile: resolve(cwd, params.plain_file),
              from: params.from,
              to: params.to,
              buildDir: params.build_dir ? resolve(cwd, params.build_dir) : undefined,
              skipRequires: params.only,
              force: params.force,
              model,
              tryIt: params.try_it === true,
              conformance: conformanceOption(params.conformance, params.plain_file),
              onDelta,
              onChainEvent: (event) => {
                progress.onChainEvent(event);
                if (event.type === "module_done") {
                  recordMilestone(pi, {
                    module: event.module,
                    text: event.passed ? "built" : "stopped before finishing",
                  });
                }
                show();
              },
              onEvent: (event) => {
                progress.onModuleEvent(event);
                if (event.type === "functionality_done") {
                  recordMilestone(pi, { module: progress.summary(), text: `functionality ${event.frid} done` });
                }
                show();
              },
            });
            return {
              report: chainReport(result),
              announce: chainAnnouncement(result),
              details: { passed: result.passed, modules: result.outcomes.map((o) => o.module) },
            };
          } finally {
            if (ctx.hasUI) {
              try {
                ctx.ui.setWidget("plainwright-render", undefined);
                ctx.ui.setStatus("plainwright-render", undefined);
              } catch {
                /* nothing to clean up */
              }
            }
          }
        },
      });
    },
  });
}

/** For the person: how to try what was built, or where the chain stopped, why, and what to do. */
function chainAnnouncement(result: Awaited<ReturnType<typeof renderChain>>): string {
  const stop = describeChainStop(result);
  if (stop !== undefined) return stop;
  const built = result.outcomes.at(-1)?.result;
  if (built?.queuedSpecDiffs !== undefined) {
    return `${built.moduleName}: queued ${built.queuedSpecDiffs.length} render spec diff job${built.queuedSpecDiffs.length === 1 ? "" : "s"} - ${built.queuedSpecDiffs.map((step) => step.jobId).join(", ")}.`;
  }
  const delivery = built ? deliveryReport(built) : undefined;
  if (delivery !== undefined) return delivery;
  return result.passed ? "Everything was already built; nothing to do." : "The chain stopped before building anything.";
}

function chainReport(result: Awaited<ReturnType<typeof renderChain>>): string {
  const built = result.outcomes.at(-1)?.result;
  const delivery = built ? deliveryReport(built) : undefined;
  const lines = [
    ...(delivery ? [delivery, ""] : []),
    result.passed
      ? `Built the whole chain: ${result.outcomes.map((o) => o.module).join(" -> ")}.`
      : (describeChainStop(result) ?? "The chain is incomplete."),
    "",
    "<chain>",
    describeChain(result.chain),
    "</chain>",
    "",
    "<modules>",
  ];

  for (const outcome of result.outcomes) {
    for (const regenerated of outcome.regenerated ?? []) {
      lines.push(
        `${regenerated.moduleName} fs ${regenerated.frid}: spec changed, regenerated in ${outcome.module}'s codebase - ` +
          (regenerated.passed ? "passes" : `stopped at ${regenerated.stoppedAt}`),
      );
    }
    if (outcome.skipped) {
      lines.push(`${outcome.module}: already built, skipped`);
      continue;
    }
    const inner = outcome.result;
    lines.push(
      `${outcome.module}: ${inner?.passed ? "done" : "incomplete"}` +
        (inner ? `, ${inner.completed.length}/${inner.frids.length} functionalities` : "") +
        (inner ? `, conformance ${inner.conformance}` : "") +
        (outcome.copied > 0 ? `, ${outcome.copied} files copied from ${result.chain.find((c) => c.moduleName === outcome.module)?.requires}` : ""),
    );
  }
  lines.push("</modules>");

  const last = result.outcomes[result.outcomes.length - 1];
  if (last?.result !== undefined) lines.push("", moduleReport(last.result));
  return lines.join("\n");
}

function moduleReport(result: RenderModuleResult): string {
  if (result.queuedSpecDiffs !== undefined) {
    return [
      `${result.moduleName}'s spec had changed in more than new functional specs: queued ${result.queuedSpecDiffs.length} render spec diff job${result.queuedSpecDiffs.length === 1 ? "" : "s"}, rendered one after another as forge-plain's are.`,
      "",
      "<spec diffs>",
      ...result.queuedSpecDiffs.map((step, index) => `${index + 1}. ${step.title}: job ${step.jobId}`),
      "</spec diffs>",
    ].join("\n");
  }
  if (result.specSteps !== undefined) {
    const done = result.specSteps.filter((step) => step.result.passed).length;
    return [
      result.passed
        ? `Brought ${result.moduleName} up to its spec in ${result.specSteps.length} spec diff${result.specSteps.length === 1 ? "" : "s"}: the spec had changed in more than new functional specs.`
        : `${result.moduleName} is not up to its spec: ${done} of the spec diffs planned passed, and the one after them did not.`,
      `Build in ${result.buildDir}.`,
      "",
      "<spec diffs>",
      ...result.specSteps.map((step, index) =>
        `${index + 1}. ${step.title} [${step.sections.join(", ")}]: ${step.result.passed ? "done" : `stopped at ${step.result.stoppedAt}`}`,
      ),
      "</spec diffs>",
    ].join("\n");
  }
  return [
    result.passed
      ? `Built all of ${result.moduleName}: ${result.completed.join(", ")}.`
      : `${result.moduleName} is incomplete. Completed: ${result.completed.join(", ") || "none"}.`,
    `Build in ${result.buildDir}, conformance tests in ${result.conformanceRoot}/${result.moduleName}/tests.`,
    {
      on: "Conformance tests were written and run.",
      "off: no test reqs": "Conformance tests were not written: the module has no test reqs.",
      "off: asked": "Conformance tests were not written, as asked.",
    }[result.conformance],
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

/**
 * Render a change to the specs, given as a git diff of the .plain files: one agent makes the
 * code match it, then conformance, the whole suite and the record, in that order.
 */
function registerRenderSpecDiff(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool({
    name: "render_spec_diff",
    label: "Render spec diff",
    description:
      "Render a change to the ***plain specs, given as a git diff of the .plain files - any change: specs " +
      "added, changed or removed, in any section, across any number of them; a diff that adds everything " +
      "builds from scratch. The diff is applied with git unless it already is. One agent, given the diff and " +
      "every spec as it now stands, makes the code match, in the chain's current codebase. Then the " +
      "conformance tests are brought in line with it, the whole suite runs, and the build record is rewritten " +
      "from the spec as parsed when the diff went in - every section, not only the functional specs - with the diff.",
    promptSnippet: "render_spec_diff: make the code match a git diff of the .plain specs",
    promptGuidelines: [
      "Pass the diff exactly as git produced it (git diff -- '*.plain'), paths relative to the project root.",
      "Pass conformance: false when the user asks to render without conformance tests.",
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "A .plain file of the module the change is for" }),
      working_dir: WORKING_DIR_PARAM,
      diff: Type.String({ description: "The change, as a git diff of the .plain files" }),
      in_module: Type.Optional(
        Type.String({ description: "The codebase to render in, when modules built on this one branch" }),
      ),
      try_it: Type.Optional(
        Type.Boolean({
          description:
            "Work out and check how the user can try what the change built. Default true. Pass false for " +
            "long unattended runs.",
        }),
      ),
      conformance: CONFORMANCE_PARAM,
      model: MODEL_PARAM,
      wait: WAIT_PARAM,
    }),
    async execute(_id, given, _signal, onUpdate, ctx) {
      const params = fromWorkingDir(cwd, given);
      const model = jobModel(ctx, "spec_changes", params.model, params.plain_file);
      const plainFile = resolve(cwd, params.plain_file);
      // Applied and parsed now, with the call: that parse is what the job builds and records,
      // whatever changes reach the files while it waits its turn.
      const applied = applySpecDiff(params.diff, params.base);
      const spec = snapshotSpec(plainFile, { cwd: params.base, inModule: params.in_module });
      // In the background it joins the render queue, as forge-plain's changes do - its conformance
      // tests a job of their own behind it.
      if (!shouldWait(ctx.mode, params.wait)) {
        const queued = renderQueueFor(jobs, cwd, ctx).enqueueSpecDiff({
          plainFile,
          diff: params.diff,
          applied,
          spec,
          cwd: params.base,
          inModule: params.in_module,
          model,
          tryIt: params.try_it ?? true,
          conformance: conformanceOption(params.conformance, params.plain_file),
        });
        return queuedReport(jobs, queued.jobId, "render_spec_diff", queued.conformanceJobId);
      }
      return deliver(jobs, {
        kind: "render_spec_diff",
        summary: `${basename(params.plain_file)} render spec diff`,
        diff: params.diff,
        model,
        wait: params.wait,
        mode: ctx.mode,
        // The job writes the codebase the change lands in, so it claims that chain's modules.
        lanes: moduleLanes(spec.plainFile),
        onUpdate,
        run: async (onDelta) => {
          const result = await renderSpecDiff({
            plainFile,
            diff: params.diff,
            cwd: params.base,
            inModule: params.in_module,
            applied,
            spec,
            tryIt: params.try_it ?? true,
            conformance: conformanceOption(params.conformance, params.plain_file),
            model,
            onDelta,
          });
          return { report: describeSpecDiff(result), details: { passed: result.passed, stoppedAt: result.stoppedAt } };
        },
      });
    },
  });
}


/**
 * Bring the conformance tests in line with a change to the specs, given as a git diff: the spec
 * diff's counterpart of render_functionality_conformance. Nothing of the change itself is rendered.
 */
function registerRenderSpecDiffConformance(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool({
    name: "render_spec_diff_conformance",
    label: "Render spec diff conformance",
    description:
      "Bring the conformance tests in line with a change to the ***plain specs, given as a git diff of the .plain " +
      "files - any change: a functional spec, its acceptance tests, the test reqs, a definition the tests rely on. " +
      "The diff is applied with git unless it already is. One agent, given the diff and every spec as it now " +
      "stands, writes, changes and removes conformance tests so they check what the spec says; then the whole " +
      "suite runs. The tests are written in the chain's current codebase - the furthest-built module whose chain " +
      "includes the one changed - even when the change is to a module it requires. Rendering and conformance are " +
      "separate jobs: this renders nothing of the change itself. Needs test reqs.",
    promptSnippet: "render_spec_diff_conformance: bring the conformance tests in line with a git diff of the .plain specs",
    promptGuidelines: [
      "Use it for a spec diff that was rendered without conformance, or one only the tests follow - test reqs, acceptance tests.",
      "A change the code has not been built for yet is rendered first, with render_spec_diff: conformance tests check code, they do not build it.",
      "Pass the diff exactly as git produced it (git diff -- '*.plain'), paths relative to the project root.",
      "Report a failing conformance test as a mismatch between the code and the specification.",
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "A .plain file of the module the change is for" }),
      working_dir: WORKING_DIR_PARAM,
      diff: Type.String({ description: "The change, as a git diff of the .plain files" }),
      in_module: Type.Optional(
        Type.String({ description: "The codebase to test in, when modules built on this one branch" }),
      ),
      model: MODEL_PARAM,
      wait: WAIT_PARAM,
    }),
    async execute(_id, given, _signal, onUpdate, ctx) {
      const params = fromWorkingDir(cwd, given);
      const model = jobModel(ctx, "spec_changes", params.model, params.plain_file);
      const plainFile = resolve(cwd, params.plain_file);
      // Applied and parsed now, with the call: that parse is what the job tests against, whatever
      // changes reach the files while it waits its turn.
      const applied = applySpecDiff(params.diff, params.base);
      const spec = snapshotSpec(plainFile, { cwd: params.base, inModule: params.in_module });
      if (!shouldWait(ctx.mode, params.wait)) {
        const queued = renderQueueFor(jobs, cwd, ctx).enqueueSpecDiffConformance({
          plainFile, diff: params.diff, applied, spec, cwd: params.base, inModule: params.in_module, model,
        });
        return queuedReport(jobs, queued.jobId, "render_spec_diff_conformance");
      }
      return deliver(jobs, {
        kind: "render_spec_diff_conformance",
        summary: `${basename(params.plain_file)} spec diff conformance`,
        diff: params.diff,
        model,
        wait: params.wait,
        mode: ctx.mode,
        // It writes the tests - and, where a test shows it wrong, the code - of the codebase the change lands in.
        lanes: moduleLanes(spec.plainFile),
        onUpdate,
        run: async (onDelta) => {
          const result = await renderSpecDiffConformance({
            plainFile,
            diff: params.diff,
            cwd: params.base,
            inModule: params.in_module,
            applied,
            spec,
            model,
            onDelta,
          });
          return { report: describeSpecDiffConformance(result), details: { passed: result.passed, stoppedAt: result.stoppedAt } };
        },
      });
    },
  });
}

/** Rebuild one functionality whose specification changed, then re-run the whole suite. */
function registerRegenerateFunctionality(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool({
    name: "regenerate_functionality",
    label: "Regenerate functionality",
    description:
      "Rebuild one functionality over code that already exists - because its specification changed, or " +
      "because the user wants it redone even though it did not. The change is " +
      "made in the current codebase: the furthest-built module whose requires chain includes this one, not " +
      "this module's own older build. Updates the code, its unit tests and its conformance tests to the " +
      "current specification, then runs the conformance suite of every module up to that codebase - " +
      "because a changed specification can break something built later just as easily as earlier. Fails " +
      "if there is no existing build.",
    promptSnippet: "regenerate_functionality: rebuild a functionality after its specification changed",
    promptGuidelines: [
      "Use regenerate_functionality, not render_functionality, when the code already exists and the specification changed.",
      "A regression repair means the implementation was changed beyond the functionality asked for; say so when reporting.",
      "Say which codebase the change was made in when it is a later module's.",
      "It also rebuilds a functionality whose spec has not changed, as it is. When the user wants it to come out differently, change its spec first - the spec is what persists - then regenerate.",
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "Path to the .plain file" }),
      working_dir: WORKING_DIR_PARAM,
      frid: Type.String({ description: "Functionality id whose specification changed" }),
      in_module: Type.Optional(
        Type.String({
          description:
            "The module whose codebase to regenerate in. Only needed when modules built on this one sit on " +
            "different branches; otherwise the furthest-built one is found.",
        }),
      ),
      build_dir: Type.Optional(
        Type.String({ description: "Regenerate in exactly this build instead of finding the current codebase" }),
      ),
      model: MODEL_PARAM,
      wait: WAIT_PARAM,
    }),
    async execute(_id, given, _signal, onUpdate, ctx) {
      const params = fromWorkingDir(cwd, given);
      const model = jobModel(ctx, "functionalities", params.model, params.plain_file);
      const plainFile = resolve(cwd, params.plain_file);
      // The job writes the codebase it regenerates in, so it claims that chain's modules.
      let lanesFrom = plainFile;
      if (params.build_dir === undefined) {
        try {
          lanesFrom = findCodebaseTip(plainFile, { inModule: params.in_module }).tip.plainFile;
        } catch {
          // The job itself reports why no codebase could be chosen.
        }
      }
      return deliver(jobs, {
        kind: "regenerate_functionality",
        summary: `${basename(params.plain_file)} fs ${params.frid} (rebuild)`,
        model,
        wait: params.wait,
        mode: ctx.mode,
        lanes: moduleLanes(lanesFrom, params.build_dir ? resolve(cwd, params.build_dir) : undefined),
        onUpdate,
        run: async (onDelta) => {
          const result = await regenerateFunctionality({
            plainFile,
            frid: params.frid,
            inModule: params.in_module,
            buildDir: params.build_dir ? resolve(cwd, params.build_dir) : undefined,
            model,
            // As the project's config.yaml says: off there, no conformance tests written or run.
            conformance: conformanceOption(undefined, plainFile),
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
      : (describeRegenerationStop(result) ?? `Regeneration of ${result.moduleName} functionality ${result.frid} stopped at ${result.stoppedAt}.`),
    repairs > 0 ? `${repairs} regression repair(s) changed the implementation beyond this functionality.` : "",
    result.codebaseOf !== undefined
      ? `Regenerated in the codebase of ${result.codebaseOf} (${result.buildDir}), where the chain's code now lives; ` +
        `${result.moduleName}'s own build was left as it was.`
      : `Build in ${result.buildDir}.`,
  ]
    .filter(Boolean)
    .join("\n");
}


const CONFORMANCE_PARAM = Type.Optional(
  Type.Boolean({
    description:
      "Write and run black-box conformance tests as each functionality is built. Default: what the project's " +
      "config.yaml says (conformance-tests), and without it on for every module that has test reqs - which is " +
      "what they are written from - and off for every module that does not. Set false when the user asks to " +
      "render without conformance tests, true when they ask for them.",
  }),
);

/**
 * The conformance setting for a chain. Off, when asked, for every module. Otherwise each
 * module decides by its own test reqs: a chain can mix modules that have them with modules
 * that do not, and asking for conformance must not fail on the ones that cannot have it.
 */
/**
 * Whether a render writes and runs conformance tests: as asked, or else as the project's
 * config.yaml says (`conformance-tests:`), or else wherever a module has test reqs. Off means
 * off - none written, and none of the existing ones run.
 */
function conformanceOption(asked: boolean | undefined, plainFile?: string): false | undefined {
  if (asked === false) return false;
  if (asked === true) return undefined;
  return readProjectConfig(configDirFor(plainFile)).conformanceTests === false ? false : undefined;
}

/** Where the config.yaml for a spec is: its project's, or - with no spec - the session's folder. */
function configDirFor(plainFile?: string): string {
  return plainFile !== undefined ? projectDirOf(resolve(process.cwd(), plainFile)) : process.cwd();
}

/**
 * Whether renders write conformance tests, for the status bar - and why: the project's config.yaml
 * says so, or, where it says nothing, whether the module has the test reqs they are written from.
 * Nothing when there is no project here.
 */
export function conformanceStatus(root: string): string | undefined {
  const project = existsSync(join(root, CONFIG_FILE))
    ? root
    : readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "plain_modules")
        .map((entry) => join(root, entry.name))
        .find((dir) => existsSync(join(dir, CONFIG_FILE)));
  if (project === undefined) return undefined;
  const config = readProjectConfig(project);
  if (config.conformanceTests === false) return "conformance off (config.yaml)";
  if (config.conformanceTests === true) return "conformance on (config.yaml)";
  if (config.module === undefined) return "conformance on where there are test reqs";
  try {
    const file = resolve(project, config.module);
    const [, tree] = plainFileParser(basename(file), resolveTemplateDirs(file));
    return (sectionsOf(tree)[TEST_REQUIREMENTS] ?? []).length > 0 ? "conformance on (test reqs)" : "conformance off (no test reqs)";
  } catch {
    return "conformance on where there are test reqs";
  }
}

/**
 * The project's config.yaml, for the chat's agent: what it says, and what that means for the
 * tools - so a question about the project's settings is answered from the file, not from the
 * tools' defaults.
 */
export function projectConfigBlock(root: string): string {
  // The session's folder, and the projects one folder down - specs kept in plain/, with its own
  // config.yaml and plain_modules - which its specs are built in when named from here.
  const projects = [
    ...(existsSync(join(root, CONFIG_FILE)) ? [root] : []),
    ...readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "plain_modules")
      .map((entry) => join(root, entry.name))
      .filter((dir) => existsSync(join(dir, CONFIG_FILE))),
  ];
  if (projects.length === 0) return "";

  const describe = (dir: string): string[] => {
    const config = readProjectConfig(dir);
    const scripts = findTestScripts(dir);
    const where = dir === root ? "" : ` (paths relative to ${relative(root, dir)}/)`;
    return [
      dir === root ? `${CONFIG_FILE}, for the specs here:` : `${relative(root, dir)}/${CONFIG_FILE}, for the specs in ${relative(root, dir)}/ - built in ${relative(root, dir)}/plain_modules:`,
      ...[
        config.module !== undefined ? `- module: ${config.module}${where} - the module to build when the user does not name one.` : undefined,
        config.conformanceTests === false
          ? "- conformance-tests: false - conformance tests are OFF: renders write none and run none, unless the user asks for them in this conversation."
          : config.conformanceTests === true
            ? "- conformance-tests: true - conformance tests are on, for every module that has test reqs."
            : "- conformance-tests: not set - conformance tests are on for every module that has test reqs.",
        ...(() => {
          // Each as it holds, with what it inherits: judge from coding, coding from harness.
          const models = projectModels(config);
          const shown = (choice: typeof models.coding) => modelSpec(choice) ?? "";
          return [
            models.coding !== undefined ? `- coding-model: ${shown(models.coding)}${config.codingModel === undefined ? " (from harness-model)" : ""} - what renders run on, unless set_render_model chose another in this session.` : undefined,
            models.judge !== undefined ? `- judge-model: ${shown(models.judge)}${config.judgeModel === undefined ? " (from coding-model)" : ""} - the judge and the test review in a conformance run.` : undefined,
            models.harness !== undefined ? `- harness-model: ${shown(models.harness)} - the model plainwright chat starts with.` : undefined,
          ];
        })(),
        `- unit testing script: ${scripts.unit !== undefined ? relative(root, scripts.unit) : "none found - every build stops until there is one"}`,
        `- conformance testing script: ${scripts.conformance !== undefined ? relative(root, scripts.conformance) : "none found"}`,
        config.testingScripts === "host"
          ? "- testing-scripts: host - the testing scripts run in place on this machine, from the project, against the host codebase - not in the sandbox VM."
          : undefined,
      ].filter((line): line is string => line !== undefined),
    ];
  };

  return [
    `<project config>`,
    `A project's ${CONFIG_FILE} sets how its specs are built. The render tools follow the one of the spec they build;`,
    "answer questions about the project's settings from it, and say when a render will differ from it because the user",
    "asked. Name a spec by its path from here - plain/hubspot.plain - and it is built in its own project.",
    ...projects.flatMap((dir) => ["", ...describe(dir)]),
    `</project config>`,
  ].join("\n");
}

const WORKING_DIR_PARAM = Type.Optional(
  Type.String({
    description:
      "The folder to render from, relative to where plainwright was started - as if it had been started there " +
      "(e.g. \"plain\"). plain_file, build_dir and a spec diff's paths are then relative to it - hubspot.plain, not " +
      "plain/hubspot.plain. Default: where " +
      "plainwright was started.",
  }),
);

/**
 * A render tool's arguments as if plainwright had been started in `working_dir`: the .plain file
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

const MODEL_PARAM = Type.Optional(
  Type.String({
    description:
      "The model for the agents of this one call: a provider/model-id, or its name as the user said it. " +
      "Omitted: the model chosen for this kind of work with set_render_model, else the conversation's. " +
      "To change it for every later render, use set_render_model instead.",
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

/**
 * The chat's model, read now - it can change while a skill runs - or, from a context that has
 * gone stale since, the model it had when it was last readable.
 */
function chatModelOf(ctx: ExtensionContext): string | undefined {
  try {
    const now = conversationModel(ctx);
    lastChatModel = now ?? lastChatModel;
    return now;
  } catch {
    return lastChatModel;
  }
}
let lastChatModel: string | undefined;

/** The models chosen in this session, by kind of work. Saved in the session, so a resume keeps them. */
const chosenModels: ModelChoices = {};
const MODEL_CHOICE_ENTRY = "plainwright_render_models";

/**
 * The model a job's agents run on: the one named on the call, checked now so a wrong name fails
 * here and not minutes later in the background; else the one chosen for its kind of work; else
 * the conversation's.
 */
/**
 * The model a render job runs on: the one asked for, or the one chosen in this session for its kind
 * of work, or the project's - `model:` in config.yaml - or the conversation's.
 */
function jobModel(ctx: ExtensionContext, work: RenderWork, named?: string, plainFile?: string): string | undefined {
  if (named !== undefined && named.trim() !== "") {
    const resolved = resolveModel(named, ctx.modelRegistry);
    if (!resolved.ok) throw new Error(describeResolution(resolved));
    return resolved.model;
  }
  return modelFor(chosenModels, work, projectModel(ctx, plainFile) ?? chatModelOf(ctx));
}

/**
 * The coding model this session starts from, and where it was given: `plainwright chat
 * --coding-model`, or `coding-model:` in the project's config.yaml - read afresh, so an edit to the
 * file holds for the next render.
 */
function codingModelDefault(plainFile?: string): { named: string; from: string } | undefined {
  const flag = process.env[CODING_MODEL_ENV]?.trim();
  if (flag) return { named: flag, from: "--coding-model" };
  // The coding model inherits what it leaves out from the harness model.
  const named = modelSpec(projectModels(readProjectConfig(configDirFor(plainFile))).coding);
  return named !== undefined ? { named, from: CONFIG_FILE } : undefined;
}

/**
 * The default coding model, resolved as a name the person said would be. One that cannot be used
 * says so, and where it came from, rather than running on something else.
 */
function projectModel(ctx: ExtensionContext, plainFile?: string): string | undefined {
  const given = codingModelDefault(plainFile);
  if (given === undefined) return undefined;
  // The model is looked up by name; how hard it thinks goes along with it as it was given.
  const { model, thinking } = splitModelSpec(given.named);
  if (model === undefined) return modelSpec({ thinking });
  const resolved = resolveModel(model, ctx.modelRegistry);
  if (!resolved.ok) {
    throw new Error(`${given.from} names the coding model "${model}", which cannot be used here.\n\n${describeResolution(resolved)}`);
  }
  return modelSpec({ model: resolved.model, thinking });
}

/** The default coding model for showing, with where it came from - never an error. */
function projectModelLabel(ctx: ExtensionContext): { model: string; from: string } | undefined {
  const given = codingModelDefault();
  if (given === undefined) return undefined;
  try {
    return { model: projectModel(ctx)!, from: given.from };
  } catch {
    return { model: `${given.named} - which cannot be used here`, from: given.from };
  }
}

/**
 * set_render_model, for the conversation's agent and for a skill's agent - whom the person talks
 * to while the skill runs - alike: both write the same choice. `conversation` is the context to
 * read models and the chat's model from; omitted, the one the tool is called with.
 */
function setRenderModelTool(pi: ExtensionAPI, conversation?: ExtensionContext) {
  return defineTool({
    name: "set_render_model",
    label: "Set render model",
    description:
      "Choose which model the agents that render run on, for the rest of this session: for spec changes " +
      "(render spec diff jobs, and the ones write_spec_diff queues), for functionalities (render, module, " +
      "regenerate, conformance), or for everything. By default " +
      "each runs on the model the project's config.yaml names, or else the conversation's model. The model may be given as provider/model-id or by name as " +
      "the user said it; a name that fits more than one model, or none with credentials, comes back as a " +
      "list - ask the user which they meant, never pick one yourself. Jobs already queued keep their model.",
    promptSnippet: "set_render_model: choose the model that renders spec changes or functionalities",
    promptGuidelines: [
      "When the user says which model should render or build something, call set_render_model - once; it holds for the rest of the session.",
      "If set_render_model returns several candidates, ask the user which one with ask_user or in your reply, then call it again with the exact provider/model-id.",
      "Say which model a render will run on when you start one on something other than the conversation's model.",
    ],
    parameters: Type.Object({
      work: Type.Union([Type.Literal("spec_changes"), Type.Literal("functionalities"), Type.Literal("all")], {
        description: "spec_changes, functionalities, or all of it",
      }),
      model: Type.String({
        description: 'provider/model-id, or the model\'s name as the user said it. "chat" goes back to the conversation\'s model.',
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, called) {
      const ctx = conversation ?? called;
      const works: Array<RenderWork | "all"> = params.work === "all" ? ["all", "spec_changes", "functionalities"] : [params.work];
      if (/^(chat|default|conversation)$/i.test(params.model.trim())) {
        for (const work of works) delete chosenModels[work];
      } else {
        const resolved = resolveModel(params.model, ctx.modelRegistry);
        if (!resolved.ok) throw new Error(describeResolution(resolved));
        if (params.work === "all") {
          delete chosenModels.spec_changes;
          delete chosenModels.functionalities;
        }
        chosenModels[params.work] = resolved.model;
      }
      pi.appendEntry(MODEL_CHOICE_ENTRY, { ...chosenModels });
      const text = `Renders now run on:\n${describeChoices(chosenModels, chatModelOf(ctx), projectModelLabel(ctx))}`;
      return { content: [{ type: "text" as const, text }], details: { ...chosenModels } };
    },
  });
}

/** Choosing which model renders what, for the rest of the session. */
function registerRenderModels(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    for (const key of Object.keys(chosenModels)) delete chosenModels[key as keyof ModelChoices];
    const saved = ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "custom" && (entry as { customType?: string }).customType === MODEL_CHOICE_ENTRY)
      .at(-1) as { data?: ModelChoices } | undefined;
    Object.assign(chosenModels, saved?.data ?? {});
  });

  pi.registerTool(setRenderModelTool(pi));

  pi.registerCommand("render-model", {
    description: "Show which model renders spec changes and functionalities. To change it, tell the agent.",
    handler: async (_args, ctx) => {
      const text = `Renders run on:\n${describeChoices(chosenModels, chatModelOf(ctx), projectModelLabel(ctx))}\n\nTo change it, say so - e.g. "render spec changes with gpt 5.5".`;
      if (ctx.hasUI) ctx.ui.notify(text, "info");
    },
  });
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
/**
 * The conversation's render queue: one, shared by every tool that queues a render or its
 * conformance tests - forge-plain's changes, render_spec_diff, render_module's spec diffs, the
 * conformance tools - so they run in the order they were asked for. Models not named are asked of
 * the conversation it was last queued from.
 */
const renderQueues = new WeakMap<JobRegistry, { queue: RenderQueue; from: { ctx: ExtensionContext } }>();

function renderQueueFor(jobs: JobRegistry, cwd: string, ctx: ExtensionContext): RenderQueue {
  let shared = renderQueues.get(jobs);
  if (shared === undefined) {
    const from = { ctx };
    const queue = createRenderQueue({
      registry: jobs,
      cwd,
      modelFor: (work, plainFile) => modelFor(chosenModels, work, projectModel(from.ctx, plainFile) ?? chatModelOf(from.ctx)),
    });
    shared = { queue, from };
    renderQueues.set(jobs, shared);
  }
  shared.from.ctx = ctx;
  return shared.queue;
}

/** What a tool says when it queued its work - and its conformance tests, when they follow as a job of their own. */
function queuedReport(jobs: JobRegistry, jobId: string, kind: string, conformanceJobId?: string) {
  const job = jobs.get(jobId);
  const model = job?.model ? ` on ${job.model}` : "";
  const when =
    job?.status === "queued"
      ? `It is queued behind ${job.waitingOn.map((id) => `job ${id}`).join(" and ")}, and starts when that finishes.`
      : "It is running now.";
  const conformance =
    conformanceJobId !== undefined
      ? ` Its conformance tests are a job of their own, ${conformanceJobId}, queued right behind it; they run once it lands.`
      : "";
  return {
    content: [
      {
        type: "text" as const,
        text:
          `Queued ${kind} as background job ${jobId}${model}: ${job?.summary ?? ""}. ${when}${conformance} ` +
          `Tell the user, and carry on. Use check_job with "${jobId}" if they ask how it is going.`,
      },
    ],
    details: { jobId, status: job?.status, conformanceJobId },
  };
}

async function deliver(
  jobs: JobRegistry,
  input: {
    kind: string;
    summary: string;
    model: string | undefined;
    wait: boolean | undefined;
    mode: string;
    /** What the job writes. See StartJobInput.lanes. */
    lanes: string[];
    onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void;
    /** For a render spec diff job: the diff, shown while it waits and runs. */
    diff?: string;
    run: (onDelta: (delta: string) => void) => Promise<JobOutcome>;
  },
) {
  const wait = shouldWait(input.mode, input.wait);

  if (wait) {
    let streamed = "";
    const { result: outcome, output } = await captureConsole(() =>
      input.run((delta) => {
        streamed += delta;
        input.onUpdate?.({ content: [{ type: "text" as const, text: streamed }], details: {} });
      }),
    );
    const noise = describeCaptured(output);
    return {
      content: [{ type: "text" as const, text: noise ? `${outcome.report}\n\n${noise}` : outcome.report }],
      details: outcome.details ?? {},
    };
  }

  // The job's name stays short for the panel; which model it runs on goes to the agent.
  const summary = input.summary;
  const onModel = input.model ? ` on ${input.model}` : "";
  const job = jobs.start({
    kind: input.kind,
    summary,
    diff: input.diff,
    model: input.model,
    lanes: input.lanes,
    // Background work writes through the same terminal the TUI is drawing on, so its
    // console output is collected rather than printed.
    run: async (onDelta) => {
      const { result, output } = await captureConsole(() => input.run(onDelta));
      const noise = describeCaptured(output);
      return noise ? { ...result, report: `${result.report}\n\n${noise}` } : result;
    },
  });
  return {
    content: [
      {
        type: "text" as const,
        text:
          (job.status === "queued"
            ? `Queued ${input.kind} as background job ${job.id}: ${summary}${onModel}. It writes the same ` +
              `module as ${job.waitingOn.map((id) => `job ${id}`).join(" and ")}, so it starts when that ` +
              "finishes. Tell the user it is queued and why, and carry on. "
            : `Started ${input.kind} as background job ${job.id}: ${summary}${onModel}.\n` +
              "It is running now and will report back when it finishes. Tell the user it has started, " +
              "and carry on. ") +
          `Use check_job with "${job.id}" if they ask how it is going.`,
      },
    ],
    details: { jobId: job.id, status: job.status },
  };
}

/** Looking in on work that is still running, and collecting what finished. */
function registerJobTools(pi: ExtensionAPI, jobs: JobRegistry, cwd: string) {
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
    description: "List the background jobs started in this session, in the order they were started.",
    promptSnippet: "list_jobs: what background work is running",
    parameters: Type.Object({}),
    async execute() {
      const all = jobs.list();
      return { content: [{ type: "text" as const, text: listJobs(jobs) }], details: { count: all.length } };
    },
  });

  // The panel is compact and ctrl+o only lasts as long as the work does. This is the whole
  // list, finished jobs included, put in the transcript where it stays.
  pi.registerTool({
    name: "stop_job",
    label: "Stop job",
    description:
      "Stop a background job: a queued one never starts, a running one has its agent stopped at once. Jobs " +
      "queued behind it move up. Code a running job already changed stays on disk; the functionality it " +
      "was building counts as not built.",
    promptSnippet: "stop_job: stop a queued or running background job",
    promptGuidelines: [
      "Stop a job only when the user asks. Name which one, and say which jobs were queued behind it - they will now run.",
    ],
    parameters: Type.Object({
      job_id: Type.String({ description: "The job's id, or the start of it" }),
    }),
    async execute(_id, params) {
      const text = stopJob(jobs, params.job_id);
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  pi.registerCommand("stop", {
    description: "Stop a queued or running background job: /stop [job id]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const live = jobs.list().filter((job) => job.status === "running" || job.status === "queued");
      let id = args.trim();
      if (id === "") {
        if (live.length === 0) return ctx.ui.notify("Nothing is running or queued.", "info");
        const label = (job: Job) => `${job.id}  ${job.status.padEnd(8)} ${job.summary}`;
        const picked = await ctx.ui.select("Stop which job?", live.map(label));
        const job = live.find((candidate) => picked !== undefined && label(candidate) === picked);
        if (job === undefined) return;
        id = job.id;
      }
      ctx.ui.notify(stopJob(jobs, id), "info");
    },
  });

  // Debug mode, for the render agents started from now on - see debug-log.ts.
  // A module's history: every render, regeneration and conformance run, as git commits.
  pi.registerCommand("history", {
    description: "Show a module's history - every render, regeneration and conformance run: /history [module]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const modules = modulesWithHistory(cwd);
      let name = args.trim();
      if (name === "") {
        if (modules.length === 0) return ctx.ui.notify("No module has any history yet.", "info");
        name = modules.length === 1 ? modules[0]! : ((await ctx.ui.select("History of which module?", modules)) ?? "");
        if (name === "") return;
      }
      pi.appendEntry(HISTORY_ENTRY, { module: name, text: historyLog(defaultBuildDir(name, cwd)) });
    },
  });

  pi.registerTool({
    name: "module_history",
    label: "Module history",
    description:
      "Read a module's history: every render, regeneration, conformance run and spec change made to its code " +
      "and tests, as git commits. Without a commit, the log; with one, that commit in full - its message and " +
      "the change it made.",
    promptSnippet: "module_history: what was rendered into a module, and when",
    parameters: Type.Object({
      module: Type.String({ description: "The module's name" }),
      commit: Type.Optional(Type.String({ description: "A commit from the log, to see in full" })),
    }),
    async execute(_id, params) {
      const buildDir = defaultBuildDir(params.module, cwd);
      const text = params.commit ? historyShow(buildDir, params.commit) : historyLog(buildDir);
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  // Read a job's agents at work: its whole transcript, live, in an overlay.
  // The transcript is a screen of its own, over the whole terminal. Leaving it (q) goes back to
  // the conversation and keeps it - its job and its place - so alt+w or /watch switch back.
  let watching: { jobId: string; handle?: OverlayHandle; close: () => void } | undefined;

  const showWatch = () => {
    watching?.handle?.setHidden(false);
    watching?.handle?.focus();
  };

  const openWatch = (ctx: ExtensionContext, job: Job) => {
    watching?.close();
    const entry: NonNullable<typeof watching> = { jobId: job.id, close: () => {} };
    watching = entry;
    // Not awaited: the screen lives on while the person is back in the conversation.
    void ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        const view = createTranscriptView({
          job: () => jobs.get(job.id),
          rows: () => tui.terminal.rows,
          style: {
            heading: (text) => theme.bold(theme.fg("accent", text)),
            muted: (text) => theme.fg("muted", text),
            accent: (text) => theme.fg("accent", text),
            error: (text) => theme.fg("error", text),
            added: (text) => theme.fg("toolDiffAdded", text),
            removed: (text) => theme.fg("toolDiffRemoved", text),
          },
          back: () => {
            entry.handle?.unfocus();
            entry.handle?.setHidden(true);
            tui.requestRender();
          },
          close: () => done(undefined),
        });
        entry.close = () => done(undefined);
        // A running job keeps writing; redraw so the screen follows it - while it is showing.
        const timer = setInterval(() => {
          if (entry.handle?.isHidden() !== true) tui.requestRender();
        }, WATCH_REDRAW_MS);
        timer.unref?.();
        return {
          render: (width: number) => view.render(width),
          handleInput: (data: string) => {
            // The screen has the keys while it shows, so the switch back is handled here too.
            if (matchesKey(data, WATCH_KEY)) view.handleInput("q");
            else view.handleInput(data);
            tui.requestRender();
          },
          invalidate: () => view.invalidate(),
          dispose: () => {
            clearInterval(timer);
            if (watching === entry) watching = undefined;
          },
        };
      },
      {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
        onHandle: (handle) => {
          entry.handle = handle;
        },
      },
    );
  };

  pi.registerCommand("watch", {
    description: "Read a background job's full transcript as it happens, on a screen of its own: /watch [job id]. q goes back to the chat; alt+w or /watch returns.",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const named = args.trim();
      if (watching !== undefined && (named === "" || watching.jobId.startsWith(named))) return showWatch();
      const job = await chooseJob(jobs, named, ctx.ui);
      if (job !== undefined) openWatch(ctx, job);
    },
  });

  pi.registerShortcut(WATCH_KEY, {
    description: "Switch to the job transcript (/watch) and back",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      if (watching !== undefined) return showWatch();
      const job = await chooseJob(jobs, "", ctx.ui);
      if (job !== undefined) openWatch(ctx, job);
    },
  });

  // An entry rather than a message, so it shows straight away even while a skill is
  // running - which is exactly when someone wants to know what the queue is doing.
  pi.registerCommand("jobs", {
    description: "List every background job: running, queued and finished",
    handler: async () => {
      pi.appendEntry(JOBS_LIST_ENTRY, { text: listJobs(jobs) });
    },
  });
}

const WATCH_REDRAW_MS = 500;
/** Switches between the conversation and the transcript screen. */
const WATCH_KEY = "alt+w";

/** The modules in this project that have a history, by name. */
function modulesWithHistory(cwd: string): string[] {
  const root = join(cwd, "plain_modules");
  try {
    return readdirSync(root).filter((name) => existsSync(join(root, name, HISTORY_DIR)));
  } catch {
    return [];
  }
}

/** The spec of the codebase a job on this module would write: the tip built on it, or itself. */
function codebasePlainFile(plainFile: string, inModule?: string): string {
  try {
    return findCodebaseTip(plainFile, { inModule }).tip.plainFile;
  } catch {
    return plainFile;
  }
}

/** Stop a job by id or id prefix, and say what that means for the queue. */
function stopJob(jobs: JobRegistry, named: string): string {
  const matches = jobs.list().filter((job) => job.id.startsWith(named.trim()));
  if (matches.length === 0) return `No job ${named}. /jobs lists them.`;
  if (matches.length > 1) return `'${named}' matches ${matches.map((job) => job.id).join(", ")}. Give more of the id.`;
  const target = matches[0]!;
  const behind = jobs.list().filter((job) => job.status === "queued" && job.waitingOn.includes(target.id));
  const stopped = jobs.stop(target.id);
  if (stopped === undefined) return `Job ${target.id} (${target.summary}) is already ${target.status}.`;
  const queued = behind.length > 0 ? ` Queued behind it, now moving up: ${behind.map((job) => `${job.summary} (${job.id})`).join(", ")}.` : "";
  return stopped.status === "stopped"
    ? `Stopped ${target.summary} (${target.id}) before it started.${queued}`
    : `Stopping ${target.summary} (${target.id}): its agent is being stopped now.${queued}`;
}

/**
 * The job to watch: the one named, or the only one running, or the one picked from a list.
 */
async function chooseJob(
  jobs: JobRegistry,
  named: string,
  ui: { select(title: string, options: string[]): Promise<string | undefined>; notify(message: string, type?: "info" | "warning" | "error"): void },
): Promise<Job | undefined> {
  const all = jobs.list();
  if (named !== "") {
    const found = all.find((job) => job.id.startsWith(named));
    if (found === undefined) ui.notify(`No job ${named}. /jobs lists them.`, "warning");
    return found;
  }
  if (all.length === 0) {
    ui.notify("No jobs have been started.", "info");
    return undefined;
  }
  const running = all.filter((job) => job.status === "running");
  if (running.length === 1) return running[0];
  const label = (job: Job) => `${job.id}  ${job.status.padEnd(9)} ${job.summary}`;
  const picked = await ui.select("Watch which job?", all.map(label));
  return all.find((job) => picked !== undefined && label(job) === picked);
}

/** Every job, in the order it was started, with what a queued one is waiting for. */
function listJobs(jobs: JobRegistry): string {
  const all = [...jobs.list()].reverse();
  if (all.length === 0) return "No jobs have been started.";
  return all
    .map((job) => {
      const time = job.status === "queued" ? "waiting" : formatDuration(job);
      const after = job.status === "queued" ? `  (after ${job.waitingOn.join(", ")})` : "";
      const spent = describeUsage(job.usage);
      const model = job.model ? `  · ${job.model}` : "";
      return `${job.id}  ${job.status.padEnd(9)} ${time.padStart(7)}  ${job.kind}: ${job.summary}${model}${after}${spent ? `  · ${spent}` : ""}`;
    })
    .join("\n");
}


/**
 * Static validation of a ***plain specification.
 *
 * This is the check that used to mean a renderer dry-run. It runs this repo's own parser,
 * so it needs no external tool, no API key and no credits - and it is the only honest way
 * to answer "is this spec valid?" without generating anything.
 */
function registerCheckPlain(pi: ExtensionAPI, cwd: string) {
  pi.registerTool(checkPlainTool(cwd));
  pi.registerTool(chatAskUserTool());
  // The web, for the conversation too - a library's documentation, an API, an error; curl is its
  // bash. Run here, like the rendering agents' (see render/web.ts).
  for (const tool of createWebTools()) pi.registerTool(tool);
}

/** check_plain, for the conversation and for the skills that write specs alike. */
function checkPlainTool(cwd: string) {
  return defineTool({
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


const MILESTONE_ENTRY = "plainwright_milestone";
const JOB_ENTRY = "plainwright_job";
const JOBS_LIST_ENTRY = "plainwright_jobs";
const HISTORY_ENTRY = "plainwright_history";

interface JobAnnouncement {
  id: string;
  summary: string;
  status: "succeeded" | "failed" | "stopped";
  /** The job ran to its end, and what it built did not pass - a build that stopped at a gate. */
  incomplete?: boolean;
  duration: string;
  /** Tokens and cost, when any were spent. */
  spent?: string;
  text: string;
}

function announceJob(pi: ExtensionAPI, job: Job): void {
  if (job.status !== "succeeded" && job.status !== "failed" && job.status !== "stopped") return;
  const announcement: JobAnnouncement = {
    id: job.id,
    summary: job.summary,
    status: job.status,
    incomplete: job.status === "succeeded" && (job.details as { passed?: unknown } | undefined)?.passed === false,
    duration: formatDuration(job),
    spent: describeUsage(job.usage) || undefined,
    text:
      job.specConflict !== undefined
        ? describeSpecConflict(job.specConflict)
        : job.status === "succeeded"
        ? (job.announce ?? job.report ?? "")
        : job.status === "stopped"
          ? "Stopped on request. Whatever it changed before it stopped is still on disk; the functionality it was on counts as not built."
          : (job.error ?? "no error recorded"),
  };
  try {
    pi.appendEntry(JOB_ENTRY, announcement);
  } catch {
    // The agent still gets the report; losing the entry must not lose the result.
  }
}

/**
 * What the conversation's agent is asked to do about a spec that contradicts itself: confirm it
 * with analyze-2-func-specs, work out the ways out with resolve-spec-conflict, and put the choice
 * to the person - who decides. Nothing in the spec is changed before they have.
 */
function specConflictTask(conflict: SpecConflict): string {
  const [one, two] = conflict.specs;
  return [
    describeSpecConflict(conflict),
    "",
    `The render stopped on it: the conformance run's judge found them conflicting, ${conflict.reasons.length} times -`,
    `functional spec ${one!.frid} of ${one!.module} (${one!.plainFile}) and functional spec ${two!.frid} of ${two!.module} (${two!.plainFile}). Now:`,
    "1. Run the analyze-2-func-specs skill (run_skill) on these two functional specs, to confirm they conflict.",
    "2. If they do, run the resolve-spec-conflict skill on the pair, to work out what could be changed - but change nothing yet.",
    "3. Tell the user exactly what the conflict is - both specs as they read, and the behaviour that cannot satisfy both -",
    "   and put the decision to them with ask_user: the ways out resolve-spec-conflict found, and Something else. Suggest they",
    "   simply decide which is meant; it is their call, not yours.",
    "4. Only once they have decided, make the change they chose to the .plain file it belongs in - either module's -",
    "   and render it with render_spec_diff (the git diff of that change) - its conformance tests follow it.",
    "If analyze-2-func-specs finds the two compatible, tell the user so, and that the conformance tests of these two are what",
    "kept failing - offer to render their conformance again.",
  ].join("\n");
}

/** A durable note in the transcript when something actually completes. */
function recordMilestone(pi: ExtensionAPI, milestone: { module: string; text: string }): void {
  try {
    pi.appendEntry(MILESTONE_ENTRY, milestone);
  } catch {
    /* the report still carries it */
  }
}

const INTERVIEW_ENTRY = "forge_exchange";

export interface Exchange {
  skill: string;
  question: string;
  answer: string;
}

/**
 * Show each question and answer in the transcript, where the person can see it.
 *
 * A skill runs inside one tool call and asks through dialogs, so its interview leaves no
 * trace in the conversation - the questions vanish once answered. These are custom
 * *entries* rather than messages on purpose: they are durable and rendered, but they do
 * not enter the model's context, so a long interview is readable without being paid for
 * twice.
 */
function registerInterviewLog(pi: ExtensionAPI) {
  pi.registerEntryRenderer(JOB_ENTRY, (entry, _options, theme) => {
    const data = entry.data as JobAnnouncement | undefined;
    if (data === undefined) return undefined;
    const ok = data.status === "succeeded";
    // A job that ran to its end but whose build did not pass is not a success: it says so.
    const header =
      data.status === "succeeded" && data.incomplete === true
        ? `${theme.fg("error", "✗")} ${theme.fg("text", data.summary)} ${theme.fg("error", `did not pass - stopped after ${data.duration}`)}`
        : data.status === "succeeded"
        ? `${theme.fg("success", "✓")} ${theme.fg("text", data.summary)} ${theme.fg("muted", `finished after ${data.duration}`)}`
        : data.status === "stopped"
          ? `${theme.fg("warning", "■")} ${theme.fg("text", data.summary)} ${theme.fg("warning", `stopped after ${data.duration}`)}`
          : `${theme.fg("error", "✗")} ${theme.fg("text", data.summary)} ${theme.fg("error", `failed after ${data.duration}`)}`;
    const spent = data.spent ? ` ${theme.fg("muted", `· ${data.spent}`)}` : "";
    const box = new Box(1, 0);
    box.addChild(new Text([header + spent, "", theme.fg(ok ? "text" : "muted", data.text.trim())].join("\n"), 0, 0));
    return box;
  });

  pi.registerEntryRenderer(HISTORY_ENTRY, (entry, _options, theme) => {
    const data = entry.data as { module: string; text: string } | undefined;
    if (data === undefined) return undefined;
    const box = new Box(1, 0);
    box.addChild(new Text([theme.fg("muted", `history of ${data.module}`), theme.fg("text", data.text)].join("\n"), 0, 0));
    return box;
  });

  pi.registerEntryRenderer(JOBS_LIST_ENTRY, (entry, _options, theme) => {
    const data = entry.data as { text: string } | undefined;
    if (data === undefined) return undefined;
    const box = new Box(1, 0);
    box.addChild(new Text([theme.fg("muted", "background jobs"), theme.fg("text", data.text)].join("\n"), 0, 0));
    return box;
  });

  pi.registerEntryRenderer(MILESTONE_ENTRY, (entry, _options, theme) => {
    const data = entry.data as { module: string; text: string } | undefined;
    if (data === undefined) return undefined;
    const box = new Box(1, 0);
    box.addChild(
      new Text(`${theme.fg("success", "●")} ${theme.fg("muted", data.module)} ${theme.fg("text", data.text)}`, 0, 0),
    );
    return box;
  });

  pi.registerEntryRenderer(INTERVIEW_ENTRY, (entry, _options, theme) => {
    const data = entry.data as Exchange | undefined;
    if (data === undefined) return undefined;

    // Two details of the TUI components matter here. Box's third argument is a
    // *background* function - passing a foreground colour into it tints every line, which
    // is what made these unreadable. And Text pads by 1 on both axes unless told
    // otherwise, so one Text per line puts a blank line between each. Hence a single Text
    // with explicit zero padding, coloured per line.
    const answer =
      data.answer.trim() === ""
        ? theme.fg("dim", "> (no answer)")
        : theme.fg("accent", `> ${data.answer}`);

    const box = new Box(1, 0);
    box.addChild(
      new Text(
        [theme.fg("muted", `${data.skill} asked`), theme.fg("text", data.question), answer].join("\n"),
        0,
        0,
      ),
    );
    return box;
  });
}

function recordExchange(pi: ExtensionAPI, exchange: Exchange): void {
  try {
    pi.appendEntry(INTERVIEW_ENTRY, exchange);
  } catch {
    // The trace still carries it; a rendering failure must not lose the answer.
  }
}


/**
 * What the skill should be told about the conversation that started it.
 *
 * The agent's own summary comes first, because it knows which parts matter. The user's
 * recent messages are appended verbatim underneath: a summary drops the particulars - a
 * product name, a phrasing the user chose - and those are exactly what makes a skill's
 * first question sound like it was listening.
 */
function conversationContext(ctx: ExtensionContext, summary: string | undefined): string | undefined {
  const spoken = recentUserMessages(ctx, 12);
  const parts: string[] = [];
  if (summary !== undefined && summary.trim() !== "") parts.push(summary.trim());
  if (spoken.length > 0) {
    parts.push(`In their own words:\n${spoken.map((line) => `- ${line}`).join("\n")}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function recentUserMessages(ctx: ExtensionContext, limit: number): string[] {
  let entries: unknown[];
  try {
    entries = ctx.sessionManager.getEntries();
  } catch {
    return [];
  }

  const said: string[] = [];
  for (const entry of entries) {
    const message = (entry as { type?: string; message?: { role?: string; content?: unknown } }).message;
    if ((entry as { type?: string }).type !== "message" || message?.role !== "user") continue;

    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((part) => (part as { type?: string }).type === "text")
              .map((part) => (part as { text?: string }).text ?? "")
              .join(" ")
          : "";

    const trimmed = text.trim().replace(/\s+/g, " ");
    if (trimmed !== "") said.push(trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed);
  }

  return said.slice(-limit);
}


const BANNER_ENTRY = "plainwright_banner";

/**
 * The name on the door.
 *
 * Pi's own startup header is a built-in component an extension cannot replace, so this
 * adds a wordmark of its own at the top of the session. `plainwright chat` starts pi without
 * its header (see pi-launch.ts), leaving only this one.
 */
function registerBranding(
  pi: ExtensionAPI,
  ruleCount: number,
  skills: { skills: Skill[]; pending: string[] },
) {
  pi.registerEntryRenderer(BANNER_ENTRY, (entry, _options, theme) => {
    const data = entry.data as
      | {
          version: string;
          rules: number;
          skills: number;
          pending: number;
          cwd: string;
          sandbox?: ReturnType<typeof vmSummary>;
        }
      | undefined;
    if (data === undefined) return undefined;

    const rule = "─".repeat(46);
    const box = new Box(1, 0);
    box.addChild(
      new Text(
        [
          theme.fg("borderMuted", rule),
          `${theme.fg("accent", "plainwright")}  ${theme.fg("muted", `v${data.version}`)}`,
          theme.fg("text", "specifications in, working code out"),
          theme.fg(
            "muted",
            `${data.rules} rules · ${data.skills} skill${data.skills === 1 ? "" : "s"}` +
              (data.pending > 0 ? theme.fg("warning", `  (${data.pending} failed to load)`) : ""),
          ),
          theme.fg("dim", data.cwd),
          // Where every command an agent runs will run - or that none can.
          ...(data.sandbox
            ? [theme.fg(data.sandbox.level === "ok" ? "dim" : data.sandbox.level === "limited" ? "warning" : "error", data.sandbox.text)]
            : []),
          theme.fg("borderMuted", rule),
        ].join("\n"),
        0,
        0,
      ),
    );
    return box;
  });

  pi.on("session_start", (_event, ctx) => {
    try {
      pi.appendEntry(BANNER_ENTRY, {
        version: packageVersion(),
        rules: ruleCount,
        skills: skills.skills.length,
        pending: skills.pending.length,
        cwd: ctx.cwd,
        sandbox: vmSummary(),
      });
    } catch {
      // Branding is the least important thing here; never let it stop a session starting.
    }
  });
}

function packageVersion(): string {
  try {
    const raw = readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
