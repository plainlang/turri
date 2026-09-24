# Installation

```bash
git clone git@github.com:plainlang/plainwright.git && cd plainwright
npm install
npm link              # puts `plainwright` on your PATH, pointing at this clone
plainwright setup     # checks the machine, fixes what it can, asks before each change
```

Then, in the project that holds your specs:

```bash
cd ~/my-project
plainwright chat      # pi, with plainwright's tools, skills and themes loaded
```

`npm link` has to be a link, not `npm install -g`: Node will not run `.ts` files from inside a
`node_modules`, and a copying global install puts them there. The link points at this working
copy, so edits here take effect immediately.

## What `plainwright setup` checks

It checks, in order, and says exactly what to run for anything missing:

| what | why | if it is missing |
| --- | --- | --- |
| Node 22.18+ | plainwright runs its `.ts` sources directly | install a newer Node |
| QEMU | every command an agent runs, runs in a sandbox VM on it | `setup` offers `brew install qemu`; on Linux, `apt install qemu-system-arm` / `qemu-system-x86` |
| the VM image | the full image has Python, Node, Java, Go, Rust, C/C++ and git | `setup` offers to build it (about 7 minutes, 2 GB) - see [Building the VM image](#building-the-vm-image) |
| a model provider | the agents need a model | run `pi` and `/login`, or set an API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, ...) |
| `plainwright` on PATH | so it runs from any project | `npm link` in this clone |
| in every `pi` (optional) | a plain `pi` gets the tools too, not only `plainwright chat` | `setup` offers to write the one-line extension and copy the themes |

It ends by starting a sandbox VM for real and listing the toolchains in it, since a VM that does
not start is the one thing that stops every render. Nothing is changed without asking;
`plainwright setup --yes` says yes to everything. Run without a terminal - piped, or in CI - it
asks nothing, changes nothing, and lists what it would have asked.

Afterwards:

```bash
plainwright doctor            # the same checks, changing nothing - for when something breaks
plainwright doctor --quick    # without starting a VM
plainwright vm-image          # build (or rebuild) the full VM image
```

A pi session says on its first line where commands will run - the image in use, a limit such as
the stock image, or that there is no VM and why. A VM that fails to start refuses the command and
names `plainwright doctor`.

## Building the VM image

The image is built once and then only run: building it is the only thing that needs e2fsprogs or
Docker. Every session boots the built image with QEMU through
[Gondolin](https://github.com/earendil-works/gondolin), and needs neither.

`plainwright vm-image` builds it the first way this machine has (`--native` or `--docker` picks
one):

| | needs | |
| --- | --- | --- |
| with e2fsprogs (the default) | `brew install e2fsprogs`, or `apt install e2fsprogs` | a few small command-line tools, installed once - nothing to start or keep running. Gondolin unpacks the Alpine packages itself; e2fsprogs writes the disk image. |
| in Docker | Docker, running | the build runs in a Linux container. For when e2fsprogs cannot be installed. |

Both take about 7 minutes and produce the same image, `plainwright:latest` in
`~/.cache/gondolin/images`, for this machine's architecture. What goes into it is `vm/image.json`.
`plainwright setup` works through them in that order:

- **e2fsprogs installed** - it offers to build.
- **e2fsprogs not installed** - on macOS it offers to install it with Homebrew, then to build; on
  Linux it prints `sudo apt install e2fsprogs`.
- **Still no e2fsprogs** - it falls back to Docker: it offers to build in Docker if it is running,
  or to start it first if it is installed but not running (`open -a Docker` on macOS, and waits
  for it; on Linux it prints `sudo systemctl start docker`).
- **Neither** - it says so, explains what the stock image means for your project, and names both
  ways to get the full one.

`plainwright doctor` shows which way is available as `Image builder`.

## Without the full VM image

Until the image is built, commands run in Gondolin's stock image, downloaded on first use (about
200 MB). What that means for a project:

| | |
| --- | --- |
| works | Python 3.12 (`venv`, `pip` inside a venv, `uv`) and Node 24 (`npm`) projects. Their dependencies install into the project folder, so there is room for them - FastAPI, SQLAlchemy, pytest, Express, Vitest all install. |
| missing | C/C++ compilers and `make`, `git`, Java, Go, Rust. |
| so | A Java, Go, Rust or C/C++ project cannot be built. A Python or npm package that has to compile native code - one with no prebuilt build for Alpine - fails to install. |
| installing more | The VM's own disk has about 80 MB free. `install_system_packages` fits small packages (`jq`, `sqlite`), never a compiler or a JDK. |

The agents are told the same, so on the stock image a project that needs more is reported as
needing the full image rather than fought with.

## plainwright in every `pi`

`plainwright chat` runs pi from this project's `node_modules`, so no global pi install is needed.
To get the tools in a plain `pi` instead, let `plainwright setup` install a one-line global
extension (`~/.pi/agent/extensions/plainwright.ts`) and copy the themes to `~/.pi/agent/themes/`.
By hand, it is:

```bash
mkdir -p ~/.pi/agent/extensions
cat > ~/.pi/agent/extensions/plainwright.ts <<'EOF'
export { default } from "/absolute/path/to/plainwright/src/extension.ts";
EOF
cp .pi/themes/*.json ~/.pi/agent/themes/
```

That is the only absolute path in the setup, and deleting the file removes the tools. pi treats a
tool registered twice as an error, so `plainwright chat` checks for the global extension and
themes and skips its own `-e` / `--theme` when it finds them.

`plainwright chat` starts in the `forge` theme. A plain `pi` keeps its own theme; to give it
`forge` too, in `~/.pi/agent/settings.json`:

```json
{ "theme": "forge" }
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
export PLAINWRIGHT_ALLOWED_HOSTS=api.example.com   # hosts the VM may reach beyond the registries
```

For Gemini, `GEMINI_API_KEY` is what makes pi *offer* the google provider, but when
`GOOGLE_API_KEY` is also set pi uses that one for the calls and says so.

| variable | |
| --- | --- |
| `PLAIN_TEMPLATE_DIRS` | colon-separated template directories, e.g. the standard library |
| `PLAINWRIGHT_ALLOWED_HOSTS` | comma-separated hosts the sandbox VM may reach, beyond the package registries |
| `PLAINWRIGHT_VM_IMAGE` | a different Gondolin image to boot (default `plainwright:latest`) |
| `PLAINWRIGHT_VM_DISK`, `PLAINWRIGHT_VM_MEMORY`, `PLAINWRIGHT_VM_CPUS` | the VM's size (default `8G`, `2G`, `2`) |
