// First: the names turri had before are carried over before anything reads them.
import { LEGACY_NAME } from "./legacy.ts";
// A project built under the old names is brought over the first time it is found.
import "./grow/migrate.ts";
// Whether the terminal shows images, before anything draws: the banner's jellyfish is a picture or text.
import "./terminal-images.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { allocateImageId, Box, type Component, getCapabilities, getPngDimensions, type ImageDimensions, matchesKey, renderImage, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CODING_MODEL_ENV } from "./chat-models.ts";
import { CONFIG_FILE, configForSpec, moduleConfigFile, modulesWithConfig, modelSpec, projectModels, readProjectConfig, splitModelSpec } from "./config.ts";
import { modulesRoot, skillRunDir } from "./grow/paths.ts";
import { defaultParallelJobs, installedPackages, STOCK_IMAGE, vmImageFor } from "./grow/vm.ts";
import { stackAgainstImage } from "./vm-stack.ts";
import { describePlan, hasProjectImage, imagePlan, planDiffersFromBuilt, projectImageTag, readBuiltImage, toolchainsOf, userImageFile } from "./vm-image.ts";
import { buildVmImage } from "./setup.ts";
import { describeContents, imageSources, resolveImageContents } from "./vm-image-contents.ts";
import { findTestScripts } from "./grow/test-scripts.ts";
import { createAskUserTool } from "./tools.ts";
import { createWebTools } from "./grow/web.ts";
import { describeGates, interruptedRun, runSkill } from "./forge.ts";
import type { Reporter } from "./graph.ts";
import { loadSkill, skillStatus, type Skill } from "./skill.ts";
import { resolveTemplateDirs } from "./grow/paths.ts";
import { plainFileParser } from "./plain/parser.ts";
import { TEST_REQUIREMENTS } from "./plain/spec.ts";
import { sectionsOf } from "./grow/state.ts";
import { runningDeployed, stopDeployed } from "./grow/release.ts";
import { createDeployState, createDeployTools, refuseInstall } from "./release-tools.ts";
import { createSteeringStore, EVERY_MODULE, moduleNameOf, queueSectionOf, steeringFor } from "./grow/steer.ts";
import { vmSummary } from "./grow/vm.ts";
import { askedForCommandLine, refusal, selfInvocation, TOOLS_NOT_CLI } from "./self-invocation.ts";
import { describeChoices, describeResolution, type ModelChoices, modelFor, type RenderWork, resolveModel } from "./grow/engine.ts";
import { checkPlainFile, checkPlainTargets, formatCheckResults } from "./plain/check.ts";
import { whyFailed } from "./grow/diagnose-job.ts";
import { createWorkLoop, describeDrift, describeModules, previewJobs, type ModuleStatus, type WorkLoop } from "./grow/loop.ts";
import { plainPaint } from "./grow/plain-palette.ts";
import { createJobPanel } from "./grow/job-panel.ts";
import { createSidePanel, type PanelView } from "./grow/side-panel.ts";
import { createJobsTreeState } from "./grow/jobs-tree.ts";
import { describeDiagnosis, diagnoseFailure } from "./grow/diagnose.ts";
import { HISTORY_DIR, historyLog, historyShow } from "./grow/lineage.ts";
import { defaultBuildDir } from "./grow/paths.ts";
import { describeUsage, type SpecConflict } from "./grow/activity.ts";
import { describeSpecConflict } from "./grow/stop-report.ts";
import { inheritProviders, inheritThinkingLevel } from "./pi.ts";
import { beginCapture, captureConsole, describeCaptured, dropNoise } from "./quiet.ts";
import { loadRules, renderRulesBlock } from "./rules.ts";
import { describeStdlib, stdlibStackCount } from "./stdlib.ts";
import { runAsk, type AskUser } from "./ask.ts";
import {
  createJobRegistry,
  describeJob,
  formatDuration,
  shouldWait,
  type Job,
  type JobOutcome,
  type JobRegistry,
} from "./grow/jobs.ts";

/**
 * Makes gated skills reachable from a conversation.
 *
 * The conversational agent keeps ordinary progressive disclosure - it reads the
 * skill descriptions and decides when one applies. What it does not get is the
 * choice of how to run it: `cultivate` hands the work to the graph, which owns
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
  onExchange: (question: string, answer: string, said?: string) => void,
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
      onExchange(request.question, answer, request.context);
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
      "When a question to the user has a handful of plausible answers - a choice, yes or no, which of these - ask it with ask_user rather than in your reply.",
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
  const panel = createJobPanel(() => shownJobs(jobs));

  // Finished work is announced twice, to two audiences, because pi treats them differently.
  // A message - what the agent reads - is held until the current turn ends, and a skill's
  // interview is one long turn: a render finishing mid-interview would say nothing until the
  // interview was over. An entry is drawn the moment it is appended. So the person gets an
  // entry, now, and the agent gets the full report as a hidden message, whenever its turn
  // allows. Neither starts a turn, so nothing talks over the person.
  const jobs: JobRegistry = createJobRegistry({
    // A job that fails is run once more; failing again, it and every job behind it fail, and the
    // harness - which can read the skills, the rules, the code, the tests and turri itself -
    // works out why, and what has to be done.
    retries: 1,
    // Modules that share nothing build side by side - as many at once as the machine has room for.
    maxRunning: parallelJobs(cwd),
    diagnose: async (job, failures, jobLog) => {
      const diagnosis = await diagnoseFailure({
        job,
        failures,
        projectDir: cwd,
        harnessDir: PACKAGE_ROOT,
        jobLog,
        model: modelSpec(projectModels(readProjectConfig(cwd)).harness),
      });
      return diagnosis !== undefined ? describeDiagnosis(diagnosis) : undefined;
    },
    onChange: () => panel.refresh(),
    onFinish: (job) => {
      panel.refresh();
      // Queued again as another job: that one says how it went.
      if (job.replacedBy !== undefined) return;
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
  // With them, the instruction to do turri's work with its tools rather than its command
  // line - enforced below, not only asked for.
  const rules = loadRules(join(PACKAGE_ROOT, "forge", "rules"));
  const rulesBlock = chatRulesBlock(rules);
  // What the project's config.yaml says, read afresh every turn: the agent answers from it, and
  // the tools default to it.
  pi.on("before_agent_start", (event) => ({
    systemPrompt: [event.systemPrompt, TURRI_IDENTITY, TOOLS_NOT_CLI, projectConfigBlock(cwd), sandboxBlock(cwd), rulesBlock].filter((part) => part !== "").join("\n\n"),
  }));

  // The conversation's agent does not run turri again through its shell, unless the person
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
      ctx.ui.setStatus("turri-conformance", conformanceStatus(cwd));
    } catch {
      // A status line is a convenience; never let it stop a turn.
    }
  };
  pi.on("session_start", (_event, ctx) => showConformance(ctx));
  // Where the keys are, from the first moment - before any job shows its panel.
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("turri-keys", `${PANEL_KEY} inspect jobs · ctrl+o expand`);
  });
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
  // And reach the providers its extensions registered - a company's own gateway - which they load none of.
  let conversationModels: ModelRegistry | undefined;
  pi.on("session_start", (_event, ctx) => {
    conversationModels = ctx.modelRegistry;
  });
  pi.on("before_agent_start", (_event, ctx) => {
    conversationModels = ctx.modelRegistry;
  });
  inheritProviders(() => conversationModels);

  registerBranding(pi, rules.length, discoveredSkills);
  registerInterviewLog(pi);
  registerJobTools(pi, jobs, cwd);
  registerCheckPlain(pi, cwd);
  registerRegrow(pi, cwd, jobs);
  registerDrift(pi, cwd, jobs);
  registerRejuvenate(pi, cwd, jobs);
  registerGlimpse(pi, cwd, jobs);
  registerBind(pi, cwd, jobs);
  registerBuildVmImage(pi, cwd, jobs);
  registerRenderModels(pi);
  registerDeploy(pi, cwd);
  registerSteering(pi, cwd);

  const { skills, pending } = discoveredSkills;
  if (skills.length === 0) return;

  const catalogue = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const pendingNote =
    pending.length > 0 ? `\n\nFailed to load and therefore not runnable: ${pending.join(", ")}.` : "";

  pi.registerTool({
    name: "cultivate",
    label: "Cultivate",
    description:
      "Execute one of this project's gated skills end to end. The skill's steps, review gates and " +
      "judges are enforced by the harness, so a gated skill's result has already passed review when it comes back; a skill " +
      "without gates is not reviewed. Every result says which files the run changed in the project.\n\n" +
      `Available skills:\n${catalogue}${pendingNote}`,
    promptSnippet: "cultivate: run a gated skill - its steps and review gates enforced by turri",
    promptGuidelines: [
      "When a request matches a skill listed in cultivate's description, call cultivate instead of doing the work yourself. Doing it by hand skips the review gates.",
      "cultivate returns the reviewed artifact and a trace of every gate decision. Report the artifact to the user; do not rewrite it.",
      "If cultivate fails, say so and stop. Never carry out the skill's work yourself in the conversation - the gates and the judges are the point of running it, and an unreviewed hand-run silently drops them.",
      "Always pass `context` to cultivate, summarising what the user has already told you.",
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
                "cultivate again with resume: true or fresh: true. Nothing has been started.",
            },
          ],
          details: { interrupted },
        };
      }

      const trace: string[] = [`skill: ${skill.name}`, ...describeGates(skill).map((l) => `  ${l}`)];
      // While it runs, what its agent is doing leads: pi shows a running tool's first lines, and the trace's first
      // lines are the gates, which say nothing about now. The result keeps the trace alone.
      const live = { started: Date.now(), step: "", stepStarted: Date.now(), recent: [] as string[], saying: "" };
      const show = () => {
        const elapsed = (since: number) => {
          const s = Math.round((Date.now() - since) / 1000);
          return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
        };
        const words = live.saying.replace(/\s+/g, " ").trim();
        const view = [
          `${skill.name}${live.step !== "" ? ` · ${live.step}, ${elapsed(live.stepStarted)}` : ""} · ${elapsed(live.started)} in all`,
          ...live.recent.map((line) => `  ${line}`),
          ...(words !== "" ? [`  says: ${words.length > 160 ? `…${words.slice(-159)}` : words}`] : []),
          "",
        ];
        onUpdate?.({ content: [{ type: "text" as const, text: [...view, ...trace].join("\n") }], details: {} });
      };
      const push = (line: string) => {
        trace.push(line);
        show();
      };
      const ticker = setInterval(show, 5000);
      ticker.unref?.();

      const report: Reporter = {
        step: (name, attempt) => {
          if (ctx.hasUI) ctx.ui.setStatus("forge-skill", skillStatus(skill, name, attempt));
          live.step = skillStatus(skill, name, attempt).slice(skill.name.length + 2);
          live.stepStarted = Date.now();
          push(`step ${name} (attempt ${attempt})`);
        },
        activity: (line) => {
          live.recent = [...live.recent, line].slice(-6);
          show();
        },
        said: (delta, fresh) => {
          live.saying = fresh ? "" : live.saying + delta;
          show();
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

      // What the run changes in the project - its specs, resources, scripts - is said with its result: a skill that
      // writes nothing is not taken for one that did its work.
      const filesBefore = projectFiles(cwd);
      const { result, output: captured } = await captureConsole(() =>
        runSkill({
        skillDir: skill.dir,
        cwd,
        runDir,
        resume: params.resume === true && interrupted !== undefined,
        report,
        context: conversationContext(ctx, params.context),
        askUser: askUserVia(ctx, (question, answer, said) => {
          // What the skill's agent said before asking stays in the run's record, not only in the dialog.
          for (const line of (said ?? "").trim().split("\n").filter((line) => line.trim() !== "")) push(`  ${line}`);
          push(`  Q: ${question}`);
          push(`  A: ${answer}`);
          recordExchange(pi, { skill: skill.name, question, answer });
        }),
        model: conversationModel(ctx),
        // Renders queued by a step land in the same registry as everything else, so
        // growth sees them without knowing a skill started them.
        // Asked per job as it is queued, so a model chosen mid-interview applies from then on.
        renderQueue: workLoopFor(jobs, cwd, ctx),
        // A skill that waits for its builds and reads what they recorded - temper-plain - sees the same jobs.
        jobs,
        // The person answers the skill's agent while it runs, so it can take "render these with ..." too.
        // validate too: a skill validates what it wrote with the same check the conversation has.
        sharedTools: [setRenderModelTool(pi, ctx), checkPlainTool(cwd), ...createWebTools()],
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
      ).finally(() => clearInterval(ticker));
      const noise = describeCaptured(captured);
      if (noise !== null) push(noise);

      const changes = changedFiles(filesBefore, projectFiles(cwd));
      const changed =
        changes.length > 0
          ? `It changed ${changes.length} file${changes.length === 1 ? "" : "s"} in the project: ${changes.join(", ")}.`
          : "It changed no file in the project - whatever it said it wrote is not there. Say so to the user; do not report the work as done.";
      // A skill that edits the specs with the file tools builds nothing: the change is the conversation's to render.
      const specsChanged = changes.filter((path) => path.endsWith(".plain"));
      const unrendered =
        specsChanged.length > 0 && !skill.allowedTools.includes("write_spec_diff")
          ? `${specsChanged.join(", ")} changed, and nothing grows from that yet: call regrow for it, and the code is brought up to the spec.`
          : "";
      const gated = skill.steps.some((step) => step.gate !== undefined);
      const text = result.ok
        ? [
            gated ? `${skill.name}: passed all gates.` : `${skill.name}: finished. It has no review gates, so nothing checked its work: read what it changed before you report it.`,
            changed,
            ...(unrendered !== "" ? [unrendered] : []),
            "",
            "<artifact>",
            result.output,
            "</artifact>",
            "",
            "<trace>",
            ...trace,
            "</trace>",
          ].join("\n")
        : [`${skill.name}: stopped at a gate. No approved artifact.`, changed, "", "<trace>", ...trace, "</trace>"].join("\n");

      if (ctx.hasUI) ctx.ui.setStatus("forge-skill", undefined);
      return { content: [{ type: "text" as const, text }], details: { ok: result.ok, artifacts: result.artifacts } };
    },
  });
}

/** What the loop is doing for a spec's modules, for the conversation - and, waiting, how each module ended. */
async function loopReply(loop: WorkLoop, statuses: ModuleStatus[], wait: boolean) {
  if (wait) await loop.drain();
  const now = wait ? loop.status().filter((status) => statuses.some((asked) => asked.plainFile === status.plainFile)) : statuses;
  const jobIds = now.flatMap((status) => (status.running !== undefined ? [status.running.jobId] : []));
  const text = [
    describeModules(now),
    "",
    wait
      ? "Tell the user how it went."
      : "It grows in the background: tell the user what runs and what is planned, and carry on. Use growth with a job's id if they ask how it is going.",
  ].join("\n");
  return { content: [{ type: "text" as const, text }], details: { jobIds } };
}

function registerRegrow(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool({
    name: "regrow",
    label: "Regrow",
    description:
      "Regrow a .plain module's code from its spec as the files have it now - and every module it requires, bottom of the " +
      "requires chain first. Call it after any change to the spec, by any means: the file tools, a skill, the user in an " +
      "editor. It takes no diff: what is left to grow - from what each module's code was grown from to its spec now - is " +
      "worked out and planned into jobs, and a job running that grows something the spec no longer wants is stopped and " +
      "rolled back. Nothing to do where the code is grown from the spec as it is. With functional specs named, those are " +
      "grown again even though their spec did not change.",
    promptSnippet: "regrow a module's code from its spec as it is now - after any change to the spec",
    promptGuidelines: [
      "Call regrow after editing a .plain file with the file tools - or when the user says they changed one - instead of working out a diff: turri compares what is grown with the spec now.",
      "regrow returns at once with what runs and what is planned. Report it, keep talking, and use growth when the user asks; the jobs report when they finish.",
      "Name functional specs in `functionalities` only when the user wants ones whose spec did not change grown again. When they want one to come out differently, change its spec first - the spec is what persists - then regrow.",
      "A change to a file the spec links - an API surface, a mapping document - is a change to the spec: regrow sees it by itself, and grows again every functional spec that uses what links it. Never name functional specs in `functionalities` for it.",
      "Never stop jobs and start them again yourself to follow a spec change: regrow does it.",
    ],
    parameters: Type.Object({
      plain_file: Type.Optional(
        Type.String({ description: "Path to the .plain file. Omitted: the module the project's config.yaml names" }),
      ),
      working_dir: WORKING_DIR_PARAM,
      functionalities: Type.Optional(
        Type.Array(Type.String(), { description: "Functional specs, by id, to grow again though their spec did not change. Omitted: only what changed" }),
      ),
      guidance: GUIDANCE_PARAM,
      model: MODEL_PARAM,
      wait: WAIT_PARAM,
    }),
    async execute(_id, given, _signal, _onUpdate, ctx) {
      // No file named: the project's config.yaml says which module.
      const located = fromWorkingDir(cwd, given);
      const named = located.plain_file ?? readProjectConfig(located.base).module;
      if (named === undefined) {
        const stacks = modulesWithConfig(located.base);
        throw new Error(
          stacks.length > 0
            ? `Name the .plain file to regrow: this project has modules with configs of their own - ${stacks.map((module) => `${module} (${moduleConfigFile(module)})`).join(", ")}.`
            : `Name the .plain file to regrow, or set module: in ${CONFIG_FILE}.`,
        );
      }
      const plainFile = resolve(located.base, named);
      const check = checkPlainFile(plainFile);
      if (!check.ok) throw new Error(`${named} does not parse, so nothing can grow from it yet: ${check.error}`);
      const again = located.functionalities ?? [];
      const model = jobModel(ctx, again.length > 0 ? "functionalities" : "spec_changes", located.model, plainFile);
      const loop = workLoopFor(jobs, cwd, ctx);
      const request = { ...(model !== undefined ? { model } : {}), ...(located.guidance !== undefined ? { guidance: located.guidance } : {}) };
      const statuses = again.length > 0 ? await loop.regenerate(plainFile, again, request) : await loop.bringUp(plainFile, request);
      return loopReply(loop, statuses, shouldWait(ctx.mode, located.wait));
    },
  });
}

/** What is left to grow: the drift between a module's code and its spec - planning nothing, starting nothing. */
function registerDrift(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool({
    name: "drift",
    label: "Drift",
    description:
      "How far a module's code has drifted from its spec: in each codebase where it lives, what is left to grow - the " +
      "functional specs to add, change or take out, and reqs or definitions alone - and the conformance tests left to " +
      "write, those bound ahead of their code, what is growing now, and why nothing grows where nothing does. It plans " +
      "nothing and starts nothing, and calls no model.",
    promptSnippet: "drift: what is left to grow in a module, code and conformance tests - starting nothing",
    promptGuidelines: [
      "Use drift when the user asks what is left to build, whether a module is up to date with its spec, or what changed since it was last grown. To see the next job's prompt as well, use glimpse.",
    ],
    parameters: Type.Object({
      plain_file: Type.Optional(Type.String({ description: "Path to the .plain file. Omitted: the module the project's config.yaml names" })),
      working_dir: WORKING_DIR_PARAM,
    }),
    async execute(_id, given, _signal, _onUpdate, ctx) {
      const located = fromWorkingDir(cwd, given);
      const named = located.plain_file ?? readProjectConfig(located.base).module;
      if (named === undefined) throw new Error(`Name the .plain file, or set module: in ${CONFIG_FILE}.`);
      const reports = workLoopFor(jobs, cwd, ctx).drift(resolve(located.base, named));
      return { content: [{ type: "text" as const, text: describeDrift(reports) }], details: { modules: reports.length } };
    },
  });
}

function registerBind(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool({
    name: "bind",
    label: "Bind conformance tests",
    description:
      "Write and run the black-box conformance tests of a module's functional specs - the ones named, or every one - on " +
      "the code as it is built, as jobs of their own: each writes its tests from the spec's test reqs and acceptance " +
      "tests, runs them with the whole suite the module inherits, and, where one fails, fixes the test or the code, " +
      "whichever is wrong. What they are written for is recorded apart from the code. For this session, whatever the " +
      "config's conformance-tests says. Functional specs not built yet can be named: the conformance job is scheduled at " +
      "once and starts when every one named is built - each call one job - before the next code job. A functional spec " +
      "the spec does not have, or a module without test reqs, is refused. A conformance job checks, as it starts, that " +
      "the code record has every functional spec it tests, and does not start otherwise.",
    promptSnippet: "bind functional specs to conformance tests - now, or ahead of their code",
    promptGuidelines: [
      "When the user asks for conformance tests - for a module, or some of its functional specs - call bind. Never edit config.yaml for it, and never regenerate a functionality to get them.",
      "Under conformance-tests: chosen, choose when the work is planned, not once it is built: what regrow returns lists the functional specs the planned code jobs add or change that no conformance test is for - decide which are worth black-box tests, say why, and call bind with their numbers straight away. Name together the ones to test in one job. A code job's report lists any left undecided. The ones named are added to those chosen before; a functional spec tested already keeps its tests.",
      "A conformance job that did not start because its code is not built: tell the user which functional specs it waits for, and which code job builds them.",
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "A .plain file of the module" }),
      working_dir: WORKING_DIR_PARAM,
      frids: Type.Optional(Type.Array(Type.String(), { description: "The functional specs to test, by id - added to those chosen before. Omitted: every one" })),
      model: MODEL_PARAM,
      wait: WAIT_PARAM,
    }),
    async execute(_id, given, _signal, _onUpdate, ctx) {
      const params = fromWorkingDir(cwd, given);
      const plainFile = resolve(params.base, params.plain_file);
      const model = jobModel(ctx, "spec_changes", params.model, plainFile);
      const loop = workLoopFor(jobs, cwd, ctx);
      const statuses = await loop.conformance(plainFile, { ...(params.frids !== undefined ? { frids: params.frids } : {}), ...(model !== undefined ? { model } : {}) });
      return loopReply(loop, statuses, shouldWait(ctx.mode, params.wait));
    },
  });
}

function registerRegenerateFunctionality(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool({
    name: "regrow",
    label: "Regenerate functionality",
    description:
      "Build one functionality of a module again - its spec changed, or the user wants it redone as it is. It is " +
      "taken out of what the module's code is recorded as built from, and the module is brought up to its spec: the " +
      "functionality is built again, in the module's own codebase.",
    promptSnippet: "build a functionality again",
    promptGuidelines: [
      "A functionality whose spec changed is built again by itself once regrow is called: use regrow when the user wants one redone whose spec did not change. Never to get conformance tests: that is bind.",
      "When the user wants it to come out differently, change its spec first - the spec is what persists - then call regrow.",
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "Path to the .plain file" }),
      working_dir: WORKING_DIR_PARAM,
      frid: Type.String({ description: "The functionality's id" }),
      model: MODEL_PARAM,
      wait: WAIT_PARAM,
    }),
    async execute(_id, given, _signal, _onUpdate, ctx) {
      const params = fromWorkingDir(cwd, given);
      const model = jobModel(ctx, "functionalities", params.model, params.plain_file);
      const plainFile = resolve(params.base, params.plain_file);
      const loop = workLoopFor(jobs, cwd, ctx);
      const statuses = await loop.regenerate(plainFile, params.frid, model !== undefined ? { model } : {});
      return loopReply(loop, statuses, shouldWait(ctx.mode, params.wait));
    },
  });
}

function registerGlimpse(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool({
    name: "glimpse",
    label: "Glimpse the next job",
    description:
      "Plan the work of a module as regrow would, and show the job each codebase would start next and the whole " +
      "prompt its coding agent would get - starting nothing. A codebase with a job running is left out: what its next job " +
      "is given depends on what the running one lands.",
    promptSnippet: "glimpse: the next job of a module and its coding agent's whole prompt, starting nothing",
    promptGuidelines: [
      "Use glimpse when the user wants to see what a job will be told before it runs, or to check a plan before steering it with steer.",
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "Path to the .plain file" }),
      working_dir: WORKING_DIR_PARAM,
    }),
    async execute(_id, given, _signal, _onUpdate, ctx) {
      const params = fromWorkingDir(cwd, given);
      const plainFile = resolve(params.base, params.plain_file);
      const running = new Set(workLoopFor(jobs, cwd, ctx).status().filter((status) => status.running !== undefined).map((status) => status.module));
      const planner = chatModelOf(ctx);
      const model = modelFor(chosenModels, "spec_changes", projectModel(ctx, plainFile) ?? planner);
      const { statuses, previews, busy } = await previewJobs({
        plainFile,
        cwd,
        ...(model !== undefined ? { model } : {}),
        ...(planner !== undefined ? { plannerModel: planner } : {}),
        steering: (file) => steeringFor(file, cwd, steeringStore),
        busy: (module) => running.has(module),
      });
      const text = [
        describeModules(statuses),
        ...busy.map((module) => `\n${module} has a job running: its next job is planned from what that one lands - preview it once it has.`),
        ...previews.map((preview) =>
          [
            "",
            `<next job module="${preview.module}" track="${preview.track}" title="${preview.title}">`,
            preview.task ?? "A conformance job's prompt is built from what the code it tests holds once it is built: it is not shown before.",
            "</next job>",
          ].join("\n"),
        ),
        "",
        "Nothing was started. Tell the user what the next job is and what it will be told - the parts they are likely to care about, not the whole prompt unless they ask.",
      ].join("\n");
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });
}

function registerRejuvenate(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool({
    name: "rejuvenate",
    label: "Rejuvenate a codebase",
    description:
      "Start over the codebase of a module that now requires a module its code was not built on - a module the specs were " +
      "split into, say: its code and conformance tests are taken out, committed so its history keeps them, and the module " +
      "is built again from the bottom of its chain. Destructive: only once the user agreed.",
    promptSnippet: "rejuvenate a codebase: grow it again from the bottom of its chain, on a module it now requires",
    promptGuidelines: [
      "Only when a module's status says it has to be started over, and only after asking the user and telling them why: its code was built without the module it now requires, so no change to the code brings that module in. If they do not agree, leave it: nothing else is built there until it is.",
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "Path to the .plain file of the module whose status says to start it over" }),
      working_dir: WORKING_DIR_PARAM,
      model: MODEL_PARAM,
      wait: WAIT_PARAM,
    }),
    async execute(_id, given, _signal, _onUpdate, ctx) {
      const params = fromWorkingDir(cwd, given);
      const model = jobModel(ctx, "functionalities", params.model, params.plain_file);
      const plainFile = resolve(params.base, params.plain_file);
      const loop = workLoopFor(jobs, cwd, ctx);
      const statuses = await loop.startOver(plainFile, model !== undefined ? { model } : {});
      return loopReply(loop, statuses, shouldWait(ctx.mode, params.wait));
    },
  });
}

/** The config a spec is built with - its project's, with its module's own over it - or, with no spec, the session folder's. */
function configOf(plainFile?: string) {
  return plainFile !== undefined ? configForSpec(resolve(process.cwd(), plainFile)) : readProjectConfig(process.cwd());
}

/**
 * Whether renders write conformance tests, for the status bar - and why: the project's config.yaml
 * says so, or, where it says nothing, whether the module has the test reqs they are written from.
 * Nothing when there is no project here.
 */
export function conformanceStatus(root: string): string | undefined {
  const project = hasConfig(root)
    ? root
    : readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "plain_modules")
        .map((entry) => join(root, entry.name))
        .find(hasConfig);
  if (project === undefined) return undefined;
  const config = readProjectConfig(project);
  // Modules on stacks of their own may say otherwise: each as its config has it, when they differ.
  const modules = modulesWithConfig(project);
  const perModule = modules.map((module) => [module, readProjectConfig(project, module).conformanceTests] as const);
  if (perModule.some(([, on]) => on !== config.conformanceTests)) {
    const state = (on: boolean | "chosen" | undefined) => (on === false ? "off" : on === "chosen" ? "on for the chosen" : on === true ? "on" : "on with test reqs");
    return `conformance: ${perModule.map(([module, on]) => `${module} ${state(on)}`).join(", ")}`;
  }
  if (config.conformanceTests === false) return "conformance off (config.yaml)";
  if (config.conformanceTests === true) return "conformance on (config.yaml)";
  if (config.conformanceTests === "chosen") return "conformance on for the chosen (config.yaml)";
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
 * How many jobs the chat runs at once: TURRI_PARALLEL_JOBS, else `parallel-jobs:` in the session
 * folder's config.yaml, else what this machine's memory holds VMs for.
 */
export function parallelJobs(cwd: string): number {
  const fromEnv = Number(process.env.TURRI_PARALLEL_JOBS);
  if (Number.isInteger(fromEnv) && fromEnv >= 1) return fromEnv;
  return readProjectConfig(cwd).parallelJobs ?? defaultParallelJobs();
}

/** The project's own files and a digest of each - not plain_modules, dependencies, or turri's and git's folders. */
export function projectFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "plain_modules" || entry.name === "node_modules" || entry.name === "__pycache__") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile()) {
        try {
          files.set(relative(root, path), createHash("sha1").update(readFileSync(path)).digest("hex"));
        } catch {
          // A file that cannot be read is left out.
        }
      }
    }
  };
  walk(root, 0);
  return files;
}

/** The files added, changed or removed between two digests of the project. */
export function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = [...after].filter(([path, digest]) => before.get(path) !== digest).map(([path]) => path);
  const removed = [...before.keys()].filter((path) => !after.has(path)).map((path) => `${path} (removed)`);
  return [...changed, ...removed].sort();
}

/**
 * The sandbox VM, for the chat's agent, read afresh every turn: the image this project's VMs run and what
 * it holds, what goes into it and from where, what the project's implementation reqs need of it and it
 * lacks, and the project's extra packages. How to manage all of it is the managing-vms rule.
 */
export function sandboxBlock(cwd: string): string {
  const own = hasProjectImage(cwd);
  const image = vmImageFor(cwd);
  const built = readBuiltImage(own ? cwd : undefined);
  const plan = imagePlan(own ? { project: cwd } : {});
  const holding = built?.packages ?? plan.packages;
  const holds = (packages: string[]) => {
    const { toolchains, extra } = toolchainsOf(packages);
    return [...toolchains, ...extra].join(", ") || "only the basics";
  };
  const stack = stackAgainstImage(cwd, image !== undefined ? holding : []);
  const configured = readProjectConfig(cwd).systemPackages ?? [];
  const installed = installedPackages(modulesRoot(cwd));
  return [
    "<sandbox VM>",
    "The image the agents' VMs run (the managing-vms rule says how they work):",
    imageSources(undefined, plan).official
      ? `- Where it comes from: Alpine Linux ${imageSources().version}, from Alpine's own server - the base system and every package, from its main and community repositories (${imageSources().repositories.map((repository) => repository.url).join(", ")}); a mirror or other repositories can be set in the recipe. build_vm_image with plan: true lists each package a build downloads: its version, repository, project, licence and size, and what each toolchain costs.`
      : `- Where it comes from: Alpine Linux ${imageSources().version}, from the sources the recipe names in place of Alpine's own server - the base system and kernel from ${imageSources(undefined, plan).mirror}, packages from ${imageSources(undefined, plan).repositories.map((repository) => repository.url).join(", ")}; what a VM installs later comes from there too. build_vm_image with plan: true lists each package a build downloads, as those repositories have it.`,
    image === undefined
      ? `- In use: the ${STOCK_IMAGE.short}.`
      : image.own
        ? `- In use: this project's own image, ${image.tag}, holding ${holds(holding)}${built !== undefined ? ` (built ${built.builtAt.slice(0, 10)})` : ""}.`
        : `- In use: the default image, ${image.tag}, holding ${holds(holding)}${built !== undefined ? ` (built ${built.builtAt.slice(0, 10)})` : ""}${image.missing !== undefined ? ` - ${image.missing}` : ""}.`,
    `- Its recipe: ${describePlan(plan)}. turri's recipe (${join(PACKAGE_ROOT, "vm", "image.json")}), then the person's file ` +
      `${userImageFile()}${plan.file !== undefined ? "" : " (none yet)"}${own ? `, then this project's vm-image: in config.yaml` : ""}.`,
    ...(plan.refused.length > 0 ? [`- Not applied: ${plan.refused.join("; ")}.`] : []),
    ...(planDiffersFromBuilt(plan, built) || (own && image?.own !== true) ? ["- The recipe asks for something the image was not built with: it takes a build - build_vm_image."] : []),
    ...stack.map(({ module, needs, missing }) =>
      needs.length === 0
        ? `- ${module}: its implementation reqs name no toolchain this knows.`
        : `- ${module}: its implementation reqs need ${needs.map((need) => `${need.toolchain} (${need.words.join(", ")})`).join(", ")}${missing.length > 0 ? ` - the image LACKS ${missing.map((need) => `${need.toolchain} (Alpine: ${need.package})`).join(", ")}` : " - the image has them"}.`,
    ),
    `- Extra packages every VM of this project installs when it starts: system-packages: in config.yaml${configured.length > 0 ? ` - ${configured.join(", ")}` : " - none"}; the coding agents' install_system_packages${installed.length > 0 ? ` - ${installed.join(", ")}` : " - none"}.`,
    "</sandbox VM>",
  ].join("\n");
}

/** Whether a folder holds a project's config: config.yaml, or a module's own config.<module>.yaml. */
function hasConfig(dir: string): boolean {
  return existsSync(join(dir, CONFIG_FILE)) || modulesWithConfig(dir).length > 0;
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
    ...(hasConfig(root) ? [root] : []),
    ...readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "plain_modules")
      .map((entry) => join(root, entry.name))
      .filter(hasConfig),
  ];
  if (projects.length === 0) return "";

  const describe = (dir: string): string[] => {
    const modules = modulesWithConfig(dir);
    const where = dir === root ? "" : ` (paths relative to ${relative(root, dir)}/)`;
    const at = (name: string) => (dir === root ? name : `${relative(root, dir)}/${name}`);
    return [
      ...settings(
        readProjectConfig(dir),
        findTestScripts(dir),
        dir === root ? `${CONFIG_FILE}, for the specs here:` : `${relative(root, dir)}/${CONFIG_FILE}, for the specs in ${relative(root, dir)}/ - built in ${relative(root, dir)}/plain_modules:`,
        where,
        modules.length > 0 ? "project of modules" : "project",
      ),
      // A module on a stack of its own: its file over the project's, for it and the modules built on it.
      ...modules.flatMap((module) => {
        const plainFile = join(dir, `${module}.plain`);
        return [
          "",
          ...settings(
            readProjectConfig(dir, module),
            findTestScripts(dir, plainFile, join(dir, "plain_modules", module, "code")),
            `${at(moduleConfigFile(module))}, over ${CONFIG_FILE}, for ${module}.plain and the modules that require it - as they are built:`,
            where,
            "module",
          ),
        ];
      }),
    ];
  };

  const settings = (
    config: ReturnType<typeof readProjectConfig>,
    scripts: ReturnType<typeof findTestScripts>,
    heading: string,
    where: string,
    /** The project's file, and whether its modules have files of their own - whose scripts are theirs - or a module's. */
    of: "project" | "project of modules" | "module",
  ): string[] => {
    const perModule = of === "project of modules";
    return [
      heading,
      ...[
        config.module !== undefined && of !== "module" ? `- module: ${config.module}${where} - the module to build when the user does not name one.` : undefined,
        config.conformanceTests === false
          ? "- conformance-tests: false - conformance tests are OFF: renders write none and run none, unless the user asks for them in this conversation."
          : config.conformanceTests === "chosen"
            ? "- conformance-tests: chosen - conformance tests are on for the functional specs chosen: those with acceptance tests always, and those you choose with bind - when the work is planned, ahead of its code: what is planned lists what the code jobs add or change that has none, and a conformance job scheduled starts once every functional spec it names is built. Once chosen, a functional spec keeps them."
            : config.conformanceTests === true
            ? "- conformance-tests: all - conformance tests are on, for every functional spec of every module that has test reqs."
            : "- conformance-tests: not set - conformance tests are on for every module that has test reqs.",
        config.review === false
          ? "- review: false - the code and its tests are not reviewed: a job lands once its tests pass."
          : `- review: ${config.review === true ? "true" : "not set"} - the code and its tests are reviewed once they pass: two reviews at most, the arbiter weighing the second.`,
        ...(() => {
          // Each as it holds, with what it inherits: judge from coding, coding from harness.
          const models = projectModels(config);
          const shown = (choice: typeof models.coding) => modelSpec(choice) ?? "";
          return [
            models.coding !== undefined ? `- coding-model: ${shown(models.coding)}${config.codingModel === undefined ? " (from harness-model)" : ""} - what renders run on, unless engine chose another in this session.` : undefined,
            models.judge !== undefined ? `- judge-model: ${shown(models.judge)}${config.judgeModel === undefined ? " (from coding-model)" : ""} - the judge and the test review in a conformance run.` : undefined,
            models.harness !== undefined && of !== "module" ? `- harness-model: ${shown(models.harness)} - the model turri chat starts with.` : undefined,
          ];
        })(),
        `- unit testing script: ${scripts.unit !== undefined ? relative(root, scripts.unit) : perModule ? "none for the whole project - each module's file below names its own" : "none found - every build stops until there is one"}`,
        `- conformance testing script: ${scripts.conformance !== undefined ? relative(root, scripts.conformance) : perModule ? "none for the whole project - see each module's file" : "none found"}`,
        config.runTestingScriptsIn === "host"
          ? "- run-testing-scripts-in: host - the testing scripts run in place on this machine, from the project, against the host codebase - not in the sandbox VM."
          : "- run-testing-scripts-in: vm - the testing scripts run in each module's VM, on a fresh copy of its code; `run-testing-scripts-in: host` runs them on this machine instead, in place.",
      ].filter((line): line is string => line !== undefined),
    ];
  };

  return [
    `<project config>`,
    `A project's ${CONFIG_FILE} sets how its specs are built - and a module's own config.<module>.yaml, over it, how that module`,
    "and the ones built on it are: its stack's testing scripts, models and conformance. The render tools follow the one of the spec they build;",
    "answer questions about the project's settings from it, and say when a render will differ from it because the user",
    "asked. Name a spec by its path from here - plain/hubspot.plain - and it is built in its own project.",
    ...projects.flatMap((dir) => ["", ...describe(dir)]),
    `</project config>`,
  ].join("\n");
}

/** How the queue is to be planned, for the work this call queues - see render/steering.ts. */
const GUIDANCE_PARAM = Type.Optional(
  Type.String({
    description:
      "How to plan the queue for this work, in a sentence or two - which functional specs go together, what first - as " +
      "the user said it, or as you understood it. A strong preference for the planner, within its limits. Omit when there is none.",
  }),
);

const WORKING_DIR_PARAM = Type.Optional(
  Type.String({
    description:
      "The folder to render from, relative to where turri was started - as if it had been started there " +
      "(e.g. \"plain\"). plain_file, build_dir and a spec diff's paths are then relative to it - hubspot.plain, not " +
      "plain/hubspot.plain. Default: where " +
      "turri was started.",
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

const MODEL_PARAM = Type.Optional(
  Type.String({
    description:
      "The model for the agents of this one call: a provider/model-id, or its name as the user said it. " +
      "Omitted: the model chosen for this kind of work with engine, else the conversation's. " +
      "To change it for every later render, use engine instead.",
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
const MODEL_CHOICE_ENTRY = "turri_render_models";
/** The same, as sessions saved it before turri had its name. */
const LEGACY_MODEL_CHOICE_ENTRY = `${LEGACY_NAME}_render_models`;

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
 * The coding model this session starts from, and where it was given: `turri chat
 * --coding-model`, or `coding-model:` in the project's config.yaml - read afresh, so an edit to the
 * file holds for the next render.
 */
function codingModelDefault(plainFile?: string): { named: string; from: string } | undefined {
  const flag = process.env[CODING_MODEL_ENV]?.trim();
  if (flag) return { named: flag, from: "--coding-model" };
  // The coding model inherits what it leaves out from the harness model.
  const named = modelSpec(projectModels(configOf(plainFile)).coding);
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
 * engine, for the conversation's agent and for a skill's agent - whom the person talks
 * to while the skill runs - alike: both write the same choice. `conversation` is the context to
 * read models and the chat's model from; omitted, the one the tool is called with.
 */
function setRenderModelTool(pi: ExtensionAPI, conversation?: ExtensionContext) {
  return defineTool({
    name: "engine",
    label: "Engine",
    description:
      "The engine: which model the agents that grow the code run on. With no model, say which it is. With one, choose it " +
      "for the rest of this session: for spec changes " +
      "(render spec diff jobs, and the ones write_spec_diff queues), for functionalities (render, module, " +
      "regenerate, conformance), or for everything. By default " +
      "each runs on the model the project's config.yaml names, or else the conversation's model. The model may be given as provider/model-id or by name as " +
      "the user said it; a name that fits more than one model, or none with credentials, comes back as a " +
      "list - ask the user which they meant, never pick one yourself. Jobs already queued keep their model.",
    promptSnippet: "the engine: show or choose the model that grows the code",
    promptGuidelines: [
      "When the user says which model should grow or build something, call engine with it - once; it holds for the rest of the session. To say which one it is, call engine with no model.",
      "If engine returns several candidates, ask the user which one with ask_user or in your reply, then call it again with the exact provider/model-id.",
      "Say which model a render will run on when you start one on something other than the conversation's model.",
    ],
    parameters: Type.Object({
      work: Type.Optional(
        Type.Union([Type.Literal("spec_changes"), Type.Literal("functionalities"), Type.Literal("all")], {
          description: "spec_changes, functionalities, or all of it. Omitted: all",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: 'provider/model-id, or the model\'s name as the user said it. "chat" goes back to the conversation\'s model. Omitted: say which it is, changing nothing',
        }),
      ),
    }),
    async execute(_id, given, _signal, _onUpdate, called) {
      const ctx = conversation ?? called;
      if (given.model === undefined) {
        const text = `The engine:\n${describeChoices(chosenModels, chatModelOf(ctx), projectModelLabel(ctx))}`;
        return { content: [{ type: "text" as const, text }], details: { ...chosenModels } };
      }
      const params = { work: given.work ?? ("all" as const), model: given.model };
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
      const text = `The engine now:\n${describeChoices(chosenModels, chatModelOf(ctx), projectModelLabel(ctx))}`;
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
      .filter((entry) => entry.type === "custom" && [MODEL_CHOICE_ENTRY, LEGACY_MODEL_CHOICE_ENTRY].includes((entry as { customType?: string }).customType ?? ""))
      .at(-1) as { data?: ModelChoices } | undefined;
    Object.assign(chosenModels, saved?.data ?? {});
  });

  pi.registerTool(setRenderModelTool(pi));

  pi.registerCommand("engine", {
    description: "Show the engine: which model grows spec changes and functionalities. To change it, tell turri.",
    handler: async (_args, ctx) => {
      const text = `The engine:\n${describeChoices(chosenModels, chatModelOf(ctx), projectModelLabel(ctx))}\n\nTo change it, say so - e.g. "grow spec changes with gpt 5.5".`;
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
/** The one work loop of a conversation's jobs: every tool that builds brings its modules up through it. */
const workLoops = new WeakMap<JobRegistry, { loop: WorkLoop; from: { ctx: ExtensionContext } }>();

/** How the conversation wants the work planned, for the session - set with steer. */
const steeringStore = createSteeringStore();

function workLoopFor(jobs: JobRegistry, cwd: string, ctx: ExtensionContext): WorkLoop {
  let shared = workLoops.get(jobs);
  if (shared === undefined) {
    const from = { ctx };
    const loop = createWorkLoop({
      registry: jobs,
      cwd,
      modelFor: (plainFile) => modelFor(chosenModels, "spec_changes", projectModel(from.ctx, plainFile) ?? chatModelOf(from.ctx)),
      // The planner reasons about the whole of the work: it runs on the chat's model.
      plannerModel: () => chatModelOf(from.ctx),
      // How the work is to be planned: the conversation's steering, and AGENTS.md's - read afresh each plan.
      steering: (plainFile) => steeringFor(plainFile, cwd, steeringStore),
    });
    shared = { loop, from };
    workLoops.set(jobs, shared);
  }
  shared.from.ctx = ctx;
  return shared.loop;
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
          `Use growth with "${job.id}" if they ask how it is going.`,
      },
    ],
    details: { jobId: job.id, status: job.status },
  };
}

/** Looking in on work that is still running, and collecting what finished. */
function registerJobTools(pi: ExtensionAPI, jobs: JobRegistry, cwd: string) {
  pi.registerTool({
    name: "diagnose",
    label: "Diagnose a job",
    description:
      "Why a job did not land, from its whole transcript: how it ended and its diagnosis, the stages that went wrong, the " +
      "last failing test run with its output, the last review that sent the work back, and the tool calls that failed - " +
      "and where the whole log is.",
    promptSnippet: "diagnose: why a job did not land, from its transcript",
    promptGuidelines: ["When a job failed or did not land, call diagnose before you explain it or change the spec: go by what happened, not by the report alone."],
    parameters: Type.Object({ job_id: Type.String({ description: "The job's id" }) }),
    async execute(_id, params) {
      const job = jobs.get(params.job_id);
      if (job === undefined) return { content: [{ type: "text" as const, text: `No job ${params.job_id} has run in this session.` }], details: { status: "unknown" } };
      return { content: [{ type: "text" as const, text: whyFailed(job) }], details: { status: job.status as string } };
    },
  });

  pi.registerTool({
    name: "growth",
    label: "Growth",
    description:
      "What is growing: with no job, every job of this session - running, planned and finished - and what deploy started; " +
      "with a job's id, that job - whether it is still running, its latest output, and its report once it has finished.",
    promptSnippet: "growth: the jobs, or one job - what is growing and how it is going",
    parameters: Type.Object({
      job_id: Type.Optional(Type.String({ description: "The id returned when the job started. Omitted: every job" })),
      wait: Type.Optional(
        Type.Boolean({ description: "With a job: block until it finishes instead of reporting its current state" }),
      ),
    }),
    async execute(_id, params) {
      if (params.job_id === undefined) {
        return { content: [{ type: "text" as const, text: listJobs(jobs) }], details: { status: "all" } };
      }
      const existing = jobs.get(params.job_id);
      const planned = shownJobs(jobs).find((job) => job.id === params.job_id && jobs.get(job.id) === undefined);
      if (planned !== undefined) {
        return {
          content: [{ type: "text" as const, text: `${planned.id} · ${planned.summary}: ${planned.note ?? "planned, not started"}${planned.waitingOn.length > 0 ? ` It runs after ${planned.waitingOn.join(", ")}.` : ""}` }],
          details: { status: "planned" },
        };
      }
      if (existing === undefined) {
        const known = shownJobs(jobs).map((job) => job.id);
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

  // The panel is compact and ctrl+o only lasts as long as the work does. This is the whole
  // list, finished jobs included, put in the transcript where it stays.
  pi.registerTool({
    name: "halt",
    label: "Halt",
    description:
      "Halt a job, or what activate started. A job: a queued one never starts, a running one has its agent stopped at once, " +
      "and the jobs queued behind it move up - what a running job already changed is rolled back, and what it was growing " +
      "counts as not grown. What activate started: the one named, or every one.",
    promptSnippet: "halt a job, or what activate started",
    promptGuidelines: [
      "Halt a job only when the user asks. Name which one, and say which jobs were queued behind it - they will now run.",
    ],
    parameters: Type.Object({
      job_id: Type.Optional(Type.String({ description: "The job's id, or the start of it" })),
      activated: Type.Optional(Type.String({ description: 'What activate started, by name - or "all" for every one' })),
    }),
    async execute(_id, params) {
      if (params.job_id === undefined && params.activated === undefined) throw new Error("Say what to halt: a job_id, or what activate started (activated).");
      const lines: string[] = [];
      if (params.job_id !== undefined) lines.push(stopJob(jobs, params.job_id));
      if (params.activated !== undefined) {
        const stopped = await stopDeployed(params.activated === "all" ? {} : { name: params.activated });
        lines.push(stopped.length > 0 ? `Halted ${stopped.join(", ")}.` : `Nothing activate started is running${params.activated === "all" ? "" : ` as ${params.activated}`}.`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
    },
  });

  pi.registerCommand("halt", {
    description: "Halt a queued or running job, or what activate started: /halt [job id | activated <name>]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const live = jobs.list().filter((job) => job.status === "running" || job.status === "queued");
      const deployed = runningDeployed();
      let id = args.trim();
      if (id === "") {
        if (live.length === 0 && deployed.length === 0) return ctx.ui.notify("Nothing is growing or queued.", "info");
        const label = (job: Job) => `${job.id}  ${job.status.padEnd(8)} ${job.summary}`;
        const labels = [...live.map(label), ...deployed.map((item) => deployedLabel(item.name, item.url ?? item.command))];
        const picked = await ctx.ui.select("Halt which?", labels);
        const job = live.find((candidate) => picked !== undefined && label(candidate) === picked);
        const server = deployed.find((item) => picked !== undefined && deployedLabel(item.name, item.url ?? item.command) === picked);
        if (server !== undefined) id = `activated ${server.name}`;
        else if (job !== undefined) id = job.id;
        else return;
      }
      const name = /^(?:activated|deploy)\s+(.+)$/.exec(id)?.[1]?.trim();
      if (name !== undefined) {
        const stopped = await stopDeployed({ name });
        return ctx.ui.notify(stopped.length > 0 ? `Halted ${stopped.join(", ")}.` : `Nothing activate started is running as ${name}.`, "info");
      }
      ctx.ui.notify(stopJob(jobs, id), "info");
    },
  });

  // Debug mode, for the render agents started from now on - see debug-log.ts.
  // A module's history: every render, regeneration and conformance run, as git commits.
  pi.registerCommand("lineage", {
    description: "Show a module's lineage - every generation of its code and tests, and what each grew from: /lineage [module]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const modules = modulesWithHistory(cwd);
      let name = args.trim();
      if (name === "") {
        if (modules.length === 0) return ctx.ui.notify("No module has any history yet.", "info");
        name = modules.length === 1 ? modules[0]! : ((await ctx.ui.select("Lineage of which module?", modules)) ?? "");
        if (name === "") return;
      }
      pi.appendEntry(HISTORY_ENTRY, { module: name, text: historyLog(defaultBuildDir(name, cwd)) });
    },
  });

  pi.registerTool({
    name: "lineage",
    label: "Lineage",
    description:
      "Read a module's lineage: every generation of its code and tests - each regrowth, conformance run and spec change, " +
      "with what it grew from - as git commits. Without a commit, the log; with one, that commit in full - its message and " +
      "the change it made.",
    promptSnippet: "a module's lineage: what grew into it, and when",
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

  // The side panel: the job queue and the agents' traces - on the right,
  // beside the conversation. Alt+O opens it with the keyboard in it; esc goes back to the chat and
  // leaves it open and live; alt+O again takes the keyboard back to it, and closes it from there.
  let panel: { handle?: OverlayHandle; view: ReturnType<typeof createSidePanel>; close: () => void } | undefined;
  // What is open in the Jobs view, and where its cursor is: the conversation's, as it was left each time it opens.
  const jobsTree = createJobsTreeState();

  sidePanelShowing = () => panel !== undefined && panel.handle?.isHidden() !== true;

  const openPanel = (ctx: ExtensionContext, show?: { jobId?: string; view?: PanelView }) => {
    if (panel !== undefined) {
      if (show !== undefined) panel.view.show(show);
      panel.handle?.setHidden(false);
      panel.handle?.focus();
      return;
    }
    // Not awaited: the panel lives on while the person types in the conversation.
    void ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        const view = createSidePanel({
          jobs: () => shownJobs(jobs),
          jobId: show?.jobId,
          tree: jobsTree,
          rows: () => tui.terminal.rows,
          key: PANEL_KEY,
          style: {
            heading: (text) => theme.bold(theme.fg("accent", text)),
            muted: (text) => theme.fg("muted", text),
            accent: (text) => theme.fg("accent", text),
            error: (text) => theme.fg("error", text),
            added: (text) => theme.fg("toolDiffAdded", text),
            removed: (text) => theme.fg("toolDiffRemoved", text),
            // A spec diff's ***plain highlighted as plyn highlights it, and its added and removed lines filled.
            diff: plainPaint(theme),
          },
          back: () => {
            entry.handle?.unfocus();
            tui.requestRender();
          },
          close: () => done(undefined),
        });
        if (show?.view !== undefined) view.show(show);
        const entry: NonNullable<typeof panel> = { view, close: () => done(undefined) };
        panel = entry;
        // Jobs keep writing; redraw so the panel follows them while it shows.
        const timer = setInterval(() => {
          if (entry.handle?.isHidden() !== true) tui.requestRender();
        }, WATCH_REDRAW_MS);
        timer.unref?.();
        return {
          render: (width: number) => view.render(width),
          handleInput: (data: string) => {
            // The panel has the keys while focused, so its own key closes it from here.
            if (matchesKey(data, PANEL_KEY)) done(undefined);
            else view.handleInput(data);
            tui.requestRender();
          },
          handleMouse: (event: Parameters<NonNullable<ReturnType<typeof createSidePanel>["handleMouse"]>>[0]) => view.handleMouse(event),
          invalidate: () => view.invalidate(),
          dispose: () => {
            clearInterval(timer);
            if (panel === entry) panel = undefined;
          },
        };
      },
      {
        overlay: true,
        overlayOptions: { width: "50%", minWidth: 40, maxHeight: "100%", anchor: "top-right", margin: 0 },
        onHandle: (handle) => {
          if (panel !== undefined) panel.handle = handle;
        },
      },
    );
  };

  pi.registerCommand("watch", {
    description: "Read a background job's agents at work, in the side panel: /watch [job id]. Alt+O opens the panel; esc goes back to the chat.",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const job = await chooseJob(jobs, args.trim(), ctx.ui);
      if (job !== undefined) openPanel(ctx, { jobId: job.id, view: "trace" });
    },
  });

  pi.registerShortcut(PANEL_KEY, {
    description: "Open the side panel - the job queue and the agents' traces - or go back to it",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      openPanel(ctx);
    },
  });

  // An entry rather than a message, so it shows straight away even while a skill is
  // running - which is exactly when someone wants to know what the queue is doing.
  pi.registerCommand("growth", {
    description: "List every job: growing, planned and finished",
    handler: async () => {
      pi.appendEntry(JOBS_LIST_ENTRY, { text: listJobs(jobs) });
    },
  });
}

const WATCH_REDRAW_MS = 500;
/** Opens the side panel, and goes back to it from the conversation. */
const PANEL_KEY = "ctrl+j";

/** The modules in this project that have a history, by name. */
function modulesWithHistory(cwd: string): string[] {
  const root = join(cwd, "plain_modules");
  try {
    return readdirSync(root).filter((name) => existsSync(join(root, name, HISTORY_DIR)));
  } catch {
    return [];
  }
}

/** Stop a job by id or id prefix, and say what that means for the queue. */
function stopJob(jobs: JobRegistry, named: string): string {
  const matches = jobs.list().filter((job) => job.id.startsWith(named.trim()));
  if (matches.length === 0) return `No job ${named}. /growth lists them.`;
  if (matches.length > 1) return `'${named}' matches ${matches.map((job) => job.id).join(", ")}. Give more of the id.`;
  const target = matches[0]!;
  const behind = jobs.list().filter((job) => job.status === "queued" && job.waitingOn.includes(target.id));
  const stopped = jobs.stop(target.id);
  if (stopped === undefined) return `Job ${target.id} (${target.summary}) is already ${target.status}.`;
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
    if (found === undefined) ui.notify(`No job ${named}. /growth lists them.`, "warning");
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
/** What deploy started, as /halt offers it. */
function deployedLabel(name: string, what: string): string {
  return `deploy ${name}  running  ${what}`;
}

/** The jobs as the person is shown them: those started, and those the work loop has planned after them. */
function shownJobs(jobs: JobRegistry): Job[] {
  return [...(workLoops.get(jobs)?.loop.planned() ?? []), ...jobs.list()];
}

function listJobs(jobs: JobRegistry): string {
  const all = [...shownJobs(jobs)].reverse().filter((job) => job.replacedBy === undefined);
  const deployed = runningDeployed().map((item) => `deploy ${item.name}  running  ${item.moduleName}: ${item.url ?? item.command}  (pid ${item.pid}, output in ${relative(process.cwd(), item.log) || item.log})`);
  const listed = deployed.length > 0 ? `\n\nActivated from dist - /halt activated <name> halts one:\n${deployed.join("\n")}` : "";
  if (all.length === 0) return `No jobs have been started.${listed}`;
  return `${jobLines(all)}${listed}`;
}

function jobLines(all: Job[]): string {
  return all
    .map((job) => {
      // Planned by the work loop, not started: it has no job of the registry's yet.
      const planned = job.id.startsWith("planned-");
      const time = job.status === "queued" ? "waiting" : formatDuration(job);
      const after = job.status === "queued" && job.waitingOn.length > 0 ? `  (after ${job.waitingOn.join(", ")})` : "";
      const spent = describeUsage(job.usage);
      const model = job.model ? `  · ${job.model}` : "";
      return `${job.id}  ${(planned ? "planned" : job.status).padEnd(9)} ${time.padStart(7)}  ${job.kind}: ${job.summary}${model}${after}${spent ? `  · ${spent}` : ""}`;
    })
    .join("\n");
}


/** Building the sandbox VM image - the default one, or a project's own - from the chat, as a background job. */
function registerBuildVmImage(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool({
    name: "build_vm_image",
    label: "Build VM image",
    description:
      "Build a sandbox VM image from its recipe, as a background job: the default one - turri's recipe with the " +
      `person's changes from ${userImageFile()} - or, with scope "project", the project's own, from its config.yaml's ` +
      "vm-image: over that, under a tag of its own. Every VM started after it runs the new image; one already running " +
      "keeps the one it started with. About 7 minutes and 2 GB with every toolchain, less with fewer.",
    promptSnippet: "build the sandbox VM image - the default one, or the project's own",
    promptGuidelines: [
      "Write the recipe first - the person's image file, or the project's vm-image: in config.yaml - with the file tools, then build it with build_vm_image. Say what it will hold, and that it takes minutes, before you start it.",
    ],
    parameters: Type.Object({
      scope: Type.Union([Type.Literal("default"), Type.Literal("project")], {
        description: '"default": the image every project without one of its own runs. "project": this project\'s own, from vm-image: in its config.yaml',
      }),
      plan: Type.Optional(
        Type.Boolean({
          description:
            "Build nothing: say what a build would download and from where - Alpine Linux's own repositories - each package the " +
            "recipe names with its version, repository, project and licence, what each toolchain costs, and any name the " +
            "repositories do not have. Use it to show the person what they would get, before building.",
        }),
      ),
      working_dir: WORKING_DIR_PARAM,
      wait: WAIT_PARAM,
    }),
    async execute(_id, given, _signal, onUpdate, ctx) {
      const params = fromWorkingDir(cwd, given as { working_dir?: string } & typeof given);
      const project = (params as { base?: string }).base ?? cwd;
      if (params.scope === "project" && !hasProjectImage(project)) {
        throw new Error(`${join(project, "config.yaml")} has no vm-image: - write the project's image there first (packages, or add and remove).`);
      }
      if (params.plan === true) {
        const plan = imagePlan(params.scope === "project" ? { project } : {});
        const contents = await resolveImageContents(plan);
        const text = [`${params.scope === "project" ? projectImageTag(project) : "The default image"}: ${describePlan(plan)}.`, ...plan.refused.map((refused) => `Not applied: ${refused}`), "", ...describeContents(contents)].join("\n");
        return { content: [{ type: "text" as const, text }], details: { missing: contents.missing } };
      }
      return deliver(jobs, {
        kind: "build_vm_image",
        summary: params.scope === "project" ? `VM image for ${basename(project)}` : "default VM image",
        model: undefined,
        wait: params.wait,
        mode: ctx.mode,
        // One image build at a time: they share the builder and the image store.
        lanes: ["vm-image-build"],
        onUpdate,
        run: async (onDelta) => {
          const status = await buildVmImage({ ...(params.scope === "project" ? { project } : {}), write: onDelta });
          const plan = imagePlan(params.scope === "project" ? { project } : {});
          return {
            report:
              status === 0
                ? `Built ${params.scope === "project" ? projectImageTag(project) : "the default image"}: ${describePlan(plan)}. VMs started from now on run it.`
                : `The image did not build (exit ${status}); VMs keep the image they had. The output above says why.`,
            details: { passed: status === 0 },
          };
        },
      });
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
  pi.registerTool(checkPlainTool(cwd));
  pi.registerTool(chatAskUserTool());
  // The web, for the conversation too - a library's documentation, an API, an error; curl is its
  // bash. Run here, like the rendering agents' (see render/web.ts).
  for (const tool of createWebTools()) pi.registerTool(tool);
}

/**
 * Steering the queue from the conversation: how the person wants the work cut into jobs and ordered, for the whole
 * project or one module, kept for the session and given to the planner with every plan - beside
 * what the project's AGENTS.md says of the queue (see render/steering.ts).
 */
function registerSteering(pi: ExtensionAPI, cwd: string) {
  pi.registerTool({
    name: "steer",
    label: "Steer",
    description:
      "Say how the work is to be planned from now on - which functional specs grow together, what goes first, how " +
      "big a job may be - for the whole project, or one module: every plan after this follows it as a strong preference, " +
      "within the planner's limits, for the rest of the session. It changes nothing queued by itself: the next plan of the " +
      "module follows it - regrow makes one now. What the project's AGENTS.md says under a heading " +
      "naming the queue is followed too, with every plan.",
    promptSnippet: "steer how the work is planned, for the project or one module",
    promptGuidelines: [
      "When the user says how the work should be cut or ordered - 'build the batch worker's helpers with the worker', 'models first' - for more than one change, call steer with it in their words. For one change only, pass it as the guidance of regrow.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("add"), Type.Literal("set"), Type.Literal("clear"), Type.Literal("show")], {
        description: "add: one more wish; set: replace them all; clear: drop them; show: say what they are",
      }),
      text: Type.Optional(Type.String({ description: "The wish, in the user's words - for add and set" })),
      module: Type.Optional(Type.String({ description: "A module's .plain file or name. Omit: every module of the project" })),
    }),
    async execute(_id, params) {
      const scope = params.module !== undefined ? moduleNameOf(params.module) : EVERY_MODULE;
      const where = scope === EVERY_MODULE ? "every module" : scope;
      const text = params.text?.trim() ?? "";
      if ((params.action === "add" || params.action === "set") && text === "") throw new Error(`Say what to ${params.action}: text is empty.`);
      if (params.action === "add") steeringStore.set(scope, [...steeringStore.get(scope), text]);
      if (params.action === "set") steeringStore.set(scope, [text]);
      if (params.action === "clear") steeringStore.set(scope, []);
      const now = steeringStore.scopes().flatMap((key) => steeringStore.get(key).map((wish) => `- ${key === EVERY_MODULE ? "every module" : key}: ${wish}`));
      const agents = existsSync(join(cwd, "AGENTS.md")) ? queueSectionOf(readFileSync(join(cwd, "AGENTS.md"), "utf8")) : "";
      return {
        content: [
          {
            type: "text" as const,
            text: [
              params.action === "show" ? "How the work is planned:" : `${params.action === "clear" ? "Cleared" : "Noted"} for ${where}. How the work is planned now:`,
              ...(now.length > 0 ? now : ["- (nothing from the conversation)"]),
              ...(agents !== "" ? ["", "And from AGENTS.md, every plan:", agents] : []),
              "",
              "The next plan of each module follows it; nothing planned changes until then.",
            ].join("\n"),
          },
        ],
        details: { scope, steering: now },
      };
    },
  });
}

/**
 * Deploy: the conversation puts what is built out in dist/<module> and starts it on this machine (see
 * render/deploy.ts). Once something is deployed, the conversation's shell installs nothing: a command
 * that would is refused, and goes to the person through propose_setup instead. What it started is
 * stopped when the session ends.
 */
function registerDeploy(pi: ExtensionAPI, cwd: string) {
  const state = createDeployState();
  const tools = createDeployTools({
    cwd,
    state,
    approve: async (title, body, ctx) => {
      const ui = ctx as { hasUI?: boolean; ui?: { confirm(title: string, message: string): Promise<boolean> } } | undefined;
      return ui?.hasUI === true && ui.ui !== undefined ? ui.ui.confirm(title, body) : undefined;
    },
    defaultPlainFile: () => readProjectConfig(cwd).module,
  });
  // The conversation's halt stops jobs too: it is registered with the job tools, and stops what activate started as well.
  for (const tool of tools) if (tool.name !== "halt") pi.registerTool(tool);
  pi.on("tool_call", (event) => {
    if (state.current === undefined || event.toolName !== "bash") return undefined;
    const command = (event.input as { command?: unknown }).command;
    const refused = typeof command === "string" ? refuseInstall(command) : undefined;
    return refused !== undefined ? { block: true, reason: refused } : undefined;
  });
  pi.on("session_shutdown", async () => {
    await stopDeployed();
  });
}

/** validate, for the conversation and for the skills that write specs alike. */
function checkPlainTool(cwd: string) {
  return defineTool({
    name: "validate",
    label: "Validate spec",
    description:
      "Validate one or more .plain specifications without rendering: parses each file, resolves its " +
      "imports and required modules, and reports every syntax, concept and structure error with the " +
      "line it is on. Pass a directory to check every .plain file in it. Fast, free, and offline.",
    promptSnippet: "validate a .plain spec, growing nothing",
    promptGuidelines: [
      "Run validate after editing a .plain file, and before telling the user a spec is valid or ready. Never shell out to another renderer to check one.",
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


const MILESTONE_ENTRY = "turri_milestone";
const JOB_ENTRY = "turri_job";
const JOBS_LIST_ENTRY = "turri_jobs";
const HISTORY_ENTRY = "turri_history";

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
          ? (job.note ?? "Stopped on request. Whatever it changed before it stopped is still on disk; the functionality it was on counts as not built.")
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
    "1. Run the analyze-2-func-specs skill (cultivate) on these two functional specs, to confirm they conflict.",
    "2. If they do, run the resolve-spec-conflict skill on the pair, to work out what could be changed - but change nothing yet.",
    "3. Tell the user exactly what the conflict is - both specs as they read, and the behaviour that cannot satisfy both -",
    "   and put the decision to them with ask_user: the ways out resolve-spec-conflict found, and Something else. Suggest they",
    "   simply decide which is meant; it is their call, not yours.",
    "4. Only once they have decided, make the change they chose to the .plain file it belongs in - either module's -",
    "   and regrow it - its conformance tests follow it.",
    "If analyze-2-func-specs finds the two compatible, tell the user so, and that the conformance tests of these two are what",
    "kept failing - offer to bind them again.",
  ].join("\n");
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


const BANNER_ENTRY = "turri_banner";

/**
 * The name on the door.
 *
 * Pi's own startup header is a built-in component an extension cannot replace, so this
 * adds a wordmark of its own at the top of the session. `turri chat` starts pi without
 * its header (see pi-launch.ts), leaving only this one.
 */
/**
 * The ***plain rules as the conversation has them in its system prompt, every turn - the standard library's
 * inventory among them, in its rule, so the conversation knows what a spec can import from the start.
 */
export function chatRulesBlock(rules = loadRules(join(PACKAGE_ROOT, "forge", "rules"))): string {
  return renderRulesBlock(rules);
}

/** Who the conversation's agent is: turri, and what it does - first, so it is how the agent speaks of itself. */
export const TURRI_IDENTITY = [
  "<turri>",
  "You are turri - always lowercase - a regenerative software harness. The software is its ***plain spec; the code is",
  "what grows from it. You help the user write and change the spec, and turri regrows the code from it a change at a",
  "time - with agents that write the code and tests, while turri decides what runs next and when the work is done -",
  "records what each piece grew from, and proves it against conformance tests written from the spec alone. When the",
  "code goes bad, it is grown again from the spec. Named after Turritopsis dohrnii, the immortal jellyfish, which",
  "turns back into its young self and grows again. Speak of yourself as turri.",
  "</turri>",
].join("\n");

function registerBranding(
  pi: ExtensionAPI,
  ruleCount: number,
  skills: { skills: Skill[]; pending: string[] },
) {
  pi.registerCommand("stdlib", {
    description: "List the ***plain standard library: the stacks a spec can import instead of writing its implementation reqs.",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(describeStdlib(), "info");
    },
  });

  pi.registerEntryRenderer(BANNER_ENTRY, (entry, _options, theme) => {
    const data = entry.data as
      | {
          version: string;
          rules: number;
          skills: number;
          pending: number;
          stdlib?: number;
          cwd: string;
          sandbox?: ReturnType<typeof vmSummary>;
        }
      | undefined;
    if (data === undefined) return undefined;

    const lines = [
      `${theme.fg("accent", "turri")}  ${theme.fg("muted", `v${data.version}`)}`,
      theme.fg("text", "regenerative software - the code grows back from the spec"),
      theme.fg(
        "muted",
        `${data.rules} rules · ${data.skills} skill${data.skills === 1 ? "" : "s"}` +
          (data.stdlib !== undefined && data.stdlib > 0 ? ` · ${data.stdlib} stdlib stacks (/stdlib)` : "") +
          (data.pending > 0 ? theme.fg("warning", `  (${data.pending} failed to load)`) : ""),
      ),
      theme.fg("dim", data.cwd),
      // Where every command an agent runs will run - or that none can.
      ...(data.sandbox
        ? [theme.fg(data.sandbox.level === "ok" ? "dim" : data.sandbox.level === "limited" ? "warning" : "error", data.sandbox.text)]
        : []),
    ];
    // The jellyfish turri is named after, in ink for the theme's background: a picture where the
    // terminal shows images, drawn in text where it does not.
    return new Banner(lines, (rule) => theme.fg("borderMuted", rule), jellyfishArt(theme.appearance, (art) => theme.fg("text", art)));
  });

  pi.on("session_start", (_event, ctx) => {
    // Only the picture moves; the jellyfish drawn in text is still.
    if (ctx.hasUI && getCapabilities().images !== null) animateJellyfish(ctx);
    try {
      pi.appendEntry(BANNER_ENTRY, {
        version: packageVersion(),
        rules: ruleCount,
        skills: skills.skills.length,
        pending: skills.pending.length,
        stdlib: stdlibStackCount(),
        cwd: ctx.cwd,
        sandbox: vmSummary(),
      });
    } catch {
      // Branding is the least important thing here; never let it stop a session starting.
    }
  });
}

/** How many rows the banner's jellyfish takes: taller than the lines beside it. */
const JELLYFISH_ROWS = 13;

/** How long each frame of the jellyfish shows. */
const JELLYFISH_FRAME_MS = 250;

/** Which frame of the jellyfish every banner shows, moved on by `animateJellyfish`. */
let jellyfishFrame = 0;
let jellyfishTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Moves the jellyfish on a frame every JELLYFISH_FRAME_MS while the banner is on the screen. An entry's
 * renderer is given no TUI to redraw, so an empty widget below the editor - which pi gives no
 * spacer - hands it over. Once the conversation outgrows the screen the banner has scrolled off,
 * and a line changing up there would have pi-tui clear and redraw everything, frame after frame: the
 * jellyfish stops on the frame it is at, for the rest of the session.
 */
function animateJellyfish(ctx: ExtensionContext): void {
  if (jellyfishTimer !== undefined) clearInterval(jellyfishTimer);
  jellyfishTimer = undefined;
  ctx.ui.setWidget(
    JELLYFISH_CLOCK_KEY,
    (tui) => {
      const timer = setInterval(() => {
        // The panel covers the jellyfish, and the banner leaves it out meanwhile.
        if (sidePanelShowing()) return;
        if (tui.render(tui.terminal.columns).length > tui.terminal.rows) {
          clearInterval(timer);
          return;
        }
        jellyfishFrame++;
        tui.requestRender();
      }, JELLYFISH_FRAME_MS);
      timer.unref?.();
      jellyfishTimer = timer;
      return {
        render: () => [],
        invalidate: () => {},
        dispose: () => clearInterval(timer),
      };
    },
    { placement: "belowEditor" },
  );
}

const JELLYFISH_CLOCK_KEY = "turri-jellyfish";

/** Columns between the jellyfish and the lines beside it. */
const JELLYFISH_GAP = 3;

/** The fewest columns the lines keep beside the jellyfish; a terminal narrower than that gets the lines alone. */
const BANNER_TEXT_MIN = 30;

/**
 * The banner: the jellyfish on the left at the frame `animateJellyfish` has it on, its lines beside it in
 * the middle of its height, and a rule the width of the terminal under them both.
 *
 * pi-tui writes a line holding an image as it is. So the picture goes on one of the rows after that
 * row's text: back to the jellyfish's column (`CSI G`), then the image's escape sequence. Kitty places
 * the image there without moving the cursor, from the first row; iTerm2 moves the cursor past what it
 * draws, so it goes on the last row and climbs back up to start, as pi-tui's Image does.
 */
class Banner implements Component {
  private readonly lines: string[];
  private readonly rule: (text: string) => string;
  private readonly art: JellyfishArt | undefined;
  private kittyImageId: number | undefined;

  /** Without `art` the banner is its lines alone. */
  constructor(lines: string[], rule: (text: string) => string, art: JellyfishArt | undefined) {
    this.lines = lines;
    this.rule = rule;
    this.art = art;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const art = this.art;
    const placed =
      art?.kind === "image" ? this.placeImage(art, Math.max(JELLYFISH_ROWS, this.lines.length), width - 2 - JELLYFISH_GAP - BANNER_TEXT_MIN) : art?.kind === "text" && art.columns <= width - 2 - JELLYFISH_GAP - BANNER_TEXT_MIN ? art : undefined;
    const left = placed !== undefined ? 1 + placed.columns + JELLYFISH_GAP : 1;
    const text = this.lines.map((line) => truncateToWidth(line, Math.max(1, width - 1 - left)));
    const height = Math.max(text.length, placed?.rows ?? 0);
    const above = Math.floor((height - text.length) / 2);
    const rows = Array.from({ length: height }, (_, row) => {
      const line = text[row - above];
      const jellyfish = placed?.kind === "text" ? (placed.lines[row] ?? " ".repeat(placed.columns)) : " ".repeat(placed?.columns ?? 0);
      const before = placed !== undefined ? ` ${jellyfish}${" ".repeat(JELLYFISH_GAP)}` : " ";
      return line !== undefined ? `${before}${line}` : placed?.kind === "text" ? ` ${jellyfish}` : "";
    });
    // Under the side panel the picture is left out: pi-tui draws no overlay over a line holding an image.
    // Its rows are kept, so the conversation does not move when the panel opens or closes.
    if (placed?.kind === "image" && !sidePanelShowing()) {
      const at = placed.onLastRow ? placed.rows - 1 : 0;
      rows[at] = `${rows[at]}\x1b[2G${placed.sequence}`;
    }
    return [...rows, ` ${this.rule("─".repeat(inner))}`];
  }

  private placeImage(
    art: Extract<JellyfishArt, { kind: "image" }>,
    rows: number,
    room: number,
  ): { kind: "image"; sequence: string; columns: number; rows: number; onLastRow: boolean } | undefined {
    if (room < 4) return undefined;
    const kitty = getCapabilities().images === "kitty";
    if (kitty && this.kittyImageId === undefined) this.kittyImageId = allocateImageId();
    const result = renderImage(art.frames[jellyfishFrame % art.frames.length]!, art.dimensions, {
      maxWidthCells: room,
      maxHeightCells: rows,
      imageId: this.kittyImageId,
      moveCursor: false,
    });
    if (result === null || result.columns > room) return undefined;
    const sequence = kitty ? result.sequence : `${result.rows > 1 ? `\x1b[${result.rows - 1}A` : ""}${result.sequence}`;
    return { kind: "image", sequence, columns: result.columns, rows: result.rows, onLastRow: !kitty };
  }
}

/**
 * The jellyfish as the banner draws it: frames of a picture, for a terminal that shows images, or one
 * drawn in text (`assets/jellyfish/fallback.txt`), for one that does not.
 */
type JellyfishArt =
  | { kind: "image"; frames: string[]; dimensions: ImageDimensions }
  | { kind: "text"; lines: string[]; columns: number; rows: number };

/**
 * Whether the side panel is showing. An overlay is not drawn over a line holding an image - pi-tui leaves
 * such a line as it is - so the banner leaves the picture out meanwhile.
 */
let sidePanelShowing: () => boolean = () => false;

const jellyfishFrameCache = new Map<string, string[]>();

/**
 * The banner's jellyfish for this terminal: where it shows images, the picture's frames spread evenly
 * over the video, light ink for a dark background and dark ink for a light one; where it does not, the
 * jellyfish drawn in text, in `ink`. None when they cannot be read.
 */
function jellyfishArt(appearance: "dark" | "light", ink: (text: string) => string): JellyfishArt | undefined {
  const dir = join(PACKAGE_ROOT, "assets", "jellyfish");
  try {
    if (getCapabilities().images === null) {
      const drawn = readFileSync(join(dir, "fallback.txt"), "utf8").replace(/\n+$/, "").split("\n");
      const columns = drawn.reduce((widest, line) => Math.max(widest, visibleWidth(line)), 0);
      return { kind: "text", lines: drawn.map((line) => ink(line.padEnd(columns))), columns, rows: drawn.length };
    }
    let frames = jellyfishFrameCache.get(appearance);
    if (frames === undefined) {
      frames = readdirSync(dir)
        .filter((name) => name.startsWith(`${appearance}-`) && name.endsWith(".png"))
        .sort()
        .map((name) => readFileSync(join(dir, name)).toString("base64"));
      jellyfishFrameCache.set(appearance, frames);
    }
    const dimensions = frames.length > 0 ? getPngDimensions(frames[0]!) : null;
    return dimensions !== null ? { kind: "image", frames, dimensions } : undefined;
  } catch {
    return undefined;
  }
}

function packageVersion(): string {
  try {
    const raw = readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
