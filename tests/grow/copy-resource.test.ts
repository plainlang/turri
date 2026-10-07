import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCopyResourceTool, loadLinkedResources } from "../../src/grow/resources.ts";

let project: string;
let code: string;
const fixture = `--batch\n${"x".repeat(20_000)}\n--batch--\n`;
beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "turri-copy-resource-")));
  code = join(project, "plain_modules", "app", "code");
  mkdirSync(code, { recursive: true });
  mkdirSync(join(project, "resources", "batch"), { recursive: true });
  writeFileSync(join(project, "resources", "batch", "list_response.txt"), fixture);
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

const resources = () =>
  loadLinkedResources(
    { "functional specs": [{ markdown: "- Parse [the LIST response](resources/batch/list_response.txt).", linked_resources: [{ text: "the LIST response", target: "resources/batch/list_response.txt" }] }] } as never,
    null,
    [project],
  );
const call = (tool: { execute: unknown }, params: object) => (tool.execute as (id: string, p: object) => Promise<{ content: Array<{ text: string }> }>)("id", params).then((result) => result.content[0]!.text);

describe("a linked resource longer than the prompt shows", () => {
  it("is shown cut, saying how long it is whole and that copy_resource gives the whole of it", () => {
    const [resource] = resources();
    expect(resource!.cutFrom).toBe(fixture.length);
    expect(resource!.content).toContain(`cut here: ${fixture.length} characters whole - copy_resource puts the whole file at its code-copy path`);
  });

  it("is copied whole, byte for byte, to its code-copy path in the agent's folder - or where it says, never outside it", async () => {
    const tool = createCopyResourceTool({ resources: resources(), dir: code });
    expect(await call(tool, { path: "resources/batch/list_response.txt" })).toContain("Copied resources/batch/list_response.txt whole to resources/batch/list_response.txt");
    expect(readFileSync(join(code, "resources", "batch", "list_response.txt"), "utf8")).toBe(fixture);
    await call(tool, { path: "resources/batch/list_response.txt", to: "src/test/resources/list.txt" });
    expect(readFileSync(join(code, "src", "test", "resources", "list.txt"), "utf8")).toBe(fixture);
    expect(await call(tool, { path: "resources/batch/list_response.txt", to: "../../escape.txt" })).toMatch(/^Not copied: .* is not inside your folder/);
    expect(await call(tool, { path: "resources/other.txt" })).toContain("No linked resource resources/other.txt");
  });
});
