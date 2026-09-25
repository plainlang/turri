import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Testing scripts for a test project, in `test_scripts/` beside its specs - as the
 * implement-*-testing-script skills write them, cut down: stage the build in /tmp, run the suite.
 */
export const UNIT_SCRIPT = [
  "#!/bin/bash",
  'WORKING_FOLDER="/tmp/python_$(basename "$1")"',
  'rm -rf "$WORKING_FOLDER" && mkdir -p "$WORKING_FOLDER" && trap \'rm -rf "$WORKING_FOLDER"\' EXIT',
  'cp -R "$1"/. "$WORKING_FOLDER" && cd "$WORKING_FOLDER" || exit 2',
  "python3 -m unittest discover",
  "",
].join("\n");

export const CONFORMANCE_SCRIPT = [
  "#!/bin/bash",
  'WORKING_FOLDER="/tmp/python_$(basename "$1")"',
  'rm -rf "$WORKING_FOLDER" && mkdir -p "$WORKING_FOLDER" && trap \'rm -rf "$WORKING_FOLDER"\' EXIT',
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
