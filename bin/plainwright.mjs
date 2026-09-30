#!/usr/bin/env node
// The launcher: plain JavaScript, so it runs on any Node and can say what is wrong before the
// TypeScript sources - which need Node to run .ts files itself - are loaded.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
  console.error(
    `plainwright needs Node 22.19 or newer; this is ${process.versions.node}.\n` +
      "Install a newer one (https://nodejs.org, or `brew install node`) and run it again.",
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
      `Go into it again - cd "${process.env.PWD ?? "<your project>"}" - or into your project, and run plainwright again.`,
  );
  process.exit(1);
}
await import("../src/cli.ts");
