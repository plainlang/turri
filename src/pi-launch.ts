import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import "./terminal-images.ts";

/**
 * pi, started the way its own CLI starts it, for `turri`.
 *
 * What differs is pi's own branding, because turri shows its own: its startup header - its
 * version, key hints and the list of every loaded skill, extension and theme - its update notice
 * and its tab title. pi only takes the header from the `quietStartup` setting, and a setting would
 * quiet every `pi` on the machine, so it is answered for this run instead. `--verbose` still shows it.
 */

const args = process.argv.slice(2);
if (!args.includes("--verbose")) {
  SettingsManager.prototype.getQuietStartup = () => true;
}

// pi's "Update Available" notice is left out: the pi turri runs is its pinned dependency, which `pi update`
// does not touch - it moves when turri does.
process.env.PI_SKIP_VERSION_CHECK = "1";

// The terminal's tab title: pi writes `π - <folder>` (its APP_TITLE, a constant), turri a jellyfish and its name.
const setTitle = ProcessTerminal.prototype.setTitle;
ProcessTerminal.prototype.setTitle = function (title: string) {
  setTitle.call(this, title.replace(/^π(?= |$)/, "🪼 turri"));
};

// pi's own keys stand: a new line is shift+enter or ctrl+j. turri's side panel is on ctrl+h (job-panel.ts PANEL_KEY).

// What pi's CLI does before main: the process title, pi's environment markers, the HTTP
// dispatcher. Not exported, so loaded from the file - beside pi's entry point, wherever npm put it.
const setup = pathToFileURL(join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli", "setup.js")).href;
const { setupCli } = (await import(setup)) as { setupCli: () => void };
setupCli();

await main(args);
