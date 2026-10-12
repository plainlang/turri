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
name: draft-spec
description: Drafts a ***plain spec, judged before it is kept.
allowed-tools: [read, write, edit, bash, ls, grep, find]
metadata:
  gates:
    - after: product                      # the ### step this gate guards
      review:
        rubric: ./references/rubric.md
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
edge after its step; a single-step skill is gated by naming the skill itself. None of the skills turri ships
declares a gate today - `brood`'s phases end on the person's confirmation alone - but a project's own skill can.

`paced: false` under `metadata:` lets a skill write spec changes one after another on its own:
`write_spec_diff` otherwise refuses a new change until the user has answered a question since the
last one - one answer, one change, as an interview writes them. `spawn` is unpaced: the tool tells it so, and after
each change to write the next at once, not to carry on with an interview it does not have.

`questioning:` under `metadata:` names the steps the questioning level caps (`src/questioning.ts`) - `brood`'s
`[stack, product]`. When there are any and someone to ask, the harness itself asks the first question of the first
step: how many questions those steps may ask - light (3), medium (5), thorough (10) or best judgement - and tells the
agent the answer beside each step's instructions, with how broad each question is to be: broad at light, a whole area
at once, narrow at thorough, an edge case at a time. Every level covers the same ground, in less or more depth. In a
capped step `ask_user` refuses a question past the cap; the step's closing confirmation, asked with
`confirms_phase: true`, is never counted. `end_questions` ends the step's questions sooner - best judgement's only
end. What the questions leave open, the agent decides itself and says what it chose. The level, and how many
questions each step has asked, are kept in the run's `run.json`, so a resumed run keeps them. A step it does not name,
or a run with nobody to ask, is not capped.

`spec-diff-per-answer:` under `metadata:` names the steps where every answer is a spec change - `brood`'s
`[product]`, at every questioning level. There `ask_user` refuses the next question until the last answer is written
with `write_spec_diff` (a confirmation, or a question dismissed, owes nothing), and `write_spec_diff` no longer waits
for an answer before a change: the agent writes as many as the step needs, those it decides itself included. The
level limits the questions, never the spec changes.

A step ends when its agent's turn does. A turn that ends on a question in the reply would end the step there, half
done, on a question no one reads - the person sees only what `ask_user` asks. So such a step is sent back, twice at
most: to ask with `ask_user` if the question is truly the person's, or, in an unpaced skill, to decide it itself -
then to carry on until the step is done.

`phases:` under `metadata:` says what each step does, in a short line a step by its name - for the person, not
the agent: while the skill runs, the line above the input shows its phases, and under them the one it is in with
its line (`groundwork - the language, frameworks, storage and architecture`). A phase's name alone
says little to someone who has not read the skill. Every skill with more than one step describes each; a line for a
step the skill does not have is an error, as a gate after one is.

A skill gets the tools its `allowed-tools` names, and nothing else: one that names none has none. So
every skill here names its own - the file tools (`read`, `write`, `edit`, `bash`, `ls`, `grep`, `find`)
for the ones that write specs, resources or scripts, only the reading ones for those that analyse
and report, and turri's own (`write_spec_diff` and the ones below) where a skill uses them.

What a run changed is part of its result: every file of the project it added, changed or removed -
its specs, resources, scripts; not the built code - or that it changed none, which is said as such,
so a run that wrote nothing is never reported as done. A skill without gates says it was not
reviewed. A `.plain` file a skill edited with the file tools is not rendered by it: the result says
so, for the conversation to render the change.

A skill acts on the work loop with the conversation's own tools, on the conversation's loop - never
copies of them (`src/loop-tools.ts`). Every skill with the loop has `drift`: what is left to grow, what
is growing, and "Fully grown" once nothing is. One that lists `regenerate` and `halt` in `allowed-tools` -
as `mature` does - can grow what a module's spec holds and halt a pulse, with why. `mature` lists two
tools of its own as well: `watch_jobs` waits for its pulses, coming back as soon as one struggles -
sent back four times or more, five setbacks, a spec conflict, a failure run again, over half an hour -
with what it went through; `spec_findings` reads back, numbered and each once, what the pulses recorded
since the run started: the assumptions and pitfalls in every codebase's working notes, a failed pulse's
diagnosis, a spec that contradicts itself.

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
  session of its own that the person never sees, so what the person must read to answer - the brief
  to confirm, the plan to approve - it passes as `ask_user`'s `context`, shown above the question in
  the dialog; `brood`, `spawn` and `bud` pass their briefs so. The agents are told to keep it to what can be taken in at
  a glance, about fifteen lines; one longer scrolls in a window of its own above the question (`src/question-dialog.ts`) -
  PgUp/PgDn, Shift+Up/Down or the mouse wheel - so the question and its options always show below it. pi's own select,
  which turri used before, put it all in its title, and a long brief pushed the options off the screen. Nothing else it wrote is shown there:
  the last thing it said before asking - its account of a probe, a regeneration - is kept with the answer,
  in the run's trace and the transcript, never in the dialog.

  Beside "Something else…", every list an agent's question shows carries "Chat about this": the person says what they
  want to talk over - why it is asked, what an option means for later - and it goes back to the agent that asked, as no
  answer. A skill's agent answers in the `context` of the question asked again, since nothing else it writes reaches
  them; the conversation's agent answers in its reply and ends its turn, the person going on in the chat. It is not
  counted against the questioning level, and owes no spec change. The harness's own first question - how many the
  phases may ask - has no agent to answer, and does not offer it. Either choice is backed out of with Esc, or by typing
  nothing: the options come back, so one picked by accident costs nothing. Esc on the options themselves dismisses the
  question.
- **Be asked something on the side.** A skill runs inside one `cultivate` call, so the conversation can answer
  nothing until it returns. `/btw <question>` (`btw.ts`) can: pi runs a command at once, even mid-turn, and it starts
  an agent of its own - fresh, on the chat's model, reading the project and turri and changing nothing - shown the
  conversation, the running skill's trace and the end of its agent's session, and the pulses. Its answer goes in the
  transcript as an entry, in no model's context: the conversation and the skill go on as if nothing was asked. While
  a question of the skill's has the keys, `/btw <question>` typed as the answer (under "Something else…") is the
  same: answered, and the question asked again with the answer above it - the skill's agent never sees it.
- **Build while it interviews.** `write_spec_diff` (`brood`, `spawn`) writes a change to the
  spec and queues its render in one call; the interview carries on while the builds run in the
  background, one after another. `drift` shows how they stand. The person sees its calls as
  `mutate`: a tool can be shown by a name of its own (`SHOWN_AS` in `grow/activity.ts`), while its
  agent calls it by the one that says what it takes.
- **Grow, and bind conformance tests.** A skill that names them in `allowed-tools` gets the conversation's own
  `regenerate`, `drift`, `halt` and `bind`, on its loop: `bind` schedules a conformance pulse for functional specs not built
  yet, as it does from the chat. The skill never waits for them.
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

## A project's own skills

A project can have skills of its own, in the same format: a folder a skill, with its `SKILL.md` - steps, gates,
rubrics in its `references/` - in `.turri/skills/` or `.agents/skills/` of the project's folder (`src/skills.ts`).
turri finds them as it starts, beside its own, and `cultivate` lists each as the project's, with where it is; `turri
cultivate <name>` runs one by name, as it does turri's own. They are run as turri's own are: the harness owns their
steps and gates, and their agents get the tools their frontmatter names.

A name is one skill. turri's own come first, then `.turri/skills/`, then `.agents/skills/`; a skill whose name is taken
already is left out, and the list says so - a project's `brood` never quietly stands in for turri's. A
skill that does not parse is said to have failed to load, by its folder.

`.turri/` is turri's scratch folder and ignores itself, all but `skills/`: its `.gitignore` is `*`, `!skills/`,
`!skills/**`, and one written before is brought up to date. pi reads `.agents/skills/` too, as skills of its own the
chat could follow by hand - the chat is told to run any `cultivate` lists with `cultivate`, so its gates still run.

The skills pi offers the chat leave out what turri has already (`src/chat-skills.ts`): a skill of a name turri runs
itself - its own, or the project's - and any skill about \*\*\*plain, its specs or their testing scripts. pi gathers
skills from `~/.pi/agent/skills`, `~/.agents/skills` and the `.agents/skills` of every folder from where turri started
up to its git root, so a folder above the project can hold another tool's \*\*\*plain skills - a `load-plain-reference`
the chat would load at the start of every session, though the whole \*\*\*plain reference, turri's
[rules](#rules), is in its system prompt already. The person is told once which were left out. A skill about anything
else is offered as pi offers it.

A skill is found once, as turri starts: one added while it runs is there the next time. A project's skill agent runs
as turri's do - pi's file tools and `bash` on the machine, no fence - so a project's skills are as trusted as the
project.

## Rules

`genome/rules/` holds the \*\*\*plain authoring rules. Every rule, in full, is appended to the system
prompt of the conversation and of the agents that write specs - never of the ones that write code.
The block is byte-identical every time, so it sits inside the cached prefix - but it is ~40k
tokens. The trade is deliberate: a rule the model has to decide to go and read is a rule it can
skip. `src/rules.ts` is where to change it.

## Trying the gate semantics

The gate machinery - the no-artifact rejection, the retry loop, escalation - is verified by live
runs rather than automated tests. To poke at it, give a skill a gate like the one in [the syntax](#the-syntax) - a
project's own, in `.turri/skills/`, with a rubric in its `references/` - run it with `turri cultivate <name>`, then
change the gate:

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
