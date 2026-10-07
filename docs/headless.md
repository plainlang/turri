# Running unattended

Given a spec, build it without a conversation - overnight, in CI, on a spare machine.

## Before you leave it

```bash
turri doctor
```

Everything marked `✗` stops the run, so fix those first. Two more things matter for a long run:

- **The toolchains.** The agents use this machine's: run `turri doctor` in the project, and it says which toolchain
  a module's implementation reqs name that this machine lacks.
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
turri regrow app.plain --model anthropic/claude-sonnet-5
```

That builds every functionality in order - code and unit tests, then conformance tests when the
module has `***test reqs***`, then every conformance test so far - and advances only when they
pass. A module that `requires` others builds them first, bottom up. When it is done it prints
`To try it: turri release <spec>` - see [deploy](deploy.md).

Keep it running when the terminal closes and the laptop would sleep, and keep the log:

```bash
# macOS: caffeinate keeps the machine awake for as long as the command runs
nohup caffeinate -is turri regrow app.plain --model anthropic/claude-sonnet-5 > render.log 2>&1 &

# Linux
nohup turri regrow app.plain --model anthropic/claude-sonnet-5 > render.log 2>&1 &
```

Or run it in `tmux` / `screen` to look in on it. `tail -f render.log` follows it either way.

The project's `config.yaml`, in the folder you run it from, can give the defaults, so a run can
be just `turri regrow`:

```yaml
module: app.plain                         # what to build when no file is given
coding-model:                             # the model every agent runs on, and how hard it thinks
  model: anthropic/claude-sonnet-5
  thinking: medium
judge-model: anthropic/claude-opus-5-5    # the judge and the test review (default: coding-model)
conformance-tests: true            # write and run conformance tests (default: when there are test reqs)
```

The same file names the [testing scripts](growing.md#the-testing-scripts); every key is in
[the project config](config.md). Options on the command
line win over it; `turri regrow`, `spec-diff`, `regenerate` and `conformance` take its
`coding-model` too, and `--coding-model` means the same as `--model` on every one of them.
A module on a stack of its own takes its settings from `config.<module>.yaml` over `config.yaml`
([modules on different stacks](config.md#modules-on-different-stacks)); with several and no
`module:`, name the file: `turri regrow backend.plain`.

Useful options - `turri regrow --help` lists all of them:

| | |
| --- | --- |
| `--model <provider/id>` | the model every agent runs on (`--coding-model` too), with `:level` for its thinking (`provider/id:high`); default, `config.yaml`'s `coding-model`, then its `harness-model`, then pi's configured model |
| `--judge-model <provider/id>` | `conformance`: the model of the judge and the test review; default, `config.yaml`'s `judge-model`, then the coding model |
| `--to <frid>` | queue functionalities only up to this one |
| `--only` | build just this module, not the ones it requires |
| `--build-dir <dir>` | where the code goes; default `plain_modules/<module>/code` |

`turri regrow` queues the jobs the chat's `regrow` does - a spec diff that brings what
is built in line, when it no longer matches the spec, then one render functionality job per
functional spec not built, each with its conformance job - and runs them all to the end, the queue
master reworking them as in the chat (see [a whole module](growing.md#a-whole-module)).
Conformance tests follow `conformance-tests:` in `config.yaml`.

## In the morning

The command exits `0` only when every module is complete. The log says, per functionality, what
was built and whether its tests passed; the last lines summarise each module.

| | |
| --- | --- |
| `plain_modules/<module>/code/` | the code and unit tests |
| `plain_modules/<module>/tests/` | the conformance tests |
| `plain_modules/<module>/code/.turri.json` | the marshalled plain tree the code is built from |

And what happened, step by step, in the module's history:

```bash
git --git-dir=plain_modules/<module>/.plaingit --work-tree=plain_modules/<module> log --stat
```

## If it stopped

Run the same command again. Functionalities already built from the current spec are left alone,
and modules that are complete are skipped, so it picks up where it stopped - after a crash, a
provider outage, or a machine that went to sleep anyway. Whatever the stopped run left
half-written is undone first: each step starts from the module's last commit. A functionality whose spec has changed
since counts as not built, so editing the spec and re-running rebuilds what changed. `--force`
rebuilds everything.

## Rebuilding one functionality

```bash
turri regrow app.plain 3
```

It rebuilds just functionality 3 over the code that already exists - after its spec changed, or as
it is - without rebuilding the ones before it. To change what it does, change its spec first: the
spec is what the code is built from, and a change made there lasts. Then it updates the
functionality's conformance tests and runs every conformance test in the codebase, since a change can break something built
later as easily as something built earlier. It works in the codebase the functionality now lives
in: when later modules are built on top of this one, the furthest-built of them (`--in <module>`
picks one when there are several). It exits `0` when everything passes, and refuses when there is
no code yet - build it with `module` first.

Several changes do not need one command each: after editing the spec, re-running `turri regrow`
brings the code up to it - one spec diff for what changed in what is built, then the functional
specs not built yet.

## Asking in words instead

pi's print mode runs one request and exits, with the render tools waiting for their work rather
than starting background jobs:

```bash
nohup turri -p "Render app.plain as a whole module, with conformance tests" > render.log 2>&1 &
```

It reports what it did at the end, and nothing streams in between, so for long runs
`turri regrow` is the better choice. The interview skill (`brood`) needs
someone to answer; without one they decide and record their assumptions, and a gate that escalates
to a human stops the run.
