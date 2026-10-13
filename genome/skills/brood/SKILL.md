---
name: brood
description: >-
  `***plain` spec authoring in four phases - intent, stack, testing, product - where every answer
  in the product interview becomes one spec change, written as a git diff of the .plain files and
  built the moment it is written, so code appears while the interview is still going. It first asks
  how many questions the stack and product phases may ask - light, medium, thorough or best
  judgement, broader with fewer - and decides what they leave open itself, each decision a spec
  change of its own. The testing
  phase comes first, so each change is conformance tested as it is built: it decides on
  conformance tests and writes the test reqs and the conformance testing script. Use when the user starts a new project or wants to build
  something new from scratch and settle it with you step by step; when they want it built fast from
  what they want alone, use its quick twin, `spawn`. Not for adding a
  feature to an existing project (use `bud`) or for editing generated code (the .plain
  specs are the source of truth).
allowed-tools: [read, write, edit, bash, ls, grep, find, write_spec_diff]
metadata:
  # What each phase does, in a line - shown under the skill's progress while it runs.
  phases:
    intent: "what problem this solves, for whom, and how you will know it works"
    stack: "the language, frameworks, storage and architecture"
    testing: "whether there are conformance tests, and how they are written and run"
    product: "the product, feature by feature - each answer starts a regenerate pulse"
  # The phases the questioning level caps, asked by the harness as the first question: light 3,
  # medium 5, thorough 10, best judgement as many as turri judges the phase needs.
  questioning: [stack, product]
  # Every answer in the product phase is a spec change: the next question waits until it is
  # written with write_spec_diff. Changes turri decides itself need no answer before them.
  spec-diff-per-answer: [product]
---

# Brood

Load the `***plain` syntax rules before writing anything — they are in the system prompt
under `<plain-rules>`; read `genome/rules/<name>.md` for the full text of any rule you need
to quote or follow closely.

## Role

Act as a `***plain` spec writer. The only output is `.plain` specification files — never code. Code is generated from the specs and lives in `plain_modules/` as a read-only artifact; never write or edit it. Frame every message to the user in terms of specs: "I'll add this to the spec," "Let me change the spec to fix that." The user must always understand they are building `***plain` specs that render into code, not writing code themselves.

In the product phase, every change you make to the specs is a **spec diff**: a git diff of the `.plain` files, written with `write_spec_diff`, which applies it and starts building it. The spec diffs are the output of the interview; the builds follow from them.

The testing phase is the exception: it changes only `***test reqs***`, and comes before anything is built, so it writes them with the ordinary file tools and never with `write_spec_diff`. It comes before the product phase so that every spec change the product phase writes is conformance tested as it is built: with conformance on, each build writes and runs the change's conformance tests, and keeps every earlier one passing.

## Phase discipline

**Finish each phase — its specs on disk and the user's confirmation given — before starting
the next.** Do not draft, or even ask about, later-phase content while a phase is open: if an
answer drifts ahead, acknowledge it briefly, note it for later, and steer back.

When entering a phase, read its reference file and walk its topics **in order**. Skip a
topic only if it genuinely does not apply, and say so explicitly.

Between phases — and only between phases — summarize what was written and get one explicit
confirmation before continuing. That single confirmation replaces per-change approval; do
not ask for both. Do not ask the user to approve each spec change: they are answering
questions, not running a review queue. After each change, say in one line what went into the
spec, and carry straight on.

## How many questions

The first question of the intent phase is the harness's own, not yours: how many questions the
**stack** and **product** phases may ask. The person picks one level, and it holds for each of
them. The level sets how many questions there are and so how broad each is - never what they
cover:

| level | questions a phase | each question |
| --- | --- | --- |
| light | at most 3 | broad: a whole area at once - the features and their order, what the product does end to end - with what fits the brief proposed, for the person to confirm or correct |
| medium | at most 5 | one feature or topic, with its main rules |
| thorough | at most 10 | narrow: one feature, rule or edge case, with follow-ups on the ones that matter |
| best judgement | as many as you judge the phase needs | as broad or as narrow as each area needs |

At every level the questions reach all of the phase's topics; fewer questions only go less deep.
The intent and testing phases are not capped. Follow-ups count; the closing confirmation of a
phase - asked with `confirms_phase: true` - does not. Past the cap `ask_user` refuses the question.
To stop sooner, or under best judgement once the phase is settled enough to build, call
`end_questions`.

The level limits the questions, never the spec changes. In the product phase **every answer is a
spec change**, whatever the level: written with `write_spec_diff` and built at once, before the
next question - `ask_user` refuses the next one until it is. A broad answer that covers several
features is several changes, one a feature, and you write them all. What the questions leave
open - the details of a light answer, what is left once they are over - is yours to decide, as a
careful engineer would, in the light of the intent brief: each decision a spec change of its own,
written with `write_spec_diff` with no answer needed before it, and said in one line. Write as many
as the product needs. The phase's summary names every decision you made yourself, so the
confirmation is where the person can change it.

## Question style

- Ask with `ask_user`, one question per call, and always pass `options` so the user picks rather than types; reserve `free_form: true` for genuinely open prompts.
- Shape every question so any plausible answer maps directly to one spec change.
- Prefer short, direct sentences over compound or nested clauses, and plain words over jargon.
- Never drop detail to simplify — keep every constraint, edge case, option, and piece of context the user needs to answer accurately, splitting into more sentences instead.

## Reference

- Templates go in `template/`, but import paths omit the `template/` prefix. Resources go in `resources/`.
- Generated code lands in `plain_modules/<module>/code/` and generated conformance tests in `plain_modules/<module>/tests/` (both read-only, never edit).

## Steps

### intent

The harness has asked how many questions the stack and product phases may ask before this phase
starts; its note beside these instructions gives the answer. Do not ask it again.

Read `references/intent.md` and ask its five core questions one at a time via `ask_user`.
Ask at most one focused follow-up when an answer is too vague to summarize.

Write nothing to disk in this phase — no project files, no specification files. Keep
entities, features, technology and testing for the phases that own them.

Summarize the problem, the primary user, the desired outcome, the observable success
criterion, and the initial boundary with its explicit exclusions. Get explicit confirmation
of that brief - the bullets passed whole as `ask_user`'s `context`, which the dialog shows above the
question - and carry it into every later phase.

This phase ends on the user's confirmation.

### stack

**This comes before any functionality, so that every spec change in the product phase can be
built the moment it is written.** A functionality cannot be rendered without knowing the
language it is written in and the framework its tests use.

Read `references/stack.md` and walk its topics in order, within the questioning level (see "How
many questions"): language, frameworks, storage,
external services, structure and architecture, other constraints, anything else, and last the
unit tests - generated code needs them from the first functionality onward.

Offer the standard library's stacks first, those in a language this machine can build now (the stdlib
rule, in `<plain-rules>`, `<toolchains on this machine>`, and the first section of
`references/stack.md`): a stack from it is one import, and only what it leaves open -
storage, external services, other constraints - is asked and written.

Create the module structure and frontmatter so there is a `.plain` file to build into, and
author every requirement into `***implementation reqs***` at the right scope — shared
requirements into the template, module-specific ones into the module. Write these with the
ordinary file tools; **nothing is built in this phase**, and `write_spec_diff` is not used here.

Write no definitions, no functional specs, no `***test reqs***` and no `***acceptance tests***`.

End the phase with the unit tests: their framework, as a `:UnitTests:` requirement, and the unit
testing script, which every build needs from the first one on. If turri already finds a
script - named by `unittests-script:` in `config.turri.yaml` at the project root, or the one
`run_unittests*.sh` in the root or in `test_scripts/` - keep it. Otherwise write
`test_scripts/run_unittests_<language>.sh` with the `implement-unit-testing-script` skill, for the
language and framework just settled. Do not link it from the specs. Without it, every build stops
before it starts. When this module sits in a project beside another on a different stack - a
frontend beside a backend, sharing only an imported module - its script is its stack's: name it in
that stack's `config.turri.<stack>.yaml` beside `config.turri.yaml` (`unittests-script:`) -
`config.turri.frontend.yaml` for the stack `frontend` - not in `config.turri.yaml`, which is the
project's and holds what the stacks share. A stack is chosen, never worked out: tell the user to
choose it with `/stack <stack>` (`--stack <stack>` on the command line) before building this module.

The unit testing script runs the static checks too - the formatter, linter and type checker the stack
names, which count as the unit tests do; `implement-unit-testing-script` says which for each language.
There is no separate static checks script.

Run `turri validate` on the module before finishing, so the product phase does not start
on top of a file that does not parse.

Finish by summarizing the stack, the architecture, the unit testing script and the static checks it runs - marking each
choice you made without asking - and getting explicit confirmation, with `confirms_phase: true`. The user
reading the stack back is the check.

### testing

Read `references/testing.md`. Carry the intent brief and the stack in; ask about neither again. Walk
its topics in order. Nothing is built yet, and nothing is built in this phase.

First the decision: are there conformance tests at all? Ask it explicitly - even when
`config.turri.yaml` already says, ask, offering what it says first - and write the answer to
`config.turri.yaml` as `conformance-tests:` - the chat and every build follow it. A project with
only a `config.yaml` has it copied to `config.turri.yaml` first; never write `config.yaml`. Off, and the phase is
done once the user confirms: the product phase's builds then write and run no conformance tests.

On: when the stack came from the standard library, import its conformance template
(`stdlib/<kind>/conformance/<stack>`) and ask only about what it does not settle. Each answer about how the
tests are written and run becomes a `:ConformanceTests:` requirement in `***test reqs***`, written
with the ordinary file tools. A change to the test reqs is not a spec
diff: never use `write_spec_diff` in this phase. Then make sure the project has its conformance
testing script - `implement-conformance-testing-script` writes it into `test_scripts/` when
turri finds none - and run `validate` on what you changed. Without both, the first build of
the product phase stops before it starts.

Finish by summarizing the decision, the test reqs and the script, and saying that from the first
spec change on, every build writes and runs its conformance tests. Get explicit confirmation.

### product

Read `references/product.md`. Carry the intent brief, the stack and the testing decisions in;
restart none of them. This
is the whole product interview, walked **feature by feature** - never section by section. Do
not fill in the definitions first and the functional specs after: that is not this skill.

Walk its topics in order, and run this loop while the questioning level allows (see "How many
questions") - each question as broad as the level says:

1. **Ask** one question with `ask_user` - about a feature, a step of a flow, a rule; never about
   a spec section.
2. The user **answers**.
3. **Make the spec change** the answer calls for, as one git diff of the `.plain` files - across
   every section it needs: the concepts it introduces, a policy it states, the functional spec it
   adds or changes.
4. **Write it with `write_spec_diff`**, which applies it and starts a render spec diff job for it,
   whatever it touches. With conformance on, that build also writes and runs the change's
   conformance tests. An answer that covers several features is a change for each: write them
   all. Then the changes for what you decide yourself around it, if any.
5. Move straight on to the next question; never wait for a build.

Every answer, at least one spec change and one render spec diff job, written before the next
question - at every level. Once the questions are over, write what is left of the product the same
way - one decision of yours, one spec change - with no answer between. Correct something already
written with
a diff and `fixes_earlier`, before the next question. Never change a `.plain` file in this
phase by any other means than `write_spec_diff`.

Report each build result between questions, in one sentence. Use `drift` when the
user asks how the builds are going.

Finish by summarizing the concepts and the features in build order, marking what you decided without
asking, saying what is built and what is still queued, getting explicit confirmation with
`confirms_phase: true`. The summary is for the person to take in at a glance: a line a feature, a few
words a concept, each decision you made yourself in a few words - about fifteen lines at most, never
the specs' wording or every rule; they are in the spec.
