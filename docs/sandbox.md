# The sandbox

A rendering agent is building one module. It has no business reading the `.plain` specs it was
not given, the rest of the project, or anything else on the machine - and pi's `cwd` is only
where relative paths start: an absolute path resolves to itself and `bash` can `cd` anywhere. So
turri fences its agents twice: their file tools check every path, and every command runs in
a VM that holds nothing else.

## What an agent can reach

Each agent's file tools reach its own module and only the parts its role needs:

| Role | Reads | Writes |
| --- | --- | --- |
| Coding agent, regression repair | its module's `code/` | its module's `code/` |
| Conformance agent | its module's `tests/` and `code/` | its module's `tests/` |
| Code fixer | its module's `code/` and `tests/` | its module's `code/` |
| Explorers | its module's `code/` | nothing |
| Test review | its module's `tests/` and `code/` | nothing |

Nothing else exists for them: not another module, not turri's scratch area `plain_modules/.turri` (a test run's
whole output reaches them through `read_output`, not by path), not the module's lineage `.plaingit`, and nothing
above `plain_modules`. The specs it is
building from reach it only through the prompt the harness writes. Nor does any context file: pi puts
every `AGENTS.md` / `CLAUDE.md` from an agent's folder up into its system prompt, and turri
turns that off for every agent it starts - so the project's own `AGENTS.md`, or yours in
`~/.pi/agent`, never reaches a rendering agent, a judge or a skill's agent. Nor do pi's skills, which
pi would list for an agent to load: each agent turri starts has one job, and turri runs its
own gated skills itself. The conversation you talk to still loads both, as pi does.

## Every agent knows its walls

Each agent's system prompt says where its sandbox is: which folders its file tools can read and
write, what the VM its shell runs in holds (its module's folder - turri's own scratch area is in the VM too, but
nothing there is the agent's, so it is not named), that nothing else exists for it - not the rest of the
machine, not the specs, not the project's other folders - that everything it needs is in its prompt,
and not to look outside or try to get around it. The words come from its fence itself, so they say
exactly what is enforced. In a conformance run, the conformance agent is told it has read access to
the code but not write access - it writes only tests - and the coding agent that fixes the code is
told it has read access to the conformance tests but not write access. Each one's shell holds only its
own folder.

Nothing it is shown points outside its walls. A test run or a command whose output was cut names the whole of it by
an id, and the agent reads it with `read_output` - not by a path into `plain_modules/.turri` or to a temporary file on
this machine (see [long output](growing.md#the-tests-must-actually-pass)).

## File tools

`src/grow/confine.ts` rebuilds `read`, `write`, `edit`, `ls`, `grep` and `find` from pi's own
factories with a check in front of every path. The check runs twice: once on the argument the
tool was called with, and once on the absolute path the tool resolved it to, because the two can
differ. Symlinks are resolved before comparing, so a link cannot walk out, and a glob containing
`..` is refused outright.

Credentials are the person's: no agent writes a `.env` or a variant of one (`.env.local`, `.env.test`) - a
template, `.env.example`, is fine. The file tools refuse it, and what an agent's `bash` does to one in what
its VM holds - the module and `plain_modules/.turri` - is put back as it was after the command, the agent
told why. A made-up credential makes every later run fail without anyone seeing why; a missing one is the
judge's to report (see [growing the code](growing.md)), the person's to provide.

## Commands run in a VM

`bash` is the case no argument check can cover - one string, and no way to read where it will
read or write. So it does not run on the host at all. Every command an agent runs with its `bash` runs in a
[Gondolin](https://github.com/earendil-works/gondolin) micro-VM (Alpine Linux). A module has two:

- **Its code's**, holding `plain_modules/<module>/code`: where code is rendered - the coding agent's
  and the explorer's commands.
- **Its tests'**, holding `plain_modules/<module>/tests`, and the module's `code` read only: where
  conformance tests are rendered - the conformance agent's and the judge's commands. They can read and
  run the code, and build it from a copy in the scratch folder, but never change it.

The project's testing scripts do not run in the VM: they are yours, and run on this machine as you would run them,
unfenced, in your own environment - on a fresh copy of the code, or in place - and only through `run_unit_tests`,
`run_conformance_tests` and the harness's own runs; see [the testing scripts](growing.md#the-testing-scripts). The
agent gets their output, nothing more.

Each also holds `plain_modules/.turri` - the package caches and the copies test runs happen
in - mounted read-write at the paths they have on the host. Neither holds the other's folder; the
other modules, the specs, the home directory and every other project do not exist in either.
- The host environment is not passed in, so the provider's API keys stay out.
- The network is open: any host on the web, internal addresses included, and this machine's
  localhost on any port - a storage service or a mock API the tests talk to, running here. In the VM,
  `localhost:<port>` reaches a server the VM runs on that port - the app under test - and this
  machine's when it runs none; `host.turri.internal:<port>` is always this machine's. A small
  proxy in the VM does that, started with it: every connection to the VM's loopback is redirected
  through it (iptables), and it tries the VM's own server first. Only HTTP(S) goes out to the web -
  Gondolin proxies it - so a raw TCP connection to a remote host, a database elsewhere, does not.
- Files on the mount are executable inside the VM: Gondolin's mounts drop mode changes, and a
  built binary, a `./gradlew` or a test script has to run. And they are owned by root, who runs
  everything in there: a tool that checks who owns a file refuses one that is not its own - a
  runtime attaching to itself, git calling a repository owned by someone else dubious.

No command can hang a build. Every one has a time limit - 2 minutes, or
`TURRI_COMMAND_TIMEOUT` seconds: the agent's own `bash` unless it gives a timeout (at most 30
minutes), its unit and conformance test runs, the harness's own runs. A
command that runs out is killed and reports exit 124 with a note on what to do instead: a server,
a watcher or a prompt waiting for input never ends on its own, and has to be started in the
background or given its input. A job that is stopped ends the command it is waiting on at once.
Either way the command is killed in the VM too, with everything it started - Gondolin's abort only
stops waiting for a command, so each one records its process ID and is killed by it.

A project works through its modules one at a time, and so has one module's VMs at a time. Each starts
as a job begins - in the background, so it boots while the agent reads its task and writes its first
files, and is ready by its first command (`TURRI_VM_WARM=0`: on the first command instead) - and the module's jobs - functionalities, spec changes, conformance
tests - reuse them one after another; a job holds both while it works in the module. The moment the
project moves on to another module, the old module's VMs are shut down and the new one's started, which costs a second or two; the system packages the agents installed before, and the image lacks, come back from the cache -
offline first, from the network only for one the cache does not hold, and for 90 seconds at most
(`TURRI_VM_SETUP_TIMEOUT`), after which the VM goes on without them - and the dependencies are in the
module's folder. A command waiting for its VM to start waits as long as a start can take - its boot and that
setup - and not once it is stopped: it is not run, and says so, and the VM goes on starting for the next one. The wait
is not the agent's: the clock on its turn stops while a command waits for its VM, and runs on from where it was once the
VM is up. A start says how long it took and where the time went - created, booted, localhost made reachable - and that,
with every other line about the VM, is kept in the job's log in `.turri/jobs/`, beside what the agents did. A VM nothing has used for a minute is shut down too, and every VM when turri exits. A VM does not die with
the process that started it, so each has a watcher beside it - a small shell that stops it within
two seconds of its turri ending, however it ends: killed outright, crashed, a test worker
terminated. One left running all the same - its parent gone, the system holding it - is stopped
when turri next starts, and you are told: nothing else would ever stop it, and it holds its memory. Two
modules rendering at once each keep their own, and several projects never share one. VMs run on Apple Silicon macOS and
on Linux, on QEMU. Anywhere else, or when the VM fails to start, there is no fallback: the agent
gets no shell and commands are refused, because there is no honest way to fence one on the host.
`turri doctor` says which of those it is.

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

## Outside the sandbox: deploy

What `deploy` starts is the one thing that runs on your machine, not in a VM: you asked to try the
software, with your toolchains, in your browser. It runs from `dist/<module>`, a copy of the last
commit outside `plain_modules`, so no rendering agent reaches it. Nothing is installed there without
your say-so - every command that would install or download is put to you first, and the chat's shell
refuses the rest. See [deploy](deploy.md).

## What the VM needs beside the code

It lives in `plain_modules/.turri`, which ignores itself in git:

| | |
| --- | --- |
| `cache/` | package caches - pip, npm, cargo, Maven, Gradle, Go, apk - so a dependency downloads once per project |
| `runs/` | the throwaway copies conformance runs happen in, emptied after each run |
| `system-packages.json` | the system packages the agents installed |

## Installing what the image lacks

The default full image has Python, Node, Java 21 with Maven and Gradle, Go, Rust, C/C++ with make
and cmake, and git. You can change it for every project, or give a project an image of its own -
see [what goes into the image](installation.md#what-goes-into-the-image). A language, compiler or
system library it lacks is not the agents' to install: they install nothing into the VM, and say what
is missing - for you to add to the project's image (`vm-image:` in `config.yaml`, then `turri vm-image`).
What `system-packages:` in `config.yaml` names, and what agents installed before they could no longer
(`system-packages.json`), is added from the project's cache whenever the project's VM starts - only what
the image does not have. They come from the repositories
the image was built with - Alpine's own, or the mirror the recipe names (see
[where it is downloaded from](installation.md#where-it-is-downloaded-from)).
Project dependencies go through the project's own package manager as usual.

On the stock image there is too little room for that - see
[Without the full VM image](installation.md#without-the-full-vm-image).

## Commands on this machine

The VM is being replaced by commands run on this machine, fenced. The one way such a command runs is
`src/grow/shell.ts` (`runCommand`), built and not yet used by agents: `bash -c` from the agent's folder, in a process
group of its own, with the same time limit and the same note as in the VM. The limit or a stopped job kills the whole
group - what it put in the background too. A server a command leaves running when it ends is its pulse's: it runs on
until the pulse ends, and is killed then; a pulse running beside it keeps its own. Everything still running is killed
when turri exits, ended by a signal too. A turri killed outright cannot do that itself, so one small watcher beside it
does, within two seconds, from the groups it recorded in the temporary folder (`turri-groups/`); and groups a turri left
that nothing killed are swept when turri next starts. On Windows there are no process groups: a command's process
tree is killed with `taskkill /T /F`, best effort.

### The command check

Before such a command runs, its text is checked (`src/grow/command-check.ts`, `checkCommand`), on every platform, and
refused - not run - with the rule it broke and what to do instead, when it:

- names a path outside the role's roots - absolute, a `..` that climbs out of the agent's folder (after the `cd`s
  before it), or inside a quoted string (`python3 -c "..."`). `~`, `$HOME` and `$TMPDIR` are the module's own and
  allowed, as are the package caches, the machine's system folders and the toolchains, and the devices
  (`/dev/null`). A path is checked when it names something on disk - under a top folder such as `/Users`, `/home`,
  `/etc` or `/tmp`, one of the fence's, or one that exists - so an API route in a curl or a JSON body is not one;
- names the code record, `.turri.json`;
- writes a credential file (`.env` and its variants; a template is fine) - by redirect, `tee`, `cp`, `mv` or an edit
  in place;
- installs software outside the project: `sudo`, the system's package managers installing (`brew`, `apt`, `dnf`,
  `apk`, `pacman`, `choco`, `winget`, ...), toolchain managers installing (`nvm`, `sdk`, `rustup`, `pyenv`, `asdf`,
  ...), global installs (`npm -g`, `yarn global`, `pip --user`, `pipx`, `gem install`), a script downloaded and run
  (`curl ... | sh`), an installer (`.pkg`, `.msi`, `.dmg`, `.run`). The project's own dependencies - `npm install`,
  pip into its venv, `mvn`, `cargo`, `go mod` - are building the code, and pass;
- kills what its pulse did not start: `pkill`, `killall`, `taskkill`, `fuser -k`, or `kill` aimed at a port or name
  lookup. `kill $!` and `kill %1` pass.

On Windows, drive letters, backslashes and any case are read as Windows has them. It knowingly misses a path built at
run time (`$(...)`, a variable, a script that reads one from a file): the OS sandbox and the audit are for those.

### The OS sandbox

Under the check, where the OS offers one, the command runs behind an OS sandbox (`src/grow/os-sandbox.ts`), driven
directly from the role's fence: Seatbelt (`sandbox-exec`) on macOS, bubblewrap on Linux and WSL2. It is an extra wall,
never where a rule lives - where neither starts (native Windows, WSL1, a container that does not allow user
namespaces) the check and the audit hold alone. What a command behind it reaches:

- reads: its role's roots, the module's home, `TMPDIR` and the package caches, and of the machine only the system's
  folders, every folder on the agent's `PATH` (the folder itself, not its parent: `~/.cargo/bin`, not `~/.cargo`), the
  folders the toolchain variables point at (`JAVA_HOME`, `RUSTUP_HOME`, `NVM_DIR`, ...) and the project's
  `toolchains:` - nothing else of the person's home;
- writes: its role's own roots - none for a role that only reads - and the module's home, `TMPDIR` and caches. On macOS
  the developer tools' own scratch files too (`xcrun`'s database, clang's module cache), which go where macOS says, not
  where `TMPDIR` does;
- never the code record; no Unix socket outside its folders (on macOS, the name service's excepted); signals and
  process listings only within its own sandbox (bubblewrap's PID namespace, Seatbelt's same-sandbox), so `ps` shows
  nothing else and `kill` reaches nothing else;
- the network as this machine has it;
- at most 4096 processes and files of at most 8 GiB, set with `ulimit` inside.

`sandboxAvailable()` tries it once and says which wall is up, or why none starts and how to give it one: bubblewrap not
installed, user namespaces off (Docker: `--security-opt seccomp=unconfined`), AppArmor in the way (Docker:
`--security-opt apparmor=unconfined`; Ubuntu 24.04: its user-namespace restriction), or Docker's masked `/proc` - for
which bubblewrap falls back to binding the host's `/proc` rather than mounting its own.

### The audit

After every such command, on every platform - a sandbox up or not - turri puts back what the command's role may not
change inside the project (`src/grow/audit.ts`): the specs, `config*.yaml`, the testing scripts, every credential file
(the agent's own folder included), the code record, the module's lineage `.plaingit` (its refs and settings), the other
modules, the folders the role only reads, and the part of its own module it does not write - the coding agent's
conformance tests. A changed file is put back, a new one removed, a deleted one brought back: from a copy kept before
the command, or - another module - as its last commit has it, unless a pulse is at work in that module, whose writes are
not this command's to undo (left, and logged). The agent is told in its command's result what was put back; the job's
log gets a line; you are not told, and the pulse goes on. It compares sizes and modification times, skipping
dependencies and build output, and contents only where those differ - about 35 ms on a project of 3000 files. Outside
the project nothing can be put back: that is the OS sandbox's, and on Windows an accepted gap.

### An agent's shell, every wall at once

`src/grow/agent-shell.ts` (`agentShell`) puts the walls together for one agent, from its role's fence: a command is
checked, refused with exit 126 and its reason - a line in the job log - or run through the host runner from the
agent's folder in the module's environment, behind the OS sandbox where one is up, under the audit, whose note is added
to its output. The services an agent starts (`start_service`) already run behind it; its `bash` still runs in the VM.
