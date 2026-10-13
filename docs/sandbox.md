# The sandbox

A rendering agent is building one module. It has no business reading the `.plain` specs it was
not given, the rest of the project, or anything else on the machine - and pi's `cwd` is only
where relative paths start: an absolute path resolves to itself and `bash` can `cd` anywhere. So
turri fences its agents: their file tools check every path, and every command they run on this
machine passes a command check, runs in an environment of the module's own behind an OS sandbox
where the OS has one, and is audited afterwards. The rules live in code that runs the same on every
platform; the OS sandbox is an extra wall under them.

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
own gated skills itself. The conversation you talk to still loads both, as pi does - but for the skills turri has
already, its own and any about \*\*\*plain (see [a project's own skills](skills-and-gates.md#a-projects-own-skills)).

## Every agent knows its walls

Each agent's system prompt says where its walls are, in words generated from its fence, so they say exactly what is
enforced and are the same on every platform:

- its own folder or folders, by absolute path, and what its file tools read and write there - a role that only reads
  is told it writes nothing, "not with your file tools, not with your shell"; the conformance agent that it reads the
  code under test but writes tests, not code; the code fixer that it reads the conformance tests but fixes the code;
- that its shell runs on this machine, in its folder, with this machine's toolchains, a home folder and a temporary
  folder of its own (`$HOME`, `$TMPDIR`), the package caches and an open network, and that nothing else exists for
  it - not the specs, not the project's other folders or modules, not your home;
- what happens on a reach outside, matter-of-fact: a command that names a path outside is refused before it runs,
  and anything a command changes outside is put back, and it is told;
- that the project's dependencies are its own, through the build manifest, and installing anything else is not: what
  the machine lacks it reports with `report_environment_error`, naming what is missing, and goes no further with what
  depends on it (see [when the environment lacks something](regenerating.md#when-the-environment-lacks-something));
- that it may stop only what it started, and that a port something else holds means another port; that `ps` may show
  nothing but what it started, so a server is checked with `kill -0 $!`, its log or a request;
- that temporary files go in `$TMPDIR`, `/tmp` being outside its walls.

Beside its walls, an agent that writes code or tests - the coding agent, the conformance agent, the code fixer, the
repair agent - is told up front what it would otherwise go looking for (`src/regenerate/workspace.ts`): whether its folder is
empty, with nothing above it to find, or holds code whose unit tests passed when it was committed; that it is not a git
repository, and `my_diff` shows its work; the versions of the toolchains its module's implementation reqs name, probed
once on this machine, or that one is missing; that the package caches and Maven's repository are set for it, and to
leave `JAVA_TOOL_OPTIONS` set; and that the network is open.

No other path is named - nothing into `plain_modules/.turri`. A test run or a command whose output was cut names the
whole of it by an id - not a file in its folder, which `read` says if it is given one - and the agent reads it with
`read_output`: not by a path into `plain_modules/.turri` or to a
temporary file on this machine (see [long output](regenerating.md#the-tests-must-actually-pass)).

## File tools

`src/regenerate/confine.ts` rebuilds `read`, `write`, `edit`, `ls`, `grep` and `find` from pi's own
factories with a check in front of every path. The check runs twice: once on the argument the
tool was called with, and once on the absolute path the tool resolved it to, because the two can
differ. Symlinks are resolved before comparing, so a link cannot walk out, and a glob containing
`..` is refused outright.

The record of what the code is built from, `code/.turri.json`, is the harness's: no agent reads or writes it. `read`
refuses it, and `ls`, `grep` and `find` leave it out of what they list - as the command check, the OS sandbox and the
audit keep it from commands.

Credentials are the person's: no agent writes a `.env` or a variant of one (`.env.local`, `.env.test`) - a
template, `.env.example`, is fine. The file tools refuse it, the command check refuses a command that would
write one, and what a command does to one anyway is put back by the audit, the agent told why. A made-up credential makes every later run fail without anyone seeing why; a missing one is the
judge's to report (see [regenerating the code](regenerating.md)), the person's to provide.

## Commands on this machine

`bash` is the case no argument check can cover - one string, and no way to read for certain where it will read or
write. So every command an agent runs - its `bash`, a service it starts - goes through every wall at once
(`src/regenerate/agent-shell.ts`, `agentShell`), from its role's fence, the same as its file tools':

1. **the command check**, before it runs - refused with exit 126 and the reason, a line in the job's log;
2. **the module's own environment** - not yours: the path, the locale, the terminal, the user and the toolchains'
   variables pass, nothing else - no provider key, no token, no SSH agent; a home folder of the module's own in
   `plain_modules/.turri/home/<module>`, kept between pulses, a `TMPDIR`, the package caches in the project, git
   stopped at the module folder, and what `agent-env:` passes (see [credentials for the agents](config.md#credentials-for-the-agents)).
   Every JVM - a test JVM Maven or Gradle forks too - is given the module's `TMPDIR` and home through
   `JAVA_TOOL_OPTIONS`, since Java takes both from the system rather than from `TMPDIR` and `HOME`; each says so in a
   "Picked up JAVA_TOOL_OPTIONS" line on its stderr;
3. **the OS sandbox**, where one is up - Seatbelt on macOS, bubblewrap on Linux and WSL2;
4. **the audit**, after it, which puts back what it changed that its role may not, and tells the agent.

The job's log says, for each agent with a shell, which walls are up - and where no OS sandbox starts, why.

The command runs through the host runner (`src/regenerate/shell.ts`): `bash -c` from the agent's folder, in a process group of
its own. No command can hang a build: every one has a time limit - 2 minutes, or `TURRI_COMMAND_TIMEOUT` seconds: the
agent's own `bash` unless it gives a timeout (at most 30 minutes), its unit and conformance test runs, the harness's own
runs. A command that runs out is killed, it and everything it started, and reports exit 124 with a note on what to do
instead: a server, a watcher or a prompt waiting for input never ends on its own, and has to be started in the
background or given its input. A job that is stopped ends the command it is waiting on at once, the same way.

A server a command leaves running in the background is its pulse's: it runs on until the pulse ends, and is killed
then - a pulse running beside it keeps its own. Everything still running is killed when turri exits, ended by a signal
too. A turri killed outright cannot do that itself, so one small watcher beside it does, within two seconds, from the
groups it recorded in the temporary folder (`turri-groups/`); and groups a turri left that nothing killed are swept when
turri next starts. On Windows there are no process groups: a command's process tree is killed with `taskkill /T /F`,
best effort.

The project's testing scripts - their static checks included - are not agents' commands: they are
yours, and run on this machine as you would run them, unfenced, in your own environment - see [the testing scripts](regenerating.md#the-testing-scripts). The agent gets their
output, nothing more.

### The command check

Before an agent's command runs, its text is checked (`src/regenerate/command-check.ts`, `checkCommand`), on every platform, and
refused - not run - with the rule it broke and what to do instead, when it:

- names a path outside the role's roots - absolute, a `..` that climbs out of the agent's folder (after the `cd`s
  before it), or inside a quoted string (`python3 -c "..."`). `~`, `$HOME` and `$TMPDIR` are the module's own and
  allowed, as are the package caches, the machine's system folders and the toolchains, and the devices
  (`/dev/null`). A path is checked when it names something on disk - under a top folder such as `/Users`, `/home`,
  `/etc` or `/tmp`, one of the fence's, or one that exists - so an API route in a curl or a JSON body is not one, and
  nor is `/` alone, a slash in code (`case '/':`), though writing to `/` is refused;
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

Under the check, where the OS offers one, the command runs behind an OS sandbox (`src/regenerate/os-sandbox.ts`), driven
directly from the role's fence: Seatbelt (`sandbox-exec`) on macOS, bubblewrap on Linux and WSL2. It is an extra wall,
never where a rule lives - where neither starts (native Windows, WSL1, a container that does not allow user
namespaces) the check and the audit hold alone. What a command behind it reaches:

- reads: its role's roots, the module's home, `TMPDIR` and the package caches, and of the machine only the system's
  folders, every folder on the agent's `PATH` (the folder itself, not its parent: `~/.cargo/bin`, not `~/.cargo`) - but
  a version manager's install whole, a `bin` whose parent is a version (`…/mise/installs/node/24.16.0/bin`), as its
  tools are links into the install beside it (`npm` into `lib/node_modules`) - the folders the toolchain variables
  point at (`JAVA_HOME`, `RUSTUP_HOME`, `NVM_DIR`, mise's `MISE_DATA_DIR`, fnm's, rbenv's, the Pythons uv fetches, ...)
  and the project's `toolchains:` - nothing else of the person's home;
- writes: its role's own roots - none for a role that only reads - and the module's home, `TMPDIR` and caches. On macOS
  the developer tools' own scratch files too (`xcrun`'s database, clang's module cache), which go where macOS says, not
  where `TMPDIR` does - and a folder of the module's own in macOS's per-user temporary folder
  (`DIRHELPER_USER_DIR_SUFFIX`), where its JVMs keep their attach sockets, so Mockito's inline mocks, `jcmd` and
  `jstack` attach to a JVM it started; the person's JVMs' sockets, beside it, stay out of reach;
- never the code record; no Unix socket outside its folders (on macOS, the name service's excepted); signals and
  process listings only within its own sandbox (bubblewrap's PID namespace, Seatbelt's same-sandbox), so `ps` shows
  nothing else and `kill` reaches nothing else;
- the network as this machine has it;
- at most 4096 processes and files of at most 8 GiB, set with `ulimit` inside.

`sandboxAvailable()` tries it once and says which wall is up, or why none starts and how to give it one: bubblewrap not
installed, user namespaces off (Docker: a user that is not root, `--security-opt seccomp=unconfined`), AppArmor in the way (Docker:
`--security-opt apparmor=unconfined`; Ubuntu 24.04: its user-namespace restriction), or Docker's masked `/proc` - for
which bubblewrap falls back to binding the host's `/proc` rather than mounting its own.

### The audit

After every agent command, on every platform - a sandbox up or not - turri puts back what the command's role may not
change inside the project (`src/regenerate/audit.ts`): the specs, `config*.yaml`, the testing scripts, every credential file
(the agent's own folder included), the code record, the module's lineage `.plaingit` (its refs and settings), the other
modules, the folders the role only reads, and the part of its own module it does not write - the coding agent's
conformance tests. A changed file is put back, a new one removed, a deleted one brought back: from a copy kept before
the command, or - another module - as its last commit has it, unless a pulse is at work in that module, whose writes are
not this command's to undo (left, and logged). Nor is a change the conversation made while the command ran: the chat's
`edit` and `write`, a spec diff it applied, or anything while a command of its own ran - the chat editing a spec beside a
pulse is the person's change, not the agent's, so it is left and logged (`src/regenerate/conversation-writes.ts`). The agents
of a pulse start without extensions, so nothing of theirs is marked so. The agent is told in its command's result what was put back; the job's
log gets a line; you are not told, and the pulse goes on. It compares sizes and modification times, skipping
dependencies and build output, and contents only where those differ - about 35 ms on a project of 3000 files. Outside
the project nothing can be put back: that is the OS sandbox's, and on Windows an accepted gap.

## The web

Every rendering agent - render, spec change, conformance, regression repair - can also search the
web and read a page, for a library's documentation or an error it has not seen:

| Tool | What it does |
| --- | --- |
| `web_search` | asks DuckDuckGo (no key needed) and returns title, address and snippet per result |
| `web_fetch` | reads one page and returns it as text - HTML without its markup, text, JSON or XML as it is; long pages come in parts |

`web_fetch` reads only the public web: localhost, the private ranges and the cloud metadata address are
refused, and so is every redirect that leads to one - what the code talks to on this machine, the agent
reaches with its own commands.

DuckDuckGo is used without a key through its Lite page, which is not an official API: it rate-limits,
and a search that is turned away tells the agent to wait or fetch a page it knows instead.

## Outside the sandbox: deploy

What `deploy` starts runs on your machine unfenced: you asked to try the software, with your toolchains,
in your browser. It runs from `dist/<module>`, a copy of the last
commit outside `plain_modules`, so no rendering agent reaches it. Nothing is installed there without
your say-so - every command that would install or download is put to you first, and the chat's shell
refuses the rest. See [deploy](deploy.md).

## What turri keeps beside the code

It lives in `plain_modules/.turri`, which ignores itself in git:

| | |
| --- | --- |
| `cache/` | package caches - pip, npm, cargo, Maven, Gradle, Go - so a dependency downloads once per project |
| `home/<module>` | each module's home folder for its agents' commands, kept between pulses |
| `tmp/<module>` | each module's `TMPDIR` |
| `scripts/` | the throwaway copies test runs happen in, emptied after each run |
| `logs/` | whole outputs cut short for an agent, read through `read_output` |
| `services/` | what the services agents started printed |

## What the machine lacks

The agents use this machine's toolchains, and install nothing on it: not a toolchain, a system package, a driver or a
global package. The project's own dependencies are theirs, through its package manager, into the project and its
caches. What the machine lacks is yours to install: an agent that finds something missing reports it, the pulse stops,
and you are told what to install - see [when the environment lacks something](regenerating.md#when-the-environment-lacks-something).
