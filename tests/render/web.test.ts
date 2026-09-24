import { describe, expect, it } from "vitest";
import {
  checkPublicUrl,
  createWebTools,
  htmlToText,
  isPrivateAddress,
  PAGE_CHARS,
  pageWindow,
  parseSearchResults,
  webFetch,
} from "../../src/render/web.ts";

// Two rows as DuckDuckGo Lite serves them, and an ad pointing at its own redirect.
const LITE = `
<tr><td valign="top">1.&nbsp;</td><td>
  <a rel="nofollow" href="https://stackoverflow.com/questions/79278490/mockito-self-attaching" class='result-link'>Mockito is currently <b>self-attaching</b> ...</a>
</td></tr>
<tr><td>&nbsp;</td><td class='result-snippet'>
  Please add <b>Mockito</b> as an agent &amp; don&#x27;t self-attach.
</td></tr>
<tr><td><a rel="nofollow" href="https://duckduckgo.com/y.js?ad_domain=ads.example" class='result-link'>Buy tests</a></td></tr>
<tr><td>2.&nbsp;</td><td>
  <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fjavadoc.io%2Fdoc%2Forg.mockito%2Fmockito-core&amp;rut=x" class='result-link'>Mockito javadoc</a>
</td></tr>`;

describe("web_search", () => {
  it("reads the results off DuckDuckGo Lite, and leaves the ads out", () => {
    expect(parseSearchResults(LITE)).toEqual([
      {
        title: "Mockito is currently self-attaching ...",
        url: "https://stackoverflow.com/questions/79278490/mockito-self-attaching",
        snippet: "Please add Mockito as an agent & don't self-attach.",
      },
      { title: "Mockito javadoc", url: "https://javadoc.io/doc/org.mockito/mockito-core", snippet: "" },
    ]);
  });

  it("is one of the tools every rendering agent gets, with web_fetch", () => {
    expect(createWebTools().map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);
  });
});

describe("what web_fetch will reach", () => {
  it("knows the addresses on this machine and its network from the public ones", () => {
    for (const ip of ["127.0.0.1", "10.0.0.8", "172.20.1.1", "192.168.1.10", "169.254.169.254", "100.100.1.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["140.82.112.3", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses localhost, private addresses, names that resolve to them, and other schemes", async () => {
    const resolve = async (host: string) => (host === "sneaky.example" ? ["93.184.216.34", "127.0.0.1"] : ["93.184.216.34"]);
    for (const url of ["http://localhost:3000/", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "http://sneaky.example/", "http://printer.local/"]) {
      await expect(checkPublicUrl(url, resolve), url).rejects.toThrow(/not on the public web/);
    }
    await expect(checkPublicUrl("file:///etc/passwd", resolve)).rejects.toThrow(/Only http and https/);
    await expect(checkPublicUrl("docs.example.com", resolve)).rejects.toThrow(/is not a URL/);
    expect((await checkPublicUrl("https://docs.example.com/guide", resolve)).href).toBe("https://docs.example.com/guide");
  });

  it("checks every redirect, so a public page cannot send it somewhere private", async () => {
    const resolve = async (host: string) => (host === "internal.example" ? ["10.0.0.5"] : ["93.184.216.34"]);
    const fetchImpl = (async () => new Response(null, { status: 302, headers: { location: "http://internal.example/admin" } })) as typeof fetch;
    await expect(webFetch("https://docs.example.com/", { resolve, fetchImpl })).rejects.toThrow(/internal.example is not on the public web/);
  });
});

describe("what web_fetch returns", () => {
  const resolve = async () => ["93.184.216.34"];

  it("a page as text: headings, lists and code kept, scripts and markup gone", async () => {
    const html =
      "<html><head><title>Mockito &amp; agents</title><script>track()</script></head><body><nav>Home | Docs</nav>" +
      "<h2>Setup</h2><p>Add the <code>-javaagent</code> flag:</p><pre><code>&lt;argLine&gt;\n  -javaagent:mockito.jar\n&lt;/argLine&gt;</code></pre>" +
      "<ul><li>Maven</li><li>Gradle</li></ul><style>p{}</style></body></html>";
    const fetchImpl = (async () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })) as typeof fetch;
    const page = await webFetch("https://site.example/docs", { resolve, fetchImpl });
    expect(page.text).toBe(
      "# Mockito & agents\n\n## Setup\nAdd the `-javaagent` flag:\n\n```\n<argLine>\n  -javaagent:mockito.jar\n</argLine>\n```\n\n- Maven\n- Gradle",
    );
  });

  it("text, JSON and the like as they are, and refuses what is not text", async () => {
    const json = (async () => new Response('{"version":"5.14.2"}', { headers: { "content-type": "application/json" } })) as typeof fetch;
    expect((await webFetch("https://api.example/v", { resolve, fetchImpl: json })).text).toBe('{"version":"5.14.2"}');
    const zip = (async () => new Response("PK", { headers: { "content-type": "application/zip" } })) as typeof fetch;
    await expect(webFetch("https://site.example/a.zip", { resolve, fetchImpl: zip })).rejects.toThrow(/application\/zip, not a page/);
  });

  it("a long page in parts, saying where the next one starts", () => {
    const text = "x".repeat(PAGE_CHARS + 500);
    expect(pageWindow(text, 0)).toContain(`[500 more characters: call web_fetch again with offset ${PAGE_CHARS}]`);
    expect(pageWindow(text, PAGE_CHARS)).toBe("x".repeat(500));
  });

  it("html without its markup, even when the page does not say it is html", () => {
    expect(htmlToText("<p>One&nbsp;two</p><p>three</p>")).toBe("One two\nthree");
  });
});
