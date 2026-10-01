import { beforeEach, describe, expect, it, vi } from "vitest";

/** The machine, as the checks see it: set per test. */
const machine = { docker: "absent" as "running" | "stopped" | "absent", mke2fs: undefined as string | undefined, packers: true, image: false };
/** What a build without Docker lacks on the machine: e2fsprogs, and cpio and lz4 unless it has them. */
const missing = () => [...(machine.mke2fs === undefined ? ["e2fsprogs"] : []), ...(machine.packers ? [] : ["cpio", "lz4"])];

vi.mock("../src/environment.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/environment.ts")>();
  return {
    ...actual,
    dockerState: () => machine.docker,
    dockerRunning: () => machine.docker === "running",
    mke2fsPath: () => machine.mke2fs,
    missingBuildTools: missing,
    nativeBuildReady: () => missing().length === 0,
    e2fsprogsInstallHint: () => `sudo apt install ${missing().join(" ")}`,
  };
});
vi.mock("../src/grow/vm.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/grow/vm.ts")>();
  return { ...actual, vmImage: () => (machine.image ? { tag: "turri:latest", path: "/x" } : undefined) };
});

const { buildRoute, checkBuilder, checkKvm } = await import("../src/setup.ts");

beforeEach(() => {
  machine.docker = "absent";
  machine.mke2fs = undefined;
  machine.packers = true;
  machine.image = false;
});

describe("what can build the VM image", () => {
  it("is e2fsprogs when it is installed, even with Docker running - nothing to keep running", () => {
    machine.docker = "running";
    machine.mke2fs = "/opt/homebrew/opt/e2fsprogs/sbin/mke2fs";
    expect(buildRoute()).toBe("native");
    expect(checkBuilder()).toMatchObject({ level: "ok", detail: expect.stringContaining("no Docker needed") });
  });

  it("is Docker when e2fsprogs is not installed and Docker is running", () => {
    machine.docker = "running";
    expect(buildRoute()).toBe("docker");
    expect(checkBuilder()).toMatchObject({ level: "ok", detail: "Docker, running" });
  });

  it("offers e2fsprogs first, then starting Docker, when Docker is installed but stopped", () => {
    machine.docker = "stopped";
    expect(buildRoute()).toBeUndefined();
    const check = checkBuilder();
    expect(check).toMatchObject({ level: "limited", detail: "Docker is installed but not running, and e2fsprogs is not installed" });
    expect(check.fix).toMatch(/^install e2fsprogs \(sudo apt install e2fsprogs\), or start Docker \((open -a Docker|sudo systemctl start docker)\)/);
  });

  it("offers e2fsprogs first when there is no Docker at all", () => {
    const check = checkBuilder();
    expect(check).toMatchObject({ level: "limited", detail: "neither Docker nor e2fsprogs is installed" });
    expect(check.fix).toMatch(/^install e2fsprogs \(sudo apt install e2fsprogs\), or install Docker/);
  });

  it("needs cpio and lz4 beside e2fsprogs to build without Docker, as a fresh Linux lacks them", () => {
    machine.mke2fs = "/sbin/mke2fs";
    machine.packers = false;
    expect(buildRoute()).toBeUndefined();
    const check = checkBuilder();
    expect(check).toMatchObject({ level: "limited", detail: "neither Docker nor cpio, lz4 are installed" });
    expect(check.fix).toMatch(/^install cpio, lz4 \(sudo apt install cpio lz4\), or install Docker/);
  });

  it("is only a note once the image is built", () => {
    machine.image = true;
    expect(checkBuilder().level).toBe("info");
  });
});

describe("KVM on Linux", () => {
  it.runIf(process.platform === "linux")("says the VM is too slow to start without /dev/kvm, and what to do in a container", () => {
    expect(checkKvm("/no/such/kvm")).toMatchObject({ level: "limited", detail: expect.stringContaining("too slow to start"), fix: expect.stringContaining("--device /dev/kvm") });
  });

  it.runIf(process.platform !== "linux")("is not a check where the VM uses the system's own hypervisor", () => {
    expect(checkKvm()).toBeUndefined();
  });
});
