# Installation

**turri** runs wherever pi runs - macOS, Linux, WSL - with git, bash and Node 22.19 or newer (a Linux
distribution's own `nodejs` package is often older: take it from nodejs.org, nvm or NodeSource). Native Windows is
best effort: it needs bash on the PATH (Git for Windows' Git Bash), and has no OS sandbox under the agents' commands.

The agents' commands run on this machine, with its toolchains - see [the sandbox](sandbox.md). Each is checked before
it runs and audited after, on every platform; under them an OS sandbox fences it where the OS has one: Seatbelt on
macOS, always there, and bubblewrap on Linux and WSL 2 - `apt install bubblewrap`, or your distribution's package.

```bash
git clone git@github.com:plainlang/turri.git && cd turri
npm install
npm link              # puts `turri` on your PATH, pointing at this clone
turri setup     # checks the machine, fixes what it can, asks before each change
```

Then, in the project that holds your specs:

```bash
cd ~/my-project
turri chat      # pi, with turri's tools, skills and themes loaded
```

`npm link` has to be a link, not `npm install -g`: Node will not run `.ts` files from inside a
`node_modules`, and a copying global install puts them there. The link points at this working
copy, so edits here take effect immediately.

## What `turri setup` checks

It checks, in order, and says exactly what to run for anything missing:

| what | why | if it is missing |
| --- | --- | --- |
| Node 22.19+ | turri runs its `.ts` sources directly, and pi needs 22.19 | install a newer Node |
| bash | every command an agent runs, and every testing script, runs with it | on Windows, Git for Windows; elsewhere, the system's package manager |
| the OS sandbox | the wall under the command check and the audit | macOS has Seatbelt; on Linux, `apt install bubblewrap`. Where it does not start it says why and how to give it one - user namespaces off (Docker: `--security-opt seccomp=unconfined`), AppArmor in the way (Docker: `--security-opt apparmor=unconfined`; Ubuntu 24.04: `sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`), Docker's masked `/proc` (`--security-opt systempaths=unconfined`, or nothing: turri binds the host's `/proc` instead). Without one, the check and the audit hold alone |
| a model provider | the agents need a model | run `pi` and `/login`, or set an API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, ...) |
| `turri` on PATH | so it runs from any project | `npm link` in this clone |
| in every `pi` (optional) | a plain `pi` gets the tools too, not only `turri chat` | `setup` offers to write the one-line extension and copy the themes |

In a project - a folder with `config.yaml` or `plain_modules` - it checks what the project needs of this machine too:

| what | |
| --- | --- |
| each module's toolchains | what its implementation reqs name - Python, Node, Java, Go, Rust, C/C++, Zig, ... - against this machine's PATH: the agents use this machine's toolchains and install none, so a missing one is yours to install |
| the testing scripts | what in them this machine does not have: a program named by its whole path that is not here (a macOS-only `/usr/libexec/java_home` on Linux), a toolchain they run that is not on the PATH |

Installing turri into every `pi` is the one thing `setup` does beyond `doctor`, and it asks first; `turri setup --yes`
says yes. Run without a terminal - piped, or in CI - it asks nothing, changes nothing, and lists what it would have
asked.

Afterwards:

```bash
turri doctor            # the same checks, changing nothing - for when something breaks
```

The chat is told every turn which wall is up and what the project's modules need of this machine that it lacks.

## turri in every `pi`

`turri chat` runs pi from this project's `node_modules`, so no global pi install is needed.
To get the tools in a plain `pi` instead, let `turri setup` install a one-line global
extension (`~/.pi/agent/extensions/turri.ts`) and copy the themes to `~/.pi/agent/themes/`.
By hand, it is:

```bash
mkdir -p ~/.pi/agent/extensions
cat > ~/.pi/agent/extensions/turri.ts <<'EOF'
export { default } from "/absolute/path/to/turri/src/extension.ts";
EOF
cp .pi/themes/*.json ~/.pi/agent/themes/
```

That is the only absolute path in the setup, and deleting the file removes the tools. pi treats a
tool registered twice as an error, so `turri chat` checks for the global extension and
themes and skips its own `-e` / `--theme` when it finds them.

`turri chat` starts in the `turri-dark` theme. A plain `pi` keeps its own theme; to give it
`turri-dark` too, in `~/.pi/agent/settings.json`:

```json
{ "theme": "turri-dark" }
```

### Project trust

pi will not auto-discover a project-local extension until you trust the project, and `-p` has no
way to ask - so `npm run chat` and `npm run ask` pass `-e` explicitly. Once you have run `pi`
interactively in this directory and accepted the trust prompt, plain `pi` picks the extension up
on its own. A `defaultProjectTrust` key in `.pi/settings.json` does *not* work - a project cannot
vouch for itself; that setting only counts in `~/.pi/agent/settings.json`.

## Environment

Models and credentials come from your pi configuration (`~/.pi/agent`) or provider environment
variables - the same resolution `pi` itself uses. Put the rest in your shell profile:

```bash
export PLAIN_TEMPLATE_DIRS=~/path/to/standard_template_library   # shared templates
export GEMINI_API_KEY=...        # and leave GOOGLE_API_KEY unset
```

For Gemini, `GEMINI_API_KEY` is what makes pi *offer* the google provider, but when
`GOOGLE_API_KEY` is also set pi uses that one for the calls and says so.

| variable | |
| --- | --- |
| `PLAIN_TEMPLATE_DIRS` | colon-separated template directories, e.g. the standard library |
| `TURRI_COMMAND_TIMEOUT` | seconds a command may run before it is stopped - an agent's own, its tests (default `120`) |
