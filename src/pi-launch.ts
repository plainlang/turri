import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { main, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ROOT } from "./environment.ts";

/**
 * pi, started the way its own CLI starts it, for `turri chat`.
 *
 * The one difference: pi's startup header - its version, key hints and the list of every
 * loaded skill, extension and theme - is left out, because turri shows its own. pi only
 * takes that from the `quietStartup` setting, and a setting would quiet every `pi` on the
 * machine, so it is answered for this run instead. `--verbose` still shows it.
 */

const args = process.argv.slice(2);
if (!args.includes("--verbose")) {
  SettingsManager.prototype.getQuietStartup = () => true;
}

// ctrl+j opens turri's side panel. pi binds it to a new line as well, besides shift+enter, and
// says so on every start when an extension takes it. For this run only, a new line is shift+enter -
// unless keybindings.json says what it is, which is kept as written. Loaded from the file, since the
// class pi resolves its keys with is not exported.
const keybindings = pathToFileURL(join(PACKAGE_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "keybindings.js")).href;
const { KeybindingsManager } = (await import(keybindings)) as {
  KeybindingsManager: { loadFromFile: (path: string) => Record<string, unknown> };
};
const loadFromFile = KeybindingsManager.loadFromFile.bind(KeybindingsManager);
KeybindingsManager.loadFromFile = (path: string) => {
  const bindings = loadFromFile(path);
  return "tui.input.newLine" in bindings ? bindings : { ...bindings, "tui.input.newLine": ["shift+enter"] };
};

// What pi's CLI does before main: the process title, pi's environment markers, the HTTP
// dispatcher. Not exported, so loaded from the file.
const setup = pathToFileURL(join(PACKAGE_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli", "setup.js")).href;
const { setupCli } = (await import(setup)) as { setupCli: () => void };
setupCli();

await main(args);
