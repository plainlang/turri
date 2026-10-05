import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BASE_PACKAGES, defaultRecipe, describePlan, imagePlan, projectImageTag, toolchainsOf } from "../src/vm-image.ts";
import { readProjectConfig } from "../src/config.ts";
import { describeSources, imageSources, replaceInTar } from "../src/vm-image-contents.ts";

let root: string;
let userFile: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "turri-vm-image-"));
  userFile = join(root, "home", "vm-image.json");
  mkdirSync(join(root, "home"));
  process.env.TURRI_VM_IMAGE_CONFIG = userFile;
});
afterEach(() => {
  delete process.env.TURRI_VM_IMAGE_CONFIG;
  rmSync(root, { recursive: true, force: true });
});

const recipe = () => ((defaultRecipe().alpine as { rootfsPackages: string[] }).rootfsPackages);

describe("the VM image's recipe", () => {
  it("is turri's, as it is, when nobody changed it", () => {
    const plan = imagePlan();
    expect(plan.packages.sort()).toEqual([...recipe()].sort());
    expect(toolchainsOf(plan.packages).toolchains).toEqual(["Python", "Node", "Java", "Go", "Rust", "C/C++", "git"]);
  });

  it("takes the person's file over it - whole toolchains out by name, packages in - and never the basics out", () => {
    writeFileSync(userFile, JSON.stringify({ remove: ["java", "python", "git", "bash"], add: ["zig", "Not A Package"] }));
    const plan = imagePlan();
    expect(plan.packages).not.toContain("openjdk21-jdk");
    expect(plan.packages).not.toContain("python3");
    expect(plan.packages).toContain("zig");
    expect(plan.packages).toContain("git");
    expect(plan.packages).toContain("bash");
    expect(plan.removed).toEqual(["Python", "Java"]);
    expect(plan.added).toEqual(["zig"]);
    expect(plan.refused.join("\n")).toMatch(/git: the VM needs git[\s\S]*bash: the VM needs bash[\s\S]*Not A Package: not an Alpine package name/);
    expect(describePlan(plan)).toContain("without Python, Java, with zig added");
  });

  it("can be defined in full - a project's own image, with only what its stack needs - and always has the basics", () => {
    writeFileSync(join(root, "config.yaml"), "vm-image:\n  packages: [zig, nodejs]\n");
    const plan = imagePlan({ project: root });
    expect(plan.definedBy).toBe(join(root, "config.yaml"));
    for (const basic of BASE_PACKAGES) expect(plan.packages).toContain(basic);
    expect(plan.packages).toContain("zig");
    expect(plan.packages).not.toContain("openjdk21-jdk");
    expect(describePlan(plan)).toContain("defined in full by");
  });

  it("layers a project's changes over the person's", () => {
    writeFileSync(userFile, JSON.stringify({ remove: ["java"] }));
    writeFileSync(join(root, "config.yaml"), "vm-image:\n  add: [odin]\n  remove: [rust]\n");
    const plan = imagePlan({ project: root });
    expect(plan.packages).not.toContain("openjdk21-jdk");
    expect(plan.packages).not.toContain("rust");
    expect(plan.packages).toContain("odin");
    expect(plan.project).toBe(root);
  });

  it("gives a project's own image a tag of its own - the same every time for the same folder", () => {
    expect(projectImageTag(root)).toMatch(/^turri-[a-z0-9._-]+-[0-9a-f]{8}:latest$/);
    expect(projectImageTag(root)).toBe(projectImageTag(root));
    expect(projectImageTag(join(root, "other"))).not.toBe(projectImageTag(root));
  });
});

describe("the project config's VM keys", () => {
  it("reads system-packages and vm-image, the project's alone", () => {
    writeFileSync(join(root, "config.yaml"), "system-packages: [sqlite, jq]\nvm-image:\n  remove: [java]\n  add: [zig]\n");
    expect(readProjectConfig(root).systemPackages).toEqual(["sqlite", "jq"]);
    expect(readProjectConfig(root).vmImage).toEqual({ add: ["zig"], remove: ["java"] });
    writeFileSync(join(root, "config.backend.yaml"), "system-packages: [curl]\n");
    expect(readProjectConfig(root, "backend").systemPackages).toEqual(["sqlite", "jq"]);
  });
});

describe("where the image is downloaded from", () => {
  it("is Alpine's own server when nobody says otherwise", () => {
    const sources = imageSources("aarch64", imagePlan());
    expect(sources.official).toBe(true);
    expect(sources.repositories.map((repository) => repository.url)).toEqual([
      `https://dl-cdn.alpinelinux.org/alpine/${sources.branch}/main`,
      `https://dl-cdn.alpinelinux.org/alpine/${sources.branch}/community`,
    ]);
  });

  it("is a mirror the person names - the base system, the kernel and the packages from it - and a project's repositories over it", () => {
    writeFileSync(userFile, JSON.stringify({ mirror: "https://mirror.example.com/alpine/" }));
    const mirrored = imageSources("aarch64", imagePlan());
    expect(mirrored.official).toBe(false);
    expect(mirrored.rootfs).toMatch(/^https:\/\/mirror\.example\.com\/alpine\/v[\d.]+\/releases\/aarch64\/alpine-minirootfs-/);
    expect(mirrored.kernel).toBe(`https://mirror.example.com/alpine/${mirrored.branch}/main`);
    expect(mirrored.repositories.map((repository) => repository.name)).toEqual(["main", "community"]);
    expect(describeSources(mirrored).join("\n")).toContain("in place of Alpine's own server");

    writeFileSync(join(root, "config.yaml"), "vm-image:\n  repositories: [https://apk.example.com/main, ftp://nope]\n");
    const plan = imagePlan({ project: root });
    expect(plan.mirror).toBe("https://mirror.example.com/alpine");
    expect(plan.repositories).toEqual(["https://apk.example.com/main"]);
    expect(plan.refused.join("\n")).toContain("repository ftp://nope: not an http(s) address");
    expect(imageSources("aarch64", plan).repositories).toEqual([{ name: "main", url: "https://apk.example.com/main" }]);
    expect(describePlan(plan)).toContain("packages from https://apk.example.com/main");
  });

  it("is written into the base system's repositories file, the rest of the archive as it was", () => {
    const tree = join(root, "rootfs");
    mkdirSync(join(tree, "etc", "apk"), { recursive: true });
    writeFileSync(join(tree, "etc", "apk", "repositories"), "https://dl-cdn.alpinelinux.org/alpine/v3.23/main\n");
    writeFileSync(join(tree, "etc", "hostname"), "alpine\n");
    execFileSync("tar", ["--format", "ustar", "-cf", join(root, "rootfs.tar"), "-C", tree, "./etc"]);
    const lines = "https://mirror.example.com/alpine/v3.23/main\nhttps://mirror.example.com/alpine/v3.23/community\n";
    writeFileSync(join(root, "out.tar"), replaceInTar(readFileSync(join(root, "rootfs.tar")), "etc/apk/repositories", lines));
    mkdirSync(join(root, "out"));
    execFileSync("tar", ["-xf", join(root, "out.tar"), "-C", join(root, "out")]);
    expect(readFileSync(join(root, "out", "etc", "apk", "repositories"), "utf8")).toBe(lines);
    expect(readFileSync(join(root, "out", "etc", "hostname"), "utf8")).toBe("alpine\n");
    expect(() => replaceInTar(readFileSync(join(root, "rootfs.tar")), "etc/missing", "")).toThrow(/holds no etc\/missing/);
  });
});
