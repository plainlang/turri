import { afterEach, describe, expect, it } from "vitest";
import { nodeVersionOk, qemuBinary, qemuInstallHint } from "../src/environment.ts";
import { vmSummary, vmSupported } from "../src/grow/vm.ts";

describe("the Node turri runs on", () => {
  it("is 22.19 or newer - it runs .ts files itself, and pi needs 22.19", () => {
    expect(nodeVersionOk("22.19.0")).toBe(true);
    expect(nodeVersionOk("22.18.0")).toBe(false);
    expect(nodeVersionOk("23.1.0")).toBe(true);
    expect(nodeVersionOk("26.8.2")).toBe(true);
    expect(nodeVersionOk("22.17.1")).toBe(false);
    expect(nodeVersionOk("20.19.0")).toBe(false);
  });
});

describe("QEMU", () => {
  it("is the binary for this machine's architecture, with a way to install it", () => {
    expect(qemuBinary()).toBe(process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64");
    expect(qemuInstallHint()).toMatch(/brew install qemu|apt install qemu-system/);
  });
});

describe.runIf(vmSupported())("where commands run, as the banner says it", () => {
  const before = process.env.TURRI_VM_IMAGE;
  afterEach(() => {
    if (before === undefined) delete process.env.TURRI_VM_IMAGE;
    else process.env.TURRI_VM_IMAGE = before;
  });

  it("names the stock image as a limit, and how to get the full one", () => {
    process.env.TURRI_VM_IMAGE = "no-such-image:latest";
    const summary = vmSummary();
    if (summary.level === "missing") return; // no QEMU on this machine: that is what it says instead
    expect(summary).toEqual({ level: "limited", text: expect.stringContaining("turri vm-image") });
  });
});
