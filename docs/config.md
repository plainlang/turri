# The project config

A project says how its specs are built in `config.turri.yaml`, at the project root. Everything in it
is optional: with no file at all, turri finds the testing scripts on its own, turns conformance
tests on wherever a module has test reqs, and runs on pi's configured model. A project whose
parts are on different stacks - a backend and a frontend - adds a file per stack,
`config.turri.<stack>.yaml`, beside it, and chooses the stack to build with (see
[stacks](#stacks)). turri never writes a `config.yaml`: it may be another tool's - codeplain's - and
is read only by a project that has no file of turri's yet (see [the old config.yaml](#the-old-configyaml)).

`turri init-config` starts one: the two models, a strong one to talk to and a smaller one to write the code. It
asks which vendor's models you use - `--vendor` says it without asking, and with neither, as from a script, it is
`other`:

| vendor | harness-model | coding-model | key pi reads |
| --- | --- | --- | --- |
| `anthropic` | `anthropic/claude-opus-5-5` | `anthropic/claude-haiku-5-5` | `ANTHROPIC_API_KEY` |
| `openai` | `openai/gpt-6-astra` | `openai/gpt-6-luna` | `OPENAI_API_KEY` |
| `google` | `google/gemini-3.1-pro-preview` | `google/gemini-3.1-flash-lite` | `GEMINI_API_KEY` |
| `amazon-bedrock`, Anthropic | `amazon-bedrock/<region>.anthropic.claude-opus-5-5` | `amazon-bedrock/<region>.anthropic.claude-haiku-5-5` | `AWS_PROFILE` or `AWS_BEARER_TOKEN_BEDROCK`, and `AWS_REGION` |
| `amazon-bedrock`, OpenAI | `amazon-bedrock/<region>.openai.gpt-6-astra` | `amazon-bedrock/<region>.openai.gpt-6-luna` | `AWS_PROFILE` or `AWS_BEARER_TOKEN_BEDROCK`, and `AWS_REGION` |
| `other` | `anthropic/claude-opus-5-5` | `google/gemini-3.1-flash-lite` | `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` |

Amazon Bedrock asks two more things - whose models, Anthropic's or OpenAI's (`--maker`), and the region of the
inference profile they run in (`--region`): `global`, `us`, `eu`, `jp` or `au` for Anthropic's, `global` or `us` for
OpenAI's. It says which `AWS_REGION` to set for it - pi calls Bedrock in `us-east-1` when none is. A `config.turri.yaml`
already there keeps everything but its two models, which it sets; `--force` writes the whole file again.

Each is written with how hard it thinks - `harness-model: openai/gpt-6-astra:medium`, `coding-model:
openai/gpt-6-luna:low` - so the file shows it. The reviews and judges run on the coding model but think medium (see
[models per role](#models-per-role)).

They are an example, not a requirement - any model [pi](https://pi.dev) supports works, signed in any way pi
supports; `other` is the starting point for another provider. What we recommend is that split, a capable model to
talk to and a smaller, cheaper one for the coding. Once written, it says what to do next: the key to set in your
shell - or `/login` in turri, which pi keeps in `~/.pi/agent/auth.json` - and that the file belongs to that folder:
turri reads the nearest `config.turri.yaml` upwards from where it starts, so one written anywhere else is not seen.

Below them it writes every other setting out, each with what it does and the value turri uses for it - `review: false`,
`turn-limit: 120`, `parallel-jobs` as this machine's cores make it - so the file says how the project is built, and you
change one by changing it. The optional ones, which have no value of their own - the testing scripts (written in by the
skill that writes them), `module`, `conformance-budget`, `judge-model`, `models` - are there commented out, each with an
example: uncomment one to use it. A key taken out of the file is still read as the table below says.

Beside a `config.yaml` - codeplain's - the new file takes from it the keys turri reads too, each in its place, its
testing scripts above all, and says which it left (see [the old config.yaml](#the-old-configyaml)); `config.yaml`
is left as it is. A `config.turri.yaml` already there keeps everything but its two models, which it sets - `--force` writes the whole
file again - and a `config.yaml` turri read until then is copied to it first. It takes a folder other than the current
one as its argument.

## Where it is read from

A spec belongs to its **project**: the nearest folder, from the spec's own folder up, that holds a
`config.turri.yaml`, a stack's `config.turri.<stack>.yaml`, the old `config.yaml` or a `plain_modules/`.
Without any of them, the spec's own folder is the project. That folder's config is the one read, and
its `plain_modules/` is where the code is built, wherever turri was started. So a project that keeps
its specs in `plain/`, with `plain/config.turri.yaml`, builds `plain/app.plain` by
`plain/config.turri.yaml` even when `turri` runs in the folder above.

When it is read:

- **In the chat**, afresh: the chat's agent is told what it says on every turn, and each render
  reads it when it is queued. An edit to the file holds from the next turn and the next render, with
  no restart. The agent is told the config of the session's folder and of the projects one folder
  down.
- **On the command line**, once, when the command starts. `turri regrow` takes `module:` from
  the folder it is run in, and the rest from the spec's own project.

## Changing it from the chat

`/turri-config` changes any key in the chat, and writes it into the `config.turri.yaml` of the folder turri was started in -
its comments, and the commented-out examples, kept. Alone, it lists every key with what it is now, and asks for the
value of the one you pick the way the key takes it: `true` or `false`, one of its words, a number from a few offered or
typed, a model from those this machine can reach and then how hard it thinks, a script or a `.plain` file the project
has, rules ticked on and off. `/turri-config review` asks for review's value; `/turri-config review false` sets it, and
`/turri-config review unset` takes it out, back to its default. Completion offers the keys, then each one's values.
Each role's model and turn limit is `models.<role>` and `models.<role>.turn-limit` - `models.coding`,
`models.planner.turn-limit`.

Each change says when it takes effect. None needs turri started again - what turri fixes as it starts is changed as it
runs:

| when | keys |
| --- | --- |
| now | `harness-model` and `models.chat` - the conversation switches to it; `parallel-jobs` - a pulse waiting for a slot starts if there is one now; `allow-to-stop-jobs` |
| your next message | `rules-off` - for the conversation; a skill's agents from the next skill run |
| the next pulse - one running keeps what it started with | `coding-model`, `judge-model`, every other `models.<role>`, `review`, `turn-limit`, `compact-at`, `agent-env`, `toolchains` |
| the next time the work is planned | `conformance-tests`, `conformance-budget`, `max-specs-per-pulse`, `max-lines-per-pulse` |
| the next test run - the running pulse's too | the testing scripts, `testing-scripts-run-on` |
| the next pulse that lands - the running one too | `release-after-pulse` |
| the next regrow that names no `.plain` file | `module` |

A coding model chosen this session - `--coding-model`, or `engine` - gives way to one set here: the last word wins. It
says, too, what wins over the change: `models.chat` over `harness-model` (and so on), and a stack's
`config.turri.<stack>.yaml`, which is not changed here, while that stack is chosen. In a project still read from
`config.yaml`, the first change copies it to `config.turri.yaml` first - see [the old config.yaml](#the-old-configyaml).

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
conformance-tests: true              # write and run conformance tests where there are test reqs (default: false)
unittests-script: test_scripts/run_unittests_python.sh
conformance-tests-script: test_scripts/run_conformance_tests_python.sh
testing-scripts-run-on: copy         # what the testing scripts run on: copy - a fresh copy (default: in-place - the code itself)
turn-limit: 150                      # seconds each agent turn has (default: 120; 0 for none)
models:                              # each agent role's model, thinking and turn limit - see below
  default: amazon-bedrock/global.openai.gpt-6-luna
  coding: { model: amazon-bedrock/eu.anthropic.claude-sonnet-5, thinking: high, turn-limit: 180 }
  explorer: google/gemini-3.1-flash-lite
```

| key | what it sets | left out |
| --- | --- | --- |
| `module` | the `.plain` file `turri regrow` and `regrow` build when none is named, from the project root | a file has to be named |
| `harness-model` | the model `turri` starts on - the one you talk to - the one that diagnoses a job that failed for good, and, in the conversation, the planner that cuts the work into jobs (on whatever model the chat is on when it plans); under `turri regrow`, the planner too | pi's configured model |
| `coding-model` | every render: functionalities, spec diffs, conformance tests, repairs, planning spec diffs, the explorer | `harness-model` |
| `judge-model` | the judge and the test review of a conformance run | `coding-model` |
| `conformance-tests` | `all` (or `true`): conformance tests for every functional spec of every module with test reqs, written once each module's code is built, before anything is built on it. `chosen`: for the functional specs chosen - every one with acceptance tests, and those the conversation chooses with `bind`: what is planned lists what the code jobs add or change that has none, for the chat model to decide - ahead of the code - which are worth black-box tests, each call a conformance job that starts once every one it names is built; once chosen, a functional spec keeps them, and they are rewritten when it changes. `false`: none written, and none of the existing ones run - until the conversation asks with `bind` | `false` |
| `conformance-budget` | under `conformance-tests: chosen`: how many of a module's functional specs may be chosen for conformance tests, beside those with acceptance tests - a count (`2`) or a share of its functional specs (`30%`, rounded up, at least one). Every choice for the module counts, whenever it was made - ahead of the code, or once it is built; the chooser and the chat model are told what is left, and `turri regrow`'s chooser can choose no more. Your own `bind` is not limited. A stack's `config.turri.<stack>.yaml` can set its own | no limit |
| `review` | `true` or `false`: whether the code and its unit tests - and the conformance tests - are reviewed once they pass: two reviews at most, the second weighed by the arbiter; off, a job lands once its tests pass - see [growing the code](growing.md#the-code-and-its-unit-tests-are-reviewed) | `false` |
| `rules-off` | a list of rule names - `integrations`, `concise-specs`, the files of `genome/rules/` without `.md` - left out of the conversation's prompt and every spec-writing agent's: a rule this project's own skills or AGENTS.md replace, such as one that says to probe a live API before any spec is written. The project's alone | none |
| `allow-to-stop-jobs` | `true` or `false`: whether turri stops a running job the spec has moved on from - a functional spec it grows changed, or a file one links was edited - rolls it back and grows the spec as it now is. `false`: the job runs to its end and lands, and what changed since is grown on top of it by the next job - see [growing the code](growing.md). Your own `halt` stops a job either way | `true` |
| `release-after-pulse` | `true` or `false`: whether every pulse that lands code releases it, in the chat, as its last stage - before the module's next pulse starts, whatever the chat is doing: an agent on the coding model looks for the project's release guidance as the chat does (what was passed to `release` this conversation, AGENTS.md, the project's skills) and, when it says to release after a build, does what it says - see [deploy](deploy.md#after-every-pulse). One release a pulse that lands; a release that fails is said in the pulse's report, and what it landed stays | `false` |
| `unittests-script` | the unit testing script, by path from the project root | looked for - see below |
| `conformance-tests-script` | the conformance testing script, by path from the project root | looked for - see below |
| `prepare-environment-script` | optional, as codeplain has it: run as `<script> <build>` before every run of the conformance testing script, which runs only once it passes - see [the testing scripts](growing.md#the-testing-scripts). turri never writes one | the one `prepare_environment*.sh` at the root or in `test_scripts/`, else none |
| `static-checks-script` | optional: the project's static checks - type checker, linter, formatter in check mode - run as `<script> <build>` beside the unit testing script, and the coding agent's work passes only when both do, within the same rounds; before each run the harness formats the code with `<script> <build> --fix`. The coding agent also runs the checks alone with `run_static_checks`. The conformance track does not run them - see [the static checks](growing.md#the-static-checks) | the one `run_static_checks*.sh` at the root or in `test_scripts/`, else none |
| `compact-at` | how many tokens of work - past its instructions - an agent kept through a job holds before the harness compacts it between turns; at least 1000; the project's alone | 100,000 - see [agent sessions](growing.md#agent-sessions) |
| `max-specs-per-pulse` | the most functional specs the planner groups into one pulse - what builds one feature goes together, up to this many; a stack's file wins | 3 |
| `max-lines-per-pulse` | the most lines of spec in one pulse - its functional specs with the definitions they bring; a group past it is split again, a functional spec a pulse; a stack's file wins | 120 |
| `parallel-jobs` | how many jobs the chat runs at once - modules that share nothing build side by side up to it; read when the chat starts, from the folder it starts in | half this machine's cores, between one and four - see [how many jobs at once](#how-many-jobs-at-once) |
| `agent-env` | credentials the agents' commands need while they work - a live API probed, tests run against a real service: `files: [...]`, dotenv files by path from the project root, every variable in them; `vars: [...]`, variables by name from the environment turri was started in. A stack's `config.turri.<stack>.yaml` adds its own to the project's. See [credentials for the agents](#credentials-for-the-agents) | none: an agent's commands get no credential |
| `toolchains` | folders of this machine an agent's commands may read beside the system's, the `PATH`'s and those the toolchain variables point at - a toolchain installed somewhere unusual (`[/srv/zig]`). A stack's add to the project's. See [the OS sandbox](sandbox.md#the-os-sandbox) | none |
| `turn-limit` | seconds each turn of an agent a job starts has, for every role without its own (`models:`); `0` for none. The config is the only place it is set. A turn past it ends at its next request to the model - see [growing the code](growing.md) | 120 |
| `models` | each agent role's own model, thinking and turn limit - see [models per role](#models-per-role) | every role on `coding-model`, the conversation's side on `harness-model` |
| `testing-scripts-run-on` | what the testing scripts run on - always on this machine, in your environment. `in-place`: the real build and tests folders, the script at its own path, from the project - so a script that finds a host codebase from its own path finds it. `copy`: a fresh copy of the code, staged in `plain_modules/.turri/scripts/`, with the script copied beside it; it gives the coding agent `can_it_fail` (see [the testing scripts](growing.md#the-testing-scripts)) | `in-place` |

Keys are written with dashes; underscores are read the same (`conformance_tests`). A key turri
does not know is ignored - a codeplain `config.yaml`, read while it is the old file, carries several - and so is a value of the
wrong type, as if it were not there. `model:`, from before there were separate models, is read as
`coding-model`.

## Models per role

`models:` gives each kind of agent its own model, thinking level and turn limit. Each entry is a model
(`provider/id`, or `provider/id:thinking`) or `{ model, thinking, turn-limit }`, any of which may be left out:

| role | the agents |
| --- | --- |
| `default` | every role not named below - but the conversation's side |
| `chat` | `turri`'s model - the same as `harness-model`, which it wins over |
| `chooser`, `planner`, `diagnosis` | the conversation's side: the conformance chooser of `turri regrow`, the planner's agents, the diagnosis of a failed job. Unnamed, the chat's model |
| `release` | `turri release`'s agent and release-after-pulse's: it follows steps - a script, a start command - so it runs on the coding model, thinking low |
| `coding` | the coding agent, the code fixer of a conformance run and the repair agent - the same as `coding-model`, which it wins over. `--model` on the command line, or a model chosen in the conversation (`engine`), wins over both |
| `conformance` | the conformance agent |
| `explorer` | the explorers of a conformance run |
| `reviewer` | the review of the code and its unit tests |
| `test-reviewer` | the review of the conformance tests - `judge-model` too, when it is set |
| `judge` | the judge of a failing conformance run - the same as `judge-model`, which it wins over |
| `arbiter` | the arbiters that weigh a second review |
| `debugger` | the fresh look at unit tests that keep failing the same way, or a coding agent going round in circles. Unnamed, `judge-model` when it is set, else the harness model - not `default` |

What an entry leaves out it takes from `default`: `reviewer: { thinking: low }` runs the default model, thinking
little. A turn limit is the role's own, else `default`'s, else `turn-limit:`, else two minutes. A stack's `config.turri.<stack>.yaml` lays its own `models:` over the project's, role by role - all but
`chat`, the project's alone.

A role whose thinking nothing names - neither its entry, `default`'s, nor a `:level` on the model it runs on - thinks
as its kind of work needs: **low** for the agents that do the work (`coding`, `conformance`, `explorer`, `release`),
which work from specs that leave little to guess and take many turns, and **medium** for the ones that judge
(`reviewer`, `test-reviewer`, `judge`, `arbiter`, `debugger`, `planner`, `chooser`, `diagnosis`), where a wrong
call costs pulses. A judging role that falls back on the coding model takes its model alone, not its thinking. The
conversation keeps its own level, as pi sets it.

The thinking level reaches the model as each provider takes it. OpenAI's models on Bedrock are sent it as their
reasoning effort (`none`, `low`, `medium`, `high`, `xhigh`) by turri itself, as pi sends them none.

## How many jobs at once

Jobs on the same module, or on modules of one `requires` chain, always run one after another.
Modules that share nothing - a backend, a frontend, a worker, ten of them - build side by side, each
pulse's builds and tests running on this machine beside your own work. So the chat runs at most `parallel-jobs` jobs
at once; a job whose turn has come waits for a free slot past that, and its line says so. Unset, it is half this
machine's cores, at least one and at most four. The config is the only place it is set. It is the project's alone,
never read from a stack's file.

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

What a model leaves out it takes from the one it inherits: `judge-model` from `coding-model` - its model, not its
thinking, which the judging roles have their own of - and `coding-model` from `harness-model`. So with only a harness model, everything runs on it;
`coding-model: {thinking: low}` renders on the harness model, thinking less.

They are defaults. What is asked for wins over them:

| model | wins over the config |
| --- | --- |
| harness | `turri --harness-model <m>` (or pi's own `--model`), and pi's `/model` in the conversation |
| coding | `turri --coding-model <m>`, `engine` in the conversation, and `--model` / `--coding-model` on `turri regrow`, `render`, `regenerate`, `conformance` and `spec-diff` |
| judge | `--judge-model` on `turri bind` |

A job keeps the model it was queued with: choosing another holds for what is queued after.

## Conformance tests

`conformance-tests:` is the one switch, and the chat, every render and `brood`'s testing phase
follow it. `false` turns them off entirely: no conformance tests are written, the ones already in a
codebase are not run, and no agent is shown the conformance testing script. No key is the same as
`false`: conformance tests are off by default. `all` (or `true`) means on wherever a module has
`***test reqs***` - a module without them has nothing to write conformance tests from, so it writes
none, but still keeps the codebase's existing ones passing. Asked in the
conversation, or with `--conformance` / `--no-conformance` on the command line, a render does
otherwise.

`spawn` writes `conformance-tests: false` into a new project unless you ask for tests;
`brood` asks, whatever the key says, offering what it says first.

## The testing scripts

A build needs a unit testing script - and, with conformance on, a conformance testing script - to
decide when it is done. They are looked for at the project root, in this order:

1. named in the config - the chosen stack's file first, then `config.turri.yaml` - by path from the root;
2. the one `run_unittests*.sh` / `run_conformance_tests*.sh` in the project root;
3. the one of each in `test_scripts/`.

The optional prepare script - `prepare-environment-script:`, else the one `prepare_environment*.sh` - is looked for the
same way, and run on the build before the conformance testing script.

A folder holding two of a kind is not guessed between: name the one to use. A script named inside
`plain_modules/` is refused - agents write there, so it could be changed by the work it judges. The
scripts are never linked from the specs. What they are and how they run is in
[growing the code](growing.md#the-testing-scripts).

## Credentials for the agents

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
it is, outside every agent's reach - and never replaces turri's own home, `TMPDIR` or caches. A stack's file adds
to the project's. A file that is not there, or a variable unset or empty, is reported as missing. The testing scripts
are not affected: they run in your own environment.

Their values never appear in what an agent is shown or what turri writes: each is replaced by its name -
`[D365_CLIENT_SECRET]` - whole, URL-encoded, or split over a command's output as it streams: in every tool result and
refusal an agent is given (and so in the session transcripts, which hold only those), in the whole outputs kept for
`read_output`, and in the job and debug logs. A value shorter than four characters is not masked - `1` or `eu` is
everywhere in ordinary output.

## Stacks

One project can hold parts that share nothing but a common module - a Python backend and a React
frontend side by side, each importing `base` from `template/`, neither requiring the other - each
needing its own testing scripts. Each stack gets a file of its own beside `config.turri.yaml`,
`config.turri.<stack>.yaml`, holding what differs for it - typically its testing scripts, its
`toolchains:`, its models:

```
config.turri.yaml            # the project's: harness-model, coding-model, conformance-tests
config.turri.backend.yaml    # the stack backend: its testing scripts
config.turri.frontend.yaml   # the stack frontend: its testing scripts, and a coding model of its own
backend.plain                # import: [base, python_fastapi_template]
frontend.plain               # import: [base, react_vite_template]
template/                    # base.plain, python_fastapi_template.plain, react_vite_template.plain
test_scripts/                # both stacks' scripts
```

```yaml
# config.turri.frontend.yaml
unittests-script: test_scripts/run_unittests_typescript.sh
conformance-tests-script: test_scripts/run_conformance_tests_typescript.sh
coding-model:
  thinking: high
```

A stack is chosen, never worked out from the spec:

- **In the chat**, with `/stack` - a list of the project's stacks and none - or `/stack backend`, `/stack none`.
  The chat's model has a `stack` tool too, and switches the stack when you ask it to, or for work on a part another
  stack builds. The status bar shows `· stack <name> (/stack)` when the project has stacks.
- **On the command line**, with `--stack <name>` on any command - `turri regrow`, `bind`, `spec-diff`, `glimpse`,
  `release`, `cultivate` - and on `turri --stack backend` for the chat; or with `TURRI_STACK` in the environment.

The choice lasts for the session only: nothing remembers it, and turri started again has none chosen. A stack the
project has no file for is refused, with the stacks it has. With none chosen, `config.turri.yaml` alone is used.

How a stack's config is made:

- **Laid over `config.turri.yaml`, key by key.** What the stack's file gives wins; what it leaves out
  is the project's. A model it names takes what it leaves out from the project's same model - above,
  with the stack frontend chosen, everything renders on the project's coding model, thinking `high`.
- **For everything built while it is chosen.** Every pulse that starts, every test run and every
  script found from then on is the chosen stack's; a pulse already running keeps the stack it
  started with. Choose the stack before building the part it is for: `/stack backend`, then
  `regrow backend.plain`.
- **The project's alone.** `module:`, `harness-model:`, `parallel-jobs:`, `rules-off:` and `compact-at:` are read
  only from `config.turri.yaml` - there is one conversation, one module built when none is named, one machine.
  `agent-env:` and `toolchains:` in a stack's file add to the project's.

The chat is told each stack's config and the one chosen. The skills that write testing scripts put
each stack's in its own file once a project has two stacks, and say which stack to choose before
building each part.

## The old config.yaml

turri's settings were once in `config.yaml`, and a stack's in `config.<stack>.yaml`. A `config.yaml`
may be another tool's, so turri never writes one. While a project folder has no `config.turri*.yaml`
at all, turri still reads its `config.yaml`, and each `config.<name>.yaml` as the stack `<name>`.

The first time turri itself writes a setting there with `/turri-config`, it copies `config.yaml` to
`config.turri.yaml` and each `config.<name>.yaml` to `config.turri.<name>.yaml` first, leaves the old
files as they are, and from then on reads only the new ones. `turri init-config` copies the stacks'
files the same way, but writes `config.turri.yaml` as its quick start, taking from `config.yaml` only
the keys turri reads too - codeplain's `unittests-script`, `conformance-tests-script` and
`prepare-environment-script`, say - each in its place in the file, and saying which keys it left:
`template_dir`, `verbose`, `api`, codeplain's alone. The two models are the vendor's, never taken. To change a
setting by hand in such a project, do the same: copy the files to their new names, and edit the
copies - never `config.yaml`.
