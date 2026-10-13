// Mutation testing: how much of what the code does the test suite would notice going wrong. `npm run mutation` runs it a
// part at a time (scripts/mutation.mjs), each part's report in reports/mutation/<part>/ - stopped, it goes on from the
// first part with no report. Per-test coverage runs each mutant against only the tests that reach its code.

/** The core of regeneration: how work is planned, what is built and left, and how a spec is cut into steps. */
export const PARTS = {
  "chunk-plan": ["src/regenerate/chunk-plan.ts"],
  "spec-steps": ["src/regenerate/spec-steps.ts"],
  records: ["src/regenerate/records.ts"],
  drift: ["src/regenerate/drift.ts", "src/regenerate/cases.ts", "src/regenerate/lanes.ts", "src/regenerate/steering.ts"],
};

const part = process.env.TURRI_MUTATION_PART;
const mutate = part !== undefined ? PARTS[part] : Object.values(PARTS).flat();
if (mutate === undefined) throw new Error(`No mutation part ${part}: ${Object.keys(PARTS).join(", ")}`);
const out = `reports/mutation/${part ?? "all"}`;

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  // Which tests reach a mutant comes from per-test coverage: vitest's own guess at related files finds none for a mutant.
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
  coverageAnalysis: "perTest",
  mutate,
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: `${out}/mutation.html` },
  jsonReporter: { fileName: `${out}/mutation.json` },
  // A part run again reuses what an earlier run found for code and tests that did not change.
  incremental: true,
  incrementalFile: `${out}/incremental.json`,
  concurrency: 6,
  timeoutMS: 60_000,
  // The first run, which finds what each test reaches, is the whole suite in one worker.
  dryRunTimeoutMinutes: 20,
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
};
