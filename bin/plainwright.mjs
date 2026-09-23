#!/usr/bin/env node
// The launcher: plain JavaScript, so it runs on any Node and can say what is wrong before the
// TypeScript sources - which need Node to run .ts files itself - are loaded.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(
    `plainwright needs Node 22.18 or newer; this is ${process.versions.node}.\n` +
      "Install a newer one (https://nodejs.org, or `brew install node`) and run it again.",
  );
  process.exit(1);
}
await import("../src/cli.ts");
