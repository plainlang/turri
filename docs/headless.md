# Running unattended

Given a spec, build it without a conversation - overnight, in CI, on a spare machine.

## Before you leave it

```bash
plainwright doctor
```

Everything marked `✗` stops the run, so fix those first. Two more things matter for a long run:

- **The VM image.** Without the full image only Python and Node projects build - see
  [installation](installation.md#without-the-full-vm-image). `plainwright vm-image` builds it in
  about 7 minutes.
- **Credentials that do not expire mid-run.** An API key in the environment
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, ...) or pi's saved login - whatever
  `doctor` shows as the model provider.

Check the spec parses, without spending anything:

```bash
cd ~/my-project                  # the directory that holds the spec
plainwright check app.plain
```

## Run it

```bash
plainwright module app.plain --model anthropic/claude-sonnet-5
```

That builds every functionality in order - code and unit tests, then conformance tests when the
module has `***test reqs***`, then every conformance test so far - and advances only when they
pass. A module that `requires` others builds them first, bottom up. Try-it steps are off: nobody
is there to try them.

Keep it running when the terminal closes and the laptop would sleep, and keep the log:

```bash
# macOS: caffeinate keeps the machine awake for as long as the command runs
nohup caffeinate -is plainwright module app.plain --model anthropic/claude-sonnet-5 > render.log 2>&1 &

# Linux
nohup plainwright module app.plain --model anthropic/claude-sonnet-5 > render.log 2>&1 &
```

Or run it in `tmux` / `screen` to look in on it. `tail -f render.log` follows it either way.

The project's `config.yaml`, in the folder you run it from, can give the defaults, so a run can
be just `plainwright module`:

```yaml
module: app.plain                  # what to build when no file is given
model: anthropic/claude-sonnet-5   # the model every agent runs on
conformance-tests: true            # write and run conformance tests (default: when there are test reqs)
```

The same file names the [testing scripts](rendering.md#the-testing-scripts). Options on the command
line win over it; `plainwright render`, `regenerate` and `conformance` take its `model` too.

Useful options - `plainwright module --help` lists all of them:

| | |
| --- | --- |
| `--model <provider/id>` | the model every agent runs on; default, `config.yaml`'s `model`, then pi's configured model |
| `--no-conformance` | skip conformance tests - faster, weaker |
| `--from <frid>`, `--to <frid>` | build a range of functionalities |
| `--only` | build just this module, not the ones it requires |
| `--max-regression-rounds <n>` | repair attempts when earlier tests break (default 20) |
| `--try-it` | work out and check how to try the last functionality built |

## In the morning

The command exits `0` only when every module is complete. The log says, per functionality, what
was built and whether its tests passed; the last lines summarise each module.

| | |
| --- | --- |
| `plain_modules/<module>/code/` | the code and unit tests |
| `plain_modules/<module>/tests/` | the conformance tests |
| `plain_modules/<module>/code/.plainwright.json` | what each functionality was built from, and whether its tests passed |

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
plainwright regenerate app.plain 3
```

It rebuilds just functionality 3 over the code that already exists - after its spec changed, or as
it is - without rebuilding the ones before it. To change what it does, change its spec first: the
spec is what the code is built from, and a change made there lasts. Then it updates the
functionality's conformance tests and runs every conformance test in the codebase, since a change can break something built
later as easily as something built earlier. It works in the codebase the functionality now lives
in: when later modules are built on top of this one, the furthest-built of them (`--in <module>`
picks one when there are several). It exits `0` when everything passes, and refuses when there is
no code yet - build it with `module` first.

Several changed functionalities do not need one command each: after editing the spec, re-running
`plainwright module` rebuilds exactly the ones whose own spec changed.

## Asking in words instead

pi's print mode runs one request and exits, with the render tools waiting for their work rather
than starting background jobs:

```bash
nohup plainwright chat -p "Render app.plain as a whole module, with conformance tests" > render.log 2>&1 &
```

It reports what it did at the end, and nothing streams in between, so for long runs
`plainwright module` is the better choice. The interview skills (`forge-plain`, `forge-diff`) need
someone to answer; without one they decide and record their assumptions, and a gate that escalates
to a human stops the run.
