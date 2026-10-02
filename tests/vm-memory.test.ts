import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { availableMemory, defaultParallelJobs, vmMemoryFor } from "../src/grow/vm.ts";

const dirs: string[] = [];
const before = process.env.TURRI_VM_MEMORY;
afterEach(() => {
  if (before === undefined) delete process.env.TURRI_VM_MEMORY;
  else process.env.TURRI_VM_MEMORY = before;
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function project(config: string): string {
  const dir = mkdtempSync(join(tmpdir(), "turri-vm-memory-"));
  dirs.push(dir);
  writeFileSync(join(dir, "config.yaml"), config);
  return dir;
}

describe("a VM's memory", () => {
  it("is 1G unless config.yaml's vm-memory says, and TURRI_VM_MEMORY wins over both", () => {
    delete process.env.TURRI_VM_MEMORY;
    expect(vmMemoryFor(project("module: app.plain\n"))).toBe("1G");
    const sized = project("vm-memory: 3G\n");
    expect(vmMemoryFor(sized)).toBe("3G");
    process.env.TURRI_VM_MEMORY = "512M";
    expect(vmMemoryFor(sized)).toBe("512M");
  });

  it("ignores a size that is not one", () => {
    delete process.env.TURRI_VM_MEMORY;
    expect(vmMemoryFor(project("vm-memory: lots\n"))).toBe("1G");
  });

  it("measures what is free now, and runs at least one job however little that is", () => {
    expect(availableMemory()).toBeGreaterThan(0);
    expect(defaultParallelJobs("1T")).toBe(1);
    expect(defaultParallelJobs("1G")).toBeGreaterThanOrEqual(1);
  });
});

describe("sandbox VMs nothing owns any more", () => {
  it("are the VM processes from the image store whose parent is gone - not another turri's, nor anything else", async () => {
    const { orphanedVmPids } = await import("../src/grow/vm.ts");
    const store = "/Users/x/.cache/gondolin/images";
    const ps = [
      `41383     1 qemu-system-aarch64 -nodefaults -m 2G -kernel ${store}/objects/605/vmlinuz`,
      `97125 62902 qemu-system-aarch64 -nodefaults -m 1G -kernel ${store}/objects/605/vmlinuz`,
      `55000     1 qemu-system-aarch64 -m 4G -kernel /other/vm/kernel`,
      `60000     1 /usr/sbin/cupsd -l`,
    ].join("\n");
    expect(orphanedVmPids(ps, store)).toEqual([41383]);
  });
});
