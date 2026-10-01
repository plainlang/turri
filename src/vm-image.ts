import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { readProjectConfig } from "./config.ts";
import { PACKAGE_ROOT } from "./environment.ts";
import { turriHome } from "./legacy.ts";

/**
 * What goes into the sandbox VM image - turri's recipe, and the person's own changes to it.
 *
 * `vm/image.json` in turri is the recipe: Alpine, and a list of packages - every toolchain a
 * project is likely to need. Someone who builds only Rust has no use for Java, and someone who
 * writes Zig needs a toolchain the recipe does not have; neither should have to edit turri's
 * own file, which the next update puts back. So `~/.turri/vm-image.json` - theirs, kept across
 * updates - removes and adds: whole toolchains by name, or single Alpine packages. What the VM needs
 * to boot and run a command is never removed.
 *
 * A project can have an image of its own: `vm-image:` in its config.yaml removes and adds the same
 * way, over that. turri vm-image in the project builds it, under a tag of the project's own, and
 * every VM of the project runs it. Nobody's image is ever without the basics - git among them.
 *
 * What was built is written down beside it, so the chat can say what the image holds, and a change
 * to the file can be told apart from what is built.
 */

/** The toolchains the recipe holds, by the name the person uses for them, and their packages. */
export const TOOLCHAINS: Record<string, { label: string; packages: string[] }> = {
  python: { label: "Python", packages: ["python3", "py3-pip", "uv"] },
  node: { label: "Node", packages: ["nodejs", "npm"] },
  java: { label: "Java", packages: ["openjdk21-jdk", "maven", "gradle"] },
  go: { label: "Go", packages: ["go"] },
  rust: { label: "Rust", packages: ["rust", "cargo"] },
  c: { label: "C/C++", packages: ["build-base", "cmake", "pkgconf"] },
  // Always there - it is among the basics - but named, so it shows among what an image holds.
  git: { label: "git", packages: ["git"] },
};

/** What the VM cannot do without: its kernel, a shell, the network, the file system, the basic tools. */
export const BASE_PACKAGES = [
  "linux-virt",
  "rng-tools",
  "bash",
  "ca-certificates",
  "curl",
  "iptables",
  "ip6tables",
  "e2fsprogs",
  "e2fsprogs-extra",
  "openssh",
  "coreutils",
  "findutils",
  "grep",
  "sed",
  "tar",
  "unzip",
  "xz",
  "git",
];

/** An Alpine package name, optionally pinned: `zig`, `ruby-dev`, `php83=8.3.1-r0`. */
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+._-]*([<>=~]{1,2}[a-z0-9+._-]+)?$/;

/** The person's own changes to the image: their file, kept across updates. */
export function userImageFile(): string {
  return process.env.TURRI_VM_IMAGE_CONFIG ?? join(turriHome(), "vm-image.json");
}

/** What the last build put into the image: beside the person's file, or - for a project's own image - in the project. */
export function builtImageFile(project?: string): string {
  return project !== undefined ? join(project, ".turri", "vm-image.built.json") : join(dirname(userImageFile()), "vm-image.built.json");
}

/** Whether a project asks for an image of its own: `vm-image:` in its config.yaml. */
export function hasProjectImage(project: string): boolean {
  return readProjectConfig(project).vmImage !== undefined;
}

/** The tag a project's own image is built and found under: its folder's name, and a hash of where it is. */
export function projectImageTag(project: string): string {
  const root = resolve(project);
  const name = basename(root).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "project";
  return `turri-${name}-${createHash("sha1").update(root).digest("hex").slice(0, 8)}:latest`;
}

/** turri's recipe, as its file has it. */
export function defaultRecipe(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, "vm", "image.json"), "utf8")) as Record<string, unknown>;
}

function defaultPackages(recipe = defaultRecipe()): string[] {
  const alpine = recipe.alpine as { rootfsPackages?: string[] } | undefined;
  return [...(alpine?.rootfsPackages ?? [])];
}

/** The image as it would be built: the recipe's packages, with the person's file laid over them. */
export interface ImagePlan {
  packages: string[];
  /** The file the person's changes come from, when there is one. */
  file?: string;
  /** The project whose config.yaml changes it further, when it has an image of its own. */
  project?: string;
  added: string[];
  /** Whole toolchains and single packages taken out. */
  removed: string[];
  /** What the file asked for that cannot be: a package the VM needs, a name that is not a package. */
  refused: string[];
  /** The file whose `packages:` list defines the image in full, when one does. */
  definedBy?: string;
  /** The basics a list left out, put back. */
  basicsAdded: string[];
  /** The Alpine mirror everything is downloaded from, when not Alpine's own server. */
  mirror?: string;
  /** The package repositories, when they are not the release's main and community. */
  repositories?: string[];
}

/** One layer of changes to the image: a list that replaces what it holds, and names to remove and add. */
interface ImageLayer {
  /** The image defined in full: these packages, and the basics. */
  packages?: string[];
  /** An Alpine mirror the base system, the kernel and the packages come from, in dl-cdn's layout. */
  mirror?: string;
  /** The package repositories, exactly: in place of the release's main and community. */
  repositories?: string[];
  add: string[];
  remove: string[];
  /** Where it was written, for what the plan says. */
  from: string;
  problem?: string;
}

/** The person's file, read: `packages`, `add` and `remove`. Nothing when there is no file. */
function readUserFile(file: string): ImageLayer | undefined {
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { add: [], remove: [], from: file, problem: `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}) - it was left out` };
  }
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : []);
  const raw = (parsed ?? {}) as { packages?: unknown; add?: unknown; remove?: unknown; mirror?: unknown; repositories?: unknown };
  return {
    ...(Array.isArray(raw.packages) ? { packages: list(raw.packages) } : {}),
    ...(typeof raw.mirror === "string" && raw.mirror.trim() !== "" ? { mirror: raw.mirror.trim() } : {}),
    ...(Array.isArray(raw.repositories) ? { repositories: list(raw.repositories) } : {}),
    add: list(raw.add),
    remove: list(raw.remove),
    from: file,
  };
}

/**
 * The image as it is to be built: turri's recipe; the person's file over it - a list of its own,
 * or names removed and added; the project's `vm-image:` over that, the same way. The basics are always in.
 */
export function imagePlan(options: { file?: string; project?: string } = {}): ImagePlan {
  const file = options.file ?? userImageFile();
  const recipe = defaultPackages();
  const layers: ImageLayer[] = [];
  const own = readUserFile(file);
  if (own !== undefined) layers.push(own);
  const theirs = options.project !== undefined ? readProjectConfig(options.project).vmImage : undefined;
  if (theirs !== undefined) layers.push({ ...theirs, from: join(options.project!, "config.yaml") });

  const refused: string[] = [];
  let current = [...recipe];
  let definedBy: string | undefined;
  let mirror: string | undefined;
  let repositories: string[] | undefined;
  for (const layer of layers) {
    if (layer.problem !== undefined) {
      refused.push(layer.problem);
      continue;
    }
    // Where it is downloaded from: a later layer's wins.
    if (layer.mirror !== undefined) {
      if (/^https?:\/\/\S+$/.test(layer.mirror)) mirror = layer.mirror.replace(/\/+$/, "");
      else refused.push(`mirror ${layer.mirror}: not an http(s) address (${layer.from})`);
    }
    if (layer.repositories !== undefined) {
      const valid = layer.repositories.filter((url) => /^https?:\/\/\S+$/.test(url)).map((url) => url.replace(/\/+$/, ""));
      for (const url of layer.repositories.filter((item) => !/^https?:\/\/\S+$/.test(item))) refused.push(`repository ${url}: not an http(s) address (${layer.from})`);
      if (valid.length > 0) repositories = valid;
    }
    if (layer.packages !== undefined) {
      const valid = layer.packages.filter((name) => PACKAGE_NAME.test(name));
      for (const name of layer.packages.filter((name) => !PACKAGE_NAME.test(name))) refused.push(`${name}: not an Alpine package name (${layer.from})`);
      current = valid;
      definedBy = layer.from;
    }
    for (const name of layer.remove) {
      const toolchain = TOOLCHAINS[name.toLowerCase()];
      const packages = toolchain !== undefined ? toolchain.packages : [name];
      const base = packages.filter((pkg) => BASE_PACKAGES.includes(pkg));
      if (base.length > 0) {
        refused.push(`${name}: the VM needs ${base.join(", ")} to boot and run commands - it stays (${layer.from})`);
        continue;
      }
      current = current.filter((pkg) => !packages.includes(pkg));
    }
    for (const name of layer.add) {
      if (!PACKAGE_NAME.test(name)) {
        refused.push(`${name}: not an Alpine package name (${layer.from})`);
        continue;
      }
      if (!current.includes(name)) current.push(name);
    }
  }
  // Whatever a list left out of the basics is put back: no image is without them.
  const basicsAdded = BASE_PACKAGES.filter((pkg) => !current.includes(pkg));
  const packages = [...BASE_PACKAGES.filter((pkg) => basicsAdded.includes(pkg)), ...current];
  // What it holds beside the recipe: added, and taken out - whole toolchains by name, the rest as packages.
  const added = packages.filter((pkg) => !recipe.includes(pkg) && !BASE_PACKAGES.includes(pkg));
  const toolchainsOut = Object.values(TOOLCHAINS).filter((toolchain) => toolchain.packages.some((pkg) => recipe.includes(pkg)) && !toolchain.packages.some((pkg) => packages.includes(pkg)));
  const inToolchains = new Set(toolchainsOut.flatMap((toolchain) => toolchain.packages));
  const removed = [...toolchainsOut.map((toolchain) => toolchain.label), ...recipe.filter((pkg) => !packages.includes(pkg) && !inToolchains.has(pkg))];
  return {
    packages,
    ...(own !== undefined ? { file } : {}),
    ...(theirs !== undefined ? { project: options.project } : {}),
    ...(definedBy !== undefined ? { definedBy } : {}),
    added,
    removed,
    refused,
    basicsAdded,
    ...(mirror !== undefined ? { mirror } : {}),
    ...(repositories !== undefined ? { repositories } : {}),
  };
}

/** The toolchains a list of packages holds, by name - and the packages it holds beyond them. */
export function toolchainsOf(packages: string[]): { toolchains: string[]; extra: string[] } {
  const toolchains = Object.values(TOOLCHAINS)
    .filter((toolchain) => toolchain.packages.some((pkg) => packages.includes(pkg)))
    .map((toolchain) => toolchain.label);
  const known = new Set([...BASE_PACKAGES, ...Object.values(TOOLCHAINS).flatMap((toolchain) => toolchain.packages)]);
  return { toolchains, extra: packages.filter((pkg) => !known.has(pkg)) };
}

/** What a plan builds, in a line: "Python, Node, Go, Rust, C/C++, git, and zig - without Java (your ~/.turri/vm-image.json)". */
export function describePlan(plan: ImagePlan): string {
  const { toolchains, extra } = toolchainsOf(plan.packages);
  const holds = [...toolchains, ...extra].join(", ") || "only the base tools";
  const changes = [
    ...(plan.removed.length > 0 ? [`without ${plan.removed.join(", ")}`] : []),
    ...(plan.added.length > 0 ? [`with ${plan.added.join(", ")} added`] : []),
  ];
  const from = [plan.file, plan.project !== undefined ? join(plan.project, "config.yaml") : undefined].filter((item): item is string => item !== undefined);
  const sources = [...(plan.mirror !== undefined ? [`from the mirror ${plan.mirror}`] : []), ...(plan.repositories !== undefined ? [`packages from ${plan.repositories.join(", ")}`] : [])];
  const tail = sources.length > 0 ? `; ${sources.join(", ")}` : "";
  if (plan.definedBy !== undefined) return `${holds} - defined in full by ${plan.definedBy}, with the basics${tail}`;
  return `${holds}${changes.length > 0 ? ` - ${changes.join(", ")}, from ${from.join(" and ") || userImageFile()}` : ""}${tail}`;
}

/** The recipe to build, with the person's changes in: what Gondolin is given. */
export function buildRecipe(plan = imagePlan()): Record<string, unknown> {
  const recipe = defaultRecipe();
  // The base system and the kernel from the mirror; the packages from the repositories the base system lists.
  const alpine = { ...(recipe.alpine as Record<string, unknown>), rootfsPackages: plan.packages, ...(plan.mirror !== undefined ? { mirror: plan.mirror } : {}) };
  return { ...recipe, alpine };
}

/** What a build put into the image, for the chat and doctor to say. */
export interface BuiltImage {
  packages: string[];
  builtAt: string;
  added: string[];
  removed: string[];
  /** Where it was downloaded from, when not Alpine's own server: the image lists those repositories. */
  mirror?: string;
  repositories?: string[];
}

export function recordBuiltImage(plan: ImagePlan, project?: string): void {
  try {
    const file = builtImageFile(project);
    mkdirSync(dirname(file), { recursive: true });
    const built: BuiltImage = {
      packages: plan.packages,
      builtAt: new Date().toISOString(),
      added: plan.added,
      removed: plan.removed,
      ...(plan.mirror !== undefined ? { mirror: plan.mirror } : {}),
      ...(plan.repositories !== undefined ? { repositories: plan.repositories } : {}),
    };
    writeFileSync(file, `${JSON.stringify(built, null, 2)}\n`);
  } catch {
    // What was built is worth saying, not worth failing a build for.
  }
}

export function readBuiltImage(project?: string): BuiltImage | undefined {
  try {
    return JSON.parse(readFileSync(builtImageFile(project), "utf8")) as BuiltImage;
  } catch {
    return undefined;
  }
}

/**
 * Whether the recipe asks for something the image was not built with - other packages, or other sources,
 * which the image lists for what a VM installs later: it takes a rebuild.
 */
export function planDiffersFromBuilt(plan: ImagePlan = imagePlan(), built: BuiltImage | undefined = readBuiltImage()): boolean {
  if (built === undefined) return false;
  const a = [...plan.packages].sort().join(" ");
  const b = [...built.packages].sort().join(" ");
  return a !== b || plan.mirror !== built.mirror || (plan.repositories ?? []).join(" ") !== (built.repositories ?? []).join(" ");
}
