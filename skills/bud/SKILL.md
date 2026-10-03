---
name: bud
description: >-
  Add a feature to an existing ***plain project the way `brood` builds one: a short
  feature-intent interview, then product questions one at a time - a trigger and its outcome, an
  edge case, a rule - where every answer becomes one spec change, written as a git diff of the
  .plain files and built the moment it is written, so the feature appears while the interview is
  still going. A change that touches what is already specified or being built is a spec diff too: what
  is left to build is worked out again from the spec. Use when the user wants to add a
  feature to an existing project. Not for starting a new project (use `brood`, or `spawn`
  to start fast) or for editing generated code (the .plain specs are the source of truth).
allowed-tools: [read, write, edit, bash, ls, grep, find, write_spec_diff]
---

# Bud

Load the `***plain` syntax rules before writing anything - they are in the system prompt under
`<plain-rules>`; read `forge/rules/<name>.md` for the full text of any rule you need to follow
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

## Question style

- Ask with `ask_user`, one question per call, and pass `options` so the user picks rather than
  types - concrete choices, plus the free-form catch-all the tool adds. Reserve `free_form: true`
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

Read `references/intent.md` and ask its five core questions one at a time with `ask_user`. Ask at
most one focused follow-up when an answer is too vague to summarize. If what the user has already
said answers a question, confirm it in one line instead of asking.

Write nothing to disk. Summarize the feature-intent brief - motivation, affected user, desired
outcome, observable success criterion, boundary and explicit exclusions - and get explicit
confirmation. Carry the brief into every later step.

### scope

Keep this short: enough to ask the first product question, not a design on paper.

1. Find the `.plain` file(s) the feature belongs to, and read them whole, following their `import`
   and `requires` chains: every definition, implementation and test req, functional spec and
   acceptance test the feature will sit beside. Read `config.yaml` (and a module's own
   `config.<module>.yaml`) for whether conformance tests are on.
2. Ask which module only if it is genuinely ambiguous; otherwise do not.
3. Look at what is built and queued (`drift`), so you know which specs already have code and
   which builds are still waiting - a change to either is still just a spec diff.

Say in one line where the feature goes, and move on. Write nothing to disk.

### product

The feature, walked question by question. Run this loop until the user says the feature is fully
covered:

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
4. **Write it with `write_spec_diff`.** It applies the diff and queues a render spec diff job for
   it; with conformance on, its conformance tests follow it. Say in one line what went into the
   spec - "added `:Note:` and functional spec 7" - and what became of the build, as the tool says,
   then ask the next question. Never wait for a build, and never ask the user to approve a change.

**One answer, one change.** A follow-up about the same behavior - an edge case, a validation rule -
is its own answer and its own change. An answer that describes two behaviors is two: write the
first, then ask about the second. A change never carries anything the user was not asked about.

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

When the loop reaches the end of what the brief covers, ask whether the feature is fully covered.
Yes: go to the review. No: the next question.

### review

A short consistency pass over what the feature changed, then the handover.

1. Read the modified `.plain` file(s) whole, and check: every new concept defined before use, with
   no cycles; build order right end to end - no spec depends on one after it; functional specs
   language-agnostic; every external interface explicit (paths, methods, arguments, formats);
   acceptance tests consistent with their functional specs.
2. Run `validate` on every module the feature touched.
3. Fix what either finds with a spec diff and `fixes_earlier` - never by editing the file. Ask the
   user only when a fix is a decision the brief and the answers do not settle.

Walk `references/checklist.md` once, as a self-audit. Then hand over in a few lines: the feature's
spec changes in order, the builds they queued and how they stand (`drift`), and that any
further change is asked for in the conversation - each one a spec diff, and what is left to build is
worked out again from the spec. The next feature starts again from the intent.
