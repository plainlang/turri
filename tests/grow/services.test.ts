import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServiceTools } from "../../src/grow/services.ts";
import { runInVm, vmSupported } from "../../src/grow/vm.ts";

let root: string;
let code: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "turri-services-")));
  code = join(root, "plain_modules", "app", "code");
  mkdirSync(code, { recursive: true });
  writeFileSync(join(code, "index.html"), "hello from app\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }> };
const call = async (tools: unknown[], name: string, params: object) =>
  (await (tools as Tool[]).find((tool) => tool.name === name)!.execute("id", params, undefined, undefined, {})).content.map((part) => part.text ?? "").join("");

describe.runIf(vmSupported())("a service an agent starts in its VM", () => {
  it("keeps running between commands until it is up, answers from outside, prints to a log - and is stopped, it and what it started", async () => {
    const services = createServiceTools({ dir: code });
    const up = await call(services.tools, "start_service", { name: "web", command: "python3 -m http.server 8765", port: 8765 });
    expect(up).toContain("web is up on port 8765");
    // Reached from another command, as an agent's bash reaches it.
    expect((await runInVm("curl -s http://127.0.0.1:8765/index.html", { cwd: code })).output).toContain("hello from app");
    expect(await call(services.tools, "service_logs", { name: "web" })).toContain('"GET /index.html HTTP/1.1" 200');
    expect(await call(services.tools, "start_service", { name: "web", command: "true" })).toContain("is running already");

    expect(await call(services.tools, "stop_service", { name: "web" })).toBe("web is stopped.");
    expect((await runInVm("curl -s -o /dev/null http://127.0.0.1:8765/ && echo up || echo down", { cwd: code })).output.trim()).toBe("down");
  }, 300_000);

  it("says what it printed when it exits before it is up, and stops whatever is left when the agent's session ends", async () => {
    const services = createServiceTools({ dir: code });
    const failed = await call(services.tools, "start_service", { name: "broken", command: "echo cannot bind to port; exit 2", port: 8766 });
    expect(failed).toContain("It exited before it was up");
    expect(failed).toContain("cannot bind to port");

    expect(await call(services.tools, "start_service", { name: "worker", command: "echo worker ready; sleep 600", ready_log: "worker ready" })).toContain("worker is up");
    const worker = () => runInVm("pgrep -f 'sleep 60[0]' >/dev/null && echo running || echo gone", { cwd: code }).then((run) => run.output.trim());
    expect(await worker()).toBe("running");
    await services.stopAll();
    expect(await worker()).toBe("gone");
  }, 300_000);
});
