import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ask, createExecutor } from "../pi.ts";
import { PLAIN_SOURCE_FILE_EXTENSION, plainFileParser } from "../plain/parser.ts";
import { getFrids, getSpecificationsForFrid, TEST_REQUIREMENTS, getInheritedFunctionalSpecs } from "../plain/spec.ts";
import { reportStage } from "./activity.ts";
import { confinedTools } from "./confine.ts";
import { moduleDirOf, recordHistory } from "./history.ts";
import type { RequiredSpec } from "./state.ts";
import { defaultBuildDir, modulesRoot, testsDirUnder } from "./paths.ts";
import { buildCodeFixPrompt, buildConformancePrompt } from "./prompt.ts";
import { loadLinkedResources } from "./resources.ts";
import { resolveTemplateDirs } from "./render.ts";
import {
  createRunTestsTool,
  findTestRemovals,
  inventoryTests,
  listFiles,
  removalChallengePrompt,
  runCommand,
  truncateOutput,
  type TestRemoval,
  type TestRun,
} from "./testing.ts";

/**
 * Tools the conformance agent gets.
 *
 * Deliberately short. There is no `read`, `grep`, `find` or `bash`, so nothing in this
 * set can open a file in the build directory - the black box stays closed by the shape
 * of the tool surface rather than by the prompt asking nicely.
 */
const CONFORMANCE_TOOLS = [
  "write",
  "edit",
  "ls",
  "read_test_file",
  "run_conformance_tests",
  "submit_triage",
];

/** Tools the code-fixing agent gets: the mirror image - the code, never the tests. */
const FIX_TOOLS = ["run_unit_tests"];

const DEFAULT_MAX_ROUNDS = 3;

/**
 * A module's conformance tests: one directory, `plain_modules/<module>/tests`, organised
 * however the tests are best organised. It holds the tests of the modules it requires too,
 * copied up with their code, so running it is the regression suite of the whole chain.
 */
export function conformanceDirFor(moduleName: string, root?: string): string {
  return testsDirUnder(root ?? modulesRoot(), moduleName);
}

const MAX_OUTPUT_CHARS = 20000;
const RUN_TIMEOUT_MS = 120_000;

export interface RenderConformanceTestsOptions {
  plainFile: string;
  frid?: string;
  templateDirs?: string[];
  /** The rendered code under test. Must exist and be non-empty. */
  buildDir?: string;
  /** Where the tests are written. Defaults to `<cwd>/plain_modules/<module>/tests`. */
  conformanceDir?: string;
  onDelta?: (delta: string) => void;
  onRun?: (command: string, exitCode: number) => void;
  /** Rounds of triage-and-fix before giving up. */
  maxRounds?: number;
  onTriage?: (verdict: TriageVerdict) => void;
  /** "provider/model-id". Omitted: whatever pi is configured to use. */
  model?: string;
  dryRun?: boolean;
  /** Update the tests for a spec change, given as a diff, rather than for one functionality. */
  diff?: string;
}

export type Fault = "test_at_fault" | "code_at_fault";

export interface TriageVerdict {
  fault: Fault;
  reasoning: string;
}

export interface CodeFix {
  reasoning: string;
  report: string;
}

export interface RenderConformanceTestsResult {
  moduleName: string;
  frid: string;
  buildDir: string;
  conformanceDir: string;
  prompt: string;
  response: string;
  files: string[];
  runs: TestRun[];
  /** Whether the last observed conformance run passed. */
  passed: boolean;
  /** Each time a failure was attributed to the tests or to the code. */
  triage: TriageVerdict[];
  /** Fixes made to the implementation after a code_at_fault verdict. */
  codeFixes: CodeFix[];
  /** Conformance tests that went missing mid-run and had to be justified. */
  testRemovals: TestRemoval[];
}


/**
 * Run a command against the built code with one or more test sets laid over it.
 *
 * Neither the build nor the tests are touched: everything happens in a throwaway copy, so a
 * test run cannot leave anything behind in the codebase it is testing, and each run starts
 * from the same state as the last.
 *
 * Several sets merge for a regression run - every functionality built so far. A file that
 * would land on one already taken is renamed rather than overwritten, because two
 * functionalities are allowed to have written a `test_helpers.py` each and neither of them
 * should silently lose.
 */
export function runInSandbox(
  buildDir: string,
  conformanceDirs: string | string[],
  command: string,
): { exitCode: number; output: string } {
  const dirs = Array.isArray(conformanceDirs) ? conformanceDirs : [conformanceDirs];
  const sandbox = mkdtempSync(join(tmpdir(), "plainwright-conformance-"));

  try {
    cpSync(buildDir, sandbox, { recursive: true });

    const taken = new Set(listFiles(sandbox));
    dirs.forEach((dir, index) => {
      if (!existsSync(dir)) return;
      for (const file of listFiles(dir)) {
        let target = file;
        if (taken.has(target)) {
          const renamed = `${index + 1}_${basename(file)}`;
          target = dirname(file) === "." ? renamed : join(dirname(file), renamed);
        }
        taken.add(target);
        const destination = join(sandbox, target);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(join(dir, file), destination);
      }
    });

    return runCommand(sandbox, command);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function createTriageTool(onVerdict: (verdict: TriageVerdict) => void) {
  return defineTool({
    name: "submit_triage",
    label: "Submit triage",
    description:
      "State whether a failing conformance run is the fault of your test or of the implementation. " +
      "Call this once per failure, before fixing anything.",
    parameters: Type.Object({
      fault: Type.Union([Type.Literal("test_at_fault"), Type.Literal("code_at_fault")], {
        description:
          "test_at_fault when your test misreads the specification or is wrong; " +
          "code_at_fault when the code does not do what the specification says.",
      }),
      reasoning: Type.String({
        description:
          "What the specification requires, what the run showed, and why that makes this the test's or the code's fault.",
      }),
    }),
    async execute(_id, params) {
      onVerdict(params as TriageVerdict);
      return {
        content: [{ type: "text" as const, text: `Recorded: ${params.fault}.` }],
        details: params,
        terminate: true,
      };
    },
  });
}

function createRunTool(
  buildDir: string,
  conformanceDir: string,
  runs: TestRun[],
  lastOutput: { value: string },
  onRun?: (command: string, exitCode: number) => void,
) {
  return defineTool({
    name: "run_conformance_tests",
    label: "Run conformance tests",
    description:
      "Run a command against the built code with your tests laid over it, in a throwaway copy. " +
      "Use the command the test reqs specify. Returns the exit code and combined output.",
    promptSnippet: "run_conformance_tests: run your tests against the built code",
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command, e.g. "python -m unittest discover"' }),
    }),
    async execute(_id, params) {
      const { exitCode, output } = runInSandbox(buildDir, conformanceDir, params.command);
      runs.push({ command: params.command, exitCode });
      lastOutput.value = output;
      onRun?.(params.command, exitCode);
      return {
        content: [{ type: "text" as const, text: `exit code: ${exitCode}\n\n${output}` }],
        details: { command: params.command, exitCode },
      };
    },
  });
}

/**
 * Write black-box conformance tests for one functionality of a .plain specification.
 *
 * Runs after the functionality has been rendered: the build directory is the subject,
 * and this refuses to start without one.
 */
export async function renderConformanceTests(
  options: RenderConformanceTestsOptions,
): Promise<RenderConformanceTestsResult> {
  if (extname(options.plainFile) !== PLAIN_SOURCE_FILE_EXTENSION) {
    throw new Error(`Expected a ${PLAIN_SOURCE_FILE_EXTENSION} file, got '${options.plainFile}'.`);
  }

  const templateDirs = resolveTemplateDirs(options.plainFile, options.templateDirs);
  const [moduleName, tree] = plainFileParser(basename(options.plainFile), templateDirs);

  const frids = [...getFrids(tree)];
  const frid = options.frid ?? frids[0];
  if (frid === undefined) throw new Error(`Module '${moduleName}' has no functionalities.`);
  if (!frids.includes(frid)) {
    throw new Error(`Functionality ${frid} does not exist. Available: ${frids.join(", ")}.`);
  }

  const buildDir = resolve(options.buildDir ?? defaultBuildDir(moduleName));
  const manifest = listFiles(buildDir);
  if (manifest.length === 0) {
    throw new Error(
      `Nothing to test: ${buildDir} is empty or missing. ` +
        `Render the functionality first, for example: npm run render -- ${options.plainFile} ${frid}`,
    );
  }

  const conformanceDir = resolve(
    options.conformanceDir ?? conformanceDirFor(moduleName),
  );

  const [specifications] = getSpecificationsForFrid(tree, frid);

  // Conformance tests are written from the test reqs: they say how the suite is built and
  // run. Without them there is nothing to write tests against, and an agent asked anyway
  // would invent a convention that nothing else in the project shares.
  if (specifications[TEST_REQUIREMENTS].length === 0) {
    throw new Error(
      `Module '${moduleName}' has no ${TEST_REQUIREMENTS}, so conformance tests cannot be written. ` +
        `Add a ${TEST_REQUIREMENTS} section saying how conformance tests are written and run, or render ` +
        "with conformance turned off.",
    );
  }

  const linkedResources = loadLinkedResources(tree, frid, templateDirs);
  const required = getInheritedFunctionalSpecs(tree);
  const prompt = buildConformancePrompt({
    moduleName,
    frid,
    specifications,
    linkedResources,
    manifest,
    existingTests: listFiles(conformanceDir),
    required,
    diff: options.diff,
  });

  if (options.dryRun) {
    return {
      moduleName,
      frid,
      buildDir,
      conformanceDir,
      prompt,
      response: "",
      files: listFiles(conformanceDir),
      runs: [],
      passed: false,
      triage: [],
      codeFixes: [],
      testRemovals: [],
    };
  }

  mkdirSync(conformanceDir, { recursive: true });

  const runs: TestRun[] = [];
  const triage: TriageVerdict[] = [];
  const codeFixes: CodeFix[] = [];
  const testRemovals: TestRemoval[] = [];
  const lastOutput = { value: "" };

  let pendingTriage: TriageVerdict | undefined;
  // Reads the code, writes only its tests. Both live under `plain_modules/<module>`, which
  // is as far as this agent can see in either direction.
  const fence = confinedTools({
    workdir: conformanceDir,
    read: [buildDir],
    write: [conformanceDir],
  });
  const executor = await createExecutor({
    cwd: conformanceDir,
    customTools: [
      ...fence.tools,
      createRunTool(buildDir, conformanceDir, runs, lastOutput, options.onRun),
      createTriageTool((verdict) => {
        pendingTriage = verdict;
        triage.push(verdict);
        options.onTriage?.(verdict);
      }),
    ],
    tools: [...fence.names, ...CONFORMANCE_TOOLS],
    model: options.model,
  });

  try {
    let inventory = inventoryTests(conformanceDir);
    const stage = (label: string) => reportStage(`${moduleName} ${frid}: ${label}`);
    stage("writing conformance tests from the spec");
    let response = await ask(executor, prompt, options.onDelta);

    const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
    for (let round = 0; round < maxRounds; round += 1) {
      const current = inventoryTests(conformanceDir);
      const removals = findTestRemovals(inventory, current);
      if (removals.length > 0) {
        testRemovals.push(...removals);
        inventory = current;
        response = await ask(
          executor,
          removalChallengePrompt(removals, "conformance tests"),
          options.onDelta,
        );
        continue;
      }

      const last = runs[runs.length - 1];
      if (last?.exitCode === 0) break;

      if (last === undefined) {
        response = await ask(
          executor,
          "You have not run the tests yet. Call run_conformance_tests with the command the test reqs give.",
          options.onDelta,
        );
        continue;
      }

      if (pendingTriage === undefined) {
        stage("conformance tests failing - deciding whether the test or the code is wrong");
        response = await ask(
          executor,
          [
            `\`${last.command}\` exited ${last.exitCode}. Before changing anything, decide where the`,
            "fault lies and call submit_triage.",
            "",
            "Your test is at fault if it asserts something the specification does not require, or",
            "misreads what it does require. The code is at fault if the specification says one thing",
            "and the run shows another.",
          ].join("\n"),
          options.onDelta,
        );
        continue;
      }

      const verdict = pendingTriage;
      pendingTriage = undefined;

      if (verdict.fault === "test_at_fault") {
        stage("correcting a conformance test");
        response = await ask(
          executor,
          [
            `You judged the test at fault: ${verdict.reasoning}`,
            "",
            "Correct the test so it checks what the specification actually requires, then call",
            "run_conformance_tests again. Do not remove the test.",
          ].join("\n"),
          options.onDelta,
        );
        continue;
      }

      // The code is at fault, and this agent cannot see the code. Hand the failure to one
      // that can - and which in turn cannot see or edit the tests.
      stage("the code is at fault - fixing the implementation");
      const fix = await runCodeFix({
        buildDir,
        moduleName,
        frid,
        specifications,
        required,
        verdict,
        failure: lastOutput.value,
        onDelta: options.onDelta,
        model: options.model,
      });
      codeFixes.push(fix);

      // The harness re-runs the same command itself, so the verdict on whether the fix
      // worked does not depend on either agent reporting it.
      stage("re-running the conformance tests against the fix");
      const recheck = runInSandbox(buildDir, conformanceDir, last.command);
      runs.push({ command: last.command, exitCode: recheck.exitCode });
      lastOutput.value = recheck.output;
      options.onRun?.(last.command, recheck.exitCode);
      if (recheck.exitCode === 0) break;

      response = await ask(
        executor,
        [
          "The implementation was changed to address your verdict, but the tests still fail:",
          "",
          recheck.output,
          "",
          "Triage again with submit_triage.",
        ].join("\n"),
        options.onDelta,
      );
    }

    const passed = runs[runs.length - 1]?.exitCode === 0;
    // The tests, and the code when a fix changed it: one commit if they share a module folder.
    const subject =
      `conformance ${moduleName} ${options.diff !== undefined ? "for a spec change" : `fs ${frid}`} ` +
      `(${passed ? "pass" : "NOT passing"}${codeFixes.length > 0 ? `, ${codeFixes.length} code fix(es)` : ""})`;
    recordHistory(conformanceDir, subject);
    if (moduleDirOf(buildDir) !== moduleDirOf(conformanceDir)) recordHistory(buildDir, subject);

    return {
      moduleName,
      frid,
      buildDir,
      conformanceDir,
      prompt,
      response,
      files: listFiles(conformanceDir),
      runs,
      passed,
      triage,
      codeFixes,
      testRemovals,
    };
  } finally {
    executor.dispose();
  }
}

/** Run a coding agent against the build to fix what conformance caught. */
async function runCodeFix(input: {
  buildDir: string;
  moduleName: string;
  frid: string;
  specifications: Parameters<typeof buildCodeFixPrompt>[0]["specifications"];
  required: RequiredSpec[];
  verdict: TriageVerdict;
  failure: string;
  onDelta?: (delta: string) => void;
  model?: string;
}): Promise<CodeFix> {
  const runs: TestRun[] = [];
  const fixFence = confinedTools({
    workdir: input.buildDir,
    read: [],
    write: [input.buildDir],
  });
  const session = await createExecutor({
    cwd: input.buildDir,
    customTools: [
      ...fixFence.tools,
      createRunTestsTool({
        name: "run_unit_tests",
        label: "Run unit tests",
        description: "Run the unit test suite in the working directory and return its exit code and output.",
        run: (command) => runCommand(input.buildDir, command),
        runs,
      }),
    ],
    tools: [...fixFence.names, ...FIX_TOOLS],
    model: input.model,
  });

  try {
    const report = await ask(
      session,
      buildCodeFixPrompt({
        moduleName: input.moduleName,
        frid: input.frid,
        specifications: input.specifications,
        required: input.required,
        triage: input.verdict.reasoning,
        failure: input.failure,
      }),
      input.onDelta,
    );
    return { reasoning: input.verdict.reasoning, report };
  } finally {
    session.dispose();
  }
}
