import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * A tool argument that is a list of objects - submit_exploration's `interfaces` and `plan`, a reviewer's `problems` - is
 * the shape a small model gets wrong most: it sends the list as JSON text, each entry as JSON text, or writes it inside
 * another argument's text as `</tests_reach_it><plan>[...]</plan>`. The validator's answer - "plan.0: must be object" -
 * does not say what it wants, and the model makes the same call again until its turn is stopped.
 *
 * So before the arguments are checked, what plainly means the list is taken as the list; and what cannot be is refused
 * with what is wanted, in words and with an example. For every tool an agent is given (createExecutor), in one place.
 */

interface Schema {
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  required?: string[];
}

interface ListArgument {
  name: string;
  required: boolean;
  item: Schema;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** The tool's arguments that take a list of objects. */
function listArguments(schema: Schema): ListArgument[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {})
    .filter(([, property]) => property.type === "array" && property.items?.type === "object")
    .map(([name, property]) => ({ name, required: required.has(name), item: property.items! }));
}

/** JSON text, fenced or not, as what it holds; anything else as it is. */
function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  if (!/^[[{]/.test(text)) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

const escaped = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Arguments the model wrote inside another argument's text - `answer</a>\n<b>[...]</b>\n<c>...` - taken out of it and
 * given as their own, where they were not given already. Which argument each was found in, for the refusal.
 */
function untucked(args: Record<string, unknown>, names: string[]): { args: Record<string, unknown>; foundIn: Map<string, string> } {
  const out = { ...args };
  const foundIn = new Map<string, string>();
  const anyTag = names.map(escaped).join("|");
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    let cut = value.search(new RegExp(`</${escaped(key)}>`));
    for (const name of names) {
      if (name === key || (out[name] !== undefined && out[name] !== "")) continue;
      const match = new RegExp(`<${escaped(name)}>([\\s\\S]*?)(?:</${escaped(name)}>|(?=<(?:${anyTag})>)|$)`).exec(value);
      if (match === null) continue;
      out[name] = match[1]!.trim();
      foundIn.set(name, key);
      cut = cut === -1 ? match.index : Math.min(cut, match.index);
    }
    if (cut !== -1) out[key] = value.slice(0, cut).trim();
  }
  return { args: out, foundIn };
}

/** What an entry of the list looks like, as JSON: its fields, the optional ones marked. */
function shapeOf(item: Schema): { fields: string; example: string } {
  const required = new Set(item.required ?? []);
  const entries = Object.entries(item.properties ?? {});
  const fields = entries.map(([name, field]) => `"${name}"${required.has(name) ? "" : "?"}: ${field.type ?? "value"}`).join(", ");
  const sample = (field: Schema) => (field.type === "number" || field.type === "integer" ? "1" : field.type === "boolean" ? "true" : field.type === "string" ? '"..."' : "...");
  const example = entries
    .filter(([name]) => required.has(name))
    .map(([name, field]) => `"${name}": ${sample(field)}`)
    .join(", ");
  return { fields: `{${fields}}`, example: `{${example}}` };
}

/** Why a list argument is not one, said so a model can make the call right next time - or undefined when it is. */
function problemOf(list: ListArgument, value: unknown, foundIn: string | undefined): string | undefined {
  if (value === undefined) return list.required ? "you left it out" : undefined;
  if (!Array.isArray(value)) {
    if (foundIn !== undefined) return `you wrote it inside \`${foundIn}\``;
    return typeof value === "string" ? "you sent it as text, not a list" : `you sent ${isObject(value) ? "an object" : `a ${typeof value}`}, not a list`;
  }
  const bad = value.findIndex((entry) => !isObject(entry));
  if (bad === -1) return undefined;
  return `entry ${bad + 1} is ${typeof value[bad] === "string" ? "text" : `a ${typeof value[bad]}`}, not an object`;
}

/** The arguments with their lists made lists where they plainly are; refused, saying what is wanted, where they are not. */
export function prepareListArguments(toolName: string, schema: Schema, raw: unknown): unknown {
  const lists = listArguments(schema);
  if (lists.length === 0 || !isObject(raw)) return raw;
  const { args, foundIn } = untucked(raw, Object.keys(schema.properties ?? {}));
  const problems: string[] = [];
  for (const list of lists) {
    let value = parsed(args[list.name]);
    if (isObject(value)) value = [value];
    if (Array.isArray(value)) value = value.map(parsed);
    if (value !== undefined) args[list.name] = value;
    const problem = problemOf(list, value, foundIn.get(list.name));
    if (problem === undefined) continue;
    const { fields, example } = shapeOf(list.item);
    problems.push(`- \`${list.name}\`: ${problem}. It is a list of objects, each ${fields} - e.g. "${list.name}": [${example}].`);
  }
  if (problems.length === 0) return args;
  throw new Error(
    [
      `${toolName} was not run - its arguments are not in the shape it takes:`,
      ...problems,
      "Each argument is a field of its own in the call, at the top level: a list is a JSON array of objects, never text, and never written inside another argument's text.",
    ].join("\n"),
  );
}

/** The tools, each that takes a list of objects preparing its arguments so before they are checked. */
export function withListArguments(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => {
    const schema = tool.parameters as Schema;
    if (listArguments(schema).length === 0) return tool;
    const before = tool.prepareArguments;
    return {
      ...tool,
      prepareArguments: (args: unknown) => prepareListArguments(tool.name, schema, before !== undefined ? before(args) : args),
    } as ToolDefinition;
  });
}
