#!/usr/bin/env node
// The launcher: plain JavaScript, so it runs on any Node and can say what is wrong before turri itself is loaded -
// the TypeScript sources in a clone, which Node runs itself, or in an installed package the files compiled from them
// (npm run build), as Node runs no .ts file inside node_modules.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  console.error(
    `turri needs Node 22.19 or newer; this is ${process.versions.node}.\n` +
      (process.platform === "darwin"
        ? "Install a newer one (`brew install node`, or https://nodejs.org) and run it again."
        : "Install a newer one - a Linux distribution's own package is often older: use https://nodejs.org/en/download " +
          "(nvm, or NodeSource's packages) - and run it again."),
  );
  process.exit(1);
}
// A terminal still sitting in a folder that was removed - or removed and made again under the same
// path - has no working directory, and everything after this needs one.
try {
  process.cwd();
} catch {
  console.error(
    "The folder this terminal is in no longer exists - it was removed, or removed and made again, while the terminal was in it.\n" +
      `Go into it again - cd "${process.env.PWD ?? "<your project>"}" - or into your project, and run turri again.`,
  );
  process.exit(1);
}
const { existsSync } = await import("node:fs");
const sources = new URL("../src/cli.ts", import.meta.url);
await import(existsSync(sources) ? sources.href : new URL("../dist/cli.js", import.meta.url).href);
