import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * The web, for the agents that build: search it, and read a page.
 *
 * An agent building on a library it half-remembers, or stuck on an error it has not seen, does
 * better reading the documentation or the answer than guessing again. So every rendering agent
 * has two tools: `web_search`, which asks DuckDuckGo and returns the results, and `web_fetch`,
 * which reads one page and returns it as text.
 *
 * Both run here, on the host, not in the VM. The VM's network stays what it was - the package
 * registries and nothing else - so the code an agent builds and runs, its tests and whatever
 * packages it installs, still cannot reach arbitrary hosts. What reaches the web is a request the
 * agent made through a tool, and what comes back is text it reads.
 *
 * Only the public web: `web_fetch` refuses an address on this machine or its network - localhost,
 * the private ranges, the cloud metadata address - so it cannot be used to reach a service the
 * VM is kept from, by way of the host.
 */

export const WEB_TOOLS = ["web_search", "web_fetch"];

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
const TIMEOUT_MS = 20_000;
/** How much of a page one call returns; the rest is had with `offset`. */
export const PAGE_CHARS = 20_000;
/** How much of a response is read at all. */
const MAX_BYTES = 5_000_000;
const MAX_REDIRECTS = 5;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", times: "×", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™",
  bull: "•", middot: "·", rarr: "→", larr: "←", deg: "°", euro: "€",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/** A DuckDuckGo link, which may point at its own redirect, as the address it leads to. */
function resultUrl(href: string): string | undefined {
  const raw = decodeEntities(href);
  try {
    const url = new URL(raw, "https://duckduckgo.com");
    if (url.hostname.endsWith("duckduckgo.com")) {
      const target = url.searchParams.get("uddg");
      return target !== null && /^https?:\/\//.test(target) ? target : undefined;
    }
    return /^https?:$/.test(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The results on a page of DuckDuckGo Lite: each a link, then its snippet. Ads are left out. */
export function parseSearchResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const link = /<a\b[^>]*\bhref=(["'])(.*?)\1[^>]*\bclass=(["'])result-link\3[^>]*>([\s\S]*?)<\/a>|<a\b[^>]*\bclass=(["'])result-link\5[^>]*\bhref=(["'])(.*?)\6[^>]*>([\s\S]*?)<\/a>/gi;
  const matches = [...html.matchAll(link)];
  matches.forEach((match, i) => {
    const url = resultUrl(match[2] ?? match[7] ?? "");
    if (url === undefined) return;
    const end = matches[i + 1]?.index ?? html.length;
    const between = html.slice(match.index! + match[0].length, end);
    const snippet = /<td[^>]*class=(["'])result-snippet\1[^>]*>([\s\S]*?)<\/td>/i.exec(between);
    results.push({ title: stripTags(match[4] ?? match[8] ?? ""), url, snippet: snippet ? stripTags(snippet[2]!) : "" });
  });
  return results;
}

export async function webSearch(query: string, limit = 8): Promise<SearchResult[]> {
  const response = await fetch("https://lite.duckduckgo.com/lite/", {
    method: "POST",
    headers: { "user-agent": USER_AGENT, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ q: query }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const html = await response.text();
  if (response.status !== 200 || (/anomaly|challenge-form/i.test(html) && !/result-link/.test(html))) {
    throw new Error(
      `The search did not answer (DuckDuckGo said ${response.status}${response.status === 202 ? ", which is its rate limit" : ""}). ` +
        "Wait a little and search again, or fetch a documentation page you know with web_fetch.",
    );
  }
  return parseSearchResults(html).slice(0, limit);
}

/** Whether an IP address is on this machine or its network, rather than the public internet. */
export function isPrivateAddress(address: string): boolean {
  let ip = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) ip = mapped[1]!;
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(ip) === 6) {
    return ip === "::" || ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip) || /^::ffff:/.test(ip);
  }
  return true;
}

type Lookup = (host: string) => Promise<string[]>;

const lookupAll: Lookup = async (host) => (await lookup(host, { all: true })).map((entry) => entry.address);

/** Refuse a URL that is not http(s) on the public internet; its parsed form when it is. */
export async function checkPublicUrl(raw: string, resolve: Lookup = lookupAll): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a URL. Give the whole address, starting with https://.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https pages can be fetched, not ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`${url.hostname} is not on the public web, and only the public web can be fetched.`);
  }
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => {
    throw new Error(`${url.hostname} could not be found.`);
  });
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error(`${url.hostname} is not on the public web, and only the public web can be fetched.`);
  }
  return url;
}

/** A page as readable text: what a person would read, without the markup, scripts and styles. */
export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  let body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|head|template|iframe)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(nav|footer)\b[\s\S]*?<\/\1>/gi, "");
  // Code keeps its lines; everything else is reflowed.
  const blocks: string[] = [];
  body = body.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_whole, code: string) => {
    blocks.push(decodeEntities(code.replace(/<[^>]*>/g, "")).replace(/\n+$/, ""));
    return `\n\u0000${blocks.length - 1}\u0000\n`;
  });
  body = body
    .replace(/<h([1-6])\b[^>]*>/gi, (_whole, level: string) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|h[1-6]|ul|ol|table|tr|blockquote|dl|dt|dd)>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<[^>]*>/g, "");
  body = decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u0000(\d+)\u0000/g, (_whole, i: string) => `\`\`\`\n${blocks[Number(i)]}\n\`\`\``)
    .trim();
  const heading = title ? stripTags(title[1]!) : "";
  return heading !== "" && !body.startsWith(`# ${heading}`) ? `# ${heading}\n\n${body}` : body;
}

const READABLE = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|toml|x-sh|[a-z.+-]*\+(json|xml)))/i;

async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
}

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  text: string;
}

/** Fetch a public page, following redirects - each checked - and return it as text. */
export async function webFetch(raw: string, opts: { resolve?: Lookup; fetchImpl?: typeof fetch } = {}): Promise<FetchedPage> {
  const get = opts.fetchImpl ?? fetch;
  let url = await checkPublicUrl(raw, opts.resolve);
  for (let hop = 0; ; hop++) {
    const response = await get(url.href, {
      redirect: "manual",
      headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      if (hop >= MAX_REDIRECTS) throw new Error(`${raw} redirected more than ${MAX_REDIRECTS} times.`);
      url = await checkPublicUrl(new URL(location, url).href, opts.resolve);
      continue;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType !== "" && !READABLE.test(contentType)) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`${url.href} is ${contentType.split(";")[0]}, not a page that can be read as text.`);
    }
    const body = await readLimited(response);
    const html = /html/i.test(contentType) || (contentType === "" && /^\s*<(!doctype|html)/i.test(body));
    return { url: url.href, status: response.status, contentType, text: html ? htmlToText(body) : body };
  }
}

/** One window of a long page, and how to read on. */
export function pageWindow(text: string, offset: number): string {
  const start = Math.max(0, Math.min(offset, text.length));
  const window = text.slice(start, start + PAGE_CHARS);
  const rest = text.length - (start + window.length);
  return rest > 0 ? `${window}\n\n[${rest} more characters: call web_fetch again with offset ${start + window.length}]` : window;
}

export function createWebTools() {
  const search = defineTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the web (DuckDuckGo) and get back the results: title, address and a snippet each. Use it for a library's " +
      "documentation, an API you are unsure of, or an error you have not seen. Read a result with web_fetch.",
    promptSnippet: "web_search: search the web for documentation, APIs and errors",
    parameters: Type.Object({
      query: Type.String({ description: "What to search for, as you would type it into a search engine" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "How many results, 8 by default" })),
    }),
    async execute(_id, params) {
      const results = await webSearch(params.query, params.limit ?? 8);
      const text =
        results.length === 0
          ? `No results for "${params.query}". Try other words.`
          : results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n");
      return { content: [{ type: "text" as const, text }], details: { results: results.length } };
    },
  });

  const read = defineTool({
    name: "web_fetch",
    label: "Fetch a web page",
    description:
      "Fetch a page from the public web and get it back as readable text - an HTML page without its markup, or a " +
      "text, JSON or XML file as it is. Long pages come in parts: call again with the offset it gives to read on.",
    promptSnippet: "web_fetch: read a web page, such as documentation, as text",
    parameters: Type.Object({
      url: Type.String({ description: "The page's full address, starting with https://" }),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Where to start reading, for the next part of a long page" })),
    }),
    async execute(_id, params) {
      const page = await webFetch(params.url);
      const head = `${page.url} (${page.status}${page.contentType ? `, ${page.contentType.split(";")[0]}` : ""})`;
      const text = page.text.trim() === "" ? `${head}\n\nThe page has no text.` : `${head}\n\n${pageWindow(page.text, params.offset ?? 0)}`;
      return { content: [{ type: "text" as const, text }], details: { characters: page.text.length, status: page.status } };
    },
  });

  return [search, read];
}
