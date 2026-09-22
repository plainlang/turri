import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ask, createExecutor } from "../pi.ts";
import { PLAIN_SOURCE_FILE_EXTENSION, plainFileParser } from "../plain/parser.ts";
import { getFrids, getSpecificationsForFrid } from "../plain/spec.ts";
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
const FIX_TOOLS = ["read", "write", "edit", "bash", "ls", "grep", "find", "run_unit_tests"];

const DEFAULT_MAX_ROUNDS = 3;

/**
 * Each functionality's conformance tests live in their own directory, so a regression run
 * can merge exactly the ones built so far.
 */
export function conformanceDirFor(moduleName: string, frid: string, root?: string): string {
  return join(root ?? join(process.cwd(), "conformance"), moduleName, frid);
}

const MAX_OUTPUT_CHARS = 20000;
const RUN_TIMEOUT_MS = 120_000;

export interface RenderConformanceTestsOptions {
  plainFile: string;
  frid?: string;
  templateDirs?: string[];
  /** The rendered code under test. Must exist and be non-empty. */
  buildDir?: string;
  /** Where the tests are written. Defaults to `<cwd>/conformance/<module>`. */
  conformanceDir?: string;
  onDelta?: (delta: string) => void;
  onRun?: (command: string, exitCode: number) => void;
  /** Rounds of triage-and-fix before giving up. */
  maxRounds?: number;
  onTriage?: (verdict: TriageVerdict) => void;
  /** "provider/model-id". Omitted: whatever pi is configured to use. */
  model?: string;
  dryRun?: boolean;
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
 * Run a command against a throwaway copy of the build with one or more sets of tests
 * laid over it.
 *
 * Several sets matter for regression: the tests of every functionality built so far are
 * merged into one run, which is the only way to notice that the newest one broke an older
 * one. They are flattened into the root so the language's own discovery finds them, and a
 * name that is already taken is prefixed with the directory it came from rather than
 * silently overwriting.
 *
 * A fresh sandbox per run means tests cannot accumulate state between attempts, and
 * whatever they write never touches the build directory.
 */
export function runInSandbox(
  buildDir: string,
  conformanceDirs: string | string[],
  command: string,
): { exitCode: number; output: string } {
  const dirs = (Array.isArray(conformanceDirs) ? conformanceDirs : [conformanceDirs]).filter((dir) =>
    existsSync(dir),
  );
  const sandbox = mkdtempSync(join(tmpdir(), "forge-conformance-"));

  try {
    cpSync(buildDir, sandbox, { recursive: true });

    const taken = new Set(listFiles(sandbox));
    for (const dir of dirs) {
      for (const file of listFiles(dir)) {
        const name = taken.has(file) ? join(dirname(file), `${basename(dir)}_${basename(file)}`) : file;
        taken.add(name);
        const target = join(sandbox, name);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(dir, file), target);
      }
    }

    const result = runCommand(sandbox, command);
    return { exitCode: result.exitCode, output: truncateOutput(result.output) };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function createReadTestFileTool(conformanceDir: string) {
  const root = resolve(conformanceDir);
  return defineTool({
    name: "read_test_file",
    label: "Read test file",
    description:
      "Read a file you have written in the conformance test directory. It cannot reach the " +
      "implementation - conformance tests are written from the specification, not from the code.",
    parameters: Type.Object({
      path: Type.String({ description: "Path relative to the conformance test directory" }),
    }),
    async execute(_id, params) {
      const target = resolve(root, params.path);
      if (relative(root, target).startsWith("..")) {
        throw new Error(
          `read_test_file: '${params.path}' is outside the conformance test directory. ` +
            "The implementation is a black box and cannot be read.",
        );
      }
      const { readFileSync } = await import("node:fs");
      return {
        content: [{ type: "text" as const, text: readFileSync(target, "utf8") }],
        details: { path: params.path },
      };
    },
  });
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

  const buildDir = resolve(options.buildDir ?? join(process.cwd(), "build", moduleName));
  const manifest = listFiles(buildDir);
  if (manifest.length === 0) {
    throw new Error(
      `Nothing to test: ${buildDir} is empty or missing. ` +
        `Render the functionality first, for example: npm run render -- ${options.plainFile} ${frid}`,
    );
  }

  const conformanceDir = resolve(
    options.conformanceDir ?? conformanceDirFor(moduleName, frid),
  );

  const [specifications] = getSpecificationsForFrid(tree, frid);
  const linkedResources = loadLinkedResources(tree, frid, templateDirs);
  const prompt = buildConformancePrompt({
    moduleName,
    frid,
    specifications,
    linkedResources,
    manifest,
    existingTests: listFiles(conformanceDir),
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
  const executor = await createExecutor({
    cwd: conformanceDir,
    customTools: [
      createReadTestFileTool(conformanceDir),
      createRunTool(buildDir, conformanceDir, runs, lastOutput, options.onRun),
      createTriageTool((verdict) => {
        pendingTriage = verdict;
        triage.push(verdict);
        options.onTriage?.(verdict);
      }),
    ],
    tools: CONFORMANCE_TOOLS,
    model: options.model,
  });

  try {
    let inventory = inventoryTests(conformanceDir);
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
      const fix = await runCodeFix({
        buildDir,
        moduleName,
        frid,
        specifications,
        verdict,
        failure: lastOutput.value,
        onDelta: options.onDelta,
        model: options.model,
      });
      codeFixes.push(fix);

      // The harness re-runs the same command itself, so the verdict on whether the fix
      // worked does not depend on either agent reporting it.
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

    return {
      moduleName,
      frid,
      buildDir,
      conformanceDir,
      prompt,
      response,
      files: listFiles(conformanceDir),
      runs,
      passed: runs[runs.length - 1]?.exitCode === 0,
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
  verdict: TriageVerdict;
  failure: string;
  onDelta?: (delta: string) => void;
  model?: string;
}): Promise<CodeFix> {
  const runs: TestRun[] = [];
  const session = await createExecutor({
    cwd: input.buildDir,
    customTools: [
      createRunTestsTool({
        name: "run_unit_tests",
        label: "Run unit tests",
        description: "Run the unit test suite in the working directory and return its exit code and output.",
        run: (command) => runCommand(input.buildDir, command),
        runs,
      }),
    ],
    tools: FIX_TOOLS,
    model: input.model,
  });

  try {
    const report = await ask(
      session,
      buildCodeFixPrompt({
        moduleName: input.moduleName,
        frid: input.frid,
        specifications: input.specifications,
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
