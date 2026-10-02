# Skills and gates

A skill's review step is normally a paragraph asking the agent to check its own work. Agents talk
their way past paragraphs. turri makes the review an edge in a graph instead: the harness
decides when a gate runs, spawns the judges itself, and branches on a structured verdict. The
model's only job is producing the artifact under review.

pi supplies the agent runtime (sessions, tools, multi-provider models); LangGraph supplies the
control flow. The gate syntax lives in `SKILL.md`, so a gated skill still loads in any
spec-compliant harness - it just runs ungated there.

## The syntax

Under `metadata:`, which the Agent Skills spec reserves for arbitrary key-values:

```yaml
---
name: brood
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

A skill declares its steps with a `## Steps` section whose `###` headings are the steps; without
it the whole skill is one step, which is what most skills are. Steps are never inferred from `###`
headings elsewhere in the body - prose skills are full of those. Each gate becomes a conditional
edge after its step; a single-step skill is gated by naming the skill itself. `brood`
declares gates today.

`paced: false` under `metadata:` lets a skill write spec changes one after another on its own:
`write_spec_diff` otherwise refuses a new change until the user has answered a question since the
last one - one answer, one change, as an interview writes them. `spawn` is unpaced.

A skill gets the tools its `allowed-tools` names, and nothing else: one that names none has none. So
every skill here names its own - the file tools (`read`, `write`, `edit`, `bash`, `ls`, `grep`, `find`)
for the ones that write specs, resources or scripts, only the reading ones for those that analyse
and report, and turri's own (`write_spec_diff` and the ones below) where a skill uses them.

What a run changed is part of its result: every file of the project it added, changed or removed -
its specs, resources, scripts; not the built code - or that it changed none, which is said as such,
so a run that wrote nothing is never reported as done. A skill without gates says it was not
reviewed. A `.plain` file a skill edited with the file tools is not rendered by it: the result says
so, for the conversation to render the change.

A skill that lists `render_spec`, `watch_jobs`, `stop_job`, `spec_status` and `spec_findings` in
`allowed-tools` - as `mature` does - can build what a module's spec holds (functionality by
functionality, or the difference as one spec diff); watch its builds, coming back as soon as one
struggles - sent back four times or more, five setbacks, a spec conflict, a failure run again, over
half an hour - with what it went through; stop one, to render it again from a clarified spec; check
whether a module is fully rendered - built from the spec as it stands, nothing running, its last
builds passing; and read back, numbered and each once, what the builds recorded since the run
started: the assumptions and pitfalls in every codebase's working notes, a failed job's diagnosis, a
spec that contradicts itself.

Each step is told where its skill's files are, so a path it names - `references/intent.md` - and a
skill it says to follow - `implement-unit-testing-script` - are found without searching.

## What the harness enforces, not the model

- **Whether review happens.** The gate is an edge. There is no prompt the executor can write that
  skips it.
- **How many attempts.** `max_retries` is a counter in graph state. The executor is never asked how
  many tries it would like.
- **What "fail" means.** Judges answer through a schema (`submit_verdict`), so the router branches
  on a value. A judge that returns no verdict counts as a fail - silence is not consent.
- **What gets reviewed.** The executor's only write path for the artifact is `write_artifact`,
  pointed at a path the graph chose. A step that produces no artifact fails its gate without
  spending a single judge call.
- **Who is judging.** Each judge is a fresh session given the artifact and the rubric and nothing
  else. It never sees the executor's transcript, because a judge that inherits the actor's
  reasoning inherits its rationalisations.

`on_fail: escalate` (and `retry` once retries are exhausted) pauses the graph on a LangGraph
`interrupt`: in the TUI that is a real confirm dialog; with no UI there is nobody to ask, so the
gate stands and the run stops.

`judge_tools` gives a gate's judges read-only tools, for a rubric that checks what is on disk.
Judges get nothing by default, which is right when the artifact is the whole subject.

A gate can also have a `continuous` reviewer: a read-only agent that re-reads the work after every
change the step makes and puts its findings on the executor's next tool result.

## What a step can do

- **Interview the user.** `ask_user` puts one question to the person. In the TUI it is a dialog;
  from the CLI the options are numbered. Offering choices is required, not optional - a call with
  neither `options` nor `free_form: true` is refused - and every list carries "Something else…".
  `multi_select: true` keeps offering what is left until they are done. The skill's agent talks in a
  session of its own that the person never sees, so what it said since its last question - the
  brief it asks them to confirm, the plan it lays out - is shown above the question in the dialog,
  and kept in the run's trace with the answer.
- **Build while it interviews.** `write_spec_diff` (`brood`, `spawn`) writes a change to the
  spec and queues its render in one call; the interview carries on while the builds run in the
  background, one after another. `render_status` shows the queue. The person sees its calls as
  `mutate`: a tool can be shown by a name of its own (`SHOWN_AS` in `grow/activity.ts`), while its
  agent calls it by the one that says what it takes.
- **Choose the render model**, when the user says so - `engine`, the same tool the
  conversation has.

The harness still owns the sequence. A step chooses what to ask; it does not choose whether the
gate afterwards runs. A run is saved as it goes, so an interrupted one can be resumed where it
stopped.

While a skill runs in the chat, `cultivate`'s output leads with what its agent is doing now: the skill,
its step and how long each has taken, its last few tool calls, and the end of what it is saying,
refreshed every few seconds. pi shows only a running tool's first lines, and a step can take many
minutes without a new line in the trace. The result the conversation gets back keeps the trace
alone.

## Rules

`forge/rules/` holds the \*\*\*plain authoring rules. Every rule, in full, is appended to the system
prompt of the conversation and of the agents that write specs - never of the ones that write code.
The block is byte-identical every time, so it sits inside the cached prefix - but it is ~40k
tokens. The trade is deliberate: a rule the model has to decide to go and read is a rule it can
skip. `src/rules.ts` is where to change it.

## Trying the gate semantics

The gate machinery - the no-artifact rejection, the retry loop, escalation - is verified by live
runs rather than automated tests. To poke at it, edit the frontmatter of
`skills/brood/SKILL.md`:

| change | expected |
| --- | --- |
| `max_retries: 0` | the first failure escalates instead of retrying |
| `on_fail: abort` | the first failure ends the run, exit 1 |
| `quorum: any` | one passing judge is enough |
| `judges: 3` | three sessions run concurrently |
| `model: google/gemini-3-pro` | judges run on another provider; an unconfigured model falls back with a note |
| `after: drafts` | rejected at load: `gate references unknown step 'drafts'` |

A trace, with a rubric strict enough that the first draft fails:

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
```
