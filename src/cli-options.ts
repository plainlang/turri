import { booleanOption, conformanceOption, overrideConfig, splitModelSpec } from "./config.ts";

/**
 * The command line of turri's commands: their words, and the options that stand for the config's own keys - kept apart
 * from the commands that use them, so a light one (doctor) reads them as a regenerate does without loading it.
 */

/**
 * A command's arguments: the positional ones, `--flag`s and `--name value` options (`--name=value` too) -
 * `--coding-model` is `--model`. An option it does not take is refused, rather than taking the word after it, and so is an
 * option with no value - the end of the words, or another option where its value should be.
 */
export function parseArgs(argv: string[], flags: string[], usage: string, valued: string[] = []): { positional: string[]; options: Record<string, string | undefined> } {
  const positional: string[] = [];
  const options: Record<string, string | undefined> = {};
  const takes = new Set(["--model", ...valued]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const [name, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const option = name === "--coding-model" ? "--model" : name;
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    } else if (flags.includes(option) && inline === undefined) options[option.slice(2)] = "yes";
    else if (takes.has(option)) {
      // Its value is the next word - never another option, which would be taken as the value and lost.
      const value = inline ?? argv[i + 1];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) {
        console.error(`${usage}\n\n${name} needs a value${value !== undefined ? `, not the option ${value}` : ""} - ${name}=<value> gives one that starts with --.`);
        process.exit(1);
      }
      if (inline === undefined) i += 1;
      options[option.slice(2)] = value;
    }
    else if (arg.startsWith("-")) {
      console.error(`${usage}\n\nNo such option: ${name}.`);
      process.exit(1);
    } else positional.push(arg);
  }
  return { positional, options };
}

/** An option's value, as parseArgs left it: refused when it was given with none. */
export function optionValue(options: Record<string, string | undefined>, name: string): string | undefined {
  const value = options[name];
  if (name in options && (value === undefined || value.trim() === "")) failOption(`--${name} needs a value`);
  return value;
}

/**
 * The options that stand for the config's own keys - `--harness-model`, `--coding-model` (`--model`), `--judge-model`
 * and, as asked, `--review`, `--mutation-testing` and `--conformance-tests` - read as if config.turri.yaml had them, in their place in the
 * order the config resolves them in (overrideConfig): a run, or doctor, with them is the same as one with them in the
 * file. Exits on a value it cannot read.
 */
export function configKeyOptions(options: Record<string, string | undefined>, take: { conformance?: boolean; review?: boolean } = {}): void {
  const flag = (name: string): boolean | undefined => {
    const given = take.review === true ? optionValue(options, name) : undefined;
    const value = given !== undefined ? booleanOption(given) : undefined;
    if (given !== undefined && value === undefined) failOption(`--${name} takes true or false, not ${given}`);
    return value;
  };
  const tests = take.conformance === true ? optionValue(options, "conformance-tests") : undefined;
  const setting = tests !== undefined ? conformanceOption(tests) : undefined;
  if (tests !== undefined && setting === undefined) failOption(`--conformance-tests takes all, chosen, module or false, not ${tests}`);
  const review = flag("review");
  const mutationTesting = flag("mutation-testing");
  const model = (name: string, key: "harnessModel" | "codingModel" | "judgeModel") => {
    const spec = optionValue(options, name);
    return spec !== undefined ? { [key]: splitModelSpec(spec) } : {};
  };
  overrideConfig({
    ...model("harness-model", "harnessModel"),
    ...model("model", "codingModel"),
    ...model("judge-model", "judgeModel"),
    ...(setting !== undefined ? { conformanceTests: setting } : {}),
    ...(review !== undefined ? { review } : {}),
    ...(mutationTesting !== undefined ? { mutationTesting } : {}),
  });
}

function failOption(message: string): never {
  console.error(message);
  process.exit(1);
}
