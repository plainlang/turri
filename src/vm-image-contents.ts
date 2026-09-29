import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { BASE_PACKAGES, defaultRecipe, TOOLCHAINS, type ImagePlan } from "./vm-image.ts";

/**
 * Where everything in the VM image comes from, and exactly what a build downloads.
 *
 * The image is Alpine Linux: its minirootfs - the base system - and then every package the recipe
 * names, with all it depends on, from Alpine's own package repositories, `main` and `community`, as the
 * minirootfs lists them. Nothing else is downloaded into it. Each package's entry in the repository's
 * index says its version, what it is, the project it comes from, its licence and its size - so a build
 * can say, before it starts, what the person is about to download, and from where.
 *
 * Where it comes from can be steered: `mirror` - another server in dl-cdn's layout, a company's own - for
 * the base system, the kernel and the packages, and `repositories` - the package repositories exactly, in
 * place of the release's main and community. Gondolin takes the mirror for the base system and the kernel
 * but installs packages from the repositories the base system lists, so plainwright writes the chosen ones
 * into it before the build (`prepareBaseSystem`). The image keeps them: what a VM installs later with
 * `apk add` comes from there too.
 */

/** Alpine's own download server, which the image's minirootfs and its package repositories are on. */
export const ALPINE_MIRROR = "https://dl-cdn.alpinelinux.org/alpine";

/** Where an image's everything comes from. */
export interface ImageSources {
  version: string;
  branch: string;
  /** The server the base system and the kernel come from. */
  mirror: string;
  /** Whether it is all from Alpine's own server, as nobody changed it. */
  official: boolean;
  /** The base system, the minirootfs. */
  rootfs: string;
  /** The package repositories, in the order they are searched. */
  repositories: Array<{ name: string; url: string }>;
  /** The repository the VM's kernel package comes from. */
  kernel: string;
  /** The second kernel, for the libkrun backend: always from its project's GitHub releases. */
  krunfw: string;
}

/** The Alpine release the recipe builds on, its branch, and the addresses everything comes from - the plan's mirror and repositories when it names them. */
export function imageSources(arch = process.arch === "arm64" ? "aarch64" : "x86_64", plan?: Pick<ImagePlan, "mirror" | "repositories">): ImageSources {
  const alpine = defaultRecipe().alpine as { version: string; branch?: string; krunfwVersion?: string };
  const branch = alpine.branch ?? `v${alpine.version.split(".").slice(0, 2).join(".")}`;
  const mirror = plan?.mirror ?? ALPINE_MIRROR;
  const repositories = plan?.repositories ?? [`${mirror}/${branch}/main`, `${mirror}/${branch}/community`];
  return {
    version: alpine.version,
    branch,
    mirror,
    official: plan?.mirror === undefined && plan?.repositories === undefined,
    rootfs: `${mirror}/${branch}/releases/${arch}/alpine-minirootfs-${alpine.version}-${arch}.tar.gz`,
    repositories: repositories.map((url) => ({ name: basename(url) || url, url })),
    kernel: `${mirror}/${branch}/main`,
    krunfw: `https://github.com/containers/libkrunfw/releases/tag/${alpine.krunfwVersion ?? "v5.2.1"}`,
  };
}

/** A package as a repository's index describes it. */
export interface AlpinePackage {
  name: string;
  version: string;
  description: string;
  /** The project it is built from. */
  upstream: string;
  license: string;
  /** The repository it comes from, by its name - main, community, or the last part of a repository's address. */
  repository: string;
  /** Bytes downloaded. */
  size: number;
  /** Bytes on disk once installed. */
  installed: number;
  depends: string[];
  provides: string[];
}

/** An APKINDEX's text, as its packages. */
export function parseApkIndex(text: string, repository: string): AlpinePackage[] {
  const packages: AlpinePackage[] = [];
  for (const block of text.split(/\n\n+/)) {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const colon = line.indexOf(":");
      if (colon > 0) fields.set(line.slice(0, colon), line.slice(colon + 1));
    }
    const name = fields.get("P");
    if (name === undefined) continue;
    packages.push({
      name,
      version: fields.get("V") ?? "",
      description: fields.get("T") ?? "",
      upstream: fields.get("U") ?? "",
      license: fields.get("L") ?? "",
      repository,
      size: Number(fields.get("S") ?? 0),
      installed: Number(fields.get("I") ?? 0),
      depends: (fields.get("D") ?? "").split(" ").filter(Boolean),
      provides: (fields.get("p") ?? "").split(" ").filter(Boolean),
    });
  }
  return packages;
}

/** The files of a tar archive, by name - enough for an APKINDEX.tar.gz. */
function untar(data: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= data.length; ) {
    const header = data.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    if (name === "") break;
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    files.set(name, data.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** An APKINDEX.tar.gz is a signature, then the index: gzip members one after the other. */
function indexText(archive: Buffer): string {
  const files = untar(gunzipSync(archive));
  const index = files.get("APKINDEX");
  if (index === undefined) throw new Error("the index archive holds no APKINDEX");
  return index.toString("utf8");
}

/** Where the indexes are kept between runs: a day old at most. */
function cacheDir(): string {
  return join(homedir(), ".cache", "plainwright", "apk");
}
const INDEX_MAX_AGE_MS = 24 * 3_600_000;

/** A repository's index, from the cache when it is fresh, else downloaded. */
async function readIndex(url: string, arch: string, repository: string): Promise<AlpinePackage[]> {
  const file = join(cacheDir(), `${url.replace(/[^A-Za-z0-9]+/g, "_")}-${arch}.APKINDEX`);
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < INDEX_MAX_AGE_MS) return parseApkIndex(readFileSync(file, "utf8"), repository);
  const response = await fetch(`${url}/${arch}/APKINDEX.tar.gz`);
  if (!response.ok) throw new Error(`${url}/${arch}/APKINDEX.tar.gz: ${response.status} ${response.statusText}`);
  const text = indexText(Buffer.from(await response.arrayBuffer()));
  mkdirSync(cacheDir(), { recursive: true });
  writeFileSync(file, text);
  return parseApkIndex(text, repository);
}

/** What a build downloads: every package, the ones the recipe names and all they depend on - and what cannot be found. */
export interface ImageContents {
  sources: ImageSources;
  /** The packages the recipe names, each as the repository has it. */
  named: AlpinePackage[];
  /** Everything installed: the named packages and their dependencies, once each. */
  all: AlpinePackage[];
  /** Names no repository has - a build would stop on them. */
  missing: string[];
  download: number;
  installed: number;
  /** What each toolchain in it adds beyond the basics, with all it depends on. */
  toolchains: Array<{ label: string; packages: string[]; download: number; installed: number }>;
}

/** Resolve a plan against Alpine's repositories: the same resolution a build does, without building. */
export async function resolveImageContents(plan: ImagePlan, arch = process.arch === "arm64" ? "aarch64" : "x86_64"): Promise<ImageContents> {
  const sources = imageSources(arch, plan);
  const byName = new Map<string, AlpinePackage>();
  const provides = new Map<string, string>();
  for (const repository of sources.repositories) {
    for (const pkg of await readIndex(repository.url, arch, repository.name)) {
      if (byName.has(pkg.name)) continue;
      byName.set(pkg.name, pkg);
      for (const token of pkg.provides) {
        const name = token.split("=")[0]!;
        if (!provides.has(name)) provides.set(name, pkg.name);
      }
    }
  }
  const resolve = (dep: string) => {
    const name = dep.replace(/^!/, "").split(/[<>=~]/)[0]!;
    return byName.has(name) ? name : provides.get(name);
  };
  /** Everything these packages bring, themselves and all they depend on. */
  const closure = (names: string[]): Set<string> => {
    const seen = new Set<string>();
    const queue = names.map(resolve).filter((name): name is string => name !== undefined);
    while (queue.length > 0) {
      const name = queue.shift()!;
      if (seen.has(name)) continue;
      seen.add(name);
      for (const dep of byName.get(name)!.depends) {
        if (dep.startsWith("!")) continue;
        const found = resolve(dep);
        if (found !== undefined && !seen.has(found)) queue.push(found);
      }
    }
    return seen;
  };
  const missing = plan.packages.filter((name) => resolve(name) === undefined);
  // Each once: a name another package provides - ip6tables, in iptables - is that package.
  const named = [...new Set(plan.packages.map(resolve).filter((name): name is string => name !== undefined))].map((name) => byName.get(name)!);
  const all = [...closure(plan.packages)].map((name) => byName.get(name)!);
  const sum = (packages: AlpinePackage[]) => ({ download: packages.reduce((total, pkg) => total + pkg.size, 0), installed: packages.reduce((total, pkg) => total + pkg.installed, 0) });
  // What a toolchain costs: what it brings that the basics do not.
  const basics = closure(BASE_PACKAGES.filter((pkg) => plan.packages.includes(pkg)));
  const toolchains = Object.values(TOOLCHAINS)
    .filter((toolchain) => !toolchain.packages.every((pkg) => BASE_PACKAGES.includes(pkg)))
    .map((toolchain) => ({ label: toolchain.label, packages: toolchain.packages.filter((pkg) => plan.packages.includes(pkg)) }))
    .filter((toolchain) => toolchain.packages.length > 0)
    .map((toolchain) => ({ ...toolchain, ...sum([...closure(toolchain.packages)].filter((name) => !basics.has(name)).map((name) => byName.get(name)!)) }));
  return { sources, named, all, missing, ...sum(all), toolchains };
}

/** Bytes, as a person reads them. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Where it all comes from, in a few lines. */
export function describeSources(sources = imageSources()): string[] {
  return [
    sources.official
      ? `Alpine Linux ${sources.version}, from Alpine's own server (dl-cdn.alpinelinux.org):`
      : `Alpine Linux ${sources.version}, from the sources the recipe names in place of Alpine's own server - trusted as they serve it:`,
    `  the base system: ${sources.rootfs}`,
    ...sources.repositories.map((repository) => `  packages, ${repository.name}: ${repository.url}`),
    `  the kernel: ${sources.kernel}`,
    `  the libkrun kernel: ${sources.krunfw}`,
  ];
}

/** A tar archive with one file's contents replaced - headers, sizes and checksums put right. */
export function replaceInTar(data: Buffer, path: string, content: string): Buffer {
  const wanted = path.replace(/^\.?\//, "");
  const text = (bytes: Buffer) => bytes.toString("utf8").replace(/\0.*$/s, "");
  const parts: Buffer[] = [];
  let found = false;
  for (let offset = 0; offset + 512 <= data.length; ) {
    const header = data.subarray(offset, offset + 512);
    const name = text(header.subarray(0, 100));
    if (name === "") {
      parts.push(data.subarray(offset));
      break;
    }
    const prefix = header.subarray(257, 263).toString("latin1").startsWith("ustar") ? text(header.subarray(345, 500)) : "";
    const size = Number.parseInt(text(header.subarray(124, 136)).trim() || "0", 8);
    const end = offset + 512 + Math.ceil(size / 512) * 512;
    const full = (prefix !== "" ? `${prefix}/${name}` : name).replace(/^\.?\//, "");
    if (full === wanted && (header[156] === 0x30 || header[156] === 0)) {
      const body = Buffer.from(content, "utf8");
      const replaced = Buffer.from(header);
      replaced.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "latin1");
      replaced.fill(0x20, 148, 156);
      const sum = replaced.reduce((total, byte) => total + byte, 0);
      replaced.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
      parts.push(replaced, body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length));
      found = true;
    } else {
      parts.push(data.subarray(offset, end));
    }
    offset = end;
  }
  if (!found) throw new Error(`the archive holds no ${wanted}`);
  return Buffer.concat(parts);
}

/**
 * When the plan steers where things come from: the base system from its mirror, with its package
 * repositories written into `/etc/apk/repositories`, where Gondolin's build finds it. Gondolin keeps its
 * downloads in `~/.cache/gondolin/build` and takes a base system it finds there as it is, so each set of
 * sources gets a build folder of its own, run as the build's home - Alpine's own downloads are never
 * mixed with a mirror's. Returns that home, or nothing when everything comes from Alpine's own server.
 */
export async function prepareBaseSystem(plan: ImagePlan, arch = process.arch === "arm64" ? "aarch64" : "x86_64"): Promise<string | undefined> {
  const sources = imageSources(arch, plan);
  if (sources.official) return undefined;
  const key = createHash("sha256").update([sources.rootfs, ...sources.repositories.map((repository) => repository.url)].join("\n")).digest("hex").slice(0, 12);
  const home = join(homedir(), ".cache", "plainwright", "vm-build", key);
  const cache = join(home, ".cache", "gondolin", "build");
  const tarball = join(cache, basename(sources.rootfs));
  if (!existsSync(tarball)) {
    const response = await fetch(sources.rootfs);
    if (!response.ok) throw new Error(`${sources.rootfs}: ${response.status} ${response.statusText}`);
    const tar = replaceInTar(gunzipSync(Buffer.from(await response.arrayBuffer())), "etc/apk/repositories", `${sources.repositories.map((repository) => repository.url).join("\n")}\n`);
    mkdirSync(cache, { recursive: true });
    writeFileSync(`${tarball}.part`, gzipSync(tar));
    renameSync(`${tarball}.part`, tarball);
  }
  return home;
}

/** What a build downloads, in full: where from, each package the recipe names, and the totals. */
export function describeContents(contents: ImageContents): string[] {
  const width = Math.max(...contents.named.map((pkg) => `${pkg.name} ${pkg.version}`.length), 10);
  return [
    ...describeSources(contents.sources),
    "",
    `The packages the recipe names (${contents.named.length}), and what each is:`,
    ...contents.named.map(
      (pkg) =>
        `  ${`${pkg.name} ${pkg.version}`.padEnd(width)}  ${pkg.repository.padEnd(9)}  ${formatBytes(pkg.size).padStart(7)}  ${pkg.description}${pkg.upstream ? ` - ${pkg.upstream}` : ""}${pkg.license ? ` (${pkg.license})` : ""}`,
    ),
    ...(contents.missing.length > 0 ? ["", `Not in Alpine ${contents.sources.version}'s repositories - the build would stop on them: ${contents.missing.join(", ")}`] : []),
    "",
    ...(contents.toolchains.length > 0
      ? ["", "What each toolchain adds beyond the basics, with all it depends on:", ...contents.toolchains.map((toolchain) => `  ${toolchain.label.padEnd(7)} ${formatBytes(toolchain.download).padStart(7)} to download, ${formatBytes(toolchain.installed).padStart(7)} installed  (${toolchain.packages.join(", ")})`)]
      : []),
    "",
    `With everything they depend on: ${contents.all.length} packages, ${formatBytes(contents.download)} to download, ${formatBytes(contents.installed)} installed.`,
  ];
}
