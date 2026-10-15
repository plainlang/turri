---
name: bud
description: >-
  Add a feature to an existing ***plain project the way `brood` builds one: it first asks how many
  questions the product phase may ask - light, medium, thorough or best judgement, broader with
  fewer - then a short feature-intent interview, then product questions - a trigger and its outcome,
  an edge case, a rule - where every answer becomes a spec change, written as a git diff of the
  .plain files and built the moment it is written, so the feature appears while the interview is
  still going. What the questions leave open it decides itself, each decision a spec change of its
  own. A change that touches what is already specified or being built is a spec diff too: what
  is left to build is worked out again from the spec. Use when the user wants to add a
  feature to an existing project. Not for starting a new project (use `brood`, or `spawn`
  to start fast) or for editing generated code (the .plain specs are the source of truth).
allowed-tools: [read, write, edit, bash, ls, grep, find, write_spec_diff]
metadata:
  # What each phase does, in a line - shown under the skill's progress while it runs.
  phases:
    intent: "what the feature is for, who it serves, and what it leaves out"
    scope: "finds where the feature goes in the spec, and what is built already"
    product: "the feature, question by question - each answer starts a regenerate pulse"
  # The phase the questioning level caps, asked by the harness as the first question: light 3,
  # medium 5, thorough 10, best judgement as many as turri judges the phase needs.
  questioning: [product]
  # Every answer in the product phase is a spec change: the next question waits until it is
  # written with write_spec_diff. Changes turri decides itself need no answer before them.
  spec-diff-per-answer: [product]
---

# Bud

Load the `***plain` syntax rules before writing anything - they are in the system prompt under
`<plain-rules>`; read `genome/rules/<name>.md` for the full text of any rule you need to follow
closely.

## Role

Act as a `***plain` spec writer adding one feature to specs that already exist - and, usually, to
code already built from them, or being built. The only output is changes to `.plain` files, and
every one of them is a **spec diff**: a git diff of the `.plain` files, written with
`write_spec_diff`, which applies it and queues its render spec diff job. Never write code, and never
change a `.plain` file by any other means. Frame every message in terms of specs: "I'll add this to
the spec."

This is `brood`'s product phase, scoped to one feature, on top of what is there: the stack,
the testing setup and every earlier feature are settled - read them, build on them, restart none.

## How many questions

The first question of the intent phase is the harness's own, not yours: how many questions the
**product** phase may ask. The level sets how many questions there are and so how broad each is -
never what they cover:

| level | product questions | each question |
| --- | --- | --- |
| light | at most 3 | broad: the whole feature at once - what it does end to end, its main rules - with what fits the brief proposed, for the person to confirm or correct |
| medium | at most 5 | one part of the feature, with its main rules |
| thorough | at most 10 | narrow: one trigger, rule or edge case, with follow-ups on the ones that matter |
| best judgement | as many as you judge the feature needs | as broad or as narrow as each part needs |

The intent phase is not capped. Follow-ups count; the closing confirmation - asked with
`confirms_phase: true` - does not. Past the cap `ask_user` refuses the question. To stop sooner, or
under best judgement once the feature is settled enough to build, call `end_questions`.

The level limits the questions, never the spec changes. **Every answer is a spec change**, whatever
the level: written with `write_spec_diff` and built at once, before the next question - `ask_user`
refuses the next one until it is. A broad answer that covers several behaviours is several changes,
and you write them all. What the questions leave open - the details of a light answer, what is left
once they are over - is yours to decide, as a careful engineer would, in the light of the brief: each
decision a spec change of its own, written with `write_spec_diff` with no answer needed before it,
and said in one line. The closing summary names every decision you made yourself, so the
confirmation is where the person can change it.

## Question style

- Ask with `ask_user`, one question per call, as broad as the level says, and pass `options` so
  the user picks rather than types - concrete choices, plus the free-form catch-all the tool adds. Reserve `free_form: true`
  for a genuinely open question.
- Ask about the product - a trigger and its outcome, an edge case, a rule, a permission, a step of
  a flow - never about a spec section ("which concepts?", "what reqs?"). Let the answer decide which
  sections change.
- Shape each question so any plausible answer maps to one spec change. Bad: "How should it work?"
  Good: "When the title is empty, should saving be refused with `Title is required`, or saved as
  `Untitled`?"
- Short, direct sentences and plain words; never drop a detail the user needs to answer - split into
  more sentences instead.

## Steps

### intent

The harness has asked how many questions the product phase may ask before this phase starts; its
note beside these instructions gives the answer. Do not ask it again.

Read `references/intent.md` and ask its five core questions one at a time with `ask_user`. Ask at
most one focused follow-up when an answer is too vague to summarize. If what the user has already
said answers a question, confirm it in one line instead of asking.

Write nothing to disk. Summarize the feature-intent brief - motivation, affected user, desired
outcome, observable success criterion, boundary and explicit exclusions - and get explicit
confirmation, the brief passed whole as `ask_user`'s `context`, which the dialog shows above the
question. Carry the brief into every later step.

### scope

Keep this short: enough to ask the first product question, not a design on paper.

1. Find the `.plain` file(s) the feature belongs to, and read them whole, following their `import`
   and `requires` chains: every definition, implementation and test req, functional spec and
   acceptance test the feature will sit beside. Read `config.turri.yaml` (or the old `config.yaml`,
   when there is no `config.turri.yaml`) and the chosen stack's `config.turri.<stack>.yaml` for
   whether conformance tests are on.
2. Ask which module only if it is genuinely ambiguous; otherwise do not.
3. Look at what is built and queued (`drift`), so you know which specs already have code and
   which builds are still waiting - a change to either is still just a spec diff.

Say in one line where the feature goes, and move on. Write nothing to disk.

### product

The feature, walked question by question. Run this loop while the questioning level allows (see
"How many questions"):

1. **Ask** one product question with `ask_user`.
2. The user **answers**.
3. **Make the spec change** the answer calls for, as one git diff of the `.plain` file(s) - across
   every section it needs:
   - a concept it introduces, into `***definitions***` - written the way `add-concept` says, and
     defined in the same change as the functional spec that first uses it;
   - a policy it states - error handling, a retry, a data format, a library not already in the
     module or its imports - into `***implementation reqs***`, the way
     `add-implementation-requirement` says;
   - the functional spec it adds, or the change to one already written, the way
     `add-functional-spec` says: its wording rules, its complexity check
     (`analyze-if-func-spec-too-complex` - at most 200 lines of code; a spec too big is split *with
     the user*, as the next question) and its conflict check (`analyze-func-specs`, over the new
     spec and every existing one in the chain). Follow those skills for what the text is; the diff
     is the only thing that writes it.
   - with conformance tests on - test reqs of the module's own or imported, and a conformance
     testing script turri finds - an acceptance test under its functional spec when the
     answer states one concrete verification (`add-acceptance-test`), and a test req only when the
     answer changes how conformance tests run (`add-test-requirement`). With conformance off, none.
   Write it as a git diff: `diff --git a/<file> b/<file>`, `--- a/<file>`, `+++ b/<file>`, then the
   hunks with a few lines of unchanged context, paths from the project root. A new functional spec
   goes where it belongs in build order - after what it builds on, usually at the end.
4. **Write it with `write_spec_diff` at once**, before anything else. It applies the diff and starts
   a render spec diff job for it; with conformance on, its conformance tests follow it. An answer
   that covers several behaviours is a change for each: write them all. Then the changes for what
   you decide yourself around it, if any. Say in one line what went into the spec - "added `:Note:`
   and functional spec 7" - and what became of the build, as the tool says, then ask the next
   question. Never wait for a build, and never ask the user to approve a change.

**One answer, at least one change.** A follow-up about the same behaviour - an edge case, a
validation rule - is its own answer and its own change. An answer that describes two behaviours is
two changes, both written before the next question. A change never carries both an answer and
something you decided: what you decide is a change of its own.

**What already exists.** When an answer - or the conflict check - means changing something already
specified: a definition, a req, a functional spec, built or still queued, the next question is
about exactly that. Quote the existing text and offer: keep it (narrow what was just written),
augment it (with the new wording in the question), or replace it. The answer is a spec diff like
any other, written with `fixes_earlier`; when a concept changes, the same diff updates every spec
that uses it, within what the user approved. Never rewrite earlier intent without asking. The queue
master reworks the builds still queued around every such change - a queued build the change undoes
is taken out, one it touches renders the spec as it now is.

**Fix your own mistakes in place.** When a later answer refines or contradicts a change you wrote in
this feature, write the correction as its own diff with `fixes_earlier`, before the next question.

Once the questions are over - the cap reached, or `end_questions` called - write what is left of
the feature the same way: one decision of yours, one spec change, with no answer between. Then run
`validate` on every module the feature touched, and fix what it finds with a spec diff and
`fixes_earlier`.

Finish by summarizing the feature's spec changes in build order, marking what you decided without
asking, saying what is built and what is still queued (`drift`), and getting explicit confirmation
with `confirms_phase: true`. The summary is for the person to take in at a glance - a line a change,
each decision you made yourself in a few words, about fifteen lines at most, never the specs'
wording. Any further change is asked for in the conversation, each one a spec diff; the next
feature starts again from the intent.
