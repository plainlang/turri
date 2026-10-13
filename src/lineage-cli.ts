import { defaultBuildDir } from "./regenerate/paths.ts";
import { historyLog, historyShow } from "./regenerate/lineage.ts";

const USAGE = `usage: turri lineage <module> [commit]

A module's lineage: every generation of its code and tests, and what each was regenerated from, as git commits.
With a commit, that commit in full.`;

const [module, commit] = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
if (module === undefined || process.argv.includes("--help")) {
  console.log(USAGE);
  process.exit(module === undefined ? 1 : 0);
}
const buildDir = defaultBuildDir(module, process.cwd());
console.log(commit !== undefined ? historyShow(buildDir, commit) : historyLog(buildDir));
