# Installation

**turri** runs wherever pi runs - macOS, Linux, WSL - with git, bash and Node 22.19 or newer (a Linux
distribution's own `nodejs` package is often older: take it from nodejs.org, nvm or NodeSource). Native Windows is
best effort: it needs bash on the PATH (Git for Windows' Git Bash), and has no OS sandbox under the agents' commands.

The agents' commands run on this machine, with its toolchains - see [the sandbox](sandbox.md). Each is checked before
it runs and audited after, on every platform; under them an OS sandbox fences it where the OS has one: Seatbelt on
macOS, always there, and bubblewrap on Linux and WSL 2 - `apt install bubblewrap`, or your distribution's package.

```bash
npm install -g @turri-rs/cli   # puts `turri` on your PATH
turri doctor           # checks the machine: what turri needs, and what is missing
```

Then, in the project that holds your specs:

```bash
cd ~/my-project
turri init-config   # a config.turri.yaml with the model you talk to and the one that writes the code, every other setting at its default
turri               # pi, with turri's tools, skills and themes loaded
```

The package is `@turri-rs/cli` - rs for regenerative software; npm keeps the name `turri` back, as too like another
package's - and the command it puts on your PATH is `turri`.

## From a clone

To work on turri itself, put the clone on your PATH instead:

```bash
git clone git@github.com:plainlang/turri.git && cd turri
npm install
npm link              # puts `turri` on your PATH, pointing at this clone
```

A clone runs its TypeScript sources directly - Node strips the types - so edits take effect immediately. The package
on npm runs JavaScript compiled from them instead (`npm run build`, into `dist/`, run by `npm pack` and `npm publish`
before they pack), as Node runs no `.ts` file inside a `node_modules`. `bin/turri.mjs` runs `src/` where there is one,
and `dist/` otherwise.

## In Docker

`docker/Dockerfile` builds an image with Node, git, bash, bubblewrap and **turri** linked; the agents' commands and the
testing scripts run inside it, so add the toolchains your projects need first. It runs **turri** as the user who owns
the project folder mounted at `/work`, never as root - bubblewrap as root in a container lacks the capability to make
its namespaces - and with seccomp and AppArmor unconfined the OS sandbox starts. `systempaths=unconfined` lets it mount
a `/proc` of its own; without it, it binds the container's. The build, the run, Windows and the keys:
[turri in Docker](../docker/README.md).

## What `turri doctor` checks

It checks, in order, and says exactly what to run for anything missing:

| what | why | if it is missing |
| --- | --- | --- |
| Node 22.19+ | pi needs 22.19, as does a clone running turri's `.ts` sources directly | install a newer Node |
| bash | every command an agent runs, and every testing script, runs with it | on Windows, Git for Windows; elsewhere, the system's package manager |
| the OS sandbox | the wall under the command check and the audit | macOS has Seatbelt; on Linux, `apt install bubblewrap`. Where it does not start it says why and how to give it one - user namespaces off (Docker: a user that is not root, `--security-opt seccomp=unconfined`), AppArmor in the way (Docker: `--security-opt apparmor=unconfined`; Ubuntu 24.04: `sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`), Docker's masked `/proc` (`--security-opt systempaths=unconfined`, or nothing: turri binds the container's `/proc` instead). Without one, the check and the audit hold alone |
| a model provider | the agents need a model | run `pi` and `/login`, or set an API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, ...) |
| `turri` on PATH | so it runs from any project | `npm install -g @turri-rs/cli`, or `npm link` in a clone |
| turri and `pi` apart | `turri` starts pi with turri; a plain `pi` stays pi | an older `turri setup` wrote a file that loads turri into every `pi` - `doctor` offers to remove it |

In a project - a folder with `config.turri.yaml` (or the old `config.yaml`) or `plain_modules` - it checks what the project needs of this machine too:

| what | |
| --- | --- |
| each module's toolchains | what its implementation reqs name - Python, Node, Java, Go, Rust, C/C++, Zig, ... - against this machine's PATH: the agents use this machine's toolchains and install none, so a missing one is yours to install |
| the testing scripts | what in them this machine does not have: a program named by its whole path that is not here (a macOS-only `/usr/libexec/java_home` on Linux), a toolchain they run that is not on the PATH |
| the models | each model `config.turri.yaml` names - `harness-model`, `coding-model`, `judge-model`, every role under `models:` - sent one short request through pi, with the credentials turri's agents will use, for any provider pi supports. One that answers is ready; for one that does not, it says what the provider said and what to do: the credentials pi reads for that provider (`AWS_PROFILE` and `AWS_REGION` for Amazon Bedrock, `OPENAI_API_KEY`, `/login`, ...), model access in the Bedrock console, the closest model ids pi knows for one it does not. `--no-models` skips it |

Removing that file is the one thing `doctor` changes, and it asks first; `turri doctor --yes` says yes. Run without a
terminal - piped, or in CI - it asks nothing and changes nothing. Run it again whenever something breaks;
`turri doctor --no-models` leaves out the models' requests.

The chat is told every turn which wall is up and what the project's modules need of this machine that it lacks.

## turri and `pi`

`turri` runs pi from this project's `node_modules`, with turri loaded, so no global pi install is needed. A plain
`pi` is left as it is: starting pi does not start turri, and turri puts nothing into pi's own folders.

An older `turri setup` could load turri into every `pi`, with a one-line file in `~/.pi/agent/extensions/` pointing at
this clone. `turri doctor` says when it is there, and offers to remove it. Until it is gone, `turri`
leaves out its own `-e`: pi treats a tool registered twice as an error.

`turri` starts in the `turri-dark` theme. A plain `pi` keeps its own theme; to give it
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
