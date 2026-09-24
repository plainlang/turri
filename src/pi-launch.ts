import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { main, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ROOT } from "./environment.ts";

/**
 * pi, started the way its own CLI starts it, for `plainwright chat`.
 *
 * The one difference: pi's startup header - its version, key hints and the list of every
 * loaded skill, extension and theme - is left out, because plainwright shows its own. pi only
 * takes that from the `quietStartup` setting, and a setting would quiet every `pi` on the
 * machine, so it is answered for this run instead. `--verbose` still shows it.
 */

const args = process.argv.slice(2);
if (!args.includes("--verbose")) {
  SettingsManager.prototype.getQuietStartup = () => true;
}

// What pi's CLI does before main: the process title, pi's environment markers, the HTTP
// dispatcher. Not exported, so loaded from the file.
const setup = pathToFileURL(join(PACKAGE_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli", "setup.js")).href;
const { setupCli } = (await import(setup)) as { setupCli: () => void };
setupCli();

await main(args);
