import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withActivity, type ActivitySink } from "../../src/grow/activity.ts";
import { agentShell } from "../../src/grow/agent-shell.ts";
import { sandboxAvailable } from "../../src/grow/os-sandbox.ts";

/**
 * An agent's command on this machine, behind every wall at once: the command check before it, the scrubbed environment
 * and the OS sandbox around it, the audit after it.
 */

let project: string;
let code: string;
beforeEach(() => {
  project = realpathSync(mkdtempSync(join(tmpdir(), "turri-agent-shell-")));
  code = join(project, "plain_modules", "app", "code");
  mkdirSync(code, { recursive: true });
  writeFileSync(join(project, "app.plain"), "the spec\n");
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

/** A sink that keeps the job log's lines. */
function logged(): { sink: ActivitySink; lines: string[] } {
  const lines: string[] = [];
  return { lines, sink: { stage() {}, activity() {}, note: (line: string) => lines.push(line), now() {}, usage() {} } as unknown as ActivitySink };
}

describe("an agent's command", () => {
  it("is refused, and not run, when the check refuses it - the refusal in its output and a line in the job log", async () => {
    const shell = agentShell({ workdir: code });
    const { sink, lines } = logged();
    const result = await withActivity(sink, () => shell.run(`touch ran && cat ${project}/app.plain`));
    expect(result.exitCode).toBe(126);
    expect(result.output).toMatch(/^Not run: .*is outside what this command may reach/);
    expect(() => readFileSync(join(code, "ran"))).toThrow();
    expect(lines).toEqual([expect.stringMatching(/^ {2}refused an agent's command \(path\): touch ran/)]);
  });

  it("runs in the module's own environment, not the person's", async () => {
    const shell = agentShell({ workdir: code });
    const result = await shell.run('echo "home=$HOME"; echo "key=${ANTHROPIC_API_KEY:-none}"');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(`home=${join(project, "plain_modules", ".turri", "home", "app")}`);
    expect(result.output).toContain("key=none");
  });

  it("has what it changed outside its role put back, and is told so, where no OS sandbox stopped it", async () => {
    // A path the check cannot read - built at run time - and no wall under it.
    const shell = agentShell({ workdir: code }, { wall: { kind: "none", why: "for the test" } });
    const result = await shell.run('P=$(dirname "$(dirname "$(dirname "$PWD")")"); echo changed > "$P/app.plain"; echo mine > mine.txt');
    expect(readFileSync(join(project, "app.plain"), "utf8")).toBe("the spec\n");
    expect(readFileSync(join(code, "mine.txt"), "utf8")).toBe("mine\n");
    expect(result.output).toContain("[turri put back app.plain as it was before this command");
  });

  it.runIf(sandboxAvailable().kind !== "none")("is stopped by the OS sandbox where the check cannot see the path", async () => {
    const shell = agentShell({ workdir: code });
    const result = await shell.run('P=$(dirname "$(dirname "$(dirname "$PWD")")"); echo changed > "$P/app.plain"');
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(project, "app.plain"), "utf8")).toBe("the spec\n");
    expect(result.output).not.toContain("turri put back");
  });

  it("says which wall is up", () => {
    expect(agentShell({ workdir: code }, { wall: { kind: "none", why: "no sandbox here" } }).description).toBe(
      "commands on this machine behind the command check and the audit - no OS sandbox: no sandbox here",
    );
    expect(agentShell({ workdir: code }, { wall: { kind: "seatbelt" } }).description).toBe("commands on this machine behind the command check, Seatbelt and the audit");
  });
});
