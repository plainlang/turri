import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentEnvironment } from "../../src/grow/agent-env.ts";
import { forgetSecretsForTests, maskSecrets, maskingStream, maskToolResults, registerSecrets } from "../../src/grow/masking.ts";
import { runCommand } from "../../src/grow/shell.ts";
import { keepFullOutput } from "../../src/grow/testing.ts";

/**
 * Every value `agent-env:` passes is replaced by its name - `[D365_CLIENT_SECRET]` - in everything an agent is shown
 * and everything turri writes.
 */

const SECRET = "s3cr3t/value+with=chars";

beforeEach(() => registerSecrets({ D365_CLIENT_SECRET: SECRET, D365_TENANT_ID: "tenant-4711" }));
afterEach(() => forgetSecretsForTests());

describe("a value, masked", () => {
  it("is replaced by its name wherever it appears whole", () => {
    expect(maskSecrets(`token=${SECRET}; tenant tenant-4711, again ${SECRET}`)).toBe("token=[D365_CLIENT_SECRET]; tenant [D365_TENANT_ID], again [D365_CLIENT_SECRET]");
  });

  it("is replaced URL-encoded too, as a query string or a form carries it", () => {
    expect(maskSecrets(`GET /token?secret=${encodeURIComponent(SECRET)}&x=1`)).toBe("GET /token?secret=[D365_CLIENT_SECRET]&x=1");
  });

  it("is not masked when it is too short to be told from ordinary output", () => {
    registerSecrets({ DEBUG: "1", REGION: "eu" });
    expect(maskSecrets("1 test passed in eu-west")).toBe("1 test passed in eu-west");
  });

  it("is found when it is split over the chunks of a stream", () => {
    const out: string[] = [];
    const stream = maskingStream((data) => out.push(data.toString("utf8")));
    const text = `before ${SECRET} after`;
    for (const piece of [text.slice(0, 9), text.slice(9, 14), text.slice(14)]) stream.write(Buffer.from(piece));
    stream.end();
    expect(out.join("")).toBe("before [D365_CLIENT_SECRET] after");
  });
});

describe("where it is masked", () => {
  let project: string;
  beforeEach(() => {
    project = realpathSync(mkdtempSync(join(tmpdir(), "turri-masking-")));
    mkdirSync(join(project, "plain_modules", "app", "code"), { recursive: true });
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it("is filled by the agents' environment from what agent-env passes", () => {
    forgetSecretsForTests();
    writeFileSync(join(project, ".env"), "API_TOKEN=tok-998877\n");
    writeFileSync(join(project, "config.yaml"), "agent-env:\n  files: [.env]\n");
    agentEnvironment(join(project, "plain_modules", "app"));
    expect(maskSecrets("Authorization: Bearer tok-998877")).toBe("Authorization: Bearer [API_TOKEN]");
  });

  it.skipIf(process.platform === "win32")("masks a command's output as it streams, a value split between two writes included", async () => {
    const chunks: string[] = [];
    const run = await runCommand(`printf 's3cr3t/val'; sleep 0.2; printf 'ue+with=chars done'`, { cwd: project, onData: (data) => chunks.push(data.toString("utf8")) });
    expect(run.output).toBe("[D365_CLIENT_SECRET] done");
    expect(chunks.join("")).toBe("[D365_CLIENT_SECRET] done");
  });

  it("masks what every tool returns to an agent - and a refusal it throws", async () => {
    const tools = maskToolResults([
      { name: "echo", execute: async () => ({ content: [{ type: "text", text: `the secret is ${SECRET}` }], details: {} }) },
      { name: "refuse", execute: async () => Promise.reject(new Error(`refused: tenant-4711`)) },
    ] as never);
    const shown = await (tools[0] as any).execute("id", {}, undefined, undefined, undefined);
    expect(shown.content[0].text).toBe("the secret is [D365_CLIENT_SECRET]");
    await expect((tools[1] as any).execute("id", {}, undefined, undefined, undefined)).rejects.toThrow("refused: [D365_TENANT_ID]");
  });

  it("masks a kept output, written whole for read_output", () => {
    const file = keepFullOutput(join(project, "plain_modules", "app", "code"), "run", `${"x\n".repeat(40_000)}${SECRET}\n`)!;
    expect(readFileSync(file, "utf8")).toContain("[D365_CLIENT_SECRET]");
    expect(readFileSync(file, "utf8")).not.toContain(SECRET);
  });

  it("masks the job log and the debug log", async () => {
    const { startJobLog } = await import("../../src/grow/job-log.ts");
    const log = startJobLog({ id: "j1", kind: "code", summary: `uses ${SECRET}` }, [join(project, "plain_modules", "app")])!;
    log.note(`a line with tenant-4711`);
    const text = readFileSync(log.file, "utf8");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("tenant-4711");
    expect(text).toContain("[D365_TENANT_ID]");
    const { startDebugLog } = await import("../../src/grow/debug-log.ts");
    const debug = startDebugLog({ subscribe: () => () => {}, systemPrompt: `the token is ${SECRET}` }, { cwd: join(project, "plain_modules", "app", "code"), label: "app coding agent" })!;
    debug.prompt(`call it with tenant-4711`);
    debug.note(`ended: ${SECRET}`);
    const written = readFileSync(debug.file, "utf8");
    expect(written).not.toContain(SECRET);
    expect(written).not.toContain("tenant-4711");
    expect(written).toContain("the token is [D365_CLIENT_SECRET]");
  });
});
