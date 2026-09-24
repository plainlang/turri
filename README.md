# plainwright

A skill's review step is normally a paragraph asking the agent to check its own work.
Agents talk their way past paragraphs. This makes the review an edge in a graph instead:
the harness decides when a gate runs, spawns the judges itself, and branches on a
structured verdict. The model's only job is producing the artifact under review.

Pi supplies the agent runtime (sessions, tools, multi-provider models). LangGraph supplies
the control flow. The gate syntax lives in `SKILL.md`, so a gated skill still loads in any
spec-compliant harness - it just runs ungated there.

## Install

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

`plainwright setup` checks, in order, and says exactly what to run for anything missing:

| what | why | if it is missing |
| --- | --- | --- |
| Node 22.18+ | plainwright runs its `.ts` sources directly | install a newer Node |
| QEMU | every command an agent runs, runs in a sandbox VM on it | `setup` offers `brew install qemu`; on Linux, `apt install qemu-system-arm` / `qemu-system-x86` |
| the VM image | the full image has Python, Node, Java, Go, Rust, C/C++ and git | `setup` offers to build it (about 7 minutes, 2 GB) - see [Building the VM image](#building-the-vm-image); until then the stock image is used - see [below](#without-the-full-vm-image) |
| a model provider | the agents need a model | run `pi` and `/login`, or set an API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, ...) |
| `plainwright` on PATH | so it runs from any project | `npm link` in this clone |
| in every `pi` (optional) | a plain `pi` gets the tools too, not only `plainwright chat` | `setup` offers to write the one-line extension and copy the themes |

It ends by starting a sandbox VM for real and listing the toolchains in it, since a VM that
does not start is the one thing that stops every render. Nothing is changed without asking;
`plainwright setup --yes` says yes to everything. Run without a terminal - piped, or in CI -
it asks nothing, changes nothing, and lists what it would have asked.

Afterwards:

```bash
plainwright doctor            # the same checks, changing nothing - for when something breaks
plainwright doctor --quick    # without starting a VM
plainwright vm-image          # build (or rebuild) the full VM image - with e2fsprogs, or in Docker
```

The pi session says where commands will run on its first line - the image in use, a limit
such as the stock image, or that there is no VM and why. A VM that fails to start refuses
the command and names `plainwright doctor`.

Models and credentials come from your Pi configuration (`~/.pi/agent`) or provider env
vars - the same resolution `pi` itself uses.

### Building the VM image

The full image is built one of two ways, and `plainwright vm-image` uses the first this machine
has (`--native` or `--docker` picks one):

| | needs | |
| --- | --- | --- |
| with e2fsprogs (the default) | e2fsprogs: `brew install e2fsprogs`, or `apt install e2fsprogs` | a few small command-line tools, installed once - nothing to start or keep running. Gondolin unpacks the Alpine packages itself; e2fsprogs writes the disk image. |
| in Docker | Docker, running | the build runs in a Linux container. For when e2fsprogs cannot be installed. |

Both take about 7 minutes and produce the same image. `plainwright setup` works through them
in that order:

- **e2fsprogs installed** - it offers to build.
- **e2fsprogs not installed** - on macOS it offers to install it with Homebrew, then to build;
  on Linux it prints `sudo apt install e2fsprogs`.
- **Still no e2fsprogs** - it falls back to Docker: it offers to build in Docker if it is
  running, or to start it first if it is installed but not running (`open -a Docker` on
  macOS, and waits for it; on Linux it prints `sudo systemctl start docker`).
- **Neither** - it says so, explains what the stock image means for your project, and names
  both ways to get the full one.

`plainwright doctor` shows which way is available as `Image builder`.

### Without the full VM image

Until `plainwright vm-image` has been run, commands run in Gondolin's stock image, downloaded
on first use (about 200 MB). What that means for a project:

| | |
| --- | --- |
| works | Python 3.12 (`venv`, `pip` inside a venv, `uv`) and Node 24 (`npm`) projects. Their dependencies install into the project folder, so there is room for them - FastAPI, SQLAlchemy, pytest, Express, Vitest all install. |
| missing | C/C++ compilers and `make`, `git`, Java, Go, Rust. |
| so | A Java, Go, Rust or C/C++ project cannot be built. A Python or npm package that has to compile native code - one with no prebuilt build for Alpine - fails to install. |
| installing more | The VM's own disk has about 80 MB free. `install_system_packages` fits small packages (`jq`, `sqlite`), never a compiler or a JDK. |

The agents are told the same, so on the stock image a project that needs more is reported as
needing the full image rather than fought with. `plainwright doctor`, `setup` and the session
banner all say which image is in use.

A gated skill can also be run directly, without a conversation:

```bash
npm run forge -- skills/forge-plain
```

## The syntax

Under `metadata:`, which the Agent Skills spec reserves for arbitrary key-values:

```yaml
---
name: forge-plain
description: End-to-end ***plain spec authoring workflow.
allowed-tools: [read, write, edit, bash, ls, grep, find]
metadata:
  gates:
    - after: product                      # the ### step this gate guards
      review:
        rubric: ./references/rubric-product.md
        judges: 2                         # independent sessions, not n samples of one
        model: anthropic/claude-sonnet-5  # optional; defaults to the executor's model
        quorum: all                       # all | majority | any
        on_fail: retry                    # retry | escalate | abort
        max_retries: 2
        judge_tools: [read, ls, grep, find]   # read-only tools the rubric needs
---

## Steps

### product
...prose the executor reads...

### finalize
...
```

Each `### heading` is a step. Each gate becomes a conditional edge after its step.

## What the harness enforces, not the model

- **Whether review happens.** The gate is an edge. There is no prompt the executor can
  write that skips it.
- **How many attempts.** `max_retries` is a counter in graph state. The executor is never
  asked how many tries it would like.
- **What "fail" means.** Judges answer through a TypeBox schema (`submit_verdict`), so the
  router branches on a value. A judge that returns no verdict counts as a fail - silence is
  not consent.
- **What gets reviewed.** The executor's only write path is `write_artifact`, pointed at a
  path the graph chose. A step that produces no artifact fails its gate without spending a
  single judge call.
- **Who is judging.** Each judge is a fresh session holding one tool, given the artifact and
  the rubric and nothing else. It never sees the executor's transcript, because a judge that
  inherits the actor's reasoning inherits its rationalisations.

`on_fail: escalate` (and `retry` once retries are exhausted) pauses the graph on a LangGraph
`interrupt`. Nothing advances until a human answers.

## The plain parser

`src/plain/` is a TypeScript port of the reference ***plain*** parser - `plain_file.py`,
`plain_spec.py`, `concept_utils.py`, and the `file_utils.py` helpers they depend on.

```bash
npm test                      # 138 tests
```

| Module | Ports |
|---|---|
| `src/plain/parser.ts` | `plain_file.py` - sections, acceptance tests, imports/requires, marshalling |
| `src/plain/spec.ts` | `plain_spec.py` - FRIDs, the per-functionality context, linked resources, ranges |
| `src/plain/concepts.ts` | `concept_utils.py` - concept extraction, validation, topological ordering |
| `src/plain/markdown.ts` | mistletoe's AST + `PlainRenderer` (mdast + a matching serializer) |
| `src/plain/liquid.ts` | `plain2code_nodes.py` + the two filters in `plain_spec.py` (liquidjs) |
| `src/plain/files.ts` | `file_utils.open_from` / `get_loaded_templates`, base64 blob detection |

### Checking a spec

```bash
plainwright check <file.plain>        # one spec
plainwright check .                   # every .plain file in a directory
plainwright check <file.plain> --json
```

This is the check that used to mean running a renderer with `--dry-run`. It uses this
repo's own parser, so it needs no external tool, no API key and no credits: it parses the
file, resolves its imports and required modules, and reports every syntax, concept and
structure error with the line it is on.

```
PASS  d365_export.plain  6 functionalities (1, 2, 3, 4, 5, 6), requires d365_restore_api

FAIL  broken.plain  PlainSyntaxError
        Plain syntax error: Syntax error at line 3: Invalid specification heading
        (`Nope:`). Allowed headings: definitions, implementation reqs, test reqs, ...
```

Exit code is 0 only when every file passed. The same thing is `check_plain` in a
conversation.

### The functional-spec iterator

`getFrids` walks functionalities depth-first through nested sections;
`getSpecificationsForFrid` builds what a single functionality is rendered with.
`iterateFunctionalSpecs` pairs them:

```ts
import { plainFileParser, iterateFunctionalSpecs } from "./src/plain/index.ts";

const [moduleName, tree] = plainFileParser("my_app.plain", ["."]);

for (const { frid, specifications, codeVariables } of iterateFunctionalSpecs(tree)) {
  // definitions and reqs in scope from the outside in, every functionality up to and
  // including this one, and only this one's acceptance tests
  console.log(frid, specifications["functional specs"].length);
}
```

### Fidelity

The port is checked against the Python implementation directly, not only against the
ported assertions. Both parsers are run over a corpus and their module name, marshalled
tree, required modules, FRID list and per-FRID specifications compared:

| Corpus | Files | Identical | Differences |
|---|---|---|---|
| `tests/data/` fixtures | 84 | 80 | 4 error strings (below) |
| `hycu-dynamics-365-modules` | 47 | 47 | none |

The 4 remaining differences are all the same thing: template partials
(`implement.plain`, `implement_2.plain`, `header.plain`, `pr_implement.plain`) are meant
to be included with arguments, not parsed alone. Both implementations reject them for
the same reason - an undefined Liquid variable - but the message text comes from the
template engine, and liquidjs phrases it differently from liquid2.

Real specs exposed three places where mdast and mistletoe disagree, each now covered by
`tests/plain/renderer.test.ts`:

- **Inline decoding.** mdast resolves `\"` to `"` and forgets whether emphasis was
  written with `_` or `*`; mistletoe round-trips the source. Inline leaf nodes are
  therefore pinned back to their original source slice at parse time.
- **List geometry.** mistletoe indents an item's continuation lines by its `prepend`,
  measured in coordinates with the enclosing item's indentation stripped - not by the
  column gap between parent and child. An acceptance test rendered detached from its
  functionality keeps 6 and 10 spaces where the naive reading gives 4 and 8.
- **Lazy continuation lines.** A paragraph's continuation lines carry leading
  whitespace that is not part of the text; keeping it in the raw slice indents the line
  twice.

Two deliberate differences from the Python source:

- The `test_plainfile.py` tests drive the acceptance-test helpers with `MagicMock`
  tokens and patch the inner helper to count calls. ESM has no equivalent, so those
  tests build real ASTs from markdown and assert the same observable outcome.
- `networkx`'s `topological_sort` is reimplemented rather than replaced with a generic
  one: it flattens `topological_generations`, so the ordering of independent concepts
  follows graph insertion order, and the Python tests assert that exact sequence.

## Rules and skills

`forge/rules/` holds the 18 ***plain authoring rules, and `skills/` the skill library. Both
moved here from `plain-forge/forge`.

### Rules load on start

The extension appends every rule, in full, to the system prompt on each turn. The block is
byte-identical every time, so it sits inside the cached prefix rather than invalidating it.

That is **~40k tokens in every session**, including ones that never touch a spec. The trade
is deliberate: a rule the model has to decide to go and read is a rule it can skip, and
these govern every spec the project writes. `src/rules.ts` is where to change it if the
cost stops being worth it.

### Skills run through the gated runner

Every skill in `skills/` is runnable. A skill declares its steps with a `## Steps` section
whose `###` headings are the steps; without that section the whole skill is one step, which
is what most skills are and what the Agent Skills standard describes.

Steps are never inferred from `###` headings elsewhere in the body. Prose skills are full of
those, and an earlier loader read them as executable steps - so a skill's explanatory
subsections would have been run as work.

Gates are declared per step in `metadata.gates`, so a single-step skill can be gated by
naming the skill itself. Only `forge-plain` declares any today.

### Gates can grant judges read-only tools

`judge_tools` on a gate gives its judges tools they would not otherwise have:

```yaml
review:
  rubric: ./references/rubric-product.md
  judges: 2
  quorum: all
  judge_tools: [read, ls, grep, find]
```

Judges get nothing by default, which is right when the artifact is the whole subject. A
rubric that checks what is on disk has to be able to look, so the gate asks for it
explicitly - and only for tools that cannot change anything.

### Steps can build while they interview

A step may call `start_render` to queue a functionality and carry straight on. The interview
is what the person is waiting on, so it never waits for a build.

Renders are queued, not merely backgrounded. Functionality 2 is built on top of
functionality 1, and two renders writing one build directory would trip over each other - so
each waits for the one before it while the interview runs ahead of all of them. A render
that fails does not cancel the ones behind it; each reports on its own. `render_status`
shows the queue.

`regenerate: true` re-queues a functionality whose spec changed after it was already built.

### Steps can interview the user

A step may call `ask_user` to put one question to the person running the skill. In the TUI
that is a real dialog through `ctx.ui`; from the CLI the options are numbered and either the
number or the text is accepted; where there is no user at all the step is told to decide and
record the assumption.

**Offering choices is the default, not an option.** A call with neither `options` nor
`free_form: true` is refused and the model is told to ask again — an optional field is one a
model quietly skips, and picking from a list is far quicker than typing. Every list also
carries "Something else…", so offering choices never traps the user into a wrong one.
`multi_select: true` keeps offering what is left until they say they are done, which beats
asking the same question five times.

The policy lives in `src/ask.ts` so the TUI and CLI behave identically and it can be tested
without a terminal.

The harness still owns the sequence. A step chooses what to ask; it does not choose whether
the gate afterwards runs.

## Using it anywhere

The tools resolve paths against the current directory, and a `.plain` file's linked
resources do too - so the intended shape is to `cd` to the module and name the file.

`npm link` (see [Install](#install)) puts `plainwright` on your PATH, pointing at this
working copy, so edits here take effect immediately - no reinstall while iterating. It has to
be a link, not `npm install -g`: Node will not run `.ts` files from inside a `node_modules`,
and a copying global install puts them there.

```bash
cd ~/Work/codeplain/hycu/hycu-dynamics-365-modules

plainwright render d365_function_executor.plain --list
plainwright module d365_function_executor.plain
plainwright conformance d365_function_executor.plain 1
plainwright regenerate d365_function_executor.plain 1
plainwright chat                         # pi here, with these tools and themes
```

The bin is `plainwright`, not `forge`: `forge` is already Foundry's.

Put the environment in your shell profile so it stops being per-command:

```bash
export PLAIN_TEMPLATE_DIRS=~/Work/codeplain/codeplain/standard_template_library
export GEMINI_API_KEY=...        # and leave GOOGLE_API_KEY unset
```

### Conversation mode from any directory

`plainwright chat` runs pi from this project's `node_modules`, so no global pi install is
needed. To get the tools in a plain `pi` instead, let `plainwright setup` install a one-line
global extension (`~/.pi/agent/extensions/plainwright.ts`) and copy the themes to
`~/.pi/agent/themes/`. By hand, it is:

```bash
mkdir -p ~/.pi/agent/extensions
cat > ~/.pi/agent/extensions/plainwright.ts <<'EOF'
export { default } from "/absolute/path/to/plainwright/src/extension.ts";
EOF
cp .pi/themes/*.json ~/.pi/agent/themes/
```

That is the only absolute path in the setup, and deleting the file removes the tools.

Do not do both by halves: pi treats a tool registered twice as an error, not a duplicate,
and refuses to load. `plainwright chat` checks for both the global extension and the global
themes, and skips its own `-e` / `--theme` when it finds them, so the two can coexist
without a startup full of collision warnings.

With the themes installed globally, `plainwright chat` needs no theme flags at all. Pin the
theme once instead of passing `--use-theme` every time:

```bash
# in ~/.pi/agent/settings.json
{ "theme": "forge" }
```

## Theming

Two brand themes ship in `.pi/themes/`, built from the brand tokens:

```bash
plainwright chat --use-theme forge
plainwright chat --use-theme forge-light/forge   # follows terminal appearance
```

The second form follows your terminal's light/dark appearance. Once the project is
trusted, `.pi/themes/` is discovered automatically and `{"theme": "forge"}` in
`~/.pi/agent/settings.json` makes it the default.

Bad input fails quietly - an unknown `--use-theme` name and a malformed theme file both
run without complaint - so if the colours do not change, suspect a typo rather than the
mechanism.

### Why there are two

Half the palette is unusable on the other background. Contrast against brand black and
brand white:

| token | on `#0f0f0f` | on `#ffffff` |
|---|---|---|
| brand-yellow | 17.07 | 1.12 |
| brand-green | 14.77 | 1.30 |
| brand-green-light | 13.34 | 1.44 |
| brand-blue | **1.97** | 9.72 |
| brand-green-dark | 1.56 | 12.31 |
| brand-red | 3.38 | 5.67 |

So `forge` (dark) carries yellow, green and green-light, and `forge-light` carries blue
and green-dark. **Brand blue never appears as text in the dark theme** - at 1.97:1 on
brand black it is illegible - so the dark theme's accent is brand yellow and blue appears
only in the light theme and in both themes' HTML-export backgrounds.

Two values are not straight from the palette, and are named in the theme files so they are
easy to find:

- `avatarFlat` `#3a3d2e` - `--color-brand-avatar-bg` composited over brand black, because
  terminals have no alpha channel.
- `errorDark` `#2a1414` - the only invented colour. The palette has no dark red, and a
  failed tool row needs a background that `--color-brand-status-error` would overpower.

`--color-brand-status-warning` on white is 3.49:1, under the 4.5:1 bar for body text. It is
used only for accents in the light theme, never for prose.

### Backgrounds

The dark theme paints no panels: every background token is brand black, so the terminal
shows through and the transcript reads as one surface. Two are deliberately not black,
because they have to be visible to work:

| token | value | why |
|---|---|---|
| `selectedBg` | `#223936` | a selection you cannot see is not a selection |
| `searchMatchBg` | `#e0ff6e` | search hits, with black text on top |

With tool rows no longer carrying a background, their state is signalled by the title and
the diff colours instead.

This only reaches as far as pi draws. **The window's own background is your terminal's
setting** - set it to `#0f0f0f` in your terminal profile, or the area around the transcript
stays whatever it was.

### The font

`--font-brand` cannot be applied. Pi draws into a terminal, so the typeface is your
terminal emulator's setting, and NeueMontreal is proportional - a terminal needs a
monospaced face. The `monospace` fallback in that token is what you would actually get.
Set it in iTerm2 / Ghostty / Alacritty, not here.

## Choosing a model

In a conversation, every render runs on the conversation's model unless you say otherwise.
Say it in words - "render spec changes with gpt 5.5", "build the functionalities on Gemini 3.6
Flash", "use Claude for everything" - and the agent calls `set_render_model`, which holds for
the rest of the session (a resumed one too):

| kind of work | covers |
| --- | --- |
| spec changes | render spec diff jobs, including the ones forge-diff queues as you answer |
| functionalities | render functionality, render module, regenerate, conformance, including the ones forge-plain queues |
| everything | both |

It works mid-interview as well: the skill's agent has the same tool. Jobs already queued keep
the model they were queued with; `"chat"` goes back to the conversation's model. `/render-model`
shows what each kind of work runs on, and each job shows its model in the panel, in `/watch`
and in `/jobs`. A render tool can also be given a model for that one call.

Names are resolved strictly, because pi's own matching guesses and says nothing ("gpt-5" can
land on a Bedrock model you have no key for). An exact `provider/model-id` is taken as it is. A
looser name is taken when it fits exactly one model you have credentials for, or is exactly one
model's id in other words ("gpt 5.5" is `openai/gpt-5.5`, not `gpt-5.5-pro`). Anything else
comes back as a short list - "gemini flash 3.1" fits Gemini 3.1 Flash Lite and its preview - and
the agent asks you which one; a model whose provider has no credentials is never picked, and it
says which provider needs a key.

From the command line, the tools use whatever pi is configured to use, or `--model provider/model-id` per run:

```bash
npm run render -- <file.plain> 1 --model google/gemini-3.1-pro-preview
npm run conformance -- <file.plain> 1 --model google/gemini-3.1-pro-preview
```

For Gemini, pi enables the provider off `GEMINI_API_KEY`:

```bash
export GEMINI_API_KEY=$GOOGLE_GENERATIVE_AI_API_KEY   # or your key
```

A quirk worth knowing: `GEMINI_API_KEY` is what makes pi *offer* the google provider, but
when `GOOGLE_API_KEY` is also set pi uses that one for the actual calls and says so. Set
`GEMINI_API_KEY` even if another Google variable is already populated.

To make it the default instead of passing `--model` every time, in
`~/.pi/agent/settings.json`:

```json
{ "defaultProvider": "google", "defaultModel": "gemini-3.1-pro-preview" }
```

A provider failure - no credits, bad key, rate limit - is raised as `ProviderError` with
the provider's own message, rather than surfacing as an agent that said nothing.

## Rendering a functionality

`plainFileParser` says what to build; this turns one functionality into code.

```bash
npm run render -- <file.plain> --list          # the functionality IDs
npm run render -- <file.plain> 1               # build functionality 1
npm run render -- <file.plain> 1 --dry-run     # print the prompt, start nothing
```

| Option | |
|---|---|
| `--build-dir <dir>` | where the agent works (default `plain_modules/<module>/code`) |
| `--template-dir <dir>` | extra template directory, repeatable |
| `--model <provider/id>` | model for the agents, e.g. `google/gemini-2.5-pro` |
| `PLAIN_TEMPLATE_DIRS` | colon-separated template dirs, e.g. the standard library |

Template search order matches `file_utils.get_template_directories`: the plain file's own
directory, then a sibling `template/` if there is one, then `--template-dir`, then the
environment.

### What the agent is given

`getSpecificationsForFrid` returns every functionality up to and including the target, so
the last one is what this run builds and the ones before it are already-built context. The
prompt keeps that distinction explicit, and carries the definitions and implementation/test
reqs in scope, the target's acceptance tests, and the contents of any linked resources the
spec references up to that point:

```
<definitions> … </definitions>
<implementation reqs> … </implementation reqs>
<test reqs> … </test reqs>
<already implemented> … </already implemented>
<linked resources> … </linked resources>
<functionality id="1"> - Display "hello, world" </functionality>
<acceptance tests> … </acceptance tests>
```

The agent runs with `read`, `write`, `edit`, `bash`, `ls`, `grep`, `find` and
`run_unit_tests`, confined to the build directory. See *Confinement* below: `cwd` alone is
where relative paths start, not a fence.

### Confinement

pi's `cwd` is a starting point: an absolute path resolves to itself and `bash` can `cd`
anywhere. A rendering agent has no business outside the module it is building, so
`src/render/confine.ts` rebuilds the file tools from pi's own factories with a check in
front of every path, and runs `bash` under an OS sandbox.

Every agent - render, conformance author, code fixer, regression repair - reads and writes
the whole of `plain_modules`, every module's code and tests, and nothing above it: not the
`.plain` specs, not the rest of the project.

The path check runs twice: once on the argument the tool was called with, and once on the
absolute path the tool resolved it to, because the two can differ. Symlinks are resolved
before comparing, so a link cannot walk out, and a glob containing `..` is refused
outright.

`bash` is the case no argument check can cover - one string, and no way to read where it
will read or write. So it does not run on the host at all: every command - the agent's
`bash`, `run_unit_tests`, conformance runs, the try-it checks - runs in one
[Gondolin](https://github.com/earendil-works/gondolin) micro-VM (Alpine Linux) per project,
which holds `plain_modules` and nothing else, mounted read-write at the path it has on the
host. The specs above it, the home directory and every other project do not exist in there.
The host environment is not passed in, so the provider's API keys stay out. The network
reaches the package registries (Alpine, PyPI, npm, Go, crates.io, Maven Central, Gradle) and
any host named in `PLAINWRIGHT_ALLOWED_HOSTS` (comma-separated), nothing else.

What the VM needs beside the code lives in `plain_modules/.plainwright`, which ignores itself:
the package caches (so a dependency downloads once per project), the copies conformance runs
and try-it checks happen in, and `system-packages.json`.

The guest image is plainwright's own, built from `vm/image.json` with `plainwright vm-image`
- or by `plainwright setup`, which offers to - for this machine's architecture, with e2fsprogs
or in Docker (see [Building the VM image](#building-the-vm-image); about 7 minutes, 2 GB):
Python, Node, Java 21 with Maven and Gradle, Go, Rust, C/C++ with make and cmake, and git.
Without it the stock Gondolin image is used (downloaded on first use, about 200 MB) - see
[Without the full VM image](#without-the-full-vm-image) for what that can and cannot build. A language, compiler or system
library the image lacks, the agent installs with `install_system_packages` (Alpine packages).
The packages are recorded in `plain_modules/.plainwright/system-packages.json` and installed
again - from the project's cache - whenever the project's VM starts, so what one render set up
is there for every later one. Project dependencies go through the project's own package manager
as usual.

The VM starts on the first command and is kept until pi exits. VMs run on Apple Silicon macOS
and on Linux, on QEMU. Anywhere else, or when the VM fails to start, there is no fallback: the
agent gets no shell and commands are refused, because there is no honest way to fence one on
the host. `plainwright doctor` says which of those it is.

### The tests must actually pass

`run_unit_tests` runs the suite and hands the exit code back to the harness, so whether
the tests pass is something the harness observes rather than something the agent reports.
After each turn it checks two things and sends the agent back if either is wrong, up to
`--max-follow-ups` times (default 4):

- **The suite is not green**, or was never run at all. A run that never went through
  `run_unit_tests` does not count.
- **Tests went missing.** The test files present before the turn are inventoried and
  compared afterwards; a deleted file or a file that lost cases is challenged by name.

The rule on removal is narrow and stated to the agent: a test may go only when it asserts
nothing meaningful - a test that cannot fail, exactly duplicates another, or tests
something the specification does not require. Inconvenient, slow, or currently failing are
not grounds. Removals survive into `result.testRemovals` and the CLI prints them, so a
justified removal is visible rather than silent.

This matters most from functionality 2 onwards, where the working directory already holds
the previous functionalities' tests - the baseline is taken before the agent starts, so
breaking an earlier test is caught too.

The CLI exits non-zero when the suite is not green.

### From a conversation

The Pi extension registers `render_functionality` and `render_conformance_tests`, so both
are reachable by asking. Called without a `frid` it lists the available IDs instead of building one. The
conversational agent names the file and the functionality; it never assembles the context
itself, so a given functionality always renders from the same specification.

### Verified

Run against `examples/example_hello_world_python/hello_world_python.plain`:

```
done hello_world_python functionality 1
  build dir: plain_modules/hello_world_python/code
    hello_world.py
    test_hello_world.py
```

`python3 -m unittest discover` in that directory: `Ran 2 tests … OK`.

## Building a whole module

```bash
npm run module -- <file.plain> --model google/gemini-3.1-pro-preview
npm run module -- <file.plain> --from 3 --to 5
```

For each functionality in order: render the code and unit tests, write its black-box
conformance tests, then run the conformance tests of **every functionality built so far,
merged into one suite**. It advances only when that whole suite is green.

Each functionality's tests live in `plain_modules/<module>/tests/<frid>/`, and a regression run
flattens the ones built so far over a throwaway copy of the build. A clashing file name is
prefixed with its directory rather than silently overwritten, and the conformance prompt
asks for the functionality id in each file name so clashes stay rare.

When the merged suite goes red, a repair agent works in the build directory with the whole
module's specification and the failure, and cannot touch the tests. Every repair changes
the code, so the suite runs again after each one - up to `--max-regression-rounds`
(default 3). Passing on its own is not enough; a functionality is finished when it passes
alongside everything before it.

### Regenerating after a spec change

```bash
npm run regenerate -- <file.plain> 2 --model google/gemini-3.1-pro-preview
```

`regenerate` assumes the code exists and the specification moved. It re-renders that
functionality over the existing build, updates that functionality's conformance tests
against the new specification (the test author is shown its own existing tests and told to
keep the coverage), and then runs **every** functionality's conformance tests - not just
the ones up to this point, because a changed specification can break something built later
just as easily as something built earlier.

It refuses to run when the build directory is empty.

### The whole-suite command

A regression is only a regression if the command runs everything. Left alone, a test agent
narrows to the file it just wrote - which passes while saying nothing about the others, so
the harness picks the command itself: the most recent passing run that looks like a
discovery run (`unittest discover`, `pytest`, `npm test`, `go test ./...`, `mvn test`,
`gradle check`, `cargo test`). When no such run is found it falls back to the last passing
command and prints a warning that the run may cover only part of the suite.

## Conformance tests

`npm run render` builds the code and its unit tests - written by the same agent that
wrote the code. Conformance tests are the other half: black box, end to end, written
from the specification by an agent that has not seen the implementation.

```bash
npm run conformance -- <file.plain> 1
npm run conformance -- <file.plain> 1 --dry-run
```

| Option | |
|---|---|
| `--build-dir <dir>` | the rendered code under test (default `plain_modules/<module>/code`) |
| `--conformance-dir <dir>` | where tests are written (default `plain_modules/<module>/tests`) |
| `--template-dir <dir>` | extra template directory, repeatable |

It refuses to start when the build directory is empty, and says what to run first -
there is nothing to test until the functionality has been rendered.

### Black box in shape, not in blindness

The test author can read the implementation and cannot write to it: its roots are the
code directory for reading and its own `tests/<frid>` directory for writing (see
*Confinement*). It also gets `run_conformance_tests`, which copies the build and the tests
into a throwaway directory, runs a command there, and returns the exit code and output.

The tests stay black box in *shape* - they invoke the built functionality from outside,
through its entry point - and the prompt is explicit about why the code is readable at all:
to find out how the thing is called, never to decide what it should do. Every assertion
comes from the specification, because a test written from the code agrees with the code by
construction and can never catch it being wrong.

That is a weaker guarantee than the tool surface used to give, and deliberately so: tests
written with no idea how to invoke the thing failed for the wrong reasons. What protects
the property now is the prompt and the `code_at_fault` triage below, not the shape of the
tool set.

Each run gets a fresh sandbox, so tests cannot accumulate state between attempts and
nothing they write reaches the build directory.

### When conformance fails, someone has to be wrong

A failing conformance run means the code and the specification disagree - but the test
could equally be the thing that misread the specification. The test author cannot see the
code, so it cannot make that call alone by inspection; it makes it from the specification
and the failure output, through `submit_triage`:

- **`test_at_fault`** - the test asserts something the specification does not require. The
  test author fixes its own test and runs again.
- **`code_at_fault`** - the specification says one thing and the run shows another. The
  failure is handed to a second agent that works in the build directory with
  `read`/`write`/`edit`/`bash` and `run_unit_tests`, and which cannot see or edit the
  conformance tests. It fixes the code, keeps the unit tests green, and the harness then
  re-runs the conformance command itself - so whether the fix worked does not depend on
  either agent's account of it.

That loop runs up to `--max-rounds` times (default 3). The same test-removal challenge
applies here: conformance tests cannot be deleted to get a pass either.

`result.triage`, `result.codeFixes` and `result.testRemovals` record what happened, and
the CLI prints each verdict as it lands.

### Verified

After rendering `hello_world_python` functionality 1, the generated conformance test
invokes the app as a subprocess and asserts on stdout, exit code and elapsed time -
no import of internals:

```python
completed = subprocess.run([sys.executable, str(executable)], capture_output=True, text=True, timeout=1)
self.assertEqual(completed.returncode, 0, msg=completed.stderr)
self.assertLess(elapsed, 1.0, "Application should complete in under 1 second")
self.assertEqual(completed.stdout.strip(), "hello, world")
```

Mutating the implementation to print `goodbye, world` makes it fail, which is the
property that matters - and the triage loop then repairs it. That run, on
`google/gemini-3.1-pro-preview`:

```
conformance tests pass  hello_world_python functionality 1
  runs:      4
  triage:    code_at_fault
  code fixes: 1 (the implementation was changed)
```

The fix agent restored `print("hello, world")`, the harness re-ran the conformance command
itself, and an independent `python3 -m unittest discover` over the merged directory passes.

## Conversing with it

The CLI runs a skill you name. To have an agent decide when a skill applies, load the
extension in `src/extension.ts` - it registers one tool, `run_skill`, whose
description carries the skill catalogue:

```bash
npm run chat                 # interactive TUI
npm run ask -- "I need a changelog entry for the change in examples/sample.diff"
```

The conversational agent keeps ordinary progressive disclosure: it reads the skill
descriptions and decides when one applies. What it does not get is the choice of *how* to
run it. `run_skill` hands the work to the graph, which owns the steps, the gates and the
judges, and returns an artifact that has already passed review. The guidelines registered
with the tool tell the agent to report that artifact rather than rewrite it.

Escalation becomes a real dialog: in the TUI the gate calls `ctx.ui.confirm`. Where no
dialog-capable UI exists (`-p`), there is nobody to ask, so the gate stands and the run
stops.

### Background jobs

Rendering a functionality takes minutes, and a tool's `execute` blocks the agent loop for
as long as it runs - so in a conversation the person cannot say anything until it
finishes. In the interactive TUI the four long tools therefore start the work detached and
return a job id straight away:

```
Started render_module as background job 1dd92ec7: greeter.plain.
It is running now and will report back when it finishes.
```

Two more tools go with them:

| Tool | |
|---|---|
| `check_job` | status, how long it has been running, its latest output, and its report once done. `wait: true` blocks until it settles |
| `list_jobs` | every job this session started, newest first |

When a job settles it announces itself into the transcript through `pi.sendMessage` with
`deliverAs: "nextTurn"` - so the result is waiting at the next thing you say rather than
interrupting what you are in the middle of typing. A listener that throws cannot take the
job down with it; the result is recorded either way and `check_job` still has it.

Every agent a tool spawns runs on **the model the conversation is on**, taken from
`ctx.model` rather than from pi's configured default - so switching model mid-session with
`/model` or Ctrl+P moves the render and conformance agents with it. A `model` parameter
still overrides per call, and the model is named in the job summary and in `list_jobs`, so
you can see what built what. A job keeps the model it started with.

Background only makes sense where the session outlives the turn. In `print`, `json` and
`rpc` modes the process ends as soon as the answer is written, taking any detached work
with it, so those wait by default. `wait: true` or `wait: false` on any of the four tools
overrides the default either way.

Jobs live in memory for the session - there is no resuming one after pi exits. The work
itself is on disk, so a killed job leaves a partial build rather than nothing.

`run_skill` is unchanged and still blocks; only the render tools were moved.

### Project trust

Pi will not auto-discover a project-local extension until you trust the project, and
`-p` has no way to ask. Both scripts above therefore pass `-e` explicitly, which always
works. Once you have run `pi` interactively in this directory and accepted the trust
prompt, plain `pi` picks the extension up on its own. A `defaultProjectTrust` key in
`.pi/settings.json` does *not* work - a project cannot vouch for itself; that setting
only counts in `~/.pi/agent/settings.json`.

Without the extension the agent still reaches the right answer - by running the CLI
through `bash`. That is worth knowing, because it looks identical from outside and
skips nothing, but it only works because the CLI happens to be here.

## Testing it

```bash
npx tsc --noEmit    # types
npm test            # 138 tests
```

The gate machinery itself - the no-artifact rejection, the retry loop, escalation to a
human - has no automated coverage. It was verified against two throwaway fixture skills
that have since been removed, so re-checking those paths now means a live run of a real
skill.

To poke at the gate semantics, edit the frontmatter of `skills/forge-plain/SKILL.md`:

| Change | Expected |
|---|---|
| `max_retries: 0` | first failure escalates instead of retrying |
| `on_fail: abort` | first failure ends the run, exit 1 |
| `quorum: any` | one passing judge is enough |
| `judges: 3` | three sessions run concurrently |
| `model: google/gemini-3-pro` | judges run on another provider; unconfigured models fall back with a note |
| `after: drafts` | rejected at load: `gate references unknown step 'drafts'` |

## Layout

| Path | What it is |
|---|---|
| `src/skill.ts` | Parses `SKILL.md` into steps + gates |
| `src/graph.ts` | Compiles a skill into a `StateGraph`: step -> gate -> route |
| `src/judge.ts` | Runs N independent judges, applies quorum, builds the critique |
| `src/pi.ts` | Pi session factories: one executor, one throwaway session per judge |
| `src/tools.ts` | Personal tools: `write_artifact`, `submit_verdict` |
| `src/forge.ts` | `runSkill()` - the one entry point the CLI and the extension share |
| `src/run.ts` | CLI: trace output and the human-review prompt |
| `src/render/` | one functionality to code: prompt, linked resources, session |
| `src/render-frid.ts` | CLI: `npm run render` |
| `src/render/conformance.ts` | black-box conformance tests + the run sandbox |
| `src/conformance-frid.ts` | CLI: `npm run conformance` |
| `src/render/module.ts` | whole-module build, the regression gate, regeneration |
| `src/render-module.ts` | CLI: `npm run module` |
| `src/regenerate-frid.ts` | CLI: `npm run regenerate` |
| `src/render/jobs.ts` | background job registry for conversation mode |
| `src/extension.ts` | Pi extension: every tool the conversation can call |

## Demo trace

The rubric is strict enough that the first draft usually fails, which is the point:

```
> step draft  attempt 1
  | Expired cached tokens are now ignored and removed instead of being returned.
> gate draft  2 independent judges
  judge 1: fail (2)
  judge 2: fail (2)
  retry <- gate draft
    - [starts with Fixed:/Added:/Changed:] ...
    - [names the source file that changed] ...

> step draft  attempt 2
  | Fixed: src/cache.ts now ignores and removes expired cached tokens instead of returning them.
> gate draft  2 independent judges
  judge 1: pass
  judge 2: pass
  advance <- gate draft

> step finalize  attempt 1
  | ## Unreleased
  | - Fixed: src/cache.ts now ignores and removes expired cached tokens instead of returning them.

run complete
```

## Known edges

- Judges default to the executor's model. Real separation wants a different provider -
  set `model:` on the gate. Unconfigured models fall back to the executor's with a note
  rather than failing the run.
- The executor keeps one session across steps and retries, so context grows with attempts.
  Long skills want compaction or a session per step.
- `MemorySaver` is in-process: an escalation must be answered in the same run.
