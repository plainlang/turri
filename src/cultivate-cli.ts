import { createInterface } from "node:readline/promises";
import { relative } from "node:path";
import { describeGates, runSkill } from "./genome.ts";
import type { Decision, Reporter } from "./graph.ts";
import { runAsk } from "./ask.ts";
import { skillRunDir } from "./grow/paths.ts";
import { loadSkill } from "./skill.ts";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const reporter: Reporter = {
  step: (name, attempt) => console.log(`\n${c.bold(c.cyan(`> step ${name}`))} ${c.dim(`attempt ${attempt}`)}`),
  artifact: (path, body) => {
    console.log(c.dim(`  ${path}:`));
    for (const line of body.split("\n")) console.log(c.dim(`  | ${line}`));
  },
  gate: (name, judges) =>
    console.log(
      judges === 0
        ? `${c.bold(c.yellow(`> gate ${name}`))} ${c.dim("no artifact - failing without spending judges")}`
        : `${c.bold(c.yellow(`> gate ${name}`))} ${c.dim(`${judges} independent judges`)}`,
    ),
  livePass: (step, scope, findings) =>
    console.log(
      findings === 0
        ? c.dim(`  review ${step}: ${scope} - clean`)
        : `  ${c.yellow(`review ${step}`)}: ${scope} ${c.dim(`- ${findings} to fix`)}`,
    ),
  liveReview: (name, passes, findings) =>
    console.log(
      findings === 0
        ? `${c.bold(c.yellow(`> gate ${name}`))} ${c.dim(`reviewer read along in ${passes} passes, nothing outstanding`)}`
        : `${c.bold(c.yellow(`> gate ${name}`))} ${c.dim(`${findings} unresolved from the reviewer - failing without spending judges`)}`,
    ),
  judge: (index, model, verdict, violations) => {
    const mark = verdict === "pass" ? c.green("pass") : c.red(verdict);
    console.log(`  judge ${index + 1} ${c.dim(`(${model})`)}: ${mark}${violations ? c.dim(` (${violations})`) : ""}`);
  },
  outcome: (name, decision, critique) => {
    const colour: Record<Decision, (s: string) => string> = {
      advance: c.green,
      retry: c.yellow,
      escalate: c.yellow,
      abort: c.red,
    };
    console.log(`  ${c.bold(colour[decision](decision))} ${c.dim(`<- gate ${name}`)}`);
    if (critique) for (const line of critique.split("\n")) console.log(c.dim(`    ${line}`));
  },
};

async function main() {
  const args = process.argv.slice(2);
  const modelIndex = args.indexOf("--model");
  const model = modelIndex === -1 ? undefined : args[modelIndex + 1];
  const skillArg = args.filter((arg, i) => !arg.startsWith("--") && i !== modelIndex + 1)[0];

  if (!skillArg) {
    console.error("usage: turri cultivate <path-to-skill-dir> [--model provider/id]");
    process.exit(1);
  }

  const cwd = process.cwd();
  const skill = loadSkill(skillArg);
  console.log(c.bold(`skill: ${skill.name}`));
  for (const line of describeGates(skill)) console.log(`  ${c.dim(line)}`);

  const result = await runSkill({
    skillDir: skillArg,
    cwd,
    runDir: skillRunDir(cwd, skill.name),
    model,
    report: reporter,
    // The CLI has no dialogs, so options are numbered and either the number or the text
    // is accepted - the point is still to pick rather than to type the answer out.
    askUser: (request) =>
      runAsk(request, {
        select: async (title, options) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const list = options.map((option, i) => `  ${c.bold(String(i + 1))}. ${option}`).join("\n");
          const reply = (await rl.question(`\n${c.bold(c.cyan("? "))}${title}\n${list}\n> `)).trim();
          rl.close();
          const index = Number.parseInt(reply, 10);
          if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1];
          return reply === "" ? undefined : reply;
        },
        input: async (title) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const reply = (await rl.question(`\n${c.bold(c.cyan("? "))}${title}\n> `)).trim();
          rl.close();
          return reply === "" ? undefined : reply;
        },
      }),
    escalate: async ({ question, critique }) => {
      console.log(`\n${c.bold(c.yellow("! human review required"))}`);
      console.log(c.dim(critique));
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
      rl.close();
      return answer === "y";
    },
  });

  console.log(
    `\n${result.ok ? c.green(c.bold("run complete")) : c.red(c.bold("run aborted at a gate"))} ${c.dim(
      `artifacts in ${relative(cwd, skillRunDir(cwd, skill.name))}`,
    )}`,
  );
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
