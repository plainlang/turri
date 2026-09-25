# The sandbox

A rendering agent is building one module. It has no business reading the `.plain` specs it was
not given, the rest of the project, or anything else on the machine - and pi's `cwd` is only
where relative paths start: an absolute path resolves to itself and `bash` can `cd` anywhere. So
plainwright fences its agents twice: their file tools check every path, and every command runs in
a VM that holds nothing else.

## What an agent can reach

Every agent - render, conformance author, code fixer, regression repair - reads and writes the
whole of `plain_modules` with its file tools, every module's code and tests, and nothing above it.
Its commands reach less: only its own module's folder (see below). The specs it is
building from reach it only through the prompt the harness writes. Nor does any context file: pi puts
every `AGENTS.md` / `CLAUDE.md` from an agent's folder up into its system prompt, and plainwright
turns that off for every agent it starts - so the project's own `AGENTS.md`, or yours in
`~/.pi/agent`, never reaches a rendering agent, a judge or a skill's agent. The conversation you
talk to still loads them, as pi does.

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
checks - runs in a
[Gondolin](https://github.com/earendil-works/gondolin) micro-VM (Alpine Linux) for the module it
works in:

- It holds that module's folder, `plain_modules/<module>`, and `plain_modules/.plainwright` - the
  package caches and the copies test runs happen in - mounted read-write at the paths they have on
  the host. The other modules, the specs, the home directory and every other project do not exist
  in there.
- The host environment is not passed in, so the provider's API keys stay out.
- The network is open: any host on the web, internal addresses included, and this machine's
  localhost on any port - a storage service or a mock API the tests talk to, running here. In the VM,
  `localhost:<port>` reaches a server the VM runs on that port - the app under test - and this
  machine's when it runs none; `host.plainwright.internal:<port>` is always this machine's. A small
  proxy in the VM does that, started with it: every connection to the VM's loopback is redirected
  through it (iptables), and it tries the VM's own server first. Only HTTP(S) goes out to the web -
  Gondolin proxies it - so a raw TCP connection to a remote host, a database elsewhere, does not.
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

A project works through its modules one at a time, and so has one VM at a time. A module's VM starts
on the first command run in it, and its jobs - functionalities, spec changes, conformance tests - reuse
it one after another. The moment the project moves on to another module, the old VM is shut down and
the new one's started, which costs a second or two; the system packages come back from the cache and
the dependencies are in the module's folder. A VM nothing has used for a minute is shut down too. Two
modules rendering at once each keep their own, and several projects never share one. VMs run on Apple Silicon macOS and
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

Both run on the host, not in the VM. `web_fetch` reads only the public web: localhost, the private
ranges and the cloud metadata address are refused, and so is every redirect that leads to one - what
the code talks to on this machine, the agent reaches with its commands in the VM.

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
