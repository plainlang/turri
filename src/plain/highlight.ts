import { readFileSync } from "node:fs";

/**
 * ***plain highlighted as plyn highlights it - the ***plain editor extension
 * (https://github.com/plainlang/plyn, MIT). Its TextMate grammar is copied in beside this file,
 * `plain.tmLanguage.json`; `npm run grammar:sync` refreshes it.
 *
 * What is read of a TextMate grammar is what plyn's uses: rules that match on a line, with or
 * without captures; rules that begin on one line and end on another (the front matter), with rules
 * of their own inside; and includes of the repository. Its expressions are
 * read as JavaScript's - plyn's need nothing of Oniguruma that JavaScript lacks. A grammar that
 * cannot be read highlights nothing: the text is shown as it is.
 */

interface RawRule {
  name?: string;
  match?: string;
  begin?: string;
  end?: string;
  include?: string;
  patterns?: RawRule[];
  captures?: Record<string, { name?: string }>;
  beginCaptures?: Record<string, { name?: string }>;
  endCaptures?: Record<string, { name?: string }>;
}

interface RawGrammar {
  patterns: RawRule[];
  repository?: Record<string, RawRule>;
}

/** A rule, read: its expression compiled, its includes followed. */
type Rule =
  | { kind: "match"; name?: string; re: RegExp; captures?: Record<string, string | undefined> }
  | { kind: "block"; name?: string; begin: RegExp; end: RegExp; patterns: Rule[]; beginCaptures?: Record<string, string | undefined>; endCaptures?: Record<string, string | undefined> };

/** A piece of a line, and the scopes it is in, outermost first. */
export interface Token {
  text: string;
  scopes: string[];
}

/** Where the lines so far leave off: the blocks open at the end of the last one. */
export type HighlightState = ReadonlyArray<Extract<Rule, { kind: "block" }>>;

const compile = (source: string): RegExp => new RegExp(source, "dg");

const namesOf = (captures: Record<string, { name?: string }> | undefined): Record<string, string | undefined> | undefined =>
  captures === undefined ? undefined : Object.fromEntries(Object.entries(captures).map(([group, capture]) => [group, capture.name]));

function readGrammar(raw: RawGrammar): Rule[] {
  const repository = new Map<string, Rule[]>();
  const root: Rule[] = [];
  const read = (rules: RawRule[], into: Rule[], seen: Set<string>) => {
    for (const rule of rules) {
      if (rule.include !== undefined) {
        // Only the repository's: plyn's grammar includes nothing else, and a rule that includes itself is followed once.
        if (!rule.include.startsWith("#")) continue;
        const key = rule.include.slice(1);
        if (seen.has(key)) continue;
        into.push(...repositoryRules(key, seen));
        continue;
      }
      if (rule.match !== undefined) {
        into.push({ kind: "match", ...(rule.name !== undefined ? { name: rule.name } : {}), re: compile(rule.match), ...(rule.captures !== undefined ? { captures: namesOf(rule.captures) } : {}) });
      } else if (rule.begin !== undefined && rule.end !== undefined) {
        const inner: Rule[] = [];
        read(rule.patterns ?? [], inner, seen);
        into.push({
          kind: "block",
          ...(rule.name !== undefined ? { name: rule.name } : {}),
          begin: compile(rule.begin),
          end: compile(rule.end),
          patterns: inner,
          ...(rule.beginCaptures ?? rule.captures ? { beginCaptures: namesOf(rule.beginCaptures ?? rule.captures) } : {}),
          ...(rule.endCaptures ?? rule.captures ? { endCaptures: namesOf(rule.endCaptures ?? rule.captures) } : {}),
        });
      } else if (rule.patterns !== undefined) {
        read(rule.patterns, into, seen);
      }
    }
  };
  const repositoryRules = (key: string, seen: Set<string>): Rule[] => {
    const known = repository.get(key);
    if (known !== undefined) return known;
    const entry = raw.repository?.[key];
    if (entry === undefined) return [];
    const rules: Rule[] = [];
    repository.set(key, rules);
    read([entry], rules, new Set([...seen, key]));
    return rules;
  };
  read(raw.patterns, root, new Set());
  return root;
}

let grammar: Rule[] | null | undefined;

/** plyn's grammar, read once - or null when it cannot be. */
function plainGrammar(): Rule[] | null {
  if (grammar !== undefined) return grammar;
  try {
    grammar = readGrammar(JSON.parse(readFileSync(new URL("./plain.tmLanguage.json", import.meta.url), "utf8")) as RawGrammar);
  } catch {
    grammar = null;
  }
  return grammar;
}

/** The pieces of a match: its capture groups under their scopes, the rest under the rule's. */
function piecesOf(match: RegExpExecArray, scopes: string[], name: string | undefined, captures: Record<string, string | undefined> | undefined): Token[] {
  const own = name !== undefined ? [...scopes, name] : scopes;
  const [start, end] = match.indices![0]!;
  const groups = Object.entries(captures ?? {})
    .map(([group, scope]) => ({ scope, at: match.indices![Number(group)] }))
    .filter((group): group is { scope: string | undefined; at: [number, number] } => group.at !== undefined && group.at[1] > group.at[0])
    .sort((a, b) => a.at[0] - b.at[0]);
  const whole = match.input;
  const tokens: Token[] = [];
  let at = start;
  for (const group of groups) {
    if (group.at[0] < at) continue;
    if (group.at[0] > at) tokens.push({ text: whole.slice(at, group.at[0]), scopes: own });
    tokens.push({ text: whole.slice(group.at[0], group.at[1]), scopes: group.scope !== undefined ? [...own, group.scope] : own });
    at = group.at[1];
  }
  if (end > at) tokens.push({ text: whole.slice(at, end), scopes: own });
  return tokens;
}

/**
 * One line of ***plain, highlighted: its tokens, and the state the next line starts from - the blocks
 * still open at its end.
 */
export function highlightLine(line: string, state: HighlightState = []): { tokens: Token[]; state: HighlightState } {
  const rules = plainGrammar();
  if (rules === null) return { tokens: line === "" ? [] : [{ text: line, scopes: [] }], state };
  const stack = [...state];
  const tokens: Token[] = [];
  const scopesNow = () => stack.map((block) => block.name).filter((name): name is string => name !== undefined);
  const push = (text: string, scopes: string[]) => {
    if (text === "") return;
    const last = tokens.at(-1);
    if (last !== undefined && last.scopes.join(" ") === scopes.join(" ")) last.text += text;
    else tokens.push({ text, scopes });
  };
  let at = 0;
  // A rule that matches nothing at a place moves the place on by one: every line ends.
  while (at <= line.length) {
    const top = stack.at(-1);
    const candidates = top?.patterns ?? rules;
    let best: { match: RegExpExecArray; rule: Rule | "end" } | undefined;
    const tryRe = (re: RegExp, rule: Rule | "end") => {
      re.lastIndex = at;
      const match = re.exec(line);
      if (match === null) return;
      // The first to match earliest wins; the end of a block before the rules inside it.
      if (best === undefined || match.index < best.match.index) best = { match, rule };
    };
    if (top !== undefined) tryRe(top.end, "end");
    for (const rule of candidates) tryRe(rule.kind === "match" ? rule.re : rule.begin, rule);
    if (best === undefined) {
      push(line.slice(at), scopesNow());
      break;
    }
    const { match, rule } = best;
    push(line.slice(at, match.index), scopesNow());
    const scopes = scopesNow();
    if (rule === "end") {
      const block = stack.pop()!;
      for (const token of piecesOf(match, scopes.slice(0, block.name !== undefined ? -1 : undefined), block.name, block.endCaptures)) push(token.text, token.scopes);
    } else if (rule.kind === "match") {
      for (const token of piecesOf(match, scopes, rule.name, rule.captures)) push(token.text, token.scopes);
    } else {
      for (const token of piecesOf(match, scopes, rule.name, rule.beginCaptures)) push(token.text, token.scopes);
      stack.push(rule);
    }
    const next = match.index + match[0].length;
    if (next === at && match[0].length === 0) {
      // Nothing matched here: take one character as it is, and go on.
      push(line.slice(at, at + 1), scopesNow());
      at += 1;
    } else at = next;
    if (at >= line.length) break;
  }
  return { tokens, state: stack };
}

/** Lines of ***plain, highlighted one after another - a block opened on one carried to the next. */
export function highlightLines(lines: string[]): Token[][] {
  let state: HighlightState = [];
  return lines.map((line) => {
    const result = highlightLine(line, state);
    state = result.state;
    return result.tokens;
  });
}

/**
 * What a piece of ***plain is, for its colour: a section's header, a concept, a link, text in quotes or
 * backticks, a front matter key, a module a front matter names, a comment, a list's bullet.
 */
export type PlainRole = "section" | "concept" | "link" | "literal" | "keyword" | "module" | "comment" | "bullet";

/** A scope's role, by what it is - the most specific first. None: the text around it. */
const ROLES: Array<[string, PlainRole]> = [
  ["comment", "comment"],
  ["keyword", "keyword"],
  ["entity.name.function", "section"],
  ["entity.name.type", "module"],
  ["entity.name.module", "module"],
  ["entity.punctuation", "bullet"],
  ["punctuation", "bullet"],
  ["variable", "concept"],
  // A link is plyn's `string.quoted.other.plain`; its quotes are `string.quoted.double`, `...other.backtick` and the like.
  ["string.quoted.other.plain", "link"],
  ["string", "literal"],
];

/** A token's role: its innermost scope that has one. */
export function roleOf(scopes: string[]): PlainRole | undefined {
  for (const scope of [...scopes].reverse()) {
    const found = ROLES.find(([prefix]) => scope === prefix || scope.startsWith(`${prefix}.`));
    if (found !== undefined) return found[1];
  }
  return undefined;
}
