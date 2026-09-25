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
| `forge-plain` | intent, stack, then the product feature by feature, where every answer becomes one spec change - a git diff of the `.plain` files, written with `write_spec_diff` and rendered as a render spec diff job the moment it is written - then testing: conformance tests on or off (into `config.yaml`), their `***test reqs***` and the conformance testing script, which build nothing, and conformance tests for the functional specs you pick |

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
| `render_conformance_tests` | write and run black-box tests for a functionality |
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
returns straight away. The conversation carries on; jobs on the same module queue behind each
other, jobs on different modules run side by side.

- **The panel** above the input shows each running job - its stage, what its agents are doing,
  its model, time and cost - and the queue. `ctrl+o` expands it.
- **`/watch`** opens a job's full transcript - every prompt, reply, thought and tool call - on a
  screen of its own. `q` goes back to the chat and keeps your place; `alt+w` or `/watch` switches
  back. `g`/`G` jump to the top and bottom, `x` closes it.
- **`/jobs`** lists every job, **`/stop <id>`** stops one - a queued one never starts.
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

## Choosing a model

There are two: the **harness model**, the one you chat with, and the **coding model**, the one
every render runs on - functionalities, conformance tests, repairs, spec changes. The project's
`config.yaml` can give both defaults:

```yaml
harness-model: anthropic/claude-opus-5-5
coding-model: amazon-bedrock/eu.anthropic.claude-sonnet-5
```

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
stopped or restarted mid-job, whatever that job left half-written is undone first. Installed
dependencies and caches are not in the history and stay. With git directly:

```bash
git --git-dir=plain_modules/<module>/.plaingit --work-tree=plain_modules/<module> log
```

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
