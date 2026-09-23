---
name: forge-diff
description: >-
  `***plain` spec authoring in three phases - intent, stack, product - where every answer in the
  product interview becomes one spec change, written as a git diff of the .plain files and
  built the moment it is written, so code appears while the interview is still going. Gated
  review of the product phase. Use when the user starts a new project or wants to build
  something new from scratch and prefers every change to be a spec diff. Not for adding a
  feature to an existing project (use add-feature) or for editing generated code (the .plain
  specs are the source of truth).
allowed-tools: [read, write, edit, bash, ls, grep, find, write_spec_diff]
metadata:
  gates:
    - after: product
      continuous:
        rubric: ./references/rubric-product-live.md
        judges: 1
        judge_tools: [read, ls, grep, find]
      review:
        rubric: ./references/rubric-product.md
        judges: 2
        quorum: all
        on_fail: retry
        max_retries: 2
        judge_tools: [read, ls, grep, find]
---

# Forge Diff

Load the `***plain` syntax rules before writing anything — they are in the system prompt
under `<plain-rules>`; read `forge/rules/<name>.md` for the full text of any rule you need
to quote or follow closely.

## Role

Act as a `***plain` spec writer. The only output is `.plain` specification files — never code. Code is generated from the specs and lives in `plain_modules/` as a read-only artifact; never write or edit it. Frame every message to the user in terms of specs: "I'll add this to the spec," "Let me change the spec to fix that." The user must always understand they are building `***plain` specs that render into code, not writing code themselves.

In the product phase, every change you make to the specs is a **spec diff**: a git diff of the `.plain` files, written with `write_spec_diff`, which applies it and starts building it. The spec diffs are the output of the interview; the builds follow from them.

## How the phases end

Every phase ends the same way for the user: a summary and one explicit confirmation. The
**product** phase is reviewed as well, and none of that review is yours to run.

A reviewer reads along behind you the whole product phase - it re-reads the module after every
spec change, and its findings arrive on your tool results - and at the end the harness spawns
two independent judges against `references/rubric-product.md` and advances only when both
pass. A failed gate comes back with the violations and the phase runs again. You cannot skip
it, self-certify it, or advance on an unmet box — so do not review your own work.

What the gate needs from you is the **phase evidence record**. At the end of the product phase,
call `write_artifact` with `product.md` and write the ordered account of what happened: each
question asked, its answer, the spec change written in response and the build job it started,
and every explicit decision. The judges check `[record]` boxes against it, `[disk]` boxes
against the files, and `[both]` by cross-checking the two. A product phase that writes no
evidence record fails its gate without a judge being spent.

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

Read `references/intent.md` and ask its five core questions one at a time via `ask_user`.
Ask at most one focused follow-up when an answer is too vague to summarize.

Write nothing to disk in this phase — no project files, no specification files. Keep
entities, features, technology and testing for the phases that own them.

Summarize the problem, the primary user, the desired outcome, the observable success
criterion, and the initial boundary with its explicit exclusions. Get explicit confirmation
of that brief, and carry it into every later phase.

This phase ends on the user's confirmation. There is no gate and no artifact to write.

### stack

**This comes before any functionality, so that every spec change in the product phase can be
built the moment it is written.** A functionality cannot be rendered without knowing the
language it is written in and the framework its tests use.

Read `references/stack.md` and walk its topics in order: language, frameworks, storage,
external services, structure and architecture, other constraints, anything else. Ask the unit
test framework here too — generated code needs it from the first functionality onward.

Create the module structure and frontmatter so there is a `.plain` file to build into, and
author every requirement into `***implementation reqs***` at the right scope — shared
requirements into the template, module-specific ones into the module. Write these with the
ordinary file tools; **nothing is built in this phase**, and `write_spec_diff` is not used here.

Write no definitions, no functional specs, no `***test reqs***` and no `***acceptance tests***`.

Run `plainwright check` on the module before finishing, so the product phase does not start
on top of a file that does not parse.

Finish by summarizing the stack and architecture and getting explicit confirmation. There is
no gate on this phase — the user reading the stack back is the check.

### product

Read `references/product.md`. Carry the intent brief and the stack in; restart neither. This
is the whole product interview, walked **feature by feature** - never section by section. Do
not fill in the definitions first and the functional specs after: that is not this skill.

Walk its topics in order, and run this loop until the product is specified:

1. **Ask** one question with `ask_user` - about a feature, a step of a flow, a rule; never about
   a spec section.
2. The user **answers**.
3. **Make the spec change** the answer calls for, as one git diff of the `.plain` files - across
   every section it needs: the concepts it introduces, a policy it states, the functional spec it
   adds or changes.
4. **Write it with `write_spec_diff`**, which applies it and starts a render spec diff job for it,
   whatever it touches. Move straight on to the next question; never wait for a build.

One answer, one spec change, one render spec diff job. Correct something already written with
a diff and `fixes_earlier`, before the next question. Never change a `.plain` file in this
phase by any other means than `write_spec_diff`.

Report each build result between questions, in one sentence. Use `render_status` when the
user asks how the builds are going.

Finish by summarizing the full concept list and feature list in build order, saying what is
built and what is still queued, getting explicit confirmation, and writing the evidence record
to `product.md`.
