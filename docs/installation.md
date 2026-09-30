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
| Node 22.19+ | plainwright runs its `.ts` sources directly, and pi needs 22.19 | install a newer Node |
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

### What goes into the image

Every command an agent runs - its shell, the builds, the tests - runs in a VM of this image, so it
has to hold what your projects are written and built with. There are three ways to have it:

- **The default image, as it is.** plainwright's recipe, `vm/image.json`: Python (`python3`, `pip`,
  `uv`), Node (`nodejs`, `npm`), Java (`openjdk21-jdk`, Maven, Gradle), Go, Rust (`rust`, `cargo`),
  C/C++ (`build-base`, `cmake`) and the basics.
- **The default image, changed**, for every project on this machine: your own file,
  `~/.plainwright/vm-image.json`, laid over the recipe and kept across plainwright's updates -

  ```json
  { "remove": ["java", "python"], "add": ["zig"] }
  ```

  `remove` takes toolchains by name - `python`, `node`, `java`, `go`, `rust`, `c` - or Alpine
  packages; `add` takes Alpine packages. `{ "packages": [...] }` instead defines the image in full.
- **A project's own image**: `vm-image:` in the project's `config.yaml`, the same keys, over your
  file -

  ```yaml
  vm-image:
    packages: [zig, nodejs]     # or add: [...] and remove: [...]
  ```

  `plainwright vm-image` run in that project builds it, under a tag of the project's own
  (`plainwright-<folder>-<hash>:latest`), and every VM of the project runs it. Until it is built, the
  project runs the default image, and says so. `--default` builds the default image instead.

The basics - git, bash, curl, the file tools and what the VM needs to boot - are in every image,
whatever a list says: a list that leaves them out has them put back, and removing one is refused.
Before a build, `plainwright vm-image` and `setup` say what the image will hold; `plainwright doctor`
says what it holds, and when its recipe asks for something it was not built with. Don't edit
`vm/image.json` itself: an update puts it back.

In the chat, plainwright knows all of this: it is told every turn what the project's image holds
and what each module's implementation reqs need of it that it lacks - Zig named in the reqs, no Zig
in the image - and it follows the managing-vms rule. It can write your file or the project's
`vm-image:` and build either with `build_vm_image`, as a background job; VMs started afterwards run
the new image.

A small library or tool one project needs - `sqlite`, `jq`, `libpq-dev` - takes no image of its own:
`system-packages:` in its `config.yaml` names Alpine packages every VM of the project installs when
it starts (see [the project config](config.md#the-keys)).

### Where it is downloaded from

Everything in the image is Alpine Linux, from Alpine's own server, `dl-cdn.alpinelinux.org`, for
the release the recipe builds on:

| what | from |
| --- | --- |
| the base system (the minirootfs) | `https://dl-cdn.alpinelinux.org/alpine/v3.23/releases/<arch>/alpine-minirootfs-3.23.0-<arch>.tar.gz` |
| every package, with all it depends on | the `main` and `community` repositories, `https://dl-cdn.alpinelinux.org/alpine/v3.23/main` and `.../community` |
| the VM's kernel | `linux-virt`, from `main` |
| the libkrun backend's kernel | the [libkrunfw](https://github.com/containers/libkrunfw) project's GitHub releases |

Python is Alpine's `python3` package, Java is `openjdk21-jdk`, and so on - built by Alpine from the
upstream projects. `plainwright vm-image --plan` lists every package a build would download,
without building anything: its version, repository, the project it comes from, its licence and
size, what each toolchain costs beyond the basics, and any name the repositories don't have (a
build stops on it before downloading anything). `setup` and the build say the same before they
start, and `doctor` says where the built image came from.

You can steer where it comes from, in your file or in a project's `vm-image:`, with a project's
setting over yours:

```json
{ "mirror": "https://mirror.example.com/alpine" }
```

```yaml
vm-image:
  mirror: https://mirror.example.com/alpine          # another server in dl-cdn's layout
  repositories:                                      # or the package repositories exactly
    - https://apk.example.com/alpine/v3.23/main
    - https://apk.example.com/alpine/v3.23/community
```

- `mirror` is another server in Alpine's own layout - a public mirror nearer you, or your
  company's. The base system, the kernel and the packages all come from it.
- `repositories` names the package repositories exactly, in the order they are searched, in place
  of the release's `main` and `community` - a company proxy, or `testing` added. The base system and
  the kernel still come from the mirror, or from Alpine's own server when there is no mirror.

Gondolin installs packages from the repositories the base system lists, so plainwright writes the
chosen ones into its `/etc/apk/repositories` before the build. The base system is kept, and the
build runs, in a folder of that set of sources' own under `~/.cache/plainwright/vm-build/`, so
Alpine's own downloads never mix with a mirror's. The image keeps the repositories: what a VM
installs later - `system-packages:`, or a coding agent's `install_system_packages` - comes from them
too. Changing the sources takes a rebuild, and `doctor` says so. What a mirror serves is taken as it
serves it, so name only servers you trust. The libkrun kernel always comes from GitHub, and the
stock image, which runs before any image is built, is Gondolin's own download.

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
```

For Gemini, `GEMINI_API_KEY` is what makes pi *offer* the google provider, but when
`GOOGLE_API_KEY` is also set pi uses that one for the calls and says so.

| variable | |
| --- | --- |
| `PLAIN_TEMPLATE_DIRS` | colon-separated template directories, e.g. the standard library |
| `PLAINWRIGHT_VM_IMAGE` | a different Gondolin image to boot (default `plainwright:latest`) |
| `PLAINWRIGHT_VM_DISK`, `PLAINWRIGHT_VM_MEMORY`, `PLAINWRIGHT_VM_CPUS` | the VM's size (default `8G`, `2G`, `2`) |
| `PLAINWRIGHT_COMMAND_TIMEOUT` | seconds a command in the VM may run before it is stopped - an agent's own, its tests, an install (default `120`) |
