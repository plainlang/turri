import { Liquid, Tag, type Context, type Emitter, type TagToken, type TopLevelToken } from "liquidjs";
import { InvalidLiquidVariableName } from "./errors.ts";

/**
 * The Liquid layer: liquid2's Environment plus the project's customisations
 * (plain2code_nodes.Plain2CodeIncludeTag and the two filters in plain_spec).
 *
 * Two behaviours matter and neither is stock Liquid:
 *
 * - An include inherits the indentation of the line it sits on, so a multi-line
 *   template dropped into a nested list item stays inside that item.
 * - An include on a `>` comment line is not expanded; the tag is written back out
 *   verbatim, because comment lines are stripped later as block quotes.
 */

export type LoadTemplateSource = (name: string) => string | null;

/** The innermost include namespace, which is what liquid2 calls `context.scope`. */
const scopeStack: Array<Record<string, unknown>> = [];

function currentScope(): Record<string, unknown> | undefined {
  return scopeStack[scopeStack.length - 1];
}

export interface PlainLiquidOptions {
  loadTemplateSource: LoadTemplateSource;
  /** Populated by the code_variable filter; absent means the filter is a pass-through. */
  codeVariables?: Record<string, Record<string, string>>;
  strictVariables?: boolean;
}

/**
 * Leading indentation of the line the tag sits on, and whether that line is a
 * comment. Ported from Plain2CodeIncludeNode.render_to_output, which walks
 * backwards from the tag to the start of its line.
 */
function scanLine(source: string, start: number): { whitespaces: number; isComment: boolean } {
  let whitespaces = 0;
  let i = start;
  while (i >= 0 && source[i] !== "\n") {
    if (source[i] === " ") {
      whitespaces += 1;
    } else if (source[i] === ">") {
      return { whitespaces, isComment: true };
    } else {
      whitespaces = 0;
    }
    i -= 1;
  }
  return { whitespaces, isComment: false };
}

interface ParsedArgs {
  name: string;
  namespace: Array<[string, string]>;
}

/** `"tpl.plain", key: "value", other: "value"` */
function parseIncludeArgs(args: string): ParsedArgs {
  const nameMatch = /^\s*(["'])(.*?)\1/.exec(args);
  if (!nameMatch) throw new Error(`Invalid include tag arguments: ${args}`);

  const namespace: Array<[string, string]> = [];
  const rest = args.slice(nameMatch[0].length);
  const argPattern = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(["'])(.*?)\2/g;
  let match: RegExpExecArray | null;
  while ((match = argPattern.exec(rest)) !== null) {
    namespace.push([match[1]!, match[3]!]);
  }

  return { name: nameMatch[2]!, namespace };
}

export function createEnvironment(options: PlainLiquidOptions): Liquid {
  const engine = new Liquid({ strictVariables: options.strictVariables ?? false });

  engine.registerTag(
    "include",
    class extends Tag {
      private readonly rawArgs: string;
      private readonly begin: number;
      private readonly source: string;

      constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
        super(token, remain, liquid);
        this.rawArgs = token.args;
        this.begin = (token as unknown as { begin: number }).begin;
        this.source = (token as unknown as { input: string }).input;
      }

      *render(_ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
        const { whitespaces, isComment } = scanLine(this.source, this.begin);
        const { name, namespace } = parseIncludeArgs(this.rawArgs);

        if (isComment) {
          // liquid2 writes the node back through str(node), which normalises quoting.
          emitter.write(`{% include '${name}' %}`);
          return;
        }

        const templateSource = options.loadTemplateSource(name);
        if (templateSource === null) {
          throw new Error(
            `Template not found: ${name}\n` +
              "The required template could not be found. Templates are searched in the following order " +
              "(highest to lowest precedence):\n\n" +
              "    1. The directory containing your .plain file\n" +
              "    2. The directory specified by --template-dir (if provided)\n" +
              "    3. The built-in 'standard_template_library' directory\n",
          );
        }

        // Plain2CodeLoaderMixin.load: rstrip, then re-indent every line to match the
        // include site. The rstrip is what stops a block-level include from ending
        // the surrounding list.
        const indented = templateSource.replace(/\s+$/, "").split("\n").join("\n" + " ".repeat(whitespaces));

        const scope: Record<string, unknown> = Object.fromEntries(namespace);
        scopeStack.push(scope);
        try {
          emitter.write(engine.parseAndRenderSync(indented, scope));
        } finally {
          scopeStack.pop();
        }
      }
    },
  );

  engine.registerFilter("code_variable", (value: unknown) => {
    const scope = currentScope();
    if (scope === undefined || Object.keys(scope).length === 0) {
      throw new Error("Invalid use of code_variable filter!");
    }

    if (options.codeVariables === undefined) return value;

    // liquid2 takes the first item of the current scope, so every code_variable in a
    // template is attributed to the include's first argument, whatever it renders.
    const variableName = Object.keys(scope)[0]!;
    const uniqueStr = randomHex();
    options.codeVariables[uniqueStr] = { [variableName]: String(value) };
    return uniqueStr;
  });

  engine.registerFilter("prohibited_chars", (value: unknown, prohibitedChars: string) => {
    const text = typeof value === "string" ? value : String(value);
    const scope = currentScope();
    if (scope === undefined || Object.keys(scope).length === 0) {
      throw new Error("Invalid use of prohibited_chars filter!");
    }

    const variableName = Object.keys(scope)[0]!;
    for (const char of prohibitedChars) {
      if (text.includes(char)) {
        throw new InvalidLiquidVariableName(
          `'${char}' is not a valid character for variable '${variableName}' (value: '${text}').`,
        );
      }
    }
    return text;
  });

  return engine;
}

function randomHex(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Port of plain_file.render_plain_source. */
export function renderPlainSource(
  plainSource: string,
  loadedTemplates: Record<string, string>,
  codeVariables: Record<string, Record<string, string>>,
): string {
  const engine = createEnvironment({
    loadTemplateSource: (name) => loadedTemplates[name] ?? null,
    codeVariables,
  });
  return engine.parseAndRenderSync(plainSource, {});
}
