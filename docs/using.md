# Using turri

## In a conversation

```bash
cd ~/my-project
turri
```

That is pi, with turri's tools, skills and themes loaded - `turri` alone, or with pi's options
(`turri -c`, `turri --harness-model <m>`); `turri chat`, its old name, still opens it. It opens with turri's own
banner - the jellyfish it is named after, swimming until the conversation fills the screen: a picture in a
terminal that shows images (Kitty, Ghostty, WezTerm, Warp, iTerm2), and drawn in text in any other, tmux
included - swimming a stroke a loop, its tentacles following its bell, frames `scripts/jellyfish-frames.mjs`
writes -
where commands will run, the rules and skills loaded - rather than pi's startup header
and resource list; `turri --verbose` shows those too. Talk to it: ask it to start a
project, add a feature, render a module, fix a spec. It decides which skill or tool applies - but
not *how* a skill runs: `cultivate` hands the work to the gated runner, which owns the steps, the
gates and the judges (see [skills and gates](skills-and-gates.md)).

The skills that build from scratch:

| skill | how it works |
| --- | --- |
| `brood` | intent, stack, then testing - conformance tests on or off (into `config.yaml`), their `***test reqs***` and the conformance testing script, which build nothing - then the product feature by feature, where every answer becomes one spec change - a git diff of the `.plain` files, written with `write_spec_diff` and rendered as a render spec diff pulse the moment it is written, with its conformance tests when they are on |
| `spawn` | its quick twin: asks only what you want to build and confirms a five-line brief, then chooses the stack and the unit tests itself - conformance tests off, unless you ask for them - and writes the product feature by feature on its own, each feature a spec diff queued as it is written - after which you keep talking, and every change you ask for is a spec diff, and what is left to build is worked out again from the spec |
| `mature` | for a spec you already have, rough or hand-written: on its own until it is fully rendered - renders what is not built, watches the agents building it, and when one struggles on something the spec leaves open, settles it in the spec as a spec diff, stops that build and renders it again; decides open choices itself and marks them in its report |

`genome/skills/` holds the rest: adding a feature, a concept, a requirement, a resource; splitting a spec
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
| `bind` | bind functional specs to conformance tests - now, or ahead of their code: every one tested in one conformance pulse, as far as a size guardrail lets (or one a functional spec, when you ask for that), started once every one named is grown; whatever the config says |
| `rejuvenate` | grow again what is grown: functional specs named grow again though their spec did not change - rewritten or started over, planned into pulses as any change is, those next to each other together; with none named, a codebase grown without a module it now requires starts over from the bottom of its chain - only once you agree |
| `validate` | validate a spec, growing nothing |
| `engine` | show or choose the model the code grows on - see [below](#choosing-a-model) |
| `growth` | the pulses - running, planned and finished - or one of them |
| `halt` | halt a pulse, or what `activate` started |
| `diagnose` | why a pulse did not land, from its transcript: how it ended, the stages that went wrong, the last failing test run, the last review, the tool calls that failed |
| `lineage` | a module's lineage: what each regrowth and conformance run changed in it, and what it grew from |
| `cultivate` | run a gated skill, its steps and review gates enforced |
| `release`, `activate` | try what is grown: release it to `dist/<module>` and activate it on this machine, installing what it needs - see [deploy](deploy.md) |
| `ask_user` | put a question to you as a dialog to pick from - several at once, or "Something else…" to type |
| `web_search`, `web_fetch` | search the web and read a page as text - documentation, an API, an error; `curl` and the like run in its `bash` |

What each render does, in order, is in [growing the code](growing.md).

The conversation knows the ***plain standard library from its first turn: the stdlib rule in its
system prompt lists every stack and where the templates are, so "build this as a Flask backend"
becomes an import of `stdlib/backend/python-flask`, not a stack written out by hand. The banner at
start says how many stacks there are, and **`/stdlib`** lists them, each with what it is (see
[the standard library](authoring-plain.md#the-standard-library)).

The agent does this work with these tools, never by running turri's command line - or
another pi - through its shell: that would be a separate, headless run outside the regeneration
and `/halt`. The harness refuses such a command unless your message asks for the
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
that share nothing run side by side, each with its own progress panel - two
modules or ten. How many run at once is capped by what the machine has room for: past
`parallel-jobs` (see [the project config](config.md#how-many-jobs-at-once)), a pulse whose turn has
come waits for a free slot, and says so.

- **The panel** above the input, while something runs, shows each running pulse - its module, time and
  cost, and what its agents are doing - and what finished, newest first, its mark green, red or amber as
  in the side panel, in one line. `ctrl+o` expands the agents' trace alone; what finished stays counted.
  What waits is not in it, and it shows no spec diff - the side panel has both. With nothing running it
  is gone.
- **A pulse's change** is what its agent works from, not a text diff of the module's file: the items
  `<spec change>` gives the agent - only what the pulse's functional specs use, an import's items as
  well as the module's own, a code pulse's without the test reqs - each in the file it is written in,
  under its section, in the file's order (`change-view.ts`).
- **A spec diff**, in the side panel, reads as an editor shows a diff: its \*\*\*plain highlighted
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
  as GitHub names a hunk's function: each section is named once.
- **The side panel** (`ctrl+h`, as it was left; **`/regeneration`** on the regeneration - `/regen` for short, `/growth` too - **`/pulses`** on the pulses; not `ctrl+j`, which a terminal without the Kitty
  keyboard protocol sends as a line feed, the same as `shift+enter`, and which a dialog takes for
  `enter`; both stay pi's new-line keys. `ctrl+h` is the byte old terminals sent for backspace; a
  terminal set to send `^H` for its Backspace key would open the panel on it) takes the whole screen - the panel or the chat, one at a time.
  It opens on the **regeneration**: the spec itself, in full, with how far the code has grown into it drawn
  onto it.

  Every item of the spec - a definition, a req, a functional spec with its sub-bullets and acceptance tests,
  what turri plans and diffs by - is a row in the file's order, its \*\*\*plain highlighted as plyn highlights it
  (as a spec diff is), and has one mark in the gutter:

  | Mark | Means |
  | --- | --- |
  | `✓` | built: the code record has it as the spec does |
  | `⠋` | growing now, in the running pulse |
  | `4` | planned, in that pulse - dimmer than the one growing: the numbers move whenever the plan is made again |
  | `·` | differs from the code, with no plan behind it - the top line says why |
  | `…` | the planner is cutting it into pulses now |
  | `!` | stuck: in the pulse that did not land and halted the module ("rolled back · was pulse 3"), or the planner found no plan |
  | `−` | taken out of the spec, still in the code: a struck-through red ghost, with the code record's text, until the pulse that takes it out lands |

  Pulses are numbered as they start in a module, from 1 each session; a halt names the one that did not
  land. The column beside the mark is `⊨` - satisfies - in brand blue when the functional spec is conformance tested as it
  reads now: more than tested, its code is shown end to end to do what the spec says. It is dimmed when the
  conformance tests were written for an earlier text, struck through for a spec taken out, a spinner while
  a conformance pulse writes them, and - as beside the mark - the number of the conformance pulse planned to write
  them, dimmed: scheduled ahead of the code by `bind` too. Under `conformance-tests: chosen` a functional spec not chosen has none, and
  shows none. Test reqs are shown only where conformance tests are on - `conformance-tests:` is not `false`, or
  `bind` turned them on this session. A test req is the conformance tests', never built into the code, so its
  mark is theirs:
  `✓` once the conformance tests follow it as it reads now, a spinner while a conformance pulse writes them
  for it, that pulse's number while it is planned, `·` until then - and none where no conformance test is
  written at all.

  A changed item shows what changed in it: its first line word by word - what is gone struck through in red,
  what is new in green, what is kept highlighted as it reads now - and, under it, only the sub-bullets that changed. A spec never built that is taken
  out is simply gone. The top line has the file, a strip of its functional specs - built, growing, planned,
  waiting - and how many are built, then what is happening: `pulse 3 of 8 growing`, or why nothing is -
  `not asked to build - regrow plans it` (turri was just opened, or nothing has asked for the module: the
  plan lives in memory and is made again on the next regrow), `planning`, `waits for backend`, and in red
  `halted - pulse 3 didn't land` or `the planner couldn't cut it into pulses`. `enter` opens an item: all of
  its text against the code's and its acceptance tests - and, when nothing grows it yet, why not.

  Each module mapped is a row of its own, `▾ backend.plain ████░░ 5/12 built · pulse 3 of 8 growing`, with
  its items under it. Only the module in focus starts open - the one growing now, else the one asked for, else
  the first - the rest closed until opened; the top line is the module the cursor is in. Under a module opened,
  after its own text, is what it is built from, in two groups, each closed until opened: **imported** - a
  folded block a file it imports, `▸ from stdlib/backend/python-fastapi · 7 reqs · all built` - and
  **required** - the modules it requires, down its chain, nearest first, each a module row of its own, read from
  the codebase built on it, whose record has every module's items. A module another one requires is shown
  there, under it, not at the top. A map longer than the screen has a minimap down its right edge, a cell a slice in the colour of
  its most pressing mark, the slice shown solid. The map is read from the files - the code record, the
  `.plain` files, the tests record - so it is right the moment turri opens a project, before anything runs;
  the work loop's plan adds the pulses on top. It maps the files asked to build this conversation, else
  `module:` in `config.yaml`, else the `.plain` files of the folder that no other one there imports or
  requires. `↑` `↓` move row by row, `enter` or `space` open and close a module, an item or an import block,
  `→` `←` open and close it (`←` on a closed one goes up to its module), `o` and `c` open or close everything
  shown, `pgup` `pgdn` and the
  wheel scroll, `g`/`G` go to the top and the bottom.

  `p` goes to the **pulses** - and back - onto the pulse that grows the item under the cursor, and
  back onto the first item the pulse under the cursor grows. The pulses are every pulse as three sections - running, queued, finished - each opened and closed on
  its own (running and queued start open). A pulse is one line: its module and kind (`hubspot regrow`, `hubspot bind`), its time and its cost - a
  finished one's mark green when it passed, red when it failed or did not pass, amber when it was stopped.
  Opened, a running one shows what it is doing; a queued one, what it waits for; a finished one, its agents
  and what each spent, and whether it did not pass. Under it is a row
  for each file its spec diff changes - the file of the module being rendered first and open, the rest by
  name and closed - each opening onto that file's lines. A file with nothing added or taken out is not
  listed. `↑` `↓` move, `enter` or `space` open and close what is under the cursor, `→` `←` open and close
  (`←` on a closed pulse goes to its section, on a closed file to its pulse), `o` and `c` open or close every
  pulse of the section - or, on a file, every file of its pulse - `pgup` `pgdn` and the wheel scroll, `g`/`G`
  go to the top and the bottom. The cursor stays on its row when the pulse under it moves on; a pulse opened
  closes when it moves to another section. What is open is kept while the panel is closed. What the agents
  said and did is not shown - it is in each pulse's log (see [Agent logs](#agent-logs)).

  `ctrl+h` again, or `esc`, closes it and goes back to the chat. While it shows, every key is the panel's,
  whatever else happens: a question the chat model asks in the background (`ask_user`) waits in the chat,
  unanswered - an `enter` in the panel never answers it - and the panel's top line says "the chat is waiting
  for your answer". Back in the chat, the question is there, with the keys.
- `turri` runs pi in fullscreen mode, so the conversation stays where you scroll it while
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
`harness-model` is what `turri` starts on. What you ask for in the conversation wins.
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

On the command line, `turri --harness-model <m> --coding-model <m>` wins over them
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

When an agent does something you cannot explain, its logs are where to look: the chat shows what
its pulse is doing, not what its agents said. Every agent a render starts - the
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
`tail -f` follows an agent live and a run that crashed leaves its log up to that moment. The pulse's
own log names each agent's log as it starts.

Beside them, each pulse has a log of its own in `.turri/jobs/` - `<time>-<pulse id>-<kind>.log`:
its whole transcript, written as it happens. The harness's stages, the functional spec or the
diff it builds, and every one of its agents in turn - each prompt, its thinking and replies, every
tool call and its result, whole where the screen clips them - and how the pulse ended. A finished pulse,
opened in the side panel, names it. It is the one to read for a pulse as a whole; an agent's own log has its system
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
turri cultivate genome/skills/brood     # run a gated skill directly
turri release <file.plain>             # release what is grown to dist/<module>, and activate it here
```

The commands' names before turri had its name - `module`, `regenerate`, `conformance`, `check`, `deploy`,
`skill` - still run them.

The ones that build take `--model provider/model-id`; `module` also takes `--build-dir` and
`--dry-run`, which plans the work, prints the prompt of each codebase's first pulse and starts nothing.
Template directories come from `PLAIN_TEMPLATE_DIRS`. `--help`
on any of them lists the rest. The bin is
`turri`, not `forge`: `forge` is already Foundry's.
