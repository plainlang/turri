import { fromMarkdown } from "mdast-util-from-markdown";

/**
 * The markdown layer.
 *
 * The Python parser leans on mistletoe for two things: an AST with line numbers,
 * and a MarkdownRenderer that round-trips a token back to markdown. mdast gives
 * us the first. The second is `renderToMarkdown` below - a serializer for the
 * subset of markdown the plain language uses, matching mistletoe's output
 * (source indentation preserved, links rewritten as `[resource]` spans).
 */

export const RESOURCE_MARKER = "[resource]";

/** Extra fields the parser hangs off AST nodes, as the Python code hangs them off tokens. */
export interface PlainAnnotations {
  acceptance_tests?: AnyNode[];
  linked_resources?: LinkedResource[];
  /** Set when `value` holds the original source slice rather than mdast's decoded text. */
  raw?: boolean;
  openDelimiter?: string;
  closeDelimiter?: string;
  /** List item geometry, in mistletoe's parent-stripped coordinates. */
  leader?: string;
  indentation?: number;
  prepend?: number;
}

export interface LinkedResource {
  text: string;
  target: string;
}

/**
 * A structural view of an mdast node. The mdast union types do not narrow well when
 * the parser hangs its own fields off nodes, so the AST is handled structurally -
 * every real mdast node satisfies this shape.
 */
export interface AnyNode extends PlainAnnotations {
  type: string;
  value?: string;
  children?: AnyNode[];
  position?: {
    start: { line: number; column: number; offset?: number };
    end: { line: number; column: number; offset?: number };
  };
  [key: string]: unknown;
}

export type Root = AnyNode;

/** A parsed specification section: mistletoe's `Document` holding a flat list of list items. */
export interface Section {
  children: AnyNode[];
}

/**
 * Parse markdown, then pin every inline node back to its original source text.
 *
 * mdast decodes inline syntax: `\"` becomes `"`, and an emphasis written with `_`
 * loses the fact that it was not `*`. mistletoe's MarkdownRenderer round-trips the
 * source instead, so re-serialising a decoded tree drifts from the Python output.
 * Recording the raw slice for leaf nodes and the real delimiters for emphasis and
 * strong keeps the two renderers in agreement.
 */
export function parseMarkdown(text: string): Root {
  const root = fromMarkdown(text) as unknown as Root;
  pinToSource(root, text);
  return root;
}

const RAW_LEAF_TYPES = new Set(["text", "inlineCode", "html"]);

function pinToSource(node: AnyNode, source: string, origin = 1): void {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;

  if (start !== undefined && end !== undefined) {
    if (RAW_LEAF_TYPES.has(node.type)) {
      const raw = source.slice(start, end);
      // A paragraph's continuation lines carry leading whitespace that is not part of
      // the text. mistletoe drops it when rendering; keeping it here would indent the
      // line twice, once from the source and once from the enclosing list item.
      node.value = node.type === "text" ? raw.replace(/\n[ \t]*/g, "\n") : raw;
      node.raw = true;
    } else if (node.type === "emphasis" || node.type === "strong") {
      const width = node.type === "strong" ? 2 : 1;
      node.openDelimiter = source.slice(start, start + width);
      node.closeDelimiter = source.slice(end - width, end);
    }
  }

  let childOrigin = origin;
  if (node.type === "listItem") {
    // mistletoe strips the enclosing item's indentation before parsing nested blocks,
    // so `indentation` and `prepend` are measured against that stripped origin - not
    // against the item's own column. Continuation lines are later indented by
    // `prepend`, which is why a nested list keeps more indentation than the gap
    // between the two columns in the source.
    const itemColumn = column(node);
    const first = childrenOf(node)[0];
    const contentColumn = first ? column(first) : itemColumn + 2;

    node.indentation = itemColumn - origin;
    node.prepend = contentColumn - origin;
    node.leader =
      start !== undefined && first
        ? source.slice(start, start + (contentColumn - itemColumn)).trimEnd()
        : "-";
    childOrigin = contentColumn;
  }

  for (const child of childrenOf(node)) pinToSource(child, source, childOrigin);
}

export function lineNumber(node: AnyNode): number {
  return node.position?.start.line ?? 0;
}

function column(node: AnyNode): number {
  return node.position?.start.column ?? 1;
}

function isParent(node: AnyNode): boolean {
  return Array.isArray(node.children);
}

function childrenOf(node: AnyNode): AnyNode[] {
  return node.children ?? [];
}

/** Port of plain_file.remove_quotes: block quotes are comments and are dropped. */
export function removeQuotes(node: AnyNode): void {
  if (!isParent(node)) return;
  const kept: AnyNode[] = [];
  for (const child of node.children as AnyNode[]) {
    if (child.type === "blockquote") continue;
    removeQuotes(child);
    kept.push(child);
  }
  node.children = kept;
}

/** Port of plain_file.get_raw_text. */
export function getRawText(node: AnyNode): string {
  if (node.type === "text") return node.value as string;
  if (isParent(node)) {
    return childrenOf(node).map(getRawText).join("");
  }
  const value = node.value;
  if (value !== undefined) return value;
  throw new Error(`Unknown token type: ${node.type}`);
}

/** Port of mistletoe.utils.traverse restricted to a node type. */
export function traverse(node: AnyNode, type: string): AnyNode[] {
  const found: AnyNode[] = [];
  const walk = (n: AnyNode) => {
    if (n.type === type) found.push(n);
    if (isParent(n)) for (const child of n.children as AnyNode[]) walk(child);
  };
  walk(node);
  return found;
}

function renderInline(node: AnyNode): string {
  switch (node.type) {
    case "text":
      return node.value as string;
    case "inlineCode":
      // The raw slice already carries its own backticks.
      return node.raw ? (node.value as string) : `\`${node.value as string}\``;
    case "emphasis":
      return `${(node.openDelimiter as string) ?? "*"}${renderInlineChildren(node)}${(node.closeDelimiter as string) ?? "*"}`;
    case "strong":
      return `${(node.openDelimiter as string) ?? "**"}${renderInlineChildren(node)}${(node.closeDelimiter as string) ?? "**"}`;
    // PlainRenderer.render_link: a link becomes a literal `[resource]<text>` span.
    case "link":
      return `\`${RESOURCE_MARKER}${renderInlineChildren(node)}\``;
    case "image":
      return `![${renderInlineChildren(node)}](${node.url as string})`;
    case "break":
      return "\n";
    case "html":
      return node.value as string;
    default:
      return isParent(node) ? renderInlineChildren(node) : (node.value ?? "");
  }
}

function renderInlineChildren(node: AnyNode): string {
  return childrenOf(node).map(renderInline).join("");
}

/** Blank lines between two sibling blocks, as they appeared in the source. */
function blankLinesBetween(previous: AnyNode, next: AnyNode): number {
  const previousEnd = previous.position?.end.line;
  const nextStart = next.position?.start.line;
  if (previousEnd === undefined || nextStart === undefined) return 0;
  return Math.max(0, nextStart - previousEnd - 1);
}

/** Port of MarkdownRenderer.prefix_lines. */
function prefixLines(lines: string[], firstPrefix: string, followingPrefix: string): string[] {
  return lines.map((line, index) => {
    const prefixed = (index === 0 ? firstPrefix : followingPrefix) + line;
    return prefixed.trim() === "" ? "" : prefixed;
  });
}

/**
 * Port of MarkdownRenderer.blocks_to_lines. Blocks are concatenated with no separator;
 * blank lines are their own tokens in mistletoe, and are recovered here from the gaps
 * between sibling positions.
 */
function blocksToLines(nodes: AnyNode[]): string[] {
  const lines: string[] = [];
  nodes.forEach((node, index) => {
    if (index > 0 && blankLinesBetween(nodes[index - 1]!, node) > 0) lines.push("");
    lines.push(...renderBlockLines(node));
  });
  return lines;
}

/** Port of MarkdownRenderer.render_list_item. */
function renderListItemLines(item: AnyNode): string[] {
  const prepend = (item.prepend as number) ?? 2;
  const indentation = (item.indentation as number) ?? 0;
  const leader = (item.leader as string) ?? "-";

  const lines = blocksToLines(childrenOf(item));
  const firstPrefix =
    " ".repeat(Math.max(0, indentation)) +
    leader +
    " ".repeat(Math.max(0, prepend - leader.length - indentation));

  return prefixLines(lines.length > 0 ? lines : [""], firstPrefix, " ".repeat(Math.max(0, prepend)));
}

function renderBlockLines(node: AnyNode): string[] {
  switch (node.type) {
    case "paragraph":
      return renderInlineChildren(node).split("\n");

    case "heading":
      return [`${"#".repeat(node.depth as number)} ${renderInlineChildren(node)}`];

    case "code":
      return [`\`\`\`${(node.lang as string) ?? ""}`, ...(node.value ?? "").split("\n"), "\`\`\`"];

    case "thematicBreak":
      return ["---"];

    case "blockquote":
      return blocksToLines(childrenOf(node)).map((line) => (line ? `> ${line}` : ">"));

    case "list":
      return blocksToLines(childrenOf(node));

    case "listItem":
      return renderListItemLines(node);

    default:
      return node.children !== undefined
        ? blocksToLines(childrenOf(node))
        : (node.value ?? "").split("\n");
  }
}

/** Port of PlainRenderer.render. */
export function renderToMarkdown(node: AnyNode): string {
  return renderBlockLines(node).join("\n");
}
