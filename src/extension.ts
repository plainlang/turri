// Whether the terminal shows images, before anything draws: the banner's jellyfish is a picture or text.
import "./terminal-images.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { conversationCommand, conversationSettled, conversationWriting } from "./regenerate/conversation-writes.ts";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { allocateImageId, Box, type Component, getCapabilities, getPngDimensions, type ImageDimensions, isKeyRelease, isKeyRepeat, matchesKey, renderImage, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CODING_MODEL_ENV } from "./chat-models.ts";
import { AGENT_ROLES, chosenStack, CONFIG_FILE, configForSpec, hasProjectConfig, LEGACY_CONFIG_FILE, projectConfigFile, stackConfigFileIn, stackOf, stacksOf, withStack, modelOnly, modelSpec, projectModels, readProjectConfig, roleModel, splitModelSpec } from "./config.ts";
import { modulesRoot, skillRunDir } from "./regenerate/paths.ts";
import { sweepOrphanedGroups } from "./regenerate/shell.ts";
import { readScript, scriptAgainstMachine, stackOnMachine, toolchainsBlock } from "./stack.ts";
import { sandboxAvailable, sandboxSummary } from "./regenerate/os-sandbox.ts";
import { findTestScripts } from "./regenerate/test-scripts.ts";
import { createAskUserTool } from "./tools.ts";
import { asksFromScratch, driftTool, fromWorkingDir, haltTool, loopReply, MODEL_PARAM, regenerateTool, stopJob, WAIT_PARAM, WORKING_DIR_PARAM } from "./loop-tools.ts";
import { createWebTools } from "./regenerate/web.ts";
import { describeGates, interruptedRun, runSkill } from "./genome.ts";
import type { Reporter } from "./graph.ts";
import { loadSkill, skillStatus, type Skill } from "./skill.ts";
import { runningDeployed, stopDeployed } from "./regenerate/release.ts";
import { createDeployState, createDeployTools, type DeployState } from "./release-tools.ts";
import { runReleaseAgent } from "./release-agent.ts";
import { createSteeringStore, EVERY_MODULE, moduleNameOf, queueSectionOf, steeringFor } from "./regenerate/steer.ts";
import { askedForCommandLine, refusal, selfInvocation, TOOLS_NOT_CLI } from "./self-invocation.ts";
import { describeChoices, describeResolution, type ModelChoices, modelFor, type RenderWork, resolveModel } from "./regenerate/engine.ts";
import { checkPlainFile, checkPlainTargets, formatCheckResults } from "./plain/check.ts";
import { whyFailed } from "./regenerate/diagnose-job.ts";
import { createWorkLoop, describeModules, isUpToDate, previewJobs, type WorkLoop } from "./regenerate/loop.ts";
import { brandBlue, plainPaint } from "./regenerate/plain-palette.ts";
import { createJobPanel, didNotPass, keyPressed, PANEL_KEY, spinner } from "./regenerate/job-panel.ts";
import { clickToFocus, dockedWidth, narrowChat, shade, shadeChat } from "./regenerate/panel-dock.ts";
import { overPictureRow, PICTURE_AT } from "./picture-row.ts";
import { skillAboutLine, skillProgressLine } from "./skill-progress.ts";
import { createSidePanel } from "./regenerate/side-panel.ts";
import { createSpecMapSource, defaultMapFiles } from "./regenerate/spec-map.ts";
import { createSpecMapState } from "./regenerate/spec-map-view.ts";
import { createJobsTreeState, selectJob } from "./regenerate/jobs-tree.ts";
import { describeDiagnosis, diagnoseFailure } from "./regenerate/diagnose.ts";
import { HISTORY_DIR, historyLog, historyShow } from "./regenerate/lineage.ts";
import { defaultBuildDir } from "./regenerate/paths.ts";
import { describeUsage, type SpecConflict } from "./regenerate/activity.ts";
import { describeSpecConflict } from "./regenerate/stop-report.ts";
import { inheritProviders, inheritThinkingLevel } from "./pi.ts";
import { beginCapture, captureConsole, describeCaptured, dropNoise } from "./quiet.ts";
import { loadRules, renderRulesBlock } from "./rules.ts";
import { registerTurriConfig } from "./config-command.ts";
import { describeStdlib, stdlibStackCount } from "./stdlib.ts";
import { peekKeyListener, runAsk, type AskUser, type AskUserRequest } from "./ask.ts";
import { QuestionDialog } from "./question-dialog.ts";
import { registerStacks } from "./stacks.ts";
import { catalogueLine, discoverSkills, leftOutNote, type SkillCatalogue } from "./skills.ts";
import { supersededByTurri } from "./chat-skills.ts";
import { TURRI_IDENTITY } from "./identity.ts";
import { turriIdentity } from "./environment.ts";
import { conformanceChooser } from "./regenerate/choose-conformance.ts";
import { answerSideQuestion, askWithAsides, BTW_HOW, runningSkill, skillRunStarted, skillSessionText, transcriptOf } from "./btw.ts";
import {
  createJobRegistry,
  defaultParallelJobs,
  describeJob,
  formatDuration,
  pulseName,
  shouldWait,
  STOPPED_ON_REQUEST,
  type Job,
  type JobOutcome,
  type JobRegistry,
} from "./regenerate/jobs.ts";

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
 * Puts a skill step's question to the person, when there is one to ask.
 *
 * A skill runs inside one tool call, in its own session, so its dialogs are not
 * conversation turns and nothing it asks would otherwise reach the transcript. Every
 * exchange is therefore reported back, so the interview is visible while it happens and
 * survives in the tool's result afterwards.
 */
export function askUserVia(
  ctx: ExtensionContext,
  onExchange: (question: string, answer: string, said?: string) => void,
  /** Given, "/btw ..." typed as an answer is a side question: answered with this, and the question asked again. */
  aside?: (question: string) => Promise<string>,
): AskUser {
  return async (request) => {
    if (!ctx.hasUI) {
      return "No user is available to answer. Decide yourself, and say in your report what you assumed.";
    }

    ctx.ui.setWorkingMessage("waiting for your answer");
    // The question has the keys: ctrl+h is caught here, or it would never reach the shortcut, which only the chat's editor sees.
    const unhook = hookPeekKey(ctx);
    try {
      // The question, with what the asker gives to read for it - a brief to confirm - above it; what it said of its work
      // before asking is kept in its record, never put in the dialog.
      // A dialog of turri's own: a long brief scrolls above the question, and the options always show (question-dialog.ts).
      const dialog = (question: string, context: string | undefined, options?: string[]) =>
        ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
          const shown: QuestionDialog = new QuestionDialog({
            question,
            ...(context !== undefined ? { context } : {}),
            ...(options !== undefined ? { options } : {}),
            rows: () => tui.terminal.rows,
            style: { accent: (text) => theme.fg("accent", text), muted: (text) => theme.fg("muted", text), bold: (text) => theme.bold(text) },
            done: (answer) => {
              if (questionShown === shown) questionShown = undefined;
              done(answer);
            },
            requestRender: () => tui.requestRender(),
          });
          questionShown = shown;
          return shown;
        });
      const asking: AskUser = (asked) =>
        runAsk(asked, {
          select: (title, options, context) => dialog(title, context, options),
          input: (title, context) => dialog(title, context),
        });
      const bare: AskUserRequest = { ...request, said: undefined };
      const answer = aside !== undefined ? await askWithAsides(bare, asking, aside) : await asking(bare);
      // Kept: what was shown with it, and what it said before it.
      onExchange(request.question, answer, [request.context, request.said].map((part) => part?.trim() ?? "").filter((part) => part !== "").join("\n\n") || undefined);
      return answer;
    } finally {
      unhook();
      ctx.ui.setWorkingMessage();
    }
  };
}

/** The side panel, as a question open in the chat reaches it: set once the extension has its panel. */
let questionPeek:
  | {
      open(ctx: ExtensionContext): void;
      /** It shows now: its own listener has the keys, ctrl+h among them. */
      shown(): boolean;
    }
  | undefined;

/**
 * The question open in the chat now, if any. The side panel gives the keys back to it: pi would give them to what had the
 * focus when the panel first opened, and a panel kept beside the chat outlives that question - the keys would go to a
 * dialog already answered, and nothing would take them.
 */
let questionShown: Component | undefined;

/** A widget with nothing to draw: below the editor, it takes no line. */
const PEEK_KEY_WIDGET = "turri-peek-key";

/**
 * While a question is open, ctrl+h opens the side panel over it - the question waits under it. pi gives an extension's
 * shortcut only the keys its editor sees, and a question has the focus: the key is caught on the terminal's input
 * instead. While the panel shows, its own listener has ctrl+h - to close it - and this lets it be.
 */
function hookPeekKey(ctx: ExtensionContext): () => void {
  if (questionPeek === undefined) return () => {};
  const peek = questionPeek;
  ctx.ui.setWidget(
    PEEK_KEY_WIDGET,
    (tui) => {
      const unlisten = tui.addInputListener(peekKeyListener({ open: () => peek.open(ctx), shown: () => peek.shown() }));
      return { render: () => [], invalidate() {}, dispose: unlisten };
    },
    { placement: "belowEditor" },
  );
  return () => ctx.ui.setWidget(PEEK_KEY_WIDGET, undefined);
}

/**
 * ask_user, for the conversation's agent too - the same dialog a skill's interview uses: options to
 * pick from, several at once, "Something else…" to type instead, "Chat about this" to talk it over in
 * the chat first - so a question with a handful of answers is picked, not typed.
 */
export function chatAskUserTool() {
  let conversation: ExtensionContext | undefined;
  const tool = createAskUserTool(
    (request) => (conversation !== undefined ? askUserVia(conversation, () => {})(request) : Promise.resolve("No user is available to answer.")),
    undefined,
    undefined,
    undefined,
    "reply",
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
  // turri's own skills, and the project's - .turri/skills, .agents/skills (skills.ts).
  const discoveredSkills = discoverSkills(PACKAGE_ROOT, cwd);

  // What the background work is doing right now, drawn above the editor while it runs.
  const panel = createJobPanel(() => shownJobs(jobs));

  // Finished work is announced twice, to two audiences, because pi treats them differently.
  // An entry is drawn the moment it is appended: the person sees the job end, now. The agent
  // gets the full report as a hidden message that starts a turn of its own - at once when it is
  // idle, else as soon as the turn it is in ends (a follow-up, never cutting into a reply or an
  // interview) - so it reacts to every job that ends without waiting for the person to speak:
  // does what the project's guidance says to do then (release what was built, say), or says
  // what finished.
  // What release has shipped, module by module: release does nothing for a module whose last commit it already shipped.
  const deployState = createDeployState();
  const jobs: JobRegistry = createJobRegistry({
    // The loop's plan changed - a module being planned, or planned: the live panel shows it at once.
    onNotify: () => panel.refresh(),
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
        // The coding model the job ran on - its model alone: the diagnosis thinks as its role has it.
        model: modelSpec(modelOnly(job.model ?? modelSpec(projectModels(readProjectConfig(cwd)).coding))),
      });
      return diagnosis !== undefined ? describeDiagnosis(diagnosis) : undefined;
    },
    onChange: () => panel.refresh(),
    onFinish: (job) => {
      panel.refresh();
      // Queued again as another job: that one says how it went.
      if (job.replacedBy !== undefined) return;
      announceJob(pi, job);
      // Gone wrong: the next ctrl+h opens on it - the live panel that showed it is gone with the last pulse.
      if (job.status === "failed" || job.status === "stopped" || didNotPass(job)) needsLooking.set(jobs, job.id);
      // A spec that contradicts itself is the person's to settle, now: the agent is started on it.
      if (job.specConflict !== undefined) {
        void pi.sendMessage(
          { customType: "turri_spec_conflict", content: specConflictTask(job.specConflict), display: false, details: { jobId: job.id } },
          { triggerTurn: true },
        );
        return;
      }
      void pi.sendMessage(
        {
          customType: "turri_job",
          content:
            (job.status === "succeeded"
              ? `Pulse ${job.id} (${job.kind}) finished after ${formatDuration(job)}.\n\n${job.report ?? ""}`
              : job.status === "stopped"
                ? `Pulse ${job.id} (${job.kind}) was stopped after ${formatDuration(job)}. ${job.error ?? STOPPED_ON_REQUEST}${job.error === undefined || job.error === STOPPED_ON_REQUEST ? " The person stopped it; what it was building counts as not built." : ""}`
                : `Pulse ${job.id} (${job.kind}) failed after ${formatDuration(job)}.\n\n${job.error ?? ""}`) +
            `\n\n${JOB_FINISHED_REACTION}`,
          display: false,
          details: { jobId: job.id, status: job.status },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  });

  // The ***plain rules go into the system prompt in full, every turn. The block is
  // identical each time, so it sits inside the cached prefix rather than invalidating it.
  // With them, the instruction to do turri's work with its tools rather than its command
  // line - enforced below, not only asked for.
  const rules = loadRules(join(PACKAGE_ROOT, "genome", "rules"), readProjectConfig(cwd).rulesOff ?? []);
  // Laid out again once rules-off changes - /turri-config changes it as turri runs - and the same block in between.
  let rulesKept = { off: (readProjectConfig(cwd).rulesOff ?? []).join(","), block: chatRulesBlock(rules) };
  const rulesBlock = (): string => {
    const off = readProjectConfig(cwd).rulesOff ?? [];
    if (off.join(",") !== rulesKept.off) rulesKept = { off: off.join(","), block: chatRulesBlock(loadRules(join(PACKAGE_ROOT, "genome", "rules"), off)) };
    return rulesKept.block;
  };
  // What the project's config.turri.yaml says, read afresh every turn: the agent answers from it, and
  // the tools default to it.
  // pi's skills that turri has already - its own and the project's, run with cultivate, and any about ***plain from
  // another tool - are left out of the list the conversation is offered (chat-skills.ts); the person is told once.
  const turriRuns = new Set(discoveredSkills.skills.map((skill) => skill.name));
  // What the modules need of this machine: worked out once the chat is up, and after a turn when a spec changed - never
  // while a message waits to be sent.
  const machine = machineNeeds(cwd);
  pi.on("session_start", () => machine.refreshSoon());
  pi.on("agent_settled", () => machine.refreshSoon());
  let leftOutSaid = false;
  pi.on("before_agent_start", (event, ctx) => {
    const offered = event.systemPromptOptions.skills;
    const leftOut = offered.filter((skill) => supersededByTurri(skill, turriRuns));
    if (leftOut.length > 0) {
      event.systemPromptOptions.skills = offered.filter((skill) => !leftOut.includes(skill));
      if (!leftOutSaid && ctx.hasUI) {
        leftOutSaid = true;
        const names = leftOut.map((skill) => skill.name);
        ctx.ui.notify(
          `turri left out ${names.length} of pi's skills it has already - ${names.slice(0, 6).join(", ")}${names.length > 6 ? ", ..." : ""}: ` +
            "the ***plain reference is in its prompt, and it runs its own skills with cultivate.",
          "info",
        );
      }
    }
    return {
      systemPrompt: [event.systemPrompt, TURRI_IDENTITY, TOOLS_NOT_CLI, projectConfigBlock(cwd), machineBlock(cwd, machine.now()), rulesBlock()].filter((part) => part !== "").join("\n\n"),
    };
  });

  // The conversation's agent does not run turri again through its shell, unless the person
  // asked for the command line in the message it is answering.
  let lastUserMessage = "";
  pi.on("input", (event) => {
    if (event.source !== "extension") lastUserMessage = event.text;
    return { action: "continue" as const };
  });
  pi.on("tool_call", (event) => {
    const command = (event.input as { command?: unknown }).command;
    if (event.toolName === "bash" && typeof command === "string") {
      const what = selfInvocation(command);
      if (what !== undefined && !askedForCommandLine(lastUserMessage)) return { block: true, reason: refusal(what) };
    }
    markConversationWrite(event.toolCallId, event.toolName, event.input as Record<string, unknown>);
    return undefined;
  });
  // What the conversation writes in the project while a pulse's agent runs a command is its own: the audit after that
  // command leaves it, rather than putting it back as the agent's (conversation-writes.ts).
  const conversationWrites = new Map<string, () => void>();
  const markConversationWrite = (id: string, tool: string, input: Record<string, unknown>) => {
    const path = typeof input.path === "string" ? input.path : undefined;
    if ((tool === "edit" || tool === "write") && path !== undefined) conversationWrites.set(id, conversationWriting([resolve(cwd, path)]));
    else if (tool === "bash" || tool === "powershell") conversationWrites.set(id, conversationCommand());
  };
  pi.on("tool_result", (event) => {
    conversationWrites.get(event.toolCallId)?.();
    conversationWrites.delete(event.toolCallId);
    return undefined;
  });
  const settleConversation = () => {
    for (const done of conversationWrites.values()) done();
    conversationWrites.clear();
    conversationSettled();
  };
  pi.on("agent_end", settleConversation);

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

  // What a turri that was killed left running - its commands' process groups - stopped as this one starts.
  const orphans = sweepOrphanedGroups();
  let orphansSaid = orphans === 0;
  pi.on("session_start", (_event, ctx) => {
    if (orphansSaid || !ctx.hasUI) return;
    orphansSaid = true;
    ctx.ui.notify(`Stopped ${orphans} process group${orphans === 1 ? "" : "s"} a turri that was killed left running.`, "info");
  });

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
  registerRegenerate(pi, cwd, jobs);
  registerDrift(pi, cwd, jobs);
  registerGlimpse(pi, cwd, jobs);
  registerBind(pi, cwd, jobs);
  registerRenderModels(pi);
  deployStates.set(jobs, deployState);
  registerDeploy(pi, cwd, jobs, deployState);
  registerSteering(pi, cwd);
  registerSideQuestions(pi, cwd, jobs);
  registerStacks(pi, cwd);

  const { skills } = discoveredSkills;
  if (skills.length === 0) return;

  const catalogue = skills.map(catalogueLine).join("\n");
  const pendingNote = leftOutNote(discoveredSkills);

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
      // pi lists .agents/skills among its own skills too: read and followed by hand, a skill's gates would be skipped.
      "A skill cultivate lists may also be among your own skills, from the project's .agents/skills: run it with cultivate all the same, never by reading its SKILL.md and following it.",
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

      // Above the input, while it runs: every phase by name, the one it is in, and how far through - and under it, what that phase does.
      const phases = skill.steps.map((step) => step.name);
      const progress = { current: -1, attempt: 1 };
      if (ctx.hasUI) {
        ctx.ui.setWidget("turri-skill", (tui, theme) => {
          // The spinner on the phase it is in moves.
          const redraw = setInterval(() => tui.requestRender(), 1000);
          redraw.unref?.();
          const style = {
            heading: (text: string) => theme.bold(theme.fg("accent", text)),
            done: (text: string) => theme.fg("success", text),
            now: (text: string) => theme.bold(theme.fg("accent", text)),
            muted: (text: string) => theme.fg("muted", text),
          };
          return {
            render: (width: number) => {
              const about = skill.steps[progress.current]?.about;
              const now = { skill: skill.name, phases, current: progress.current, attempt: progress.attempt, frame: spinner(Date.now()), ...(about !== undefined ? { about } : {}) };
              const under = skillAboutLine(now, width, style);
              return [skillProgressLine(now, width, style), ...(under !== undefined ? [under] : [])];
            },
            invalidate: () => {},
            dispose: () => clearInterval(redraw),
          };
        });
      }

      const report: Reporter = {
        step: (name, attempt) => {
          progress.current = phases.indexOf(name);
          progress.attempt = attempt;
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
      // A side question asked while it runs is told what it has done so far.
      const ended = skillRunStarted({ skill: skill.name, dir: skill.dir, step: () => live.step, trace: () => [...trace], runDir });
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
          recordExchange(pi, { skill: skill.name, question, answer, ...(said !== undefined && said.trim() !== "" ? { said: said.trim() } : {}) });
        }, (question) => askOnTheSide(pi, ctx, cwd, jobs, question)),
        model: conversationModel(ctx),
        // Renders queued by a step land in the same registry as everything else, so
        // pulses sees them without knowing a skill started them.
        // Asked per job as it is queued, so a model chosen mid-interview applies from then on.
        renderQueue: workLoopFor(jobs, cwd, ctx),
        // A skill that waits for its builds and reads what they recorded - `mature` - sees the same jobs.
        jobs,
        // The person answers the skill's agent while it runs, so it can take "render these with ..." too.
        // validate too: a skill validates what it wrote with the same check the conversation has.
        sharedTools: [setRenderModelTool(pi, ctx), checkPlainTool(cwd), ...createWebTools()],
        // The conversation's own regenerate, drift, halt and conform, on its loop: a skill waits for nothing, and regenerates on the model chosen.
        loopTools: [
          regenerateTool({ cwd, jobs, loop: () => workLoopFor(jobs, cwd, ctx), model: (_skill, plainFile, named, work) => jobModel(ctx, work ?? "spec_changes", named, plainFile), wait: () => false }),
          driftTool({ cwd, jobs, loop: () => workLoopFor(jobs, cwd, ctx) }),
          haltTool({ jobs, workLoop: () => workLoops.get(jobs)?.loop }),
          conformTool({ cwd, loop: () => workLoopFor(jobs, cwd, ctx), model: (_skill, plainFile, named) => jobModel(ctx, "spec_changes", named, plainFile), wait: () => false }),
        ],
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
      ).finally(() => {
        ended();
        clearInterval(ticker);
        if (ctx.hasUI) ctx.ui.setWidget("turri-skill", undefined);
      });
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
          ? `${specsChanged.join(", ")} changed, and nothing is regenerated from that yet: call regenerate for it, and the code is brought up to the spec.`
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

      return { content: [{ type: "text" as const, text }], details: { ok: result.ok, artifacts: result.artifacts } };
    },
  });
}

function registerRegenerate(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool(
    regenerateTool({
      cwd,
      jobs,
      loop: (ctx) => workLoopFor(jobs, cwd, ctx),
      model: (ctx, plainFile, named, work) => jobModel(ctx, work ?? "spec_changes", named, plainFile),
      wait: (ctx, asked) => shouldWait(ctx.mode, asked),
    }),
  );

  // /regenerate: the same as the tool, from the person - a module brought up to its spec as it is now, cut into pulses
  // by the planner: one functional spec at a time, a few together or the whole module in one, as it judges. What
  // follows the module is guidance for that plan, in the person's words.
  pi.registerCommand("regenerate", {
    description: "Regenerate a module from its spec as it is now, in pulses the planner cuts - named functionalities though they did not change, or all of it from scratch: /regenerate [module | file.plain] [functionality ...] [from scratch] [how to cut the work]",
    handler: async (args, ctx) => {
      const command = `/regenerate ${args.trim()}`.trim();
      await echoCommand(pi, command);
      const say = (text: string, level: "info" | "warning" | "error") => shownAfterCommand(pi, ctx, command, text, level, true);
      const all = args.trim().split(/\s+/).filter((word) => word !== "");
      const [first = ""] = all;
      const { named, rest } = moduleNamedFirst(cwd, all);
      if (named === undefined && first.endsWith(".plain")) {
        say(`There is no ${first} here.`, "error");
        return;
      }
      // Functionalities named first, by id - 3, 2.1, fs 4 - as on the command line; what follows them is guidance.
      const words = rest;
      const again: string[] = [];
      while (words.length > 0 && /^(fs)?\d+(\.\d+)*,?$/i.test(words[0]!)) again.push(words.shift()!.replace(/^fs/i, "").replace(/,$/, ""));
      const guidance = words.join(" ").trim();
      let plainFile = named;
      if (plainFile === undefined) {
        const modules = defaultMapFiles(cwd);
        if (modules.length === 0) {
          say("No .plain file to regenerate: name one - /regenerate app.plain - or set module: in config.turri.yaml.", "warning");
          return;
        }
        if (modules.length === 1 || !ctx.hasUI) plainFile = modules[0]!;
        else {
          const label = (file: string) => relative(cwd, file) || basename(file);
          const picked = await ctx.ui.select("Regenerate which module?", modules.map(label));
          plainFile = modules.find((file) => label(file) === picked);
          if (plainFile === undefined) return;
        }
      }
      const check = checkPlainFile(plainFile);
      if (!check.ok) {
        say(`${relative(cwd, plainFile) || plainFile} does not parse, so nothing can be regenerated from it yet: ${check.error}`, "error");
        return;
      }
      // From scratch - started over, its code deleted - asked in the person's words: confirmed first, as it deletes.
      const scratch = asksFromScratch(guidance);
      const module = basename(plainFile).replace(/\.plain$/, "");
      if (scratch && again.length > 0) {
        say("Name functionalities or ask for it from scratch, not both: from scratch regenerates every one of them.", "warning");
        return;
      }
      if (scratch && ctx.hasUI) {
        const agreed = await ctx.ui.confirm(
          `Regenerate ${module} from scratch?`,
          `Its code and conformance tests are deleted - committed first, so /lineage ${module} keeps them - and the whole module is regenerated from its spec.`,
        );
        if (!agreed) return;
      }
      const loop = workLoopFor(jobs, cwd, ctx);
      const model = jobModel(ctx, again.length > 0 ? "functionalities" : "spec_changes", undefined, plainFile);
      const request = { ...(model !== undefined ? { model } : {}), ...(guidance !== "" ? { guidance } : {}) };
      // Said at once, and kept in the chat: what follows takes a while - the planner is an agent - and the person sees it
      // began, not a chat that stays empty until the first pulse starts. The plan is said under it once it is made.
      say(
        scratch
          ? `Deleting ${module}'s code, then planning all of it again…`
          : again.length > 0
            ? `Planning ${module}'s functionalit${again.length === 1 ? "y" : "ies"} ${again.join(", ")} again…`
            : `Planning ${module}'s pulses…`,
        "info",
      );
      await nextFrame();
      try {
        const statuses = scratch
          ? await loop.fromScratch(plainFile, request)
          : again.length > 0
            ? await loop.regenerateAgain(plainFile, again, request)
            : await loop.bringUp(plainFile, request);
        // Nothing to do: say how to build it again anyway.
        const hint = statuses.length > 0 && statuses.every(isUpToDate)
          ? `\nTo regenerate parts of it anyway, name their functionalities - /regenerate ${basename(plainFile)} 2.1 - or start over with /regenerate ${basename(plainFile)} from scratch.`
          : "";
        say(describeModules(statuses) + hint, "info");
      } catch (error) {
        say(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}


/**
 * What a slash command showed the person: kept in the chat, where they read it, and put in the conversation as well -
 * unseen there - so that when they speak of it next ("fix it"), the agent knows what they saw. A command runs outside
 * the agent's turns, and a notification is gone in seconds and reaches no model.
 */
export function shownAfterCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  command: string,
  text: string,
  level: NonNullable<CommandOutcome["level"]>,
  /** The command is in the chat already, above it (echoCommand): the text alone. */
  echoed = false,
): void {
  try {
    pi.appendEntry(COMMAND_OUTCOME, { command, text, level, ...(echoed ? { echoed } : {}) } satisfies CommandOutcome);
  } catch {
    // Shown for a moment all the same.
    if (ctx.hasUI) ctx.ui.notify(text, level);
  }
  void pi.sendMessage({ customType: COMMAND_OUTCOME, content: `The person ran ${command}, and was shown:\n${text}`, display: false });
}

export const COMMAND_OUTCOME = "turri_command_outcome";

interface CommandOutcome {
  command: string;
  /** None: the command itself, as the person typed it. */
  text?: string;
  level?: "info" | "warning" | "error";
  echoed?: boolean;
}

/** Longer than a frame of the TUI's (16ms): an entry appended before it is drawn by its end. */
const ONE_FRAME_MS = 20;

/**
 * What the person typed, put in the chat the moment they send it - before the command does anything - and drawn before
 * it goes on: a command's work can hold the event loop (a long requires chain parsed), and the chat stays as it was
 * until it lets go. What the command says comes under it.
 */
export async function echoCommand(pi: ExtensionAPI, command: string): Promise<void> {
  try {
    pi.appendEntry(COMMAND_OUTCOME, { command } satisfies CommandOutcome);
  } catch {
    return;
  }
  await nextFrame();
}

/** Until the TUI has drawn what was just put in the chat. */
export const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, ONE_FRAME_MS));

/**
 * The module a /regenerate's first words name, and the words after it - all of them when none is named. A name typed
 * with spaces for its underscores - "d365_function executor" - is the module d365_function_executor: the most words
 * that name one win.
 */
export function moduleNamedFirst(cwd: string, words: string[]): { named?: string; rest: string[] } {
  for (let count = words.length; count >= 1; count -= 1) {
    const named = plainFileNamed(cwd, words.slice(0, count).join("_"));
    if (named !== undefined) return { named, rest: words.slice(count) };
  }
  return { rest: words };
}

/** The .plain file a /regenerate argument names - a path, or a module's name in the folder - if it names one. */
function plainFileNamed(cwd: string, word: string): string | undefined {
  for (const candidate of [word, `${word}.plain`]) {
    const path = resolve(cwd, candidate);
    if (path.endsWith(".plain") && existsSync(path)) return path;
  }
  return undefined;
}

/** What is left to regenerate: the drift between a module's code and its spec - planning nothing, starting nothing. */
function registerDrift(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool(driftTool({ cwd, jobs, loop: (ctx) => workLoopFor(jobs, cwd, ctx) }));
}

function registerBind(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool(
    conformTool({
      cwd,
      loop: (ctx) => workLoopFor(jobs, cwd, ctx),
      model: (ctx, plainFile, named) => jobModel(ctx, "spec_changes", named, plainFile),
      wait: (ctx, asked) => shouldWait(ctx.mode, asked),
    }),
  );
}

/**
 * conform, for the conversation and for a skill that names it in its allowed-tools - the skill's on the conversation's
 * loop, its pulses scheduled like any other.
 */
function conformTool(options: {
  cwd: string;
  loop: (ctx: ExtensionContext) => WorkLoop;
  model: (ctx: ExtensionContext, plainFile: string, named: string | undefined) => string | undefined;
  wait: (ctx: ExtensionContext, asked: boolean | undefined) => boolean;
}) {
  const { cwd } = options;
  return defineTool({
    name: "conform",
    label: "Conform",
    description:
      "Write and run the black-box conformance tests of a module's functional specs - the ones named, or every one - on " +
      "the code as it is built, in a pulse of their own - every functional spec tested in one, as far as a size guardrail " +
      "lets, or one a functional spec when the user asks for that: each writes its tests from the spec's test reqs and acceptance " +
      "tests, runs them with the whole suite the module inherits, and, where one fails, fixes the test or the code, " +
      "whichever is wrong. What they are written for is recorded apart from the code. For this session, whatever the " +
      "config's conformance-tests says. Functional specs not built yet can be named: the conformance pulse is scheduled at " +
      "once and starts when the module's code is built - every code pulse of it landed - before anything is built on it. A functional spec " +
      "the spec does not have, or a module without test reqs, is refused. A conformance pulse checks, as it starts, that " +
      "the code record has every functional spec it tests, and does not start otherwise.",
    promptSnippet: "conform: write and run conformance tests for functional specs - now, or ahead of their code",
    promptGuidelines: [
      "When the user asks for conformance tests - for a module, or some of its functional specs - call conform. Never edit config.turri.yaml for it, and never regenerate a functionality to get them.",
      "Under conformance-tests: chosen or module, the chooser decides which functional specs get conformance tests - under chosen as each code pulse ends, under module once the whole module is regenerated - and a pulse's report says what it chose and why. You do not choose them: call conform only when the user asks for conformance tests. The ones named are added to those chosen before; a functional spec tested already keeps its tests.",
      "What the user asks for comes first: for a module already regenerated, while a module built on it is being regenerated, conform stops that pulse, deletes the codebase built on it, writes the tests, and the module above is regenerated from it after - say so. For a module not regenerated yet - one above the one being regenerated - the tests are scheduled now and written once its code is built, before anything is built on it.",
      "Conformance tests go in one pulse for all the functional specs tested. Set one_by_one only when the user asks for a pulse a functional spec - one at a time, separately, or the like.",
      "When the user asks for the conformance tests in pulses of their own grouping - 1-3 and 4-6 - pass those groups as groups, in one call: each group is a pulse of its own, never sharing one with another. Without groups, every functional spec named goes in one pulse.",
      "A conformance pulse that did not start because its code is not built: tell the user which functional specs it waits for, and which code pulse builds them.",
    ],
    parameters: Type.Object({
      plain_file: Type.String({ description: "A .plain file of the module" }),
      working_dir: WORKING_DIR_PARAM,
      frids: Type.Optional(Type.Array(Type.String(), { description: "The functional specs to test, by id - added to those chosen before. Omitted: every one" })),
      groups: Type.Optional(
        Type.Array(Type.Array(Type.String()), {
          description: "Only when the user asks for them in pulses of their own grouping: the functional specs by id, a list a pulse - [[\"1\",\"2\",\"3\"],[\"4\",\"5\",\"6\"]]. Each is tested in a pulse of its own; they are added to those chosen, as frids are",
        }),
      ),
      one_by_one: Type.Optional(
        Type.Boolean({ description: "Only when the user asks for it: a pulse a functional spec. Omitted: every functional spec tested in one pulse, as far as the size guardrail lets" }),
      ),
      model: MODEL_PARAM,
      wait: WAIT_PARAM,
    }),
    async execute(_id, given, _signal, _onUpdate, ctx) {
      const params = fromWorkingDir(cwd, given);
      const plainFile = resolve(params.base, params.plain_file);
      const model = options.model(ctx, plainFile, params.model);
      const loop = options.loop(ctx);
      const statuses = await loop.conformance(plainFile, {
        ...(params.frids !== undefined ? { frids: params.frids } : {}),
        ...(params.groups !== undefined ? { groups: params.groups } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(params.one_by_one === true ? { separately: true } : {}),
      });
      return loopReply(loop, statuses, options.wait(ctx, params.wait));
    },
  });
}

function registerGlimpse(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerTool({
    name: "glimpse",
    label: "Glimpse the next pulse",
    description:
      "Plan the work of a module as regenerate would, and show the pulse each codebase would start next and the whole " +
      "prompt its coding agent would get - starting nothing. A codebase with a pulse running is left out: what its next pulse " +
      "is given depends on what the running one lands.",
    promptSnippet: "glimpse: the next pulse of a module and its coding agent's whole prompt, starting nothing",
    promptGuidelines: [
      "Use glimpse when the user wants to see what a pulse will be told before it runs, or to check a plan before steering it with steer.",
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
        ...busy.map((module) => `\n${module} has a pulse running: its next pulse is planned from what that one lands - preview it once it has.`),
        ...previews.map((preview) =>
          [
            "",
            `<next pulse module="${preview.module}" track="${preview.track}" title="${preview.title}">`,
            preview.task ?? "A conformance pulse's prompt is built from what the code it tests holds once it is built: it is not shown before.",
            "</next pulse>",
          ].join("\n"),
        ),
        "",
        "Nothing was started. Tell the user what the next pulse is and what it will be told - the parts they are likely to care about, not the whole prompt unless they ask.",
      ].join("\n");
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });
}

/** The config a spec is built with - its project's, with the chosen stack's over it - or, with no spec, the session folder's. */
function configOf(plainFile?: string) {
  return plainFile !== undefined ? configForSpec(resolve(process.cwd(), plainFile)) : readProjectConfig(process.cwd(), stackOf(process.cwd()));
}

/**
 * How many jobs the chat runs at once: `parallel-jobs:` in the session folder's config.turri.yaml - the only place it
 * is set - else half this machine's cores, between one and four.
 */
export function parallelJobs(cwd: string): number {
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
 * This machine, for the chat's agent, read afresh every turn: which wall is up under the agents' commands, whether the
 * machine has the toolchains the project's modules name, and what in its testing scripts it lacks - for the person to
 * install or fix; the agents install nothing. `modules`: what the modules need, when it is known already - working it
 * out parses every spec of the project.
 */
export function machineBlock(cwd: string, modules: ReturnType<typeof stackOnMachine> = stackOnMachine(cwd)): string {
  const wall = sandboxAvailable();
  const walls =
    wall.kind === "none"
      ? `behind the command check and the audit alone - no OS sandbox: ${wall.why}${wall.fix !== undefined ? ` (to give it one: ${wall.fix})` : ""}`
      : `behind the command check, ${wall.kind === "seatbelt" ? "Seatbelt" : "bubblewrap"} and the audit`;
  const needing = modules.filter(({ needs }) => needs.length > 0);
  const scripts = findTestScripts(cwd);
  const misfits = [scripts.unit, scripts.prepare, scripts.conformance].flatMap((script) => {
    if (script === undefined) return [];
    const text = readScript(script);
    const found = text !== undefined ? scriptAgainstMachine(text) : [];
    return found.length > 0 ? [`- ${relative(cwd, script)} does not fit this machine: it ${found.join("; ")} - the person's to fix.`] : [];
  });
  return [
    "<this machine>",
    `The agents' commands run on this machine, with its toolchains, ${walls}. The testing scripts run here too, unfenced, in the person's environment. Nothing is installed by an agent: what the machine lacks is the person's to install.`,
    ...needing.map(({ module, needs, missing }) =>
      `- ${module}: its implementation reqs need ${needs.map((need) => `${need.toolchain} (${need.words.join(", ")})`).join(", ")}${missing.length > 0 ? ` - this machine LACKS ${missing.map((need) => need.toolchain).join(", ")}` : " - this machine has them"}.`,
    ),
    ...misfits,
    "</this machine>",
    "",
    toolchainsBlock(),
  ].join("\n");
}

/**
 * What the project's modules need of this machine, kept between turns - working it out parses every spec, seconds on a
 * project of long requires chains, and a message is never kept waiting for it. Worked out once the chat is up, and again
 * when a turn has settled and a spec changed since: a turn is told what was known last, at most a turn behind.
 */
export function machineNeeds(cwd: string, work: (cwd: string) => ReturnType<typeof stackOnMachine> = stackOnMachine) {
  let known: { stamp: string; modules: ReturnType<typeof stackOnMachine> } | undefined;
  /** The project's specs as they are on disk: their names and when each last changed. */
  const stamp = (): string => {
    try {
      return readdirSync(cwd)
        .filter((name) => name.endsWith(".plain"))
        .sort()
        .map((name) => `${name}\0${statSync(join(cwd, name)).mtimeMs}`)
        .join("\n");
    } catch {
      return "";
    }
  };
  const refresh = () => {
    const now = stamp();
    if (known?.stamp === now) return;
    known = { stamp: now, modules: work(cwd) };
  };
  return {
    /** What is known - worked out now only when nothing is yet. */
    now(): ReturnType<typeof stackOnMachine> {
      if (known === undefined) refresh();
      return known!.modules;
    },
    /** Worked out again, if a spec changed - once the chat has drawn what it is drawing. */
    refreshSoon(): void {
      setTimeout(() => {
        try {
          refresh();
        } catch {
          // Told what was known last.
        }
      }, ONE_FRAME_MS);
    },
  };
}

/** Whether a folder holds a project's config: config.turri.yaml, a module's own, or the config.turri.yaml read until there is one. */
function hasConfig(dir: string): boolean {
  return hasProjectConfig(dir);
}

/**
 * The project's config.turri.yaml, for the chat's agent: what it says, and what that means for the
 * tools - so a question about the project's settings is answered from the file, not from the
 * tools' defaults.
 */
export function projectConfigBlock(root: string): string {
  // The session's folder, and the projects one folder down - specs kept in plain/, with its own
  // config.turri.yaml and plain_modules - which its specs are built in when named from here.
  const projects = [
    ...(hasConfig(root) ? [root] : []),
    ...readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "plain_modules")
      .map((entry) => join(root, entry.name))
      .filter(hasConfig),
  ];
  if (projects.length === 0) return "";

  const describe = (dir: string): string[] => {
    const stacks = stacksOf(dir);
    const chosen = stackOf(dir);
    const where = dir === root ? "" : ` (paths relative to ${relative(root, dir)}/)`;
    const at = (name: string) => (dir === root ? name : `${relative(root, dir)}/${name}`);
    return [
      ...settings(
        readProjectConfig(dir),
        withStack(undefined, () => findTestScripts(dir)),
        dir === root ? `${projectConfigFile(dir)}, for the specs here:` : `${relative(root, dir)}/${projectConfigFile(dir)}, for the specs in ${relative(root, dir)}/ - built in ${relative(root, dir)}/plain_modules:`,
        where,
        stacks.length > 0 ? "project of stacks" : "project",
      ),
      ...(stacks.length > 0
        ? ["", `Stacks: ${stacks.join(", ")} - chosen now: ${chosen ?? "none, so the project's file alone"}. Everything is built with the chosen one; switch with the stack tool when the user asks.`]
        : []),
      // A stack: its file over the project's, for everything built while it is chosen.
      ...stacks.flatMap((stack) => [
        "",
        ...settings(
          readProjectConfig(dir, stack),
          withStack(stack, () => findTestScripts(dir)),
          `${at(stackConfigFileIn(dir, stack))}, over ${projectConfigFile(dir)}, for everything built while the stack ${stack} is chosen${chosen === stack ? " - as it is now" : ""}:`,
          where,
          "stack",
        ),
      ]),
    ];
  };

  const settings = (
    config: ReturnType<typeof readProjectConfig>,
    scripts: ReturnType<typeof findTestScripts>,
    heading: string,
    where: string,
    /** The project's file, and whether it has stacks - whose scripts are theirs - or a stack's. */
    of: "project" | "project of stacks" | "stack",
  ): string[] => {
    const perModule = of === "project of stacks";
    return [
      heading,
      ...[
        config.module !== undefined && of !== "stack" ? `- module: ${config.module}${where} - the module to build when the user does not name one.` : undefined,
        config.conformanceTests === false
          ? "- conformance-tests: false - conformance tests are OFF: renders write none and run none, unless the user asks for them in this conversation."
          : config.conformanceTests === "chosen"
            ? "- conformance-tests: chosen - conformance tests are on for the functional specs chosen: those with acceptance tests always, those the chooser picks as each code pulse ends from what it regenerated, and those the user asks for with conform. A conformance pulse starts once the module's code is built, before anything is built on it. Once chosen, a functional spec keeps them."
            : config.conformanceTests === "module"
            ? "- conformance-tests: module - conformance tests are on for the functional specs chosen: those with acceptance tests always, those the chooser picks - and plans into pulses - once the whole module is regenerated, and those the user asks for with conform. They run before anything is built on the module. Once chosen, a functional spec keeps them."
            : config.conformanceTests === true
            ? "- conformance-tests: all - conformance tests are on, for every functional spec of every module that has test reqs."
            : "- conformance-tests: not set - conformance tests are OFF, as with false: renders write none and run none, unless the user asks for them in this conversation.",
        config.review === true
          ? "- review: true - the code and its tests are reviewed once they pass: two reviews at most, the arbiter weighing the second."
          : `- review: ${config.review === false ? "false" : "not set, so off"} - the code and its tests are not reviewed: a pulse lands once its tests pass.`,
        ...(() => {
          // Each as it holds, with what it inherits: judge from coding, coding from harness.
          const models = projectModels(config);
          const shown = (choice: typeof models.coding) => modelSpec(choice) ?? "";
          return [
            models.coding !== undefined ? `- coding-model: ${shown(models.coding)}${config.codingModel === undefined ? " (from harness-model)" : ""} - what renders run on, unless engine chose another in this session.` : undefined,
            models.judge !== undefined ? `- judge-model: ${shown(models.judge)}${config.judgeModel === undefined ? " (from coding-model)" : ""} - the judge and the test review in a conformance run.` : undefined,
            models.harness !== undefined && of !== "stack" ? `- harness-model: ${shown(models.harness)} - the model you start with.` : undefined,
            // The other roles' own, where models: names them.
            ...AGENT_ROLES.filter((role) => role !== "coding" && role !== "chat").flatMap((role) => {
              const own = roleModel(config, role);
              return own !== undefined ? [`- models: ${role}: ${shown(own)}`] : [];
            }),
            ...(() => {
              const limits = AGENT_ROLES.flatMap((role) => (config.models?.[role]?.turnLimit !== undefined ? [`${role} ${config.models[role]!.turnLimit}s`] : []));
              const all = config.models?.default?.turnLimit ?? config.turnLimit;
              return all !== undefined || limits.length > 0 ? [`- turn limits: ${all !== undefined ? `${all}s each` : "two minutes each"}${limits.length > 0 ? `; ${limits.join(", ")}` : ""}.`] : [];
            })(),
          ];
        })(),
        `- unit testing script: ${scripts.unit !== undefined ? relative(root, scripts.unit) : perModule ? "none for the whole project - each stack's file below names its own" : "none found - every build stops until there is one"}`,
        `- conformance testing script: ${scripts.conformance !== undefined ? relative(root, scripts.conformance) : perModule ? "none for the whole project - see each stack's file" : "none found"}`,
        scripts.prepare !== undefined ? `- prepare script: ${relative(root, scripts.prepare)} - run on the build before every conformance testing script run, which runs only once it passes` : undefined,
        config.testingScriptsRunOn === "copy"
          ? "- testing-scripts-run-on: copy - the testing scripts run on this machine, on a fresh copy of each module's code; `testing-scripts-run-on: in-place` (the default) runs them on the code in place."
          : "- testing-scripts-run-on: in-place - the testing scripts run on this machine on the code in place, from the project, against the host codebase; `testing-scripts-run-on: copy` runs them on a fresh copy of each module's code.",
      ].filter((line): line is string => line !== undefined),
    ];
  };

  return [
    `<project config>`,
    `A project's ${CONFIG_FILE} sets how its specs are built - and a stack's config.turri.<stack>.yaml, over it, how everything is built`,
    "while that stack is chosen: its testing scripts, toolchains, models and conformance - a backend and a frontend each with their own scripts.",
    "One stack is chosen at a time, for the session: the render tools follow the project's file with the chosen stack's over it;",
    `a project with no ${CONFIG_FILE} yet is read from its ${LEGACY_CONFIG_FILE} (and config.<stack>.yaml): to change a setting there, copy`,
    `${LEGACY_CONFIG_FILE} to ${CONFIG_FILE} - and each config.<stack>.yaml to config.turri.<stack>.yaml - first, then edit the copy; never edit ${LEGACY_CONFIG_FILE}.`,
    "answer questions about the project's settings from it, and say when a render will differ from it because the user",
    "asked. Name a spec by its path from here - plain/hubspot.plain - and it is built in its own project.",
    ...projects.flatMap((dir) => ["", ...describe(dir)]),
    `</project config>`,
  ].join("\n");
}

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

/**
 * The model a job's agents run on: the one named on the call, checked now so a wrong name fails
 * here and not minutes later in the background; else the one chosen for its kind of work; else
 * the conversation's.
 */
/**
 * The model a render job runs on: the one asked for, or the one chosen in this session for its kind
 * of work, or the project's - `model:` in config.turri.yaml - or the conversation's.
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
 * The coding model this session starts from, and where it was given: `turri
 * --coding-model`, or `coding-model:` in the project's config.turri.yaml - read afresh, so an edit to the
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
      "The engine: which model the agents that regenerate the code run on. With no model, say which it is. With one, choose it " +
      "for the rest of this session: for spec changes " +
      "(render spec diff pulses, and the ones write_spec_diff queues), for functionalities (render, module, " +
      "regenerate with functionalities named, conformance), or for everything. By default " +
      "each runs on the model the project's config.turri.yaml names, or else the conversation's model. The model may be given as provider/model-id or by name as " +
      "the user said it; a name that fits more than one model, or none with credentials, comes back as a " +
      "list - ask the user which they meant, never pick one yourself. Pulses already queued keep their model.",
    promptSnippet: "the engine: show or choose the model that regenerates the code",
    promptGuidelines: [
      "When the user says which model should regenerate or build something, call engine with it - once; it holds for the rest of the session. To say which one it is, call engine with no model.",
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
      .filter((entry) => entry.type === "custom" && (entry as { customType?: string }).customType === MODEL_CHOICE_ENTRY)
      .at(-1) as { data?: ModelChoices } | undefined;
    Object.assign(chosenModels, saved?.data ?? {});
  });

  pi.registerTool(setRenderModelTool(pi));

  pi.registerCommand("engine", {
    description: "Show the engine: which model regenerates spec changes and functionalities. To change it, say so in the conversation.",
    handler: async (_args, ctx) => {
      const text = `The engine:\n${describeChoices(chosenModels, chatModelOf(ctx), projectModelLabel(ctx))}\n\nTo change it, say so - e.g. "regenerate spec changes with gpt 5.5".`;
      if (ctx.hasUI) ctx.ui.notify(text, "info");
    },
  });
}

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

/** What release has shipped in a conversation, by its jobs: shared by the chat's release and a pulse's own. */
const deployStates = new WeakMap<JobRegistry, DeployState>();

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
      // Under conformance-tests: chosen or module, the chooser decides as a pulse ends - on the chat's model - so the choice
      // is made before anything is built on the module; the pulse's report says what it chose, and why.
      onChoose: conformanceChooser({ model: () => chatModelOf(from.ctx) }),
      // How the work is to be planned: the conversation's steering, and AGENTS.md's - read afresh each plan.
      steering: (plainFile) => steeringFor(plainFile, cwd, steeringStore),
      // Under release-after-pulse, a pulse releases what it landed itself, before the next starts - on the model that
      // regenerated it: a release follows steps, and a small model thinking little does that well.
      release: ({ plainFile, moduleName, title, onDelta }) => {
        const model = modelFor(chosenModels, "spec_changes", projectModel(from.ctx, plainFile) ?? chatModelOf(from.ctx));
        return runReleaseAgent({
          plainFile,
          cwd,
          state: deployStates.get(jobs) ?? createDeployState(),
          afterPulse: { moduleName, subject: title },
          onDelta,
          ...(model !== undefined ? { model } : {}),
        });
      },
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
            ? `Queued ${input.kind} as pulse ${job.id}: ${summary}${onModel}. It writes the same ` +
              `module as ${job.waitingOn.map((id) => `pulse ${id}`).join(" and ")}, so it starts when that ` +
              "finishes. Nothing to wait for: if what you are doing has a next step, take it now, in this same turn, and tell " +
              "the user it is queued and why alongside it, never as a reply that ends your turn. "
            : `Started ${input.kind} as pulse ${job.id}: ${summary}${onModel}.\n` +
              "It is running now and will report back when it finishes - nothing to wait for: if what you are doing has a " +
              "next step, take it now, in this same turn, and tell the user it has started alongside it, never as a reply " +
              "that ends your turn. ") +
          `Use pulses with "${job.id}" if they ask how it is going.`,
      },
    ],
    details: { jobId: job.id, status: job.status },
  };
}

/** Looking in on work that is still running, and collecting what finished. */
/** By registry: what opens the side panel - for a skill's question that invites the person to peek. */
const panelOpeners = new WeakMap<JobRegistry, (ctx: ExtensionContext) => void>();

/** By registry: the last pulse that failed, stopped or did not pass, not yet looked at - ctrl+h opens on it. */
const needsLooking = new WeakMap<JobRegistry, string>();

function registerJobTools(pi: ExtensionAPI, jobs: JobRegistry, cwd: string) {
  pi.registerTool({
    name: "diagnose",
    label: "Diagnose a pulse",
    description:
      "Why a pulse did not land, from its whole transcript: how it ended and its diagnosis, the stages that went wrong, the " +
      "last failing test run with its output, the last review that sent the work back, and the tool calls that failed - " +
      "and where the whole log is.",
    promptSnippet: "diagnose: why a pulse did not land, from its transcript",
    promptGuidelines: ["When a pulse failed or did not land, call diagnose before you explain it or change the spec: go by what happened, not by the report alone."],
    parameters: Type.Object({ job_id: Type.String({ description: "The pulse's id" }) }),
    async execute(_id, params) {
      const job = jobs.get(params.job_id);
      if (job === undefined) return { content: [{ type: "text" as const, text: `No pulse ${params.job_id} has run in this session.` }], details: { status: "unknown" } };
      return { content: [{ type: "text" as const, text: whyFailed(job) }], details: { status: job.status as string } };
    },
  });

  pi.registerTool({
    name: "pulses",
    label: "Pulses",
    description:
      "What is regenerating: with no pulse, every pulse of this session - running, planned and finished - and what deploy started; " +
      "with a pulse's id, that pulse - whether it is still running, its latest output, and its report once it has finished.",
    promptSnippet: "pulses: every pulse, or one - what is regenerating and how it is going",
    parameters: Type.Object({
      job_id: Type.Optional(Type.String({ description: "The id returned when the pulse started. Omitted: every pulse" })),
      wait: Type.Optional(
        Type.Boolean({ description: "With a pulse: block until it finishes instead of reporting its current state" }),
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
          content: [{ type: "text" as const, text: `${planned.id} · ${pulseName(planned)}: ${planned.note ?? "planned, not started"}${planned.waitingOn.length > 0 ? ` It runs after ${planned.waitingOn.join(", ")}.` : ""}` }],
          details: { status: "planned" },
        };
      }
      if (existing === undefined) {
        const known = shownJobs(jobs).map((job) => job.id);
        return {
          content: [
            {
              type: "text" as const,
              text: `No pulse ${params.job_id}. ${known.length > 0 ? `Known pulses: ${known.join(", ")}.` : "No pulses have been started."}`,
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

  pi.registerCommand("halt", {
    description: "Halt a queued or running pulse, a module's planned pulses, or what activate started: /halt [pulse id | module | activated <name>]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const live = jobs.list().filter((job) => job.status === "running" || job.status === "queued");
      const deployed = runningDeployed();
      const loop = workLoops.get(jobs)?.loop;
      // A module's planned pulses, one line a module: halting one halts the module.
      const plannedRows = loop?.planned() ?? [];
      const planned = [...new Set(plannedRows.map((row) => row.module ?? ""))].filter((module) => module !== "");
      let id = args.trim();
      if (id === "") {
        if (live.length === 0 && deployed.length === 0 && planned.length === 0) return ctx.ui.notify("Nothing is regenerating, queued or planned.", "info");
        const label = (job: Job) => `${job.id}  ${job.status.padEnd(8)} ${pulseName(job)}`;
        const plannedLabel = (module: string) => {
          const rows = plannedRows.filter((row) => row.module === module);
          const waiting = rows.find((row) => row.id.endsWith("-waiting"));
          return `${module}  ${waiting !== undefined ? waiting.summary : `${rows.length} planned`} - halts the module`;
        };
        const labels = [...live.map(label), ...planned.map(plannedLabel), ...deployed.map((item) => deployedLabel(item.name, item.url ?? item.command))];
        const picked = await ctx.ui.select("Halt which?", labels);
        const job = live.find((candidate) => picked !== undefined && label(candidate) === picked);
        const module = planned.find((name) => picked !== undefined && plannedLabel(name) === picked);
        const server = deployed.find((item) => picked !== undefined && deployedLabel(item.name, item.url ?? item.command) === picked);
        if (server !== undefined) id = `activated ${server.name}`;
        else if (job !== undefined) id = job.id;
        else if (module !== undefined) id = module;
        else return;
      }
      const name = /^(?:activated|deploy)\s+(.+)$/.exec(id)?.[1]?.trim();
      if (name !== undefined) {
        const stopped = await stopDeployed({ name });
        return shownAfterCommand(pi, ctx, `/halt ${id}`, stopped.length > 0 ? `Halted ${stopped.join(", ")}.` : `Nothing activate started is running as ${name}.`, "info");
      }
      ctx.ui.notify(stopJob(jobs, id, undefined, loop), "info");
    },
  });

  // Debug mode, for the render agents started from now on - see debug-log.ts.
  // A module's history: every render, regeneration and conformance run, as git commits.
  pi.registerCommand("lineage", {
    description: "Show a module's lineage - every generation of its code and tests, and what each was regenerated from: /lineage [module]",
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
      "Read a module's lineage: every generation of its code and tests - each regeneration, conformance run and spec change, " +
      "with what it was regenerated from - as git commits. Without a commit, the log; with one, that commit in full - its message and " +
      "the change it made.",
    promptSnippet: "a module's lineage: what was regenerated into it, and when",
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

  // The side panel: the regeneration - and the pulses behind p - over the whole screen, or beside the chat (s, from one to
  // the other). Its key (PANEL_KEY) opens it; the key again closes it and goes back to the chat, as esc does over the
  // screen - beside the chat, esc gives the chat its keys back and the panel stays, and the key gives them to the panel.
  // While the panel has the keys, every key is its own.
  let panel: { handle?: OverlayHandle; view: ReturnType<typeof createSidePanel>; close: () => void; keepChatFocus: () => void; keys: boolean } | undefined;
  // Beside the chat or over it: as the person last left it, for the conversation.
  let panelDocked = false;
  // The terminal the panel is drawn on, for its width: set as it opens.
  let panelTerminal: { columns: number } | undefined;
  /** The columns the panel takes beside the chat - 0 over the whole screen, or when the terminal is too narrow to share. */
  const panelBeside = (): number => (panelDocked && panelTerminal !== undefined ? dockedWidth(panelTerminal.columns) : 0);
  // What is open in the pulse list and the map, and where their cursors are: the conversation's, as left each time it opens.
  const jobsTree = createJobsTreeState();
  const mapState = createSpecMapState();
  // The map from the files - the .plain files asked for, else the project's - with the work loop's plan laid over them.
  const specMap = createSpecMapSource({
    files: () => {
      const asked = workLoops.get(jobs)?.loop.mapPlan().files ?? [];
      return asked.length > 0 ? asked : defaultMapFiles(cwd);
    },
    plan: () => workLoops.get(jobs)?.loop.mapPlan() ?? { files: [], codebases: [] },
  });

  /** Open the side panel - on the view named, or as it was left. */
  const openPanel = (ctx: ExtensionContext, view?: "map" | "pulses") => {
    // Found: ctrl+h under the job panel stops breathing.
    keyPressed("peek");
    if (view !== undefined) mapState.view = view;
    // A pulse that failed or stopped since the panel was last opened: opened as it is, it is on that pulse - what went
    // wrong is what the person opens it to see.
    else {
      const id = needsLooking.get(jobs);
      if (id !== undefined && selectJob(shownJobs(jobs), jobsTree, id)) mapState.view = "pulses";
    }
    needsLooking.delete(jobs);
    if (panel !== undefined) {
      panel.keepChatFocus();
      panel.handle?.setHidden(false);
      panel.keys = true;
      panel.handle?.focus();
      return;
    }
    // Not awaited: the panel lives on while the jobs it shows run.
    void ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        // What the chat shows when the panel takes the keys - its editor, or a pi dialog - for when it gives them back.
        const focusedNow = () => (tui as unknown as { getFocusedComponent?(): Component | null }).getFocusedComponent?.() ?? null;
        let chatFocus = focusedNow();
        const keepChatFocus = () => {
          const focused = focusedNow();
          if (focused !== null && focused !== component && !(focused instanceof QuestionDialog)) chatFocus = focused;
        };
        // The keys back to the chat: to the question open there now, else to what it showed - never to a question answered
        // while the panel was open.
        const giveBack = () => entry.handle?.unfocus({ target: questionShown ?? chatFocus });
        const close = () => {
          giveBack();
          done(undefined);
        };
        panelTerminal = tui.terminal;
        let component: { render(width: number): string[]; dispose?(): void } | undefined;
        // Beside the chat: the chat drawn narrower, on the left, and a click on either side giving it the keys - undone
        // when the panel goes over the screen, or closes.
        let undock: (() => void) | undefined;
        const layOut = () => {
          if (panelDocked && undock === undefined) {
            const widen = narrowChat(tui, panelBeside);
            const unwatch = clickToFocus(
              tui,
              () => tui.terminal.columns - panelBeside(),
              (side) => {
                if (panelBeside() === 0) return;
                if (side === "chat") toChat();
                else toPanel();
              },
            );
            // The side without the keys in the shade: the chat while the panel has them.
            const unshade = shadeChat(tui, () => panelBeside() > 0 && entry.keys);
            undock = () => {
              unshade();
              unwatch();
              widen();
            };
          } else if (!panelDocked && undock !== undefined) {
            undock();
            undock = undefined;
          }
        };
        // Beside the chat, back to it: the chat has the keys, the panel stays.
        const toChat = () => {
          entry.keys = false;
          giveBack();
          tui.requestRender();
        };
        const toPanel = () => {
          keepChatFocus();
          entry.keys = true;
          entry.handle?.focus();
          tui.requestRender();
        };
        const back = () => (panelBeside() > 0 ? toChat() : close());
        // Opened, it reads the files again at once: they may have changed while it was closed.
        specMap.refresh();
        const view = createSidePanel({
          jobs: () => shownJobs(jobs),
          tree: jobsTree,
          map: () => specMap.read(),
          mapState,
          rows: () => tui.terminal.rows,
          key: PANEL_KEY,
          dock: {
            docked: () => panelBeside() > 0,
            toggle: () => {
              panelDocked = panelBeside() === 0;
              layOut();
              tui.requestRender();
            },
          },
          style: {
            heading: (text) => theme.bold(theme.fg("accent", text)),
            muted: (text) => theme.fg("muted", text),
            accent: (text) => theme.fg("accent", text),
            error: (text) => theme.fg("error", text),
            success: (text) => theme.fg("success", text),
            warning: (text) => theme.fg("warning", text),
            added: (text) => theme.fg("toolDiffAdded", text),
            removed: (text) => theme.fg("toolDiffRemoved", text),
            // A spec diff's ***plain highlighted as plyn highlights it, and its added and removed lines filled.
            diff: plainPaint(theme),
            // What conformance tests show does what its spec says: brand blue.
            conforms: brandBlue(theme),
          },
          back,
          close,
          // A module that needs the person: the chat takes it up with them, in their words - what went wrong, and what now.
          discuss: (page) => {
            back();
            const why = page.codebase?.stuck?.why;
            pi.sendUserMessage(
              `regen says ${page.module} needs me: ${page.status}. What went wrong, and what do we do about it?${why !== undefined ? `\n\n(turri's reason: ${why})` : ""}`,
              { deliverAs: "followUp" },
            );
          },
          // Something took the keys' focus while the panel showed - a question in the chat - and waits there.
          waiting: () => {
            if (!entry.keys) return false;
            const focused = (tui as unknown as { getFocusedComponent?(): unknown }).getFocusedComponent?.() ?? null;
            return focused !== null && focused !== component;
          },
        });
        const entry: NonNullable<typeof panel> = { view, close, keepChatFocus, keys: true };
        panel = entry;
        layOut();
        // Every key goes to the panel while it shows, whatever has the focus: a question the chat model asks in the
        // background takes the focus, but no key reaches it - an enter never answers it unseen. It waits in the chat
        // until the panel closes, and has the keys then. Mouse events are the screen's, before this sees them.
        // Only while it is on the screen: up in the TUI's overlays and not hidden. An overlay taken off without the panel
        // being disposed - another one closed over it - leaves no panel to take keys for: it lets them go, and goes.
        const shown = (): boolean | "gone" => {
          const overlays = (tui as unknown as { overlayStack?: Array<{ component: unknown }> }).overlayStack;
          if (entry.handle === undefined || component === undefined) return false;
          if (overlays !== undefined && !overlays.some((overlay) => overlay.component === component)) return "gone";
          return entry.handle.isHidden() !== true;
        };
        const unlisten = tui.addInputListener((data) => {
          const state = shown();
          if (state === "gone") {
            component?.dispose?.();
            return undefined;
          }
          if (!state) return undefined;
          // Beside the chat, ⌥⌘← and ⌥⌘→ go to the side they point at, whichever has the keys - on a terminal that tells
          // turri of ⌘ (the Kitty keyboard protocol). Its release goes nowhere.
          if (panelBeside() > 0 && (matchesKey(data, SIDE_KEYS.chat) || matchesKey(data, SIDE_KEYS.panel))) {
            if (!isKeyRelease(data)) {
              if (matchesKey(data, SIDE_KEYS.chat)) toChat();
              else toPanel();
            }
            return { consume: true };
          }
          // Beside the chat, with the chat's keys: they are the chat's - PANEL_KEY among them, for the shortcut that gives
          // them to the panel. A click on the panel gives it the focus, and the keys with it.
          if (!entry.keys && entry.handle?.isFocused() !== true) return undefined;
          entry.keys = true;
          // A terminal on the Kitty keyboard protocol reports a key's release, and listeners are given it: the release of
          // the ctrl+h that opened the panel would close it again at once, and every arrow would move twice. Only
          // presses count - and ctrl+h held down, repeating, does not open and close it over and over.
          if (isKeyRelease(data) || (isKeyRepeat(data) && matchesKey(data, PANEL_KEY))) return { consume: true };
          // ctrl+c closes it too: whatever else goes wrong, a key always leads back to the chat.
          if (matchesKey(data, PANEL_KEY) || matchesKey(data, "ctrl+c")) close();
          else {
            try {
              view.handleInput(data);
            } catch {
              /* a key the panel fails on is dropped, never the panel's hold on the keys */
            }
          }
          tui.requestRender();
          return { consume: true };
        });
        // Jobs keep writing; redraw so the panel follows them while it shows.
        const timer = setInterval(() => {
          if (entry.handle?.isHidden() !== true) tui.requestRender();
        }, WATCH_REDRAW_MS);
        timer.unref?.();
        component = {
          // Beside the chat, a rule down its left edge between them - and the panel in the shade while the chat has the keys.
          render: (width: number) => {
            if (panelBeside() === 0) return view.render(width);
            const lines = view.render(width - 2).map((line) => `${theme.fg("borderMuted", "│")} ${line}`);
            return entry.keys ? lines : lines.map(shade);
          },
          // Reached only if the listener above is gone: the same, so the panel never passes a key on.
          handleInput: (data: string) => {
            if (isKeyRepeat(data) && matchesKey(data, PANEL_KEY)) return;
            if (matchesKey(data, PANEL_KEY)) close();
            else view.handleInput(data);
            tui.requestRender();
          },
          handleMouse: (event: Parameters<NonNullable<ReturnType<typeof createSidePanel>["handleMouse"]>>[0]) => view.handleMouse(event),
          invalidate: () => view.invalidate(),
          dispose: () => {
            unlisten();
            clearInterval(timer);
            undock?.();
            if (panel === entry) panel = undefined;
          },
        } as { render(width: number): string[]; dispose?(): void };
        return component as never;
      },
      {
        overlay: true,
        // The whole screen, or the columns on the right beside the chat - read at each frame, so it follows the terminal.
        overlayOptions: {
          get width() {
            return panelBeside() > 0 ? panelBeside() : "100%";
          },
          maxHeight: "100%",
          anchor: "top-right",
          margin: 0,
        },
        onHandle: (handle) => {
          if (panel !== undefined) panel.handle = handle;
        },
      },
    );
  };

  // /pulses opens the side panel on every pulse, regenerating, planned and finished, and what each regenerates; regen -
  // the spec, with how far the code has been regenerated into it - is PANEL_KEY's, no command of its own beside
  // /regenerate. What the agents did is in each pulse's log.
  pi.registerCommand("pulses", {
    description: `The pulses, in the side panel: every pulse, regenerating, planned and finished, and what each regenerates. ${PANEL_KEY} opens the panel too.`,
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      openPanel(ctx, "pulses");
    },
  });

  panelOpeners.set(jobs, (ctx) => openPanel(ctx));
  questionPeek = {
    open: (ctx) => openPanel(ctx),
    shown: () => panel !== undefined && panel.keys,
  };

  pi.registerShortcut(PANEL_KEY, {
    description: "Peek at regen and the pulses - a question waiting in the chat waits for you - or go back to it",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      openPanel(ctx);
    },
  });

  // /turri-config: every setting of config.turri.yaml from the chat, each taking effect as it says - what turri fixed at its
  // start changed here, as it runs.
  registerTurriConfig(pi, {
    cwd,
    rules: () => loadRules(join(PACKAGE_ROOT, "genome", "rules")).map((rule) => rule.name),
    chatSpec: () => modelSpec(projectModels(readProjectConfig(cwd)).harness),
    live: {
      chatModel: async (spec, ctx) => {
        if (spec === undefined) return "The conversation keeps the model it runs on now; turri starts on pi's own choice next time.";
        const { model, thinking } = splitModelSpec(spec);
        if (model !== undefined) {
          const resolved = resolveModel(model, ctx.modelRegistry);
          if (!resolved.ok) return `The conversation keeps its model: ${model} cannot be used here.\n${describeResolution(resolved)}`;
          const slash = resolved.model.indexOf("/");
          const found = ctx.modelRegistry.find(resolved.model.slice(0, slash), resolved.model.slice(slash + 1));
          if (found === undefined || !(await pi.setModel(found))) return `The conversation keeps its model: ${resolved.model} could not be switched to.`;
        }
        if (thinking !== undefined) pi.setThinkingLevel(thinking);
        return `The conversation runs on ${spec} now.`;
      },
      codingModel: () => {
        const dropped: string[] = [];
        // What the session chose wins over the file; changed in the file, the file's holds from now on.
        if (process.env[CODING_MODEL_ENV] !== undefined) {
          dropped.push(`--coding-model ${process.env[CODING_MODEL_ENV]}`);
          delete process.env[CODING_MODEL_ENV];
        }
        for (const work of Object.keys(chosenModels) as Array<keyof ModelChoices>) {
          dropped.push(`the engine's ${work === "all" ? "" : `${work.replace(/_/g, " ")} `}model ${chosenModels[work]}`);
          delete chosenModels[work];
        }
        return dropped.length === 0 ? undefined : `Chosen this session, and given way to the config: ${dropped.join("; ")}.`;
      },
      parallelJobs: (count) => {
        const limit = count ?? parallelJobs(cwd);
        jobs.setMaxRunning(limit);
        return `Up to ${limit} pulse${limit === 1 ? "" : "s"} run at once now.`;
      },
    },
  });
}

export { fromWorkingDir };

const WATCH_REDRAW_MS = 500;
/**
 * What the agent is to do with a job that just ended, unasked: what the project's guidance says to do then, or else say
 * in a line or two what ended - the person saw it end already, in the transcript.
 */
export const JOB_FINISHED_REACTION = [
  "React to this now - the person has not asked, and need not. If guidance for this project - its AGENTS.md, a skill,",
  "what the person said earlier - says what to do when a pulse finishes (release what was built, run something, tell",
  "someone), do that, as it says. Otherwise say in a line or two what finished and what it means for the person - the",
  "report is theirs to read in full; do not repeat it - and, when it failed, what they can do. Start no other work.",
  "A report that says \"Released after the pulse\" was released by turri itself, as the pulse's last stage: do not call",
  "release for it - say in a line what was released, or why nothing was.",
  "A pulse that stopped on its environment - \"stopped: turri's sandbox kept its agents from…\" or \"stopped: the",
  "environment lacks…\" - stops the same way again until that is fixed: never regenerate it before. Heal it, then regenerate the",
  "module to resume:",
  "- turri's sandbox kept the agents from reading a folder on this machine: nothing is missing. Add the folder its report",
  "  names to `toolchains:` in config.turri.yaml - a list, keeping what is there - say so in a line, and resume.",
  "- turri's sandbox kept the agents from writing a file - a lock a build tool takes, say: no setting lets them, and",
  "  `toolchains:` does not - never add it there, and never resume before the fix. Do what the report says if it is the",
  "  project's to change - a tool told to use `$HOME` in the build's own files - say so, and resume; otherwise tell the",
  "  person, in a line or two, what the report says and that \"resume\" picks it up once it is done.",
  "- the machine lacks a toolchain or a tool - a JDK, Maven, Gradle, Go, uv, Node, a system library: first find out, in your",
  "  shell, whether it is installed somewhere off the PATH (`command -v`, Homebrew's opt folders, /Library/Java/",
  "  JavaVirtualMachines, a version manager the person uses - mise, asdf, sdkman, nvm). Then ask the person with ask_user",
  "  to let you put it in place the way this machine installs things - the exact command, `brew install openjdk@21`,",
  "  `mise use -g java@21`, `sdk install maven` - and on yes run it in your shell, check that the command is found now as",
  "  the testing script would find it (`command -v`, `turri doctor`), and resume. A tool installed where the PATH turri",
  "  was started with does not reach needs turri restarted: say so, with the line for the shell profile. On no, or when it",
  "  needs what you cannot do - sudo with a password, a licence, a download behind a login - tell the person exactly what",
  "  to do, and that \"resume\" picks it up once it is in.",
  "- a credential `agent-env:` names that is not there: never make one up - tell the person where it is read from.",
].join("\n");

/** The keys that go to the chat and to the panel, side by side: ⌥⌘← and ⌥⌘→. */
const SIDE_KEYS = { chat: "alt+super+left", panel: "alt+super+right" } as const;

/** Opens the side panel, and goes back to it from the conversation. */

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
  if (all.length === 0) return `No pulses have been started.${listed}`;
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
      return `${job.id}  ${(planned ? "planned" : job.status).padEnd(9)} ${time.padStart(7)}  ${pulseName(job)}${model}${after}${spent ? `  · ${spent}` : ""}`;
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
      "Say how the work is to be planned from now on - which functional specs are regenerated together, what goes first, how " +
      "big a pulse may be - for the whole project, or one module: every plan after this follows it as a strong preference, " +
      "within the planner's limits, for the rest of the session. It changes nothing queued by itself: the next plan of the " +
      "module follows it - regenerate makes one now. What the project's AGENTS.md says under a heading " +
      "naming the queue is followed too, with every plan.",
    promptSnippet: "steer how the work is planned, for the project or one module",
    promptGuidelines: [
      "When the user says how the work should be cut or ordered - 'build the batch worker's helpers with the worker', 'models first' - for more than one change, call steer with it in their words. For one change only, pass it as the guidance of regenerate.",
      "After steering, call regenerate to plan again. Where its reply lists what the plan did not do as asked, tell the user that and the reasons it gives - never a reason of your own.",
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
 * regenerate/release.ts), installing what it needs in its own shell - nothing is put to the person. What it
 * started is stopped when the session ends.
 */
const SIDE_ENTRY = "turri_btw";

/**
 * /btw, a question on the side (btw.ts): answered at once, even while a skill runs - pi runs a command mid-turn - and
 * shown in the transcript, never in a model's context.
 */
function registerSideQuestions(pi: ExtensionAPI, cwd: string, jobs: JobRegistry) {
  pi.registerCommand("btw", {
    description: "Ask turri something on the side - answered now, even mid-skill, and left out of the conversation: /btw <question>",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (question === "") return ctx.ui.notify(BTW_HOW, "info");
      ctx.ui.notify(`Looking into it: ${question}`, "info");
      // Not awaited: the editor is free while it is answered, for another /btw or the conversation.
      void askOnTheSide(pi, ctx, cwd, jobs, question).catch((error: unknown) =>
        ctx.ui.notify(`The side question could not be answered: ${error instanceof Error ? error.message : String(error)}`, "error"),
      );
    },
  });

  pi.registerEntryRenderer(COMMAND_OUTCOME, (entry, _options, theme) => {
    const data = entry.data as CommandOutcome | undefined;
    if (data === undefined) return undefined;
    const box = new Box(1, 0);
    // The command as typed; what it said, under it - or, said without it above, with it.
    const said = data.text !== undefined ? theme.fg(data.level === undefined || data.level === "info" ? "text" : data.level, data.text) : undefined;
    const lines = data.text === undefined ? [theme.bold(theme.fg("accent", data.command))] : data.echoed === true ? [said!] : [theme.fg("muted", data.command), said!];
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });

  pi.registerEntryRenderer(SIDE_ENTRY, (entry, _options, theme) => {
    const data = entry.data as { question: string; answer: string } | undefined;
    if (data === undefined) return undefined;
    const box = new Box(1, 0);
    box.addChild(new Text([theme.fg("muted", `btw: ${data.question}`), theme.fg("text", data.answer)].join("\n"), 0, 0));
    return box;
  });
}

/** A side question answered - from the conversation, the skill running, the pulses - and kept in the transcript. */
async function askOnTheSide(pi: ExtensionAPI, ctx: ExtensionContext, cwd: string, jobs: JobRegistry, question: string): Promise<string> {
  let entries: unknown[] = [];
  try {
    entries = ctx.sessionManager.getEntries();
  } catch {
    // Without the conversation it is still answered, from the skill and the project.
  }
  const skill = runningSkill();
  const answer = await answerSideQuestion(
    {
      question,
      conversation: transcriptOf(entries, 24_000),
      ...(skill !== undefined ? { skill: { name: skill.skill, dir: skill.dir, step: skill.step(), trace: skill.trace(), session: skillSessionText(skill.runDir) } } : {}),
      pulses: jobs.list().map((job) => `${job.id} ${job.status}: ${pulseName(job)}`),
      projectDir: cwd,
      harnessDir: PACKAGE_ROOT,
    },
    chatModelOf(ctx),
  );
  try {
    pi.appendEntry(SIDE_ENTRY, { question, answer });
  } catch {
    // Shown where it was asked all the same.
  }
  return answer;
}

function registerDeploy(pi: ExtensionAPI, cwd: string, jobs: JobRegistry, state: DeployState) {
  const tools = createDeployTools({
    cwd,
    state,
    jobs,
    workLoop: () => workLoops.get(jobs)?.loop,
    defaultPlainFile: () => readProjectConfig(cwd).module,
  });
  for (const tool of tools) pi.registerTool(tool);
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
    promptSnippet: "validate a .plain spec, regenerating nothing",
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
    // Its module, kind and number - never what it regenerates, which is the agents' words and long.
    summary: pulseName(job),
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
    "   and regenerate it - its conformance tests follow it.",
    "If analyze-2-func-specs finds the two compatible, tell the user so, and that the conformance tests of these two are what",
    "kept failing - offer to conform them again.",
  ].join("\n");
}

const INTERVIEW_ENTRY = "turri_exchange";

/**
 * A skill's question as the transcript keeps it: who asked, what it said before asking - a brief to confirm, the choices
 * it weighed, shown in the dialog that is gone once answered - the question, and the answer.
 */
export function exchangeLines(data: Exchange, fg: (color: "muted" | "text" | "dim" | "accent", text: string) => string): string[] {
  const said = data.said !== undefined ? data.said.split("\n").map((line) => fg("text", line)) : [];
  const answer = data.answer.trim() === "" ? fg("dim", "> (no answer)") : fg("accent", `> ${data.answer}`);
  return [fg("muted", `${data.skill} asked`), ...said, ...(said.length > 0 ? [""] : []), fg("text", data.question), answer];
}

export interface Exchange {
  skill: string;
  /** What the skill's agent said before asking - a brief to confirm, the choices it weighed: shown in the dialog, kept here. */
  said?: string;
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
    // Its headline only: the chat has the whole report, and says what it means - or does what the project says to. One
    // that went wrong says where to see why: the live panel, which said it, is gone with the last pulse.
    const wrong = data.status !== "succeeded" || data.incomplete === true;
    const box = new Box(1, 0);
    box.addChild(new Text(header + spent + (wrong ? `\n${theme.fg("muted", `  ${PANEL_KEY} shows this pulse - its stages, what its agents did, its log`)}` : ""), 0, 0));
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
    box.addChild(new Text([theme.fg("muted", "pulses"), theme.fg("text", data.text)].join("\n"), 0, 0));
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
    const box = new Box(1, 0);
    box.addChild(new Text(exchangeLines(data, (color, text) => theme.fg(color, text)).join("\n"), 0, 0));
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
 * adds a wordmark of its own at the top of the session. `turri` starts pi without
 * its header (see pi-launch.ts), leaving only this one.
 */
/**
 * The ***plain rules as the conversation has them in its system prompt, every turn - the standard library's
 * inventory among them, in its rule, so the conversation knows what a spec can import from the start.
 */
export function chatRulesBlock(rules = loadRules(join(PACKAGE_ROOT, "genome", "rules"))): string {
  return renderRulesBlock(rules);
}

function registerBranding(
  pi: ExtensionAPI,
  ruleCount: number,
  skills: SkillCatalogue,
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
          /** The commit, when turri runs from a clone - and whether the clone has changes on it. */
          commit?: string;
          changed?: boolean;
          rules: number;
          skills: number;
          /** Of them, the project's own. */
          projectSkills?: number;
          pending: number;
          stdlib?: number;
          cwd: string;
          sandbox?: ReturnType<typeof sandboxSummary>;
        }
      | undefined;
    if (data === undefined) return undefined;

    const lines = [
      `${theme.fg("accent", "turri")}  ${theme.fg("muted", `v${data.version}`)}` +
        (data.commit !== undefined ? theme.fg("dim", `  from a clone, ${data.commit}${data.changed ? " with changes" : ""}`) : ""),
      theme.fg("text", "regenerative software - the code is regenerated from the spec"),
      theme.fg(
        "muted",
        `${data.rules} rules · ${data.skills} skill${data.skills === 1 ? "" : "s"}` +
          (data.projectSkills !== undefined && data.projectSkills > 0 ? ` (${data.projectSkills} the project's)` : "") +
          (data.stdlib !== undefined && data.stdlib > 0 ? ` · ${data.stdlib} stdlib stacks (/stdlib)` : "") +
          (data.pending > 0 ? theme.fg("warning", `  (${data.pending} failed to load)`) : ""),
      ),
      // Where the settings are changed, without leaving the chat.
      theme.fg("muted", "configure with /turri-config"),
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
    if (ctx.hasUI) animateJellyfish(ctx);
    try {
      const identity = turriIdentity();
      pi.appendEntry(BANNER_ENTRY, {
        version: identity.version ?? "0.0.0",
        commit: identity.git_commit?.slice(0, 7),
        changed: identity.git_dirty === true,
        rules: ruleCount,
        skills: skills.skills.length,
        projectSkills: skills.skills.filter((skill) => skill.origin !== "turri").length,
        pending: skills.pending.length,
        stdlib: stdlibStackCount(),
        cwd: ctx.cwd,
        sandbox: sandboxSummary(),
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
 * spacer - hands it over. Once the conversation is taller than the screen the banner has scrolled off,
 * and a line changing up there would have pi-tui clear and redraw everything, frame after frame: the
 * jellyfish stops on the frame it is at, for the rest of the session.
 */
function animateJellyfish(ctx: ExtensionContext): void {
  if (jellyfishTimer !== undefined) clearInterval(jellyfishTimer);
  jellyfishTimer = undefined;
  ctx.ui.setWidget(
    JELLYFISH_CLOCK_KEY,
    (tui) => {
      drawOverlaysBesidePicture(tui);
      const timer = setInterval(() => {
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

/** The columns the banner's picture takes from the left edge, while it shows one; 0 when it does not. */
let pictureRight = 0;

/**
 * pi-tui draws no overlay over a line holding an image: it leaves the line as it is, and the side panel
 * would have a gap on the banner's row that carries the picture. So that row's text gets the overlay as
 * any other does, and the picture goes back on after it - unless the overlay reaches over the picture,
 * which is then left out of that row until it no longer does.
 */
function drawOverlaysBesidePicture(tui: TUI): void {
  const target = tui as unknown as { compositeLineAt?: (base: string, overlay: string, col: number, width: number, total: number) => string; turriPicture?: true };
  if (target.turriPicture === true || typeof target.compositeLineAt !== "function") return;
  target.turriPicture = true;
  const original = target.compositeLineAt.bind(tui);
  target.compositeLineAt = (base, overlay, col, width, total) => overPictureRow(base, overlay, col, width, total, pictureRight) ?? original(base, overlay, col, width, total);
}

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
    // Wrapped in the columns beside the picture, never cut short - the chat beside the docked panel is narrow.
    const text = this.lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width - 1 - left)));
    const height = Math.max(text.length, placed?.rows ?? 0);
    const above = Math.floor((height - text.length) / 2);
    const drawn = placed?.kind === "text" ? placed.frames[jellyfishFrame % placed.frames.length]! : undefined;
    const rows = Array.from({ length: height }, (_, row) => {
      const line = text[row - above];
      const jellyfish = drawn !== undefined ? (drawn[row] ?? " ".repeat(placed!.columns)) : " ".repeat(placed?.columns ?? 0);
      const before = placed !== undefined ? ` ${jellyfish}${" ".repeat(JELLYFISH_GAP)}` : " ";
      return line !== undefined ? `${before}${line}` : placed?.kind === "text" ? ` ${jellyfish}` : "";
    });
    // The side panel is drawn beside the picture (drawOverlaysBesidePicture), which goes on showing.
    pictureRight = placed?.kind === "image" ? 1 + placed.columns : 0;
    if (placed?.kind === "image") {
      const at = placed.onLastRow ? placed.rows - 1 : 0;
      rows[at] = `${rows[at]}${PICTURE_AT}${placed.sequence}`;
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
  | { kind: "text"; frames: string[][]; columns: number; rows: number };

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
      // Its frames one after another, each ended by a line of "---" (scripts/jellyfish-frames.mjs writes them).
      const drawn = readFileSync(join(dir, "fallback.txt"), "utf8")
        .split(/^---$/m)
        .map((frame) => frame.replace(/^\n+|\n+$/g, "").split("\n"))
        .filter((frame) => frame.some((line) => line.trim() !== ""));
      if (drawn.length === 0) return undefined;
      const columns = Math.max(...drawn.flat().map((line) => visibleWidth(line)));
      const rows = Math.max(...drawn.map((frame) => frame.length));
      return { kind: "text", frames: drawn.map((frame) => frame.map((line) => ink(line.padEnd(columns)))), columns, rows };
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
