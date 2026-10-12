// Builds the published package: src/ compiled to dist/ by tsc, and the files beside the sources that they read copied
// over. A clone needs none of it - bin/turri.mjs runs the sources there.
import { execFileSync } from "node:child_process";
import { cpSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "src");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "tsconfig.build.json")], { stdio: "inherit" });

function copyAssets(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) copyAssets(path);
    else if (!name.endsWith(".ts")) cpSync(path, join(dist, relative(src, path)));
  }
}
copyAssets(src);
