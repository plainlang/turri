import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAllVms, runInVm, vmSupported } from "../../src/render/vm.ts";

let root: string;
let code: string;
let server: Server;
let port: number;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "plainwright-vm-network-")));
  code = join(root, "plain_modules", "app", "code");
  mkdirSync(code, { recursive: true });
  // A service on this machine, the way a storage service the tests talk to would be.
  server = createServer((_request, response) => response.end("from this machine"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  await closeAllVms();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

const run = async (command: string) => (await runInVm(command, { cwd: code })).output.trim();

describe.runIf(vmSupported())("the VM's network", { timeout: 120_000 }, () => {
  it("reaches this machine's localhost, and still its own servers first", async () => {
    // Nothing in the VM on that port: localhost is this machine.
    expect(await run(`curl -sS http://localhost:${port}/`)).toBe("from this machine");
    expect(await run(`curl -sS http://host.plainwright.internal:${port}/`)).toBe("from this machine");

    // The app under test serving on the same port in the VM: localhost is the VM's own.
    const own = await run(
      `mkdir -p /tmp/own && echo from the vm > /tmp/own/index.html && ` +
        `(python3 -m http.server ${port} --bind 127.0.0.1 --directory /tmp/own > /dev/null 2>&1 &) && ` +
        // Until it listens - asking localhost would find this machine's meanwhile.
        `for i in $(seq 100); do netstat -ltn | grep -q ":${port} " && break; sleep 0.1; done; ` +
        `curl -sS http://localhost:${port}/`,
    );
    expect(own).toBe("from the vm");
  });
});
