# The sandbox

A rendering agent is building one module. It has no business reading the `.plain` specs it was
not given, the rest of the project, or anything else on the machine - and pi's `cwd` is only
where relative paths start: an absolute path resolves to itself and `bash` can `cd` anywhere. So
plainwright fences its agents twice: their file tools check every path, and every command runs in
a VM that holds nothing else.

## What an agent can reach

Every agent - render, conformance author, code fixer, regression repair - reads and writes the
whole of `plain_modules`, every module's code and tests, and nothing above it. The specs it is
building from reach it only through the prompt the harness writes.

## File tools

`src/render/confine.ts` rebuilds `read`, `write`, `edit`, `ls`, `grep` and `find` from pi's own
factories with a check in front of every path. The check runs twice: once on the argument the
tool was called with, and once on the absolute path the tool resolved it to, because the two can
differ. Symlinks are resolved before comparing, so a link cannot walk out, and a glob containing
`..` is refused outright.

## Commands run in a VM

`bash` is the case no argument check can cover - one string, and no way to read where it will
read or write. So it does not run on the host at all. Every command - the agent's `bash`,
`run_unit_tests`, conformance runs, the harness's runs of the project's testing scripts, the try-it
checks - runs in one
[Gondolin](https://github.com/earendil-works/gondolin) micro-VM (Alpine Linux) per project:

- It holds `plain_modules` and nothing else, mounted read-write at the path it has on the host.
  The specs above it, the home directory and every other project do not exist in there.
- The host environment is not passed in, so the provider's API keys stay out.
- The network reaches the package registries (Alpine, PyPI, npm, Go, crates.io, Maven Central,
  Gradle) and any host named in `PLAINWRIGHT_ALLOWED_HOSTS`, nothing else.
- Files on the mount are executable inside the VM: Gondolin's mounts drop mode changes, and a
  built binary, a `./gradlew` or a test script has to run. And they are owned by root, who runs
  everything in there: a JVM ignores an attach request whose trigger file is not its own, which
  would break Mockito's inline mocks, and git calls a repository owned by someone else dubious.

No command can hang a build. Every one has a time limit - 2 minutes, or
`PLAINWRIGHT_COMMAND_TIMEOUT` seconds: the agent's own `bash` unless it gives a timeout (at most 30
minutes), its unit and conformance test runs, the harness's own runs, `install_system_packages`. A
command that runs out is killed and reports exit 124 with a note on what to do instead: a server,
a watcher or a prompt waiting for input never ends on its own, and has to be started in the
background or given its input. A job that is stopped ends the command it is waiting on at once.
Either way the command is killed in the VM too, with everything it started - Gondolin's abort only
stops waiting for a command, so each one records its process ID and is killed by it.

The VM starts on the first command and is kept until pi exits. VMs run on Apple Silicon macOS and
on Linux, on QEMU. Anywhere else, or when the VM fails to start, there is no fallback: the agent
gets no shell and commands are refused, because there is no honest way to fence one on the host.
`plainwright doctor` says which of those it is.

## The web

Every rendering agent - render, spec change, conformance, regression repair - can also search the
web and read a page, for a library's documentation or an error it has not seen:

| Tool | What it does |
| --- | --- |
| `web_search` | asks DuckDuckGo (no key needed) and returns title, address and snippet per result |
| `web_fetch` | reads one page and returns it as text - HTML without its markup, text, JSON or XML as it is; long pages come in parts |

Both run on the host, not in the VM, so the VM's network stays as it is: the code an agent builds
and runs, its tests and the packages it installs still reach only the registries. `web_fetch` reads
only the public web: localhost, the private ranges and the cloud metadata address are refused, and
so is every redirect that leads to one, so it cannot reach through the host what the VM is kept from.

DuckDuckGo is used without a key through its Lite page, which is not an official API: it rate-limits,
and a search that is turned away tells the agent to wait or fetch a page it knows instead.

## What the VM needs beside the code

It lives in `plain_modules/.plainwright`, which ignores itself in git:

| | |
| --- | --- |
| `cache/` | package caches - pip, npm, cargo, Maven, Gradle, Go, apk - so a dependency downloads once per project |
| `runs/` | the throwaway copies conformance runs happen in, emptied after each run |
| `try/` | the copies try-it steps are checked in, and where you try a build yourself |
| `system-packages.json` | the system packages the agents installed |

## Installing what the image lacks

The full image has Python, Node, Java 21 with Maven and Gradle, Go, Rust, C/C++ with make and
cmake, and git (see [installation](installation.md#building-the-vm-image)). A language, compiler
or system library it lacks, the agent installs with `install_system_packages` (Alpine packages).
The packages are recorded in `system-packages.json` and installed again - from the project's
cache - whenever the project's VM starts, so what one render set up is there for every later one.
Project dependencies go through the project's own package manager as usual.

On the stock image there is too little room for that - see
[Without the full VM image](installation.md#without-the-full-vm-image).
