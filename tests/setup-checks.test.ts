import { beforeEach, describe, expect, it, vi } from "vitest";

/** The machine, as the checks see it: set per test. */
const machine = { docker: "absent" as "running" | "stopped" | "absent", mke2fs: undefined as string | undefined, image: false };

vi.mock("../src/environment.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/environment.ts")>();
  return {
    ...actual,
    dockerState: () => machine.docker,
    dockerRunning: () => machine.docker === "running",
    mke2fsPath: () => machine.mke2fs,
  };
});
vi.mock("../src/render/vm.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/render/vm.ts")>();
  return { ...actual, vmImage: () => (machine.image ? { tag: "plainwright:latest", path: "/x" } : undefined) };
});

const { buildRoute, checkBuilder } = await import("../src/setup.ts");

beforeEach(() => {
  machine.docker = "absent";
  machine.mke2fs = undefined;
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
    expect(check.fix).toMatch(/^install e2fsprogs \((brew|sudo apt) install e2fsprogs\), or start Docker \((open -a Docker|sudo systemctl start docker)\)/);
  });

  it("offers e2fsprogs first when there is no Docker at all", () => {
    const check = checkBuilder();
    expect(check).toMatchObject({ level: "limited", detail: "neither Docker nor e2fsprogs is installed" });
    expect(check.fix).toMatch(/^install e2fsprogs \((brew|sudo apt) install e2fsprogs\), or install Docker/);
  });

  it("is only a note once the image is built", () => {
    machine.image = true;
    expect(checkBuilder().level).toBe("info");
  });
});
