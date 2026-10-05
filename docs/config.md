# The project config

A project says how its specs are built in `config.yaml`, at the project root. Everything in it is
optional: with no file at all, turri finds the testing scripts on its own, turns conformance
tests on wherever a module has test reqs, and runs on pi's configured model. A project whose
modules are on different stacks adds a file per module, `config.<module>.yaml`, beside it.

## Where it is read from

A spec belongs to its **project**: the nearest folder, from the spec's own folder up, that holds a
`config.yaml`, a module's `config.<module>.yaml` or a `plain_modules/`. Without any of them, the
spec's own folder is the project. That folder's config is the one read, and its `plain_modules/` is
where the code is built, wherever turri was started. So a project that keeps its specs in
`plain/`, with `plain/config.yaml`, builds `plain/app.plain` by `plain/config.yaml` even when
`turri chat` runs in the folder above.

When it is read:

- **In the chat**, afresh: the chat's agent is told what it says on every turn, and each render
  reads it when it is queued. An edit to the file holds from the next turn and the next render, with
  no restart. The agent is told the config of the session's folder and of the projects one folder
  down.
- **On the command line**, once, when the command starts. `turri regrow` takes `module:` from
  the folder it is run in, and the rest from the spec's own project.

## The keys

```yaml
module: app.plain                    # what to build when no .plain file is named
harness-model:                       # the model you chat with
  model: anthropic/claude-opus-5-5
  thinking: high
coding-model:                        # every render (default: harness-model)
  model: amazon-bedrock/eu.anthropic.claude-sonnet-5
  thinking: low
judge-model:                         # the verdicts of a conformance run (default: coding-model)
  model: amazon-bedrock/eu.anthropic.claude-sonnet-5
  thinking: medium
conformance-tests: true              # write and run conformance tests (default: where there are test reqs)
unittests-script: test_scripts/run_unittests_python.sh
conformance-tests-script: test_scripts/run_conformance_tests_python.sh
run-testing-scripts-in: host         # where the testing scripts run: host - this machine, in place (default: vm - each module's VM)
```

| key | what it sets | unset |
| --- | --- | --- |
| `module` | the `.plain` file `turri regrow` and `regrow` build when none is named, from the project root | a file has to be named |
| `harness-model` | the model `turri chat` starts on - the one you talk to - the one that diagnoses a job that failed for good, and, in the conversation, the planner that cuts the work into jobs (on whatever model the chat is on when it plans); under `turri regrow`, the planner too | pi's configured model |
| `coding-model` | every render: functionalities, spec diffs, conformance tests, repairs, planning spec diffs, the explorer | `harness-model` |
| `judge-model` | the judge and the test review of a conformance run | `coding-model` |
| `conformance-tests` | `all` (or `true`): conformance tests for every functional spec of every module with test reqs, a conformance job after each code job. `chosen`: for the functional specs chosen - every one with acceptance tests, and those the conversation chooses with `bind`: what is planned lists what the code jobs add or change that has none, for the chat model to decide - ahead of the code - which are worth black-box tests, each call a conformance job that starts once every one it names is built; once chosen, a functional spec keeps them, and they are rewritten when it changes. `false`: none written, and none of the existing ones run - until the conversation asks with `bind` | `all`, for every module with test reqs |
| `review` | `true` or `false`: whether the code and its unit tests - and the conformance tests - are reviewed once they pass: two reviews at most, the second weighed by the arbiter; off, a job lands once its tests pass - see [growing the code](growing.md#the-code-and-its-unit-tests-are-reviewed) | `true` |
| `rules-off` | a list of rule names - `integrations`, `concise-specs`, the files of `genome/rules/` without `.md` - left out of the conversation's prompt and every spec-writing agent's: a rule this project's own skills or AGENTS.md replace, such as one that says to probe a live API before any spec is written. The project's alone | none |
| `allow-to-stop-jobs` | `true` or `false`: whether turri stops a running job the spec has moved on from - a functional spec it grows changed, or a file one links was edited - rolls it back and grows the spec as it now is. `false`: the job runs to its end and lands, and what changed since is grown on top of it by the next job - see [growing the code](growing.md). Your own `halt` stops a job either way | `true` |
| `unittests-script` | the unit testing script, by path from the project root | looked for - see below |
| `conformance-tests-script` | the conformance testing script, by path from the project root | looked for - see below |
| `static-checks-script` | optional: the project's static checks - type checker, linter - run as `<script> <build>`, as the unit testing script is; the coding agent runs them with `run_static_checks`, and they decide nothing - see [checking its own work](growing.md#checking-its-own-work) | the one `run_static_checks*.sh` at the root or in `test_scripts/`, else none |
| `vm-image` | the project's own VM image: `packages: [...]` to define it in full, or `add: [...]` and `remove: [...]` over the default, and `mirror:` or `repositories: [...]` for where it is downloaded from (see [where it is downloaded from](installation.md#where-it-is-downloaded-from)) - built by `turri vm-image` in the project, and run by every VM of the project; the basics are always in (see [what goes into the image](installation.md#what-goes-into-the-image)) | the default image |
| `system-packages` | Alpine packages every VM of the project installs when it starts - a library or tool a build needs, `sqlite`, `jq` | none |
| `compact-at` | how many tokens of work - past its instructions - an agent kept through a job holds before the harness compacts it between turns; at least 1000; the project's alone | 100,000 - see [agent sessions](growing.md#agent-sessions) |
| `vm-memory` | the memory each of the project's sandbox VMs is given - `1G`, `2G`, `512M`: more for a project that compiles Java, Rust or C++, less on a machine short of memory - `TURRI_VM_MEMORY` wins. The project's alone | `2G` |
| `parallel-jobs` | how many jobs the chat runs at once - modules that share nothing build side by side up to it; read when the chat starts, from the folder it starts in | what the memory free then holds VMs for - see [how many jobs at once](#how-many-jobs-at-once) |
| `agent-env` | credentials the agents' commands need while they work - a live API probed, tests run against a real service: `files: [...]`, dotenv files by path from the project root, every variable in them; `vars: [...]`, variables by name from the environment turri was started in. A module's `config.<module>.yaml` adds its own to the project's. See [credentials for the agents](#credentials-for-the-agents) | none: an agent's commands get no credential |
| `toolchains` | folders of this machine an agent's commands may read beside the system's, the `PATH`'s and those the toolchain variables point at - a toolchain installed somewhere unusual (`[/srv/zig]`). A module's own add to the project's. See [the OS sandbox](sandbox.md#the-os-sandbox) | none |
| `run-testing-scripts-in` | where the testing scripts run. `vm`: in the module's VM, the agents' own, on a fresh copy of the code. `host`: on this machine, in place, on the real build and tests folders, in its environment - for an integration embedded in a host codebase, or tests that need what only this machine has (see [where they run](growing.md#the-testing-scripts)). `testing-scripts:`, its name before, is read the same | `vm` |

Keys are written with dashes; underscores are read the same (`conformance_tests`). A key turri
does not know is ignored - a codeplain `config.yaml` carries several - and so is a value of the
wrong type, as if it were not there. `model:`, from before there were separate models, is read as
`coding-model`.

## How many jobs at once

Jobs on the same module, or on modules of one `requires` chain, always run one after another.
Modules that share nothing - a backend, a frontend, a worker, ten of them - build side by side, and
each module's jobs start VMs of their own: its code's and its tests', `vm-memory` each (2 GB unless
`config.yaml` or `TURRI_VM_MEMORY` says). So the chat runs at most `parallel-jobs` jobs at once; a
job whose turn has come waits for a free slot past that, and its line says so. Unset, it is three
quarters of the memory free when the chat starts - free and what the system takes back at once, as
`vm_stat` or `/proc/meminfo` count it - over two VMs' worth. Not the machine's whole memory: a machine
already swapping starts every VM out of swap, minutes instead of seconds. A VM starting with less free
than it is given says so. `TURRI_PARALLEL_JOBS` wins over the config. It is the project's alone,
never read from a module's file.

The testing scripts all run on this machine, each on a copy of its module's code, so they never
share files - but they do share its network: two modules whose conformance scripts start a server
on the same port collide when they run at once. Give each its own.

## Models

Each model is a model reference and a thinking level - `off`, `minimal`, `low`, `medium`, `high`,
`xhigh` or `max` - and either may be left out:

```yaml
coding-model:
  model: google/gemini-3.1-flash      # the provider and the model id, as pi names them
  thinking: medium
judge-model: google/gemini-3.1-pro:high   # the same, as one string
harness-model: anthropic/claude-opus-5-5  # a model alone
```

What a model leaves out it takes from the one it inherits: `judge-model` from `coding-model`,
`coding-model` from `harness-model`. So with only a harness model, everything runs on it;
`coding-model: {thinking: low}` renders on the harness model, thinking less.

They are defaults. What is asked for wins over them:

| model | wins over the config |
| --- | --- |
| harness | `turri chat --harness-model <m>` (or pi's own `--model`), and pi's `/model` in the conversation |
| coding | `turri chat --coding-model <m>`, `engine` in the conversation, and `--model` / `--coding-model` on `turri regrow`, `render`, `regenerate`, `conformance` and `spec-diff` |
| judge | `--judge-model` on `turri bind` |

A job keeps the model it was queued with: choosing another holds for what is queued after.

## Conformance tests

`conformance-tests:` is the one switch, and the chat, every render and `brood`'s testing phase
follow it. `false` turns them off entirely: no conformance tests are written, the ones already in a
codebase are not run, and no agent is shown the conformance testing script. `true`, or no key, means
on wherever a module has `***test reqs***` - a module without them has nothing to write conformance
tests from, so it writes none, but still keeps the codebase's existing ones passing. Asked in the
conversation, or with `--conformance` / `--no-conformance` on the command line, a render does
otherwise.

`spawn` writes `conformance-tests: false` into a new project unless you ask for tests;
`brood` asks.

## The testing scripts

A build needs a unit testing script - and, with conformance on, a conformance testing script - to
decide when it is done. They are looked for at the project root, in this order:

1. named in the config - the module's own file first, then `config.yaml` - by path from the root;
2. the one `run_unittests*.sh` / `run_conformance_tests*.sh` in the project root;
3. the one of each in `test_scripts/`.

A folder holding two of a kind is not guessed between: name the one to use. A script named inside
`plain_modules/` is refused - agents write there, so it could be changed by the work it judges. The
scripts are never linked from the specs. What they are and how they run is in
[growing the code](growing.md#the-testing-scripts).

## Credentials for the agents

This is the environment of agents' commands run on this machine, which is being built: today they still run in the
VM, which gets none of it, and `agent-env:` is read but passed to no command yet.

An agent's commands do not get the environment turri was started in: it holds your providers' API keys, cloud
credentials and tokens. They get only the path, the locale, the terminal and the user, the variables that locate your
toolchains (`JAVA_HOME`, `NVM_DIR`, `RUSTUP_HOME`, ... - the ones in your home found even when your shell sets none),
and turri's own: a home folder of the module's own (`plain_modules/.turri/home/<module>`, kept between pulses, with a
git identity of its own), a `TMPDIR`, the package caches in `plain_modules/.turri/cache`, and git stopped at the module
folder, so a project that is itself a repository is never found from the code.

A project whose agents need a credential while they work names it:

```yaml
agent-env:
  files: [.env]              # every variable of these dotenv files, by path from the project root
  vars: [D365_TENANT_ID]     # these variables, from the environment turri was started in
```

What it names reaches every agent with a shell, as environment variables of its commands only - the file stays where
it is, outside every agent's reach - and never replaces turri's own home, `TMPDIR` or caches. A module's own file adds
to the project's. A file that is not there, or a variable unset or empty, is reported as missing. The testing scripts
are not affected: they run in your own environment.

## Modules on different stacks

One project can hold modules that share nothing but a common module - a Python backend and a React
frontend side by side, each importing `base` from `template/`, neither requiring the other. Each
gets a file of its own beside `config.yaml`, named for the module:

```
config.yaml            # the project's: harness-model, coding-model, conformance-tests
config.backend.yaml    # the backend's testing scripts
config.frontend.yaml   # the frontend's testing scripts, and a coding model of its own
backend.plain          # import: [base, python_fastapi_template]
frontend.plain         # import: [base, react_vite_template]
template/              # base.plain, python_fastapi_template.plain, react_vite_template.plain
test_scripts/          # both stacks' scripts
```

```yaml
# config.frontend.yaml
unittests-script: test_scripts/run_unittests_typescript.sh
conformance-tests-script: test_scripts/run_conformance_tests_typescript.sh
coding-model:
  thinking: high
```

How a module's config is made:

- **Laid over `config.yaml`, key by key.** What the module's file gives wins; what it leaves out
  is the project's. A model it names takes what it leaves out from the project's same model - above,
  the frontend renders on the project's coding model, thinking `high`.
- **Down the `requires` chain.** A module without a file of its own takes the file of the first
  module down its `requires` chain that has one: `backend_admin`, which requires `backend`, is built
  with `config.backend.yaml`. A chain is one codebase, so it is one stack.
- **By the codebase it runs in.** What runs in a codebase follows that codebase's module - a
  required module's spec rebuilt up the chain is tested with the scripts of the module it is rebuilt
  in.
- **The project's alone.** `module:`, `harness-model:`, `parallel-jobs:`, `compact-at:`, `vm-image:` and
  `system-packages:` are read only from `config.yaml` - there is one conversation, one module built
  when none is named, one machine, and one image for the project's VMs. An import module is never built and has
  no config.

With module files and no `module:`, building without naming a file lists the modules and asks for
one: `turri regrow backend.plain`. The chat is told each module's config as it holds, and the
status bar shows conformance per module when they differ. The skills that write testing scripts put
each module's in its own file once a project has two stacks.
