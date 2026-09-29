# Using plainwright

## In a conversation

```bash
cd ~/my-project
plainwright chat
```

That is pi, with plainwright's tools, skills and themes loaded. It opens with plainwright's own
banner - where commands will run, the rules and skills loaded - rather than pi's startup header
and resource list; `plainwright chat --verbose` shows those too. Talk to it: ask it to start a
project, add a feature, render a module, fix a spec. It decides which skill or tool applies - but
not *how* a skill runs: `run_skill` hands the work to the gated runner, which owns the steps, the
gates and the judges (see [skills and gates](skills-and-gates.md)).

The skills that build from scratch:

| skill | how it works |
| --- | --- |
| `forge-plain` | intent, stack, then testing - conformance tests on or off (into `config.yaml`), their `***test reqs***` and the conformance testing script, which build nothing - then the product feature by feature, where every answer becomes one spec change - a git diff of the `.plain` files, written with `write_spec_diff` and rendered as a render spec diff job the moment it is written, with its conformance tests when they are on |
| `spark-plain` | its quick twin: asks only what you want to build and confirms a five-line brief, then chooses the stack and the unit tests itself - conformance tests off, unless you ask for them - and writes the product feature by feature on its own, each feature a spec diff queued as it is written - after which you keep talking, and every change you ask for is a spec diff the queue master works into the builds still queued |
| `temper-plain` | for a spec you already have, rough or hand-written: on its own until it is fully rendered - renders what is not built, watches the agents building it, and when one struggles on something the spec leaves open, settles it in the spec as a spec diff, stops that build and renders it again; decides open choices itself and marks them in its report |

`skills/` holds the rest: adding a feature, a concept, a requirement, a resource; splitting a spec
that is too big; resolving conflicts; checking the environment - see
[authoring \*\*\*plain](authoring-plain.md#the-skills). A skill run that is interrupted can be resumed
where it stopped.

## The tools

| tool | |
| --- | --- |
| `render_functionality` | build one functionality - code and unit tests - then keep the existing conformance tests passing |
| `render_module` | build every functionality in order, each advancing only when every conformance test so far passes |
| `regenerate_functionality` | rebuild just one functionality - after its spec changed, or as it is |
| `render_spec_diff` | make the code match a change to the specs, given as a git diff |
| `render_functionality_conformance` | write and run black-box tests for a functionality |
| `render_spec_diff_conformance` | bring the conformance tests in line with a change to the specs, given as a git diff |
| `check_plain` | validate a spec without rendering |
| `set_render_model` | choose the model renders run on - see [below](#choosing-a-model) |
| `ask_user` | put a question to you as a dialog to pick from - several at once, or "Something else…" to type |
| `web_search`, `web_fetch` | search the web and read a page as text - documentation, an API, an error; `curl` and the like run in its `bash` |
| `check_job`, `list_jobs`, `stop_job` | the background jobs |
| `module_history` | what each render, regeneration and conformance run changed in a module |

What each render does, in order, is in [rendering](rendering.md).

The agent does this work with these tools, never by running plainwright's command line - or
another pi - through its shell: that would be a separate, headless run outside the job panel,
`/watch` and `/stop`. The harness refuses such a command unless your message asks for the
command line ("run it headless", "use the CLI", or the command itself). pi configuring itself -
`pi install`, `update`, `list`, `config`, `auth`, its settings - is not affected.

## Background jobs

A render takes minutes, so in the TUI every render tool starts the work as a background job and
returns straight away. The conversation carries on; jobs on the same module - or on modules of one
`requires` chain - queue behind each other, in the order they were asked for, and jobs on modules
that share nothing run side by side, each module in its own VM, with its own progress panel - two
modules or ten. How many run at once is capped by what the machine has room for: past
`parallel-jobs` (see [the project config](config.md#how-many-jobs-at-once)), a job whose turn has
come waits for a free slot, and says so.

- **The panel** above the input shows each running job - its stage, what its agents are doing,
  its model, time and cost - and the queue. `ctrl+o` expands it.
- **The side panel** (`ctrl+j`, which in plainwright replaces pi's own new-line key - `shift+enter` still
  inserts one; pi outside plainwright keeps it, and a `tui.input.newLine` of your own in
  `~/.pi/agent/keybindings.json` is kept as you set it) opens on the right, beside the chat, with three views - `tab`
  switches between them:
  - **Jobs** - the whole queue: what runs, what waits and on what, what finished, with time and cost;
  - **Try it** - how to try what a job built, as the harness checked it, once its tests pass;
  - **Trace** - a job's agents at work: every prompt, reply, thought and tool call, each agent's
    turn headed by who it is and the model it runs on. `a` follows one agent at a time, `j` switches
    job.

  It scrolls with the arrows, PgUp/PgDn and the wheel, and follows the newest line at the bottom
  (`g`/`G` top and bottom). `esc` goes back to the chat and leaves it open and live; `ctrl+j` takes
  the keys back to it, and closes it from there. **`/watch [job]`** opens it on a job's trace.
- `plainwright chat` runs pi in fullscreen mode, so the conversation stays where you scroll it while
  the jobs redraw (PgUp/PgDn, the wheel); `--tui-mode regular` goes back to the terminal's own
  scrollback.
- **`/jobs`** lists every job, **`/stop <id>`** stops one - a queued one never starts.
- **A change that renders nothing** - definitions moved to a common module, specs moved between
  modules - is recorded, not rendered: the job says "spec restructured - nothing to render".
  Specs moved into a module the code was not built on start a rebuild instead: that module, then
  the codebase from scratch on it. A change to two modules of a chain, the upper one not built
  yet, is split into a spec diff per codebase, bottom first.
- **Spec diffs that overlap** are reworked as each one is queued: the queue master merges, drops,
  reorders or rewrites the waiting ones so they render only what is left of them - a change that
  undoes a queued one takes that job out - and always end on the spec as it is in the `.plain` file.
  It may ask you when it is not sure. A job it takes out says so in the Jobs view. To drop something
  already queued, ask for it to be taken out of the spec - one spec diff - and the queue master
  takes it out of the queued jobs; to reorder or merge them, ask, and the chat uses `rework_queue`.
  Stopping a queued spec diff leaves its change in the spec: the next one renders it.
- **A job that fails** - its work errors, or it does not pass - is run once more. Failing again, it
  stops, and so does every job queued behind it on the same module, without running - the other
  modules' jobs go on. The harness then works out why: an
  agent that can read the project's specs, code, tests, testing scripts and logs, and plainwright's
  own source, skills and rules, says what happened, why, whether the fix belongs in the spec, the
  environment, the code or plainwright itself, and exactly what to do.
- **When a job finishes** it says what was built and how to try it, in a few numbered steps: what
  to run or do, and what you should see. Every command was run first, in a fresh copy - servers
  included - and carries a ✓ when it worked.
- **When a job stops** - a gate still failing after 20 attempts - it says where it stopped, why in
  plain words, and what to change in the spec - which section, and how.
  Running the same build again picks up from there.

In `print`, `json` and `rpc` modes the process ends when the answer is written, so the tools wait
for the work there instead. Jobs live in memory for the session; the work itself is on disk.

## The project's config.yaml

The chat reads the project's `config.yaml` afresh every turn and follows it: its agent is told what
it sets, and the render tools default to it - `module` when you ask to build without naming one,
`conformance-tests: false` to render without conformance tests (none written, none of the existing
ones run) unless you ask for them, `coding-model` for what renders run on, and the testing scripts.
`harness-model` is what `plainwright chat` starts on. What you ask for in the conversation wins.
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

On the command line, `plainwright chat --harness-model <m> --coding-model <m>` wins over them
(pi's own `--model` works for the harness model too), and in the conversation pi's `/model`
changes the harness model and `set_render_model`, below, the coding model. `model:`, from before
there were two, is read as `coding-model`. With neither, renders run on the conversation's model.

Every render runs on the coding model unless you say otherwise. Say it in words -
"render spec changes with gpt 5.5", "build the functionalities on Gemini 3.6 Flash", "use Claude
for everything" - and the agent calls `set_render_model`, which holds for the rest of the session
(a resumed one too):

| kind of work | covers |
| --- | --- |
| spec changes | render spec diff jobs, including the ones forge-plain queues as you answer |
| functionalities | render functionality, render module, regenerate, conformance |
| everything | both |

It works mid-interview as well: the skill's agent has the same tool. Jobs already queued keep the
model they were queued with; `"chat"` drops the session's choice, back to the default coding model -
`--coding-model`, `config.yaml`, or the conversation's. `/render-model` shows
what each kind of work runs on. A render tool can also be given a model for one call.

Names are resolved strictly, because pi's own matching guesses and says nothing ("gpt-5" can land
on a Bedrock model you have no key for). An exact `provider/model-id` is taken as it is. A looser
name is taken when it fits exactly one model you have credentials for, or is exactly one model's
id in other words ("gpt 5.5" is `openai/gpt-5.5`, not `gpt-5.5-pro`). Anything else comes back as
a short list and the agent asks you which one; a model whose provider has no credentials is never
picked.

A provider a pi extension registers - your company's own LLM gateway, say - works for every agent
the conversation starts, not only for the conversation. Those agents load no extensions (they would
load a second copy of plainwright), so each is given the providers the conversation's extensions
registered, as they are when it starts. An unattended run - `plainwright module`, `render` and the
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
changes the module - a render, a regeneration, a conformance run, a regression repair, a spec
change. `/history [module]` and `module_history` show it.

The last commit is also the last known good state. Every render, regeneration, spec change and
conformance run starts by putting the codebase it works in back to it, so if plainwright was
stopped or restarted mid-job, whatever that job left half-written is undone first - and one that
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

The logs are in `.plainwright/debug/` in the project, beside `plain_modules`, one per agent, named
by when it started and what it is: `2026-09-26T13-45-02-123Z-app-3-coding-agent.log`. Each starts
with the job it runs for, its model and thinking level, its folder, its saved pi session, its
tools and its system prompt, and then has, in order and stamped with the time: every prompt it is
sent, whole; its thinking and replies as they stream; every tool call with its arguments, numbered
- `→ #3 bash` - and its whole result under the same number, `← #3 bash done`, since calls made
together run at once and finish in any order; a tool call a response was cut off in, marked as
never run; each response's stop reason, tokens and cost; the provider's
retries and errors; and how each turn ended. Every line is on disk as it happens, so
`tail -f` follows an agent live and a run that crashed leaves its log up to that moment. The job
panel names each agent's log as it starts.

Beside them, each job has a log of its own in `.plainwright/jobs/` - `<time>-<job id>-<kind>.log`:
what `/watch` shows for it, written as it happens. The harness's stages, the functional spec or the
diff it builds, and every one of its agents in turn - each prompt, its thinking and replies, every
tool call and its result, whole where the screen clips them - and how the job ended. The panel names
it when the job starts. It is the one to read for a job as a whole; an agent's own log has its system
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
plainwright check <file.plain>              # validate a spec - no model, no API key
plainwright render <file.plain> --list      # the functionality ids
plainwright render <file.plain> 1           # build functionality 1
plainwright module <file.plain>             # build every functionality
plainwright regenerate <file.plain> 2       # rebuild after its spec changed
plainwright conformance <file.plain> 1      # black-box tests for functionality 1
plainwright skill skills/forge-plain        # run a gated skill directly
```

Each takes `--model provider/model-id`, `--build-dir` and `--template-dir` (repeatable); `render`
and `conformance` also take `--dry-run`, which prints the prompt and starts nothing. `--help`
on any of them lists the rest. The bin is
`plainwright`, not `forge`: `forge` is already Foundry's.
