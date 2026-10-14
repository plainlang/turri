#!/usr/bin/env node
// Mutation testing a part at a time (stryker.config.mjs PARTS): a part with a report is done and skipped, so a run that
// is stopped goes on from the part it was in. `npm run mutation` runs every part left; `npm run mutation -- <part> ...`
// those named, again; `npm run mutation -- --summary` only sums up the reports there are; `--list` prints the parts named,
// or every part, as JSON - the mutation workflow's jobs, read before any npm install.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PARTS } from "../stryker.config.mjs";

const reportOf = (part) => `reports/mutation/${part}/mutation.json`;

/**
 * Stryker's vitest runner, as this suite needs it - set again after every npm install undoes it:
 * - forked workers, not threads: the tests change the working directory, which a worker thread cannot;
 * - a test-name filter that matches vitest 5's names, whose suites are joined with " > ", not a space - without it a
 *   mutant runs no test at all, and every one survives.
 */
function fixRunner() {
  // Not among what the package exports: read where npm puts it.
  const file = "node_modules/@stryker-mutator/vitest-runner/dist/src/vitest-test-runner.js";
  let text = readFileSync(file, "utf8");
  const fixes = [
    ["            pool: 'threads',\n            maxWorkers: 1,", "            pool: 'forks',\n            maxWorkers: 1,"],
    [".map(({ test: name }) => escapeRegExp(name))", ".map(({ test: name }) => escapeRegExp(name).replace(/ /g, '(?: | > )'))"],
  ];
  for (const [from, to] of fixes) {
    if (text.includes(to)) continue;
    if (!text.includes(from)) throw new Error(`Stryker's vitest runner changed: ${file} no longer has\n${from}\nSee scripts/mutation.mjs.`);
    text = text.replace(from, to);
  }
  writeFileSync(file, text);
}

function summary() {
  const rows = [];
  for (const part of Object.keys(PARTS)) {
    if (!existsSync(reportOf(part))) {
      rows.push(`  ${part.padEnd(12)} not run yet`);
      continue;
    }
    const report = JSON.parse(readFileSync(reportOf(part), "utf8"));
    for (const [file, { mutants }] of Object.entries(report.files)) {
      const count = (status) => mutants.filter((mutant) => mutant.status === status).length;
      const killed = count("Killed") + count("Timeout");
      const covered = killed + count("Survived");
      const score = covered > 0 ? ((100 * killed) / covered).toFixed(1) : "-";
      rows.push(`  ${file.padEnd(28)} ${String(mutants.length).padStart(5)} mutants · killed ${killed} · survived ${count("Survived")} · no coverage ${count("NoCoverage")} · score (covered) ${score}%`);
    }
  }
  console.log(`\nmutation testing, by file:\n${rows.join("\n")}`);
}

const args = process.argv.slice(2);
if (args.includes("--summary")) {
  summary();
  process.exit(0);
}
const named = args.filter((arg) => !arg.startsWith("--"));
for (const part of named) if (!(part in PARTS)) throw new Error(`No mutation part ${part}: ${Object.keys(PARTS).join(", ")}`);
if (args.includes("--list")) {
  console.log(JSON.stringify(named.length > 0 ? named : Object.keys(PARTS)));
  process.exit(0);
}
const parts = named.length > 0 ? named : Object.keys(PARTS).filter((part) => !existsSync(reportOf(part)));
if (parts.length === 0) console.log("Every part has a report - name one to run it again.");
fixRunner();
for (const part of parts) {
  console.log(`\n── mutation testing ${part}: ${PARTS[part].join(", ")}`);
  const run = spawnSync("npx", ["stryker", "run"], { stdio: "inherit", env: { ...process.env, TURRI_MUTATION_PART: part } });
  if (run.status !== 0) {
    console.error(`\n${part} did not finish (exit ${run.status ?? run.signal}): run again to go on from it.`);
    process.exit(1);
  }
}
summary();
