# Using turri

## In a conversation

```bash
cd ~/my-project
turri chat
```

That is pi, with turri's tools, skills and themes loaded. It opens with turri's own
banner - the jellyfish it is named after, swimming until the conversation fills the screen: a picture in a
terminal that shows images (Kitty, Ghostty, WezTerm, Warp, iTerm2), and drawn in text in any other, tmux
included - swimming a stroke a loop, its tentacles following its bell, frames `scripts/jellyfish-frames.mjs`
writes -
where commands will run, the rules and skills loaded - rather than pi's startup header
and resource list; `turri chat --verbose` shows those too. Talk to it: ask it to start a
project, add a feature, render a module, fix a spec. It decides which skill or tool applies - but
not *how* a skill runs: `cultivate` hands the work to the gated runner, which owns the steps, the
gates and the judges (see [skills and gates](skills-and-gates.md)).

The skills that build from scratch:

| skill | how it works |
| --- | --- |
| `brood` | intent, stack, then testing - conformance tests on or off (into `config.yaml`), their `***test reqs***` and the conformance testing script, which build nothing - then the product feature by feature, where every answer becomes one spec change - a git diff of the `.plain` files, written with `write_spec_diff` and rendered as a render spec diff pulse the moment it is written, with its conformance tests when they are on |
| `spawn` | its quick twin: asks only what you want to build and confirms a five-line brief, then chooses the stack and the unit tests itself - conformance tests off, unless you ask for them - and writes the product feature by feature on its own, each feature a spec diff queued as it is written - after which you keep talking, and every change you ask for is a spec diff, and what is left to build is worked out again from the spec |
| `mature` | for a spec you already have, rough or hand-written: on its own until it is fully rendered - renders what is not built, watches the agents building it, and when one struggles on something the spec leaves open, settles it in the spec as a spec diff, stops that build and renders it again; decides open choices itself and marks them in its report |

`skills/` holds the rest: adding a feature, a concept, a requirement, a resource; splitting a spec
that is too big; resolving conflicts; checking the environment - see
[authoring \*\*\*plain](authoring-plain.md#the-skills). A skill run that is interrupted can be resumed
where it stopped.

## The tools

| tool | |
| --- | --- |
| `regrow` | regrow a module and its chain from the spec as it is now - after any change to it, by any means: what is left to grow is planned into pulses of one to three functional specs, each with the definitions and reqs it uses, and a pulse growing what the spec no longer wants is stopped |
| `drift` | what is left to grow: how far the code and its conformance tests have drifted from the spec, starting nothing |
| `glimpse` | the pulse a module's codebases would start next, and the whole prompt its coding agent would get - starting nothing |
| `steer` | say how the work is planned - which functional specs go together, what first - for the project or one module, for the session; the next plan follows it, beside what AGENTS.md says under a heading naming the queue |
| `bind` | bind functional specs to conformance tests - now, or ahead of their code: a conformance pulse is scheduled and starts once every one named is grown; whatever the config says |
| `rejuvenate` | grow again what is grown: functional specs named grow again though their spec did not change - rewritten or started over, planned into pulses as any change is, those next to each other together; with none named, a codebase grown without a module it now requires starts over from the bottom of its chain - only once you agree |
| `validate` | validate a spec, growing nothing |
| `engine` | show or choose the model the code grows on - see [below](#choosing-a-model) |
| `growth` | the pulses - running, planned and finished - or one of them |
| `halt` | halt a pulse, or what `activate` started |
| `diagnose` | why a pulse did not land, from its transcript: how it ended, the stages that went wrong, the last failing test run, the last review, the tool calls that failed |
| `lineage` | a module's lineage: what each regrowth and conformance run changed in it, and what it grew from |
| `cultivate` | run a gated skill, its steps and review gates enforced |
| `release`, `activate`, `propose_setup` | try what is grown: release it to `dist/<module>`, activate it on this machine, ask before installing anything - see [deploy](deploy.md) |
| `ask_user` | put a question to you as a dialog to pick from - several at once, or "Something else…" to type |
| `web_search`, `web_fetch` | search the web and read a page as text - documentation, an API, an error; `curl` and the like run in its `bash` |

What each render does, in order, is in [growing the code](growing.md).

The conversation knows the ***plain standard library from its first turn: the stdlib rule in its
system prompt lists every stack and where the templates are, so "build this as a Flask backend"
becomes an import of `stdlib/backend/python-flask`, not a stack written out by hand. The banner at
start says how many stacks there are, and **`/stdlib`** lists them, each with what it is (see
[the standard library](authoring-plain.md#the-standard-library)).

The agent does this work with these tools, never by running turri's command line - or
another pi - through its shell: that would be a separate, headless run outside the regeneration,
`/watch` and `/halt`. The harness refuses such a command unless your message asks for the
command line ("run it headless", "use the CLI", or the command itself). pi configuring itself -
`pi install`, `update`, `list`, `config`, `auth`, its settings - is not affected.

## Pulses

A pulse is one unit of work growing the code. It was called a job, and still is where a name is kept -
`job_id`, `parallel-jobs`, `allow-to-stop-jobs`, `.turri/jobs/` - and in a project's own files written before:
the chat is told the two are the same, so an `AGENTS.md` or a skill that says "job" needs no change.

A render takes minutes, so in the TUI every render tool starts the work as a pulse and
returns straight away. The conversation carries on; pulses on the same module - or on modules of one
`requires` chain - queue behind each other, in the order they were asked for, from the first pulse on:
one queued while the spec is only a scaffold, with no functional specs yet, or while it does not
parse, still holds its module, so nothing on the module runs beside it. Pulses on modules
that share nothing run side by side, each module in its own VM, with its own progress panel - two
modules or ten. How many run at once is capped by what the machine has room for: past
`parallel-jobs` (see [the project config](config.md#how-many-jobs-at-once)), a pulse whose turn has
come waits for a free slot, and says so.

- **The panel** above the input shows each running pulse - its stage, what its agents are doing,
  its model, time and cost - and the queue. `ctrl+o` expands it.
- **A pulse's change** is what its agent works from, not a text diff of the module's file: the items
  `<spec change>` gives the agent - only what the pulse's functional specs use, an import's items as
  well as the module's own, a code pulse's without the test reqs - each in the file it is written in,
  under its section, in the file's order (`change-view.ts`).
- **A spec diff**, wherever a panel shows one, reads as an editor shows a diff: its \*\*\*plain highlighted
  as [plyn](https://github.com/plainlang/plyn) highlights it - section headers, concepts, names in
  backticks, text in quotes, links, the front matter - each added line filled green and each removed one
  red, the text on top, the fill the width of the panel ([colours](theming.md#spec-diffs)). It is shown
  file by file, each file's lines together under its name, with what it adds and takes out - the module
  being rendered first, the rest by name, and none the diff does not change. Each line has its number in
  that file: a spec diff is of the spec as read, with what it imports laid in, so a line is placed in the
  file it is written in - its links read as the parser renders them - and a removed line, in no file now,
  goes with the change it is part of and has no number. A line is never put in a file on a guess: one
  that cannot be placed is listed last, under "not found in the spec's files". Where lines of a file are not in
  the diff, `↕ 28 lines` says how many, as GitHub does - `↑` above the first - and names the section
  the lines under it are in when it is another than the one above, `↕ 28 lines · ***functional specs***`,
  as GitHub names a hunk's function: each section is named once. Opened with `ctrl+o`, the panel wraps
  every line rather than cutting it off.
- **The side panel** (`ctrl+h`, or **`/regeneration`** - `/regen` for short, `/growth` too - not `ctrl+j`, which a terminal without the Kitty
  keyboard protocol sends as a line feed, the same as `shift+enter`, and which a dialog takes for
  `enter`; both stay pi's new-line keys. `ctrl+h` is the byte old terminals sent for backspace; a
  terminal set to send `^H` for its Backspace key would open the panel on it) opens on the right, beside the chat, with two views - `tab`
  switches between them:
  - **Regeneration** - every pulse as three sections - running, queued, finished - each opened and closed on
    its own (running and queued start open). A pulse is one line: what it is and what it changes, with time
    and cost - a running one adds its stage. Opened, it shows what it is doing, running, and under it a row
    for each file its spec diff changes - the file of the module being rendered first and open, the rest by
    name and closed - each opening onto that file's lines. A file with nothing added or taken out is not
    listed. `↑` `↓` move, `enter` or `space` open and close what is under the cursor, `→` `←` open and close
    (`←` on a closed pulse goes to its section, on a closed file to its pulse), `o` and `c` open or close every
    pulse of the section - or, on a file, every file of its pulse - `t`
    opens a pulse's trace, `pgup` `pgdn` and the wheel scroll. The cursor stays on its row when the pulse under
    it moves on; a pulse opened closes when it moves to another section. What is open is kept while the
    panel is closed;
  - **Trace** - a pulse's agents at work: every prompt, reply, thought and tool call, each agent's
    turn headed by who it is and the model it runs on. `a` follows one agent at a time, `j` switches
    pulse.

  It scrolls with the arrows, PgUp/PgDn and the wheel, and follows the newest line at the bottom
  (`g`/`G` top and bottom). `esc` goes back to the chat and leaves it open and live; `ctrl+h` takes
  the keys back to it, and closes it from there. **`/watch [pulse]`** opens it on a pulse's trace.
- `turri chat` runs pi in fullscreen mode, so the conversation stays where you scroll it while
  the pulses redraw (PgUp/PgDn, the wheel); `--tui-mode regular` goes back to the terminal's own
  scrollback.
- **`/halt <id>`** halts a pulse - a queued one never starts - and **`/halt activated <name>`** halts a
  server `activate` started; it lists both when no id is given.
- **Nothing is queued.** What is left to build is worked out from what each codebase is built from
  and the spec as it is now - again whenever a pulse ends or the spec changes - and the first pulse of
  it runs; see [a whole module](growing.md#a-whole-module). Changes that overlap never pile up: the next pulse
  builds the spec as it is. The pulses planned after the one running are listed behind it, as queued,
  and so is each module waiting for the one it is built on - "waits for base" - until it can be planned.
  A change inside what the running pulse grows - a spec it grows reworded or given a sub-bullet, a definition or req it is given, a file they link - steers it: its agent is told, and it lands the spec as it is now there, twice a pulse at most. Otherwise a pulse building something the spec no longer wants is stopped and rolled back - unless `allow-to-stop-jobs: false` in `config.yaml`, which has it land first and the change grown on top. To drop something, take it out of the spec - one spec diff. Stopping a pulse leaves its change
  in the spec: the codebase waits until the spec changes or it is asked for again.
- **A change to a module below** is made in the codebase at the tip of the chain, where its code
  lives; the codebase below is left as it was, and is brought up to its own spec only when a new
  module is to start from it. Specs moved into a module the code was not built on stop the codebase:
  no change to its code brings that module in, so it has to be started over - its code and
  conformance tests taken out, kept in its history, and built again from the bottom of the chain.
  That is never done unasked: the chat asks you, saying why, and `rejuvenate` does it once you agree;
  on the command line `turri regrow` asks at the terminal, and `--rejuvenate` agrees in advance.
- **Conformance tests are a track of their own.** A code pulse lands once its unit tests pass and are
  reviewed. Then, before the next one builds on it, a conformance pulse writes and runs the tests of what it
  built - from the test reqs and acceptance tests - with the whole suite the module inherits, and, where one
  fails, fixes the test or the code, whichever is wrong; what they are written for is recorded in
  `tests/.turri.json`. With `conformance-tests: false` none is written until you ask -
  `bind`, for a module or some of its functional specs. A conformance pulse that does not pass
  is undone whole and halts the conformance tests alone: the code goes on being built.
- **A pulse that fails** - its work errors, or it does not pass - is run once more. Failing again, it
  stops, and so does every pulse queued behind it on the same module, without running - the other
  modules' pulses go on. The harness then works out why: an
  agent that can read the project's specs, code, tests, testing scripts and logs, and turri's
  own source, skills and rules, says what happened, why, whether the fix belongs in the spec, the
  environment, the code or turri itself, and exactly what to do.
- **When a pulse finishes** the transcript shows its line - `✓`, `✗` or `■`, what it was, how long it
  took and what it cost - and the chat, which gets its whole report, reacts then and there, whatever
  else is running or queued, without waiting for you to speak: at once when it is idle, else as soon
  as the reply it is in ends. It does what the project's guidance says to do when a pulse finishes -
  release what was built, say - or tells you what finished and what it means. Ask to try it ("let me
  try it") and the chat releases what is built to `dist/<module>` and starts it on your machine, even
  while other pulses run. See [deploy](deploy.md). The chat reacts to it then and there,
  whatever else is running or queued, without waiting for you to speak - at once when it is idle, else
  as soon as the reply it is in ends: it does what the project's guidance says to do when a pulse
  finishes (release what was built, say), or tells you in a line or two what finished.
- **When a pulse stops** - a gate still failing after 20 attempts - it says where it stopped, why in
  plain words, and what to change in the spec - which section, and how.
  Running the same build again picks up from there.

In `print`, `json` and `rpc` modes the process ends when the answer is written, so the tools wait
for the work there instead. Pulses live in memory for the session; the work itself is on disk.

## The project's config.yaml

The chat reads the project's `config.yaml` afresh every turn and follows it: its agent is told what
it sets, and the render tools default to it - `module` when you ask to build without naming one,
`conformance-tests: false` to render without conformance tests (none written, none of the existing
ones run) unless you ask for them, `coding-model` for what renders run on, and the testing scripts.
`harness-model` is what `turri chat` starts on. What you ask for in the conversation wins.
Every key, what happens without it, and how the models inherit: [the project config](config.md).

A project whose modules are on different stacks gives each its own `config.<module>.yaml` beside
`config.yaml` - `config.backend.yaml`, `config.frontend.yaml` - with its testing scripts, models and
conformance over the project's; the chat is told both, and each render follows its module's. See
[modules on different stacks](config.md#modules-on-different-stacks).

## Choosing a model

There are three: the **harness model**, the one you chat with; the **coding model**, the one
every render runs on - functionalities, conformance tests, repairs, spec changes; and the **judge
model**, which gives the verdicts in a conformance run - the judge, which says whether the code, the
tests or the spec is wrong, and the test review. The project's `config.yaml` can give each a model and
a thinking level (off, minimal, low, medium, high, xhigh, max):

```yaml
harness-model:
  model: anthropic/claude-opus-5-5
  thinking: high
coding-model:
  model: amazon-bedrock/eu.anthropic.claude-sonnet-5
  thinking: medium
judge-model:
  model: anthropic/claude-opus-5-5
```

Each may leave out either part, and a bare string (`coding-model: provider/id`, or
`provider/id:high`) is a model alone. What one leaves out it takes from the one it inherits from:
the judge model from the coding model, the coding model from the harness model - so with only a
harness model, everything runs on it.

On the command line, `turri chat --harness-model <m> --coding-model <m>` wins over them
(pi's own `--model` works for the harness model too), and in the conversation pi's `/model`
changes the harness model and `engine`, below, the coding model. `model:`, from before
there were two, is read as `coding-model`. With neither, renders run on the conversation's model.

Every render runs on the coding model unless you say otherwise. Say it in words -
"render spec changes with gpt 5.5", "build the functionalities on Gemini 3.6 Flash", "use Claude
for everything" - and the agent calls `engine`, which holds for the rest of the session
(a resumed one too):

| kind of work | covers |
| --- | --- |
| spec changes | render spec diff pulses, including the ones `brood` queues as you answer |
| functionalities | render functionality, render module, regenerate, conformance |
| everything | both |

It works mid-interview as well: the skill's agent has the same tool. Pulses already queued keep the
model they were queued with; `"chat"` drops the session's choice, back to the default coding model -
`--coding-model`, `config.yaml`, or the conversation's. `/engine` shows
what each kind of work runs on. A render tool can also be given a model for one call.

Names are resolved strictly, because pi's own matching guesses and says nothing ("gpt-5" can land
on a Bedrock model you have no key for). An exact `provider/model-id` is taken as it is. A looser
name is taken when it fits exactly one model you have credentials for, or is exactly one model's
id in other words ("gpt 5.5" is `openai/gpt-5.5`, not `gpt-5.5-pro`). Anything else comes back as
a short list and the agent asks you which one; a model whose provider has no credentials is never
picked.

A provider a pi extension registers - your company's own LLM gateway, say - works for every agent
the conversation starts, not only for the conversation. Those agents load no extensions (they would
load a second copy of turri), so each is given the providers the conversation's extensions
registered, as they are when it starts. An unattended run - `turri regrow`, `render` and the
rest, outside the chat - has no conversation to take them from: there, only the providers in pi's
own configuration (`~/.pi/agent/models.json` and `auth.json`) are there, so a gateway those runs use
has to be set up in `models.json`.

To change pi's own default, in `~/.pi/agent/settings.json`:

```json
{ "defaultProvider": "google", "defaultModel": "gemini-3.1-pro-preview" }
```

A provider failure - no credits, bad key, rate limit - is raised with the provider's own message,
rather than surfacing as an agent that said nothing.

## Module history

Each `plain_modules/<module>` is a git repository whose git directory is `.plaingit` rather than
`.git`, so it stays plain files to your own repository. A commit is made after every step that
changes the module - a render, a rejuvenation, a conformance run, a regression repair, a spec
change. `/lineage [module]` and `lineage` show it.

The last commit is also the last known good state. Every render, rejuvenation, spec change and
conformance run starts by putting the codebase it works in back to it, so if turri was
stopped or restarted mid-pulse, whatever that pulse left half-written is undone first - and one that
does not pass is undone the same way when it ends, commits and all. Only work that passed is
committed. Installed dependencies and caches are not in the history and stay. With git directly:

```bash
git --git-dir=plain_modules/<module>/.plaingit --work-tree=plain_modules/<module> log
```

## Agent logs

When an agent does something you cannot explain, `/watch` is not always enough: it clips a tool
call's arguments and results, and it is gone when pi exits. So every agent a render starts - the
coding agent, the conformance agent, the repair agent, the spec-steps planner - also streams its
whole conversation to a file of its own, always.

The logs are in `.turri/debug/` in the project, beside `plain_modules`, one per agent, named
by when it started and what it is: `2026-09-26T13-45-02-123Z-app-3-coding-agent.log`. Each starts
with the pulse it runs for, its model and thinking level, its folder, its saved pi session, its
tools and its system prompt, and then has, in order and stamped with the time: every prompt it is
sent, whole; its thinking and replies as they stream; every tool call with its arguments, numbered
- `→ #3 bash` - and its whole result under the same number, `← #3 bash done`, since calls made
together run at once and finish in any order; a tool call a response was cut off in, marked as
never run; each response's stop reason, tokens and cost; the provider's
retries and errors; and how each turn ended. Every line is on disk as it happens, so
`tail -f` follows an agent live and a run that crashed leaves its log up to that moment. The pulse
panel names each agent's log as it starts.

Beside them, each pulse has a log of its own in `.turri/jobs/` - `<time>-<pulse id>-<kind>.log`:
what `/watch` shows for it, written as it happens. The harness's stages, the functional spec or the
diff it builds, and every one of its agents in turn - each prompt, its thinking and replies, every
tool call and its result, whole where the screen clips them - and how the pulse ended. The panel names
it when the pulse starts. It is the one to read for a pulse as a whole; an agent's own log has its system
prompt, tokens and retries besides.

No agent can read the logs: they are outside `plain_modules` - or, for a `--build-dir` outside it,
beside that folder rather than in it. Nothing prunes them either - delete
the folder when you are done with it. A log that cannot be written is given up on without failing
the render.

## From the command line

The same work, without a conversation. Run it from the directory that holds the spec, so its
linked resources resolve the way the parser expects. For a long run - a whole spec overnight - see
[running unattended](headless.md).

```bash
turri validate <file.plain>            # validate a spec - no model, no API key
turri drift <file.plain>               # what is left to grow - no model, starts nothing
turri regrow <file.plain>              # grow what the code is not grown from yet, and what it requires
turri glimpse <file.plain>             # plan it, and print the first job's prompt - starts nothing
turri regrow <file.plain> 2            # grow functionality 2 again, changed or not
turri spec-diff <file.plain> <diff>    # apply a spec diff, and regrow it
turri bind <file.plain> 1              # black-box tests for functionality 1
turri lineage <module>                 # what grew into a module, and when
turri cultivate skills/brood     # run a gated skill directly
turri release <file.plain>             # release what is grown to dist/<module>, and activate it here
```

The commands' names before turri had its name - `module`, `regenerate`, `conformance`, `check`, `deploy`,
`skill` - still run them.

The ones that build take `--model provider/model-id`; `module` also takes `--build-dir` and
`--dry-run`, which plans the work, prints the prompt of each codebase's first pulse and starts nothing.
Template directories come from `PLAIN_TEMPLATE_DIRS`. `--help`
on any of them lists the rest. The bin is
`turri`, not `forge`: `forge` is already Foundry's.
