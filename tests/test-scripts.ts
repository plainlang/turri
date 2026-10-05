import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { onTestFinished } from "vitest";

/**
 * Testing scripts for a test project, in `test_scripts/` beside its specs - as the
 * implement-*-testing-script skills write them, cut down: stage the build in a fresh temp folder, run the suite.
 */
export const UNIT_SCRIPT = [
  "#!/bin/bash",
  // A folder of its own each run: on the host, test files running side by side would share one /tmp/python_code.
  'WORKING_FOLDER="$(mktemp -d)" && trap \'rm -rf "$WORKING_FOLDER"\' EXIT',
  'cp -R "$1"/. "$WORKING_FOLDER" && cd "$WORKING_FOLDER" || exit 2',
  "python3 -m unittest discover",
  "",
].join("\n");

export const CONFORMANCE_SCRIPT = [
  "#!/bin/bash",
  // A folder of its own each run: on the host, test files running side by side would share one /tmp/python_code.
  'WORKING_FOLDER="$(mktemp -d)" && trap \'rm -rf "$WORKING_FOLDER"\' EXIT',
  'cp -R "$1"/. "$WORKING_FOLDER" && cd "$WORKING_FOLDER" || exit 2',
  'python3 -m unittest discover -s "$2" -t "$2"',
  "",
].join("\n");

export function writeTestScripts(
  projectDir: string,
  scripts: { unit?: string; conformance?: string } = { unit: UNIT_SCRIPT, conformance: CONFORMANCE_SCRIPT },
): void {
  const dir = join(projectDir, "test_scripts");
  mkdirSync(dir, { recursive: true });
  if (scripts.unit !== undefined) writeFileSync(join(dir, "run_unittests_python.sh"), scripts.unit);
  if (scripts.conformance !== undefined) writeFileSync(join(dir, "run_conformance_tests_python.sh"), scripts.conformance);
}

/**
 * Where the testing scripts run for the rest of this test, when its project's config does not say: in the VM, for a test
 * about running them there - the suite has them on the host (tests/setup.ts) - or, undefined, as nothing set it.
 */
export function scriptsInForThisTest(where: "vm" | undefined): void {
  const before = process.env.TURRI_TESTING_SCRIPTS_IN;
  if (where === undefined) delete process.env.TURRI_TESTING_SCRIPTS_IN;
  else process.env.TURRI_TESTING_SCRIPTS_IN = where;
  onTestFinished(() => {
    if (before === undefined) delete process.env.TURRI_TESTING_SCRIPTS_IN;
    else process.env.TURRI_TESTING_SCRIPTS_IN = before;
  });
}
