import { readProjectConfig, CONFIG_FILE } from "./config.ts";
import { createJobRegistry } from "./grow/jobs.ts";
import { createWorkLoop, describeDrift } from "./grow/loop.ts";

const USAGE = `usage: plainwright drift [file.plain]

How far the module's code has drifted from its spec, in each codebase where it lives: what is left to
grow, and the conformance tests left to write. Plans nothing, starts nothing, calls no model.`;

const [given] = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
const named = given ?? readProjectConfig(process.cwd()).module;
if (named === undefined) {
  console.error(`${USAGE}\n\nNo file given, and ${CONFIG_FILE} names no module.`);
  process.exit(1);
}
try {
  const loop = createWorkLoop({ registry: createJobRegistry(), cwd: process.cwd(), planner: false, dryRun: true });
  console.log(describeDrift(loop.drift(named)));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
