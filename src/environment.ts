import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What plainwright needs from the machine it runs on, found out without changing anything.
 *
 * Kept free of heavy imports so the CLI can ask these questions before it has loaded pi or
 * Gondolin - and so `plainwright doctor` can report a missing piece instead of crashing on it.
 */

export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const AGENT_DIR = join(homedir(), ".pi", "agent");

/** The oldest Node that runs .ts files by itself, which is how plainwright runs. */
export const MIN_NODE = [22, 19] as const;

export function nodeVersionOk(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

/** Whether a command runs at all. */
export function runs(command: string, args: string[] = ["--version"]): boolean {
  const result = spawnSync(command, args, { stdio: "ignore", timeout: 15_000 });
  return result.status === 0;
}

/** The QEMU binary Gondolin boots VMs with on this machine. */
export function qemuBinary(): string {
  return process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
}

export function qemuInstalled(): boolean {
  return runs(qemuBinary());
}

/** How to install QEMU here, as a command to copy. */
export function qemuInstallHint(): string {
  if (process.platform === "darwin") return "brew install qemu";
  return process.arch === "arm64" ? "sudo apt install qemu-system-arm" : "sudo apt install qemu-system-x86";
}

/** Docker is installed and its daemon answers: one way to build the VM image. */
export function dockerRunning(): boolean {
  return runs("docker", ["info"]);
}

/** Whether Docker is there at all, there but not running, or running. */
export function dockerState(): "running" | "stopped" | "absent" {
  if (!runs("docker", ["--version"])) return "absent";
  return dockerRunning() ? "running" : "stopped";
}

/** How to get the Docker daemon going here, as a command to copy. */
export function dockerStartHint(): string {
  return process.platform === "darwin" ? "open -a Docker" : "sudo systemctl start docker";
}

/**
 * Where `mke2fs` is, if anywhere: with it, the VM image builds without Docker. Looked for where
 * Gondolin looks - the PATH, then Homebrew's keg-only e2fsprogs, which is not on the PATH.
 */
export function mke2fsPath(): string | undefined {
  for (const command of ["mke2fs", "mkfs.ext4"]) {
    if (spawnSync(command, ["-V"], { stdio: "ignore" }).error === undefined) return command;
  }
  for (const path of [
    "/opt/homebrew/opt/e2fsprogs/sbin/mke2fs",
    "/opt/homebrew/opt/e2fsprogs/bin/mke2fs",
    "/usr/local/opt/e2fsprogs/sbin/mke2fs",
    "/usr/local/opt/e2fsprogs/bin/mke2fs",
    "/sbin/mke2fs",
    "/usr/sbin/mke2fs",
  ]) {
    if (existsSync(path)) return path;
  }
  return undefined;
}

/** How to install e2fsprogs here, as a command to copy. */
export function e2fsprogsInstallHint(): string {
  return process.platform === "darwin" ? "brew install e2fsprogs" : "sudo apt install e2fsprogs";
}

export function brewInstalled(): boolean {
  return process.platform === "darwin" && runs("brew");
}

/** The global pi extension file that loads plainwright into every `pi`, if there is one. */
export function globalExtensionFile(): string | undefined {
  const dir = join(AGENT_DIR, "extensions");
  try {
    for (const entry of readdirSync(dir)) {
      try {
        if (readFileSync(join(dir, entry), "utf8").includes(PACKAGE_ROOT)) return join(dir, entry);
      } catch {
        // Not a file we can read; not ours.
      }
    }
  } catch {
    // No extensions directory yet.
  }
  return undefined;
}

export function extensionInstalledGlobally(): boolean {
  return globalExtensionFile() !== undefined;
}

export function themeFiles(): string[] {
  try {
    return readdirSync(join(PACKAGE_ROOT, ".pi", "themes")).filter((entry) => entry.endsWith(".json"));
  } catch {
    return [];
  }
}

/**
 * Are this project's themes already installed globally?
 *
 * Passing --theme as well would make pi load each of them twice and report a collision
 * on startup - the global copy wins and the project copy is skipped, which is noise
 * about a duplicate we created ourselves.
 */
export function themesInstalledGlobally(): boolean {
  const names = themeFiles();
  return names.length > 0 && names.every((name) => existsSync(join(AGENT_DIR, "themes", name)));
}

/** Where `plainwright` on the PATH points, if it is on the PATH at all. */
export function plainwrightOnPath(): string | undefined {
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["plainwright"], { encoding: "utf8" });
  const found = which.status === 0 ? which.stdout.trim().split("\n")[0] : undefined;
  return found === "" ? undefined : found;
}
