# Running unattended

Given a spec, build it without a conversation - overnight, in CI, on a spare machine.

## Before you leave it

```bash
turri doctor
```

Everything marked `✗` stops the run, so fix those first. Two more things matter for a long run:

- **The toolchains.** The agents use this machine's: run `turri doctor` in the project, and it says which toolchain
  a module's implementation reqs name that this machine lacks.
- **The models.** In a project, `turri doctor` sends each model `config.turri.yaml` names one short request, as turri's
  agents will - so a key the provider refuses, a model pi does not know or an account without access to it shows now,
  not an hour into the run.
- **Credentials that do not expire mid-run.** An API key in the environment
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, ...) or pi's saved login - whatever
  `doctor` shows as the model provider.

Check the spec parses, without spending anything:

```bash
cd ~/my-project                  # the directory that holds the spec
turri validate app.plain
```

## Run it

```bash
turri regenerate app.plain --model anthropic/claude-sonnet-5
```

That builds every functionality in order - code and unit tests, then conformance tests when the
module has `***test reqs***`, then every conformance test so far - and advances only when they
pass. A module that `requires` others builds them first, bottom up. When it is done it prints
`To try it: turri release <spec>` - see [deploy](deploy.md).

Keep it running when the terminal closes and the laptop would sleep, and keep the log:

```bash
# macOS: caffeinate keeps the machine awake for as long as the command runs
nohup caffeinate -is turri regenerate app.plain --model anthropic/claude-sonnet-5 > render.log 2>&1 &

# Linux
nohup turri regenerate app.plain --model anthropic/claude-sonnet-5 > render.log 2>&1 &
```

Or run it in `tmux` / `screen` to look in on it. `tail -f render.log` follows it either way.

The project's `config.turri.yaml`, in the folder you run it from, can give the defaults, so a run can
be just `turri regenerate`:

```yaml
module: app.plain                         # what to build when no file is given
coding-model:                             # the model every agent runs on, and how hard it thinks
  model: anthropic/claude-sonnet-5
  thinking: medium
judge-model: anthropic/claude-opus-5-5    # the judge and the test review (default: coding-model)
conformance-tests: true            # write and run conformance tests where there are test reqs (default: false)
```

The same file names the [testing scripts](regenerating.md#the-testing-scripts); every key is in
[the project config](config.md). `turri regenerate`, `spec-diff` and `conform` take five of its keys on
the command line too - `--harness-model`, `--coding-model` (`--model` is the same), `--judge-model`,
`--review` and, but for `conform`, `--conformance-tests`. Each is read as if the file had it, in its place:
it takes that key's value, and every key keeps its place in the order the config resolves them in - a
`models:` entry still wins over `harness-model`, `coding-model` or `judge-model`, the planner and the
conformance chooser run on the harness model, the judge falls back on the coding model. So a run with
the options is the same as one, or a chat, with those keys in `config.turri.yaml` - and a `config.yaml`
the project has is left as it is.
A project whose parts are on different stacks keeps each stack's settings in
`config.turri.<stack>.yaml` beside it ([stacks](config.md#stacks)). Choose the one to build with
`--stack <name>` - on any command: `regenerate`, `conform`, `spec-diff`, `glimpse`, `release`, `cultivate` -
or `TURRI_STACK`: `turri regenerate backend.plain --stack backend`. With none chosen,
`config.turri.yaml` alone is used; a stack the project has no file for is refused.

Useful options - `turri regenerate --help` lists all of them:

| | |
| --- | --- |
| `--harness-model <provider/id>` | `harness-model`: the planner, the conformance chooser, the diagnosis of a failed pulse |
| `--coding-model <provider/id>` | `coding-model` (`--model` too): the agents that build - with `:level` for how hard it thinks (`provider/id:high`); not given, the harness model's |
| `--judge-model <provider/id>` | `judge-model`: the judge and the test review; not given, the coding model |
| `--conformance-tests <all\|chosen\|module\|false>` | `conformance-tests`, with its values (`true` is `all`) |
| `--review <true\|false>` | `review`: whether the code and its tests are reviewed once they pass |
| `--stack <name>` | build with the stack's `config.turri.<name>.yaml` over `config.turri.yaml`; default, `TURRI_STACK`, else none |
| `--start-over` | start over, unasked, a codebase built without a module it now requires - without a terminal, a run that needs it and lacks it stops |
| `--build-dir <dir>` | as the run ends, export the code there - see below |
| `--report <file.json>` | write [the run report](#the-run-report) there |

An option a command does not take is refused, not ignored.

`turri regenerate` queues the jobs the chat's `regenerate` does - a spec diff that brings what
is built in line, when it no longer matches the spec, then one render functionality job per
functional spec not built, each with its conformance job - and runs them all to the end, the queue
master reworking them as in the chat (see [a whole module](regenerating.md#a-whole-module)).
Conformance tests follow `conformance-tests:` in `config.turri.yaml`, or `--conformance-tests`.

## In the morning

The command exits `0` only when every module is complete: its code regenerated from the spec as it is
now, and its conformance tests written for what is built when they are on - no pulse failed, nothing
halted, nothing waiting for a start over. Anything else exits `1`, and the last lines say which
module is not complete, and why. The log says, per functionality, what was built and whether its
tests passed.

| | |
| --- | --- |
| `plain_modules/<module>/code/` | the code and unit tests |
| `plain_modules/<module>/tests/` | the conformance tests |
| `plain_modules/<module>/code/.turri.json` | the marshalled plain tree the code is built from |
| `.turri/jobs/` | each pulse's log: its agents, its test runs, how it ended |
| `.turri/debug/` | each agent's whole conversation |

And what happened, step by step, in the module's history:

```bash
git --git-dir=plain_modules/<module>/.plaingit --work-tree=plain_modules/<module> log --stat
```

### Where the code is

A module that `requires` others is built in its own codebase on top of theirs: the code of
`plain_modules/<module>/code` holds every module below it. `--build-dir <dir>` exports it as the run
ends, however it ends - done, failed, stopped by a signal: the last commit of the furthest-built
codebase of the chain, with the harness's own files (`.turri.json`, the notes) left out, so what is in
it is only what landed, its unit tests passing. The folder's contents are replaced each time; a
folder that holds the project, or one inside `plain_modules`, is refused. Point an external test
suite at it.

### The run report

`--report <file.json>` writes one JSON summary of the run, for a benchmark or CI to read rather than
the log. It is written as the run starts, again as each pulse ends, and last as the process exits -
whether the run is done, a pulse failed, the provider failed, it crashed, or `SIGTERM` / `SIGINT` /
`SIGHUP` stopped it. Only a process killed outright (`SIGKILL`) keeps the one written as its last pulse
ended. Each write replaces the file whole (written beside it, then renamed), so a reader never sees
half of one. Keys are snake_case, numbers are numbers, and `schema_version` changes only when a field
changes meaning or goes; new fields may appear in the same version. Paths in `pulses`,
`functionalities` and `logs` are relative to `project_dir`.

```jsonc
{
  "schema_version": 1,
  "turri": { "version": "0.1.1", "git_commit": "48dacfc…", "git_dirty": false },  // commit: null outside a clone
  "command": ["regenerate", "app.plain", "--model", "…", "--report", "report.json"],
  "spec_file": "/work/app.plain", "project_dir": "/work", "build_dir": "/work/out",  // build_dir: null without one
  "conformance_tests": "all",                                                       // all | chosen | module | false
  "review": false,
  "models": {
    "harness": { "model": "…", "thinking": "medium" },  // the planner, the chooser, the diagnosis
    "coding":  { "model": "…", "thinking": "low" },
    "judge":   { "model": "…", "thinking": "medium" },
    "observed": { "coding": ["provider/id:low"], "planner": ["provider/id:medium"] }  // what each role really ran on
  },
  "started_at": "…", "finished_at": "…", "duration_seconds": 4351.4,
  "outcome": {
    "status": "completed",  // completed | incomplete | failed | interrupted | crashed | running (written mid-run)
    "exit_code": 0, "signal": null, "error": null,
    "modules": [{ "module": "app", "state": "complete" }]  // complete | incomplete | halted | start_over_needed | running, with "why"
  },
  "usage": {
    "total": {
      "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0, "cost_usd": 0,
      "llm_calls": 0, "agent_turns": 0, "compactions": 0, "model_seconds": 0
    },
    "in_pulses": { },       // the pulses' usage added up - the same fields
    "outside_pulses": { },  // the planner, the conformance chooser, a failed pulse's diagnosis
    "by_model": { "provider/id:low": { } },
    "by_role": { "coding": { }, "reviewer": { }, "planner": { } },
    "by_pulse_kind": { "code": { }, "conformance": { } }
  },
  "pulses": {
    "counts": { "total": 7, "landed": 5, "failed": 1, "stopped": 0, "rolled_back": 2, "running": 0, "not_started": 0 },
    "list": [{
      "id": "2a058729", "module": "app", "number": 1, "kind": "code", "title": "…",
      "status": "succeeded", "landed": true, "failed_for_good": false,
      "started_at": "…", "duration_seconds": 512.3, "usage": { },
      "agents": [{ "label": "app 1 coding agent", "model": "…", "turns": 14, "compactions": 0, "input_tokens": 0, "…": 0 }],
      "log_file": ".turri/jobs/….log", "error": null
    }]
  },
  "functionalities": {
    "total": { "specified": 12, "completed": 10, "conformance_tested": 8 },
    "modules": [
      { "module": "base", "specified": 4, "completed": 4, "conformance_tested": 4, "incomplete_frids": [] },
      { "module": "app", "specified": 8, "completed": 6, "conformance_tested": 4, "incomplete_frids": ["7", "8"] }
    ],
    "codebases": ["plain_modules/app/code"]
  },
  "build_dir_export": { "exported": true, "dir": "/work/out", "module": "app", "commit": "8036b3b", "files": 23 },
  "logs": { "jobs_dir": ".turri/jobs", "debug_dir": ".turri/debug", "sessions_dir": ".turri/sessions" }
}
```

**Usage.** Every model response an agent gets counts, in a pulse or not. `total` is `in_pulses` plus
`outside_pulses`, and `in_pulses` is the pulses' own usage added up - the figures their lines in the
notes and the pulse logs print - so the totals can be checked by hand against them. `llm_calls` counts
model responses, a compaction's included; `agent_turns` the harness's requests to an agent, each as
many responses as it takes; `model_seconds` the time from each request to its response's end, added
up - several agents working at once each count theirs, so it can exceed the run's duration. Tokens and
cost are as the provider reports them to pi. `by_model`, `by_role` and `by_pulse_kind` split the same
calls; a role or model turri could not tell is `unknown`.

**Pulses.** `landed`: its work is committed. `rolled_back`: it ended without landing - failed,
stopped, or did not pass - and everything it wrote was undone. A pulse that failed is tried once more
before it counts as failed; both tries are the one pulse.

**Completed functional specs** - the pass rate, the figure to compare runs by.
A functional spec is completed when the code record of the codebase the run delivers - the
furthest-built of the chain, the one `--build-dir` exports - as last committed, holds it as the spec has
it now: the same text, every file it links holding the same, no definition it uses changed, and not
marked to regenerate again. A record moves only when a pulse lands, and a pulse lands only once the
code's unit tests pass (its conformance tests too, when they are on), so completed means landed and
passing. Each module counts its own functional specs: a module below the tip counts from what the
tip's code was built on, and a module above the delivered codebase has none completed.
`conformance_tested` is those of the completed ones whose conformance tests are recorded as written
for them as they are now (`plain_modules/<module>/tests/.turri.json`).

## If it stopped

Run the same command again. Functionalities already built from the current spec are left alone,
and modules that are complete are skipped, so it picks up where it stopped - after a crash, a
provider outage, or a machine that went to sleep anyway. Whatever the stopped run left
half-written is undone first: each step starts from the module's last commit. A functionality whose spec has changed
since counts as not built, so editing the spec and re-running rebuilds what changed. `--from-scratch`
rebuilds everything.

## Rebuilding one functionality

```bash
turri regenerate app.plain 3
```

It rebuilds just functionality 3 over the code that already exists - after its spec changed, or as
it is - without rebuilding the ones before it. To change what it does, change its spec first: the
spec is what the code is built from, and a change made there lasts. Then it updates the
functionality's conformance tests and runs every conformance test in the codebase, since a change can break something built
later as easily as something built earlier. It works in the codebase the functionality now lives
in: when later modules are built on top of this one, the furthest-built of them. It exits `0` when
everything passes, and refuses when there is no code yet - regenerate the module first.

Several changes do not need one command each: after editing the spec, re-running `turri regenerate`
brings the code up to it - one spec diff for what changed in what is built, then the functional
specs not built yet.

## In a container

A benchmark or CI task runs it with no terminal and nothing to ask, so give it everything up front:

```bash
turri regenerate app.plain --harness-model amazon-bedrock/eu.anthropic.claude-opus-5-5 \
  --coding-model amazon-bedrock/eu.anthropic.claude-sonnet-5-5 \
  --conformance-tests all --review false --judge-model amazon-bedrock/eu.anthropic.claude-opus-5-5 \
  --start-over --build-dir /out/build --report /out/report.json < /dev/null
```

- **What it needs:** Node 22.19 or newer, `bash`, `git` (each module's history, and the spec diffs
  the work is planned from), `/bin/sh` with `kill` and `sleep`, a writable `HOME` (pi keeps
  `~/.pi/agent/auth.json` there, even with no login - or set `PI_CODING_AGENT_DIR`) and `TMPDIR`, and
  the toolchains the project's testing scripts and implementation reqs name. `turri doctor --no-models`
  in the project checks them; `--no-models` because a `config.yaml` written for another tool names no models, and
  doctor would count that against it.
- **Without bubblewrap:** a container that cannot make user namespaces - no
  `--security-opt seccomp=unconfined` - has no OS sandbox. turri runs anyway, the command check and the
  audit holding alone under the agents' commands; `turri doctor` shows it as `!`, not `✗`. Installing
  the `bubblewrap` package is worth it where it can start.
- **As another user:** run it as the user who will own `plain_modules/`. git refuses a repository
  another user made (`dubious ownership`), so do not let root create it first.
- **Amazon Bedrock:** `AWS_BEARER_TOKEN_BEDROCK` (or the usual AWS credentials) and `AWS_REGION` are
  enough - no pi login. An `eu.` inference profile needs an EU region. A model id pi does not know
  stops the first pulse; `turri --list-models bedrock` lists the ones it does.
- **A project with only a `config.yaml`:** it is read while there is no `config.turri*.yaml` -
  `unittests-script`, `conformance-tests-script` and `prepare-environment-script` included, relative to
  the project; the keys turri does not know are ignored. Do not write a `config.turri.yaml` beside it to
  turn on conformance tests or review: from then on `config.yaml` is not read. The options above do it instead.
- **Long test suites:** a testing script run is stopped after 120 seconds; set `TURRI_COMMAND_TIMEOUT`
  (seconds) for more.

## Asking in words instead

pi's print mode runs one request and exits, with the render tools waiting for their work rather
than starting background jobs:

```bash
nohup turri -p "Render app.plain as a whole module, with conformance tests" > render.log 2>&1 &
```

It reports what it did at the end, and nothing streams in between, so for long runs
`turri regenerate` is the better choice. The interview skill (`brood`) needs
someone to answer; without one they decide and record their assumptions, and a gate that escalates
to a human stops the run.
