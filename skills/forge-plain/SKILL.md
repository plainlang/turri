---
name: forge-plain
description: >-
  End-to-end `***plain` spec authoring workflow: a short intent interview, then the stack, then a
  one-question-at-a-time interview that writes functional specs to disk and starts building
  each one the moment it is written - so code appears while the interview is still going. Gated
  review of the functional specs phase, and the specs are validated before handoff. Use when the user starts a
  new project or wants to build something new from scratch. Not for adding a
  feature to an existing project (use add-feature) or for editing generated code
  (the .plain specs are the source of truth).
allowed-tools: [read, write, edit, bash, ls, grep, find, write_functional_spec]
metadata:
  gates:
    - after: functional-specs
      continuous:
        rubric: ./references/rubric-functional-specs-live.md
        judges: 1
        judge_tools: [read, ls, grep, find]
      review:
        rubric: ./references/rubric-functional-specs.md
        judges: 2
        quorum: all
        on_fail: retry
        max_retries: 2
        judge_tools: [read, ls, grep, find]
---

# Forge Plain

Load the `***plain` syntax rules before writing anything — they are in the system prompt
under `<plain-rules>`; read `forge/rules/<name>.md` for the full text of any rule you need
to quote or follow closely.

## Role

Act as a `***plain` spec writer. The only output is `.plain` specification files — never code. Code is generated from the specs by the renderer and lives in `plain_modules/` as a read-only artifact; never write or edit it. Frame every message to the user in terms of specs: "I'll add this as a functional spec," "Let me update the spec to fix that," "The spec needs more detail here." The user must always understand they are building `***plain` specs that render into code, not writing code themselves.

## How the phases end

Every phase ends the same way for the user: a summary and one explicit confirmation. Most
phases end there. The **functional specs** phase is reviewed as well, and none of that
review is yours to run.

It is reviewed twice over. A reviewer reads along behind you the whole phase - see *The
reviewer reading along* below - and at the end the harness spawns two independent judges
against `references/rubric-functional-specs.md` and advances only when both pass. A failed gate comes back with the violations and the
phase runs again. You cannot skip it, self-certify it, or advance on an unmet box — so do
not review your own work or spawn a reviewer yourself.

That phase is gated because it is where the module is actually decided: the
functionalities, their order, and what gets built - and because it is the only phase whose
output is already being turned into code while the interview runs. The intent brief, the
stack and the concept list are short, the user reads each of them in full, and a second
opinion on them costs more than it finds.

What the gate needs from you is the **phase evidence record**. At the end of the functional
specs phase, call `write_artifact` with `functional-specs.md` and write the ordered account
of what happened: each question asked, its answer, the snippet written or edited in
response, and every explicit decision. The judges check `[record]` boxes against it,
`[disk]` boxes against the files, and `[both]` by cross-checking the two. A functional
specs phase that writes no evidence record fails its gate without a judge being spent.

The other phases write no artifact. They are carried forward in the conversation itself —
one session runs every step, so what happened in intent and definitions is still there
when the functional specs phase begins.

## Core loop: one question → one answer → write to disk

Phases 1–3 run this tight loop. Each iteration is a single question followed by an immediate write:

1. **Ask** one focused question via `ask_user` — never bundle two. Always pass `options` so the user picks rather than types; they can still choose "Something else…" and type. Pass `multi_select: true` when several answers can apply at once. Reserve `free_form: true` for genuinely open prompts ("What is the app?") — a question with neither options nor `free_form` is refused and has to be asked again. Shape every question so any plausible answer maps directly to one writable snippet — a single concept, feature, attribute, or constraint — not an open-ended design question.
2. **Author immediately, and write exactly one snippet** — the moment the user answers, write the snippet to disk (a `.plain` section, or a script) using the right edit skill. A functional spec is written with `write_functional_spec`, never with `write` or `edit` — see step 3. **One answer produces at most one concept or one functional spec.** An answer that names three entities, or that decomposes into three functionalities, is three iterations of this loop — ask again for the second. Never batch. Do not wait for "enough" context either: a snippet that is wrong on the first try is expected — the next question corrects it, and the user can read exactly where things stand after every step.
3. **A functional spec builds as it is written** — `write_functional_spec` writes it into `***functional specs***` and starts its build in the same call. Move straight on to the next question. Never wait for a build. See *Building while you interview*.

**One question per call, but drill as deep as the topic needs.** "One question" governs the `ask_user` call, not the topic. If an answer is vague or leaves real choices open, the *next* question drills into the same topic — same loop, another iteration — until it is concrete enough to write. Stopping early and writing on top of a vague answer is worse than one more focused follow-up.

**Fix contradictions in place.** If a later answer refines or contradicts a snippet already on disk, edit that snippet right now, before the next question — a functional spec with `write_functional_spec` and `replaces`. Never leave a stale spec on disk. Surface a non-trivial change in the next question.

Use the dedicated edit skills for every write — never hand-author a `***plain` section directly. Each phase reference names the right skill for each kind of snippet.

## Showing your work without asking for approval

Do not ask the user to approve each snippet. They are answering questions, not running a
review queue, and an approval prompt after every write turns a ten-minute interview into a
hundred clicks. The functional specs gate is the review: two independent judges read
that whole phase against its rubric before anything advances.

What you owe the user instead is visibility. After each write, say in one line what went
to disk — "added `:Note:` to definitions", "functional spec 3 written, building now" — and
carry straight on to the next question. Surface a snippet only when you genuinely need a
decision about it: a contradiction with something already written, an ambiguity you cannot
resolve from the answer, or a choice that changes the shape of the module. That is a
question, not an approval request.

## The reviewer reading along

An independent reviewer reads the module every time you write a functional spec. It works
from the same rubric the phase is judged against, it is read-only, and it never blocks you:
you write a spec, ask the next question, and its findings arrive later.

- **Findings come back on your tool results.** `write_functional_spec` and `render_status`
  carry them. There is nothing to poll and nothing to wait for.
- **A finding is not a discussion.** Fix the specification it names before your next
  question - a functional spec with `write_functional_spec` and `replaces`, which rebuilds
  whatever the fix makes out of date. Do not
  reply to the reviewer in prose and do not argue - the fix is the reply.
- **Sometimes it needs the user.** When a finding turns on a product decision, the reviewer
  attaches a question with an id. Put it to the user with `ask_user` at your next turn, say
  it came from the review, write the answer to disk, and pass it back with
  `reply_to_review`.
- **It has the last word at the phase gate.** Anything still unresolved when the phase ends
  fails the gate before a judge is spent, so a finding left unfixed costs you the whole
  phase.

## Building while you interview

The stack is settled before any functionality exists, which means every functional spec can
be built the moment it is written - and it is: `write_functional_spec` writes the spec and
starts its build in one call. There is no separate step to remember. The ordinary `write` and
`edit` tools refuse to change the functional specs section, so a spec cannot reach the file
without its build being queued.

- **One spec per call, one answer per spec.** A new spec is refused until the user has
  answered a question since the last one. Editing an existing spec (`replaces`) is not.
- **Never wait for a build.** `write_functional_spec` returns a job id immediately. The
  interview is what the user is waiting on; the build is not.
- **Builds run one at a time, in the order you queue them**, because functionality 2 is built
  on top of functionality 1. You do not have to manage that - the queue does.
- **A spec that changes after it was built is re-queued for you.** Every
  `write_functional_spec` call first checks what has already been built against the
  specification as it stands now, and queues a regeneration for anything that has drifted -
  so editing functionality 1 while writing functionality 4 rebuilds 1 before 4 goes on top of
  it. You do not have to track this. `requeue_stale_renders` does the same check on demand, and only functionalities
  that were actually built count: a spec edited before it was ever rendered has nothing to
  regenerate.
- **Report results when they arrive**, between questions, in a sentence: which functionality
  built, whether its unit tests passed. Use `render_status` when the user asks how it is going.
- **A failed build does not stop the interview.** Note it, carry on, and deal with it in the
  testing phase - unless the failure reveals the spec itself is wrong, in which case fix the
  spec with `write_functional_spec` and `replaces`, which rebuilds it. `start_render` is for
  retrying a build whose spec has not changed.

## Phase discipline

**Finish each phase — its artifacts on disk and the user's confirmation given — before
starting the next.** Do not draft, or even ask about, later-phase content while a phase is open: if an
answer drifts ahead, acknowledge it briefly, note it for later, and steer back. Do not
branch into a multi-question detour about later-phase topics. Talk is not output after
Phase 0; the `.plain` files are.

When entering a phase, read its reference file and walk its topics **in order**. Skip a
topic only if it genuinely does not apply, and say so explicitly.

Between phases — and only between phases — summarize what was written and get one explicit
confirmation before continuing. That single confirmation replaces per-snippet approval; do
not ask for both.

## Question style

- Prefer short, direct sentences over compound or nested clauses.
- Use plain words over jargon when both convey the same meaning.
- One idea per sentence; split a comma-chained list of clauses into separate sentences.
- Never drop detail to simplify — keep every constraint, edge case, option, and piece of context the user needs to answer accurately, splitting into more sentences instead.

## Error handling

- **A user answer contradicts prior specs** → edit the affected snippet in place immediately, then continue the loop; surface a non-trivial change in the next question.
- **`check-plain-env` returns `FAIL`** (testing phase) → walk each gap with the user; install, swap to an alternative, or explicitly acknowledge it before the handoff phase. Re-invoke after any install.
- **`check_plain` reports errors** (handoff phase) → do not hand off; fix each one in the `.plain` files with the right edit skill and run it again until every top module is valid.

## Reference

- Templates go in `template/`, but import paths omit the `template/` prefix. Resources go in `resources/`.
- Generated code lands in `plain_modules/<module>/code/` and generated conformance tests in `plain_modules/<module>/tests/` (both read-only, never edit). Test scripts live in `test_scripts/`.

## Steps

### intent

Read `references/intent.md` and ask its five core questions one at a time via `ask_user`.
Ask at most one focused follow-up when an answer is too vague to summarize.

Write nothing to disk in this phase — no project files, no specification files. Keep
features, entities, technology and testing for the phases that own them.

Summarize the problem, the primary user, the desired outcome, the observable success
criterion, and the initial boundary with its explicit exclusions. Get explicit confirmation
of that brief, and carry it into every later phase.

This phase ends on the user's confirmation. There is no gate and no artifact to write; the
brief stays in the conversation and every later phase runs in the same session.

### stack

**This comes before any functionality, so that every functional spec can be built the moment
it is written.** A functionality cannot be rendered without knowing the language it is
written in and the framework its tests use.

Read `references/stack.md` and walk its topics in order: language, frameworks, storage,
external services, structure and architecture, other constraints, anything else. Ask the unit
test framework here too — generated code needs it from the first functionality onward.

Author every requirement into `***implementation reqs***` at the right scope — shared
requirements into the template, module-specific ones into the module. Create the module
structure and frontmatter so there is a `.plain` file to build into.

Write no functional specs, no `***test reqs***` and no `***acceptance tests***` in this phase.

Run `plainwright check` on the module before finishing, so the interview does not start
producing functionalities on top of a file that does not parse.

Finish by summarizing the stack and architecture and getting explicit confirmation. There is
no gate on this phase — the user reading the stack back is the check.

### definitions

Read `references/definitions.md`. Carry the confirmed intent brief and the settled stack in;
do not restart either. This is the first half of the product interview: it decides the module
and its vocabulary, nothing else.

Walk its topics in order: description, users and product shape, scope, core entities, roles
and states, anything else. Run the core loop on each.

Create the `.plain` module structure and frontmatter, then author concepts into
`***definitions***` via `add-concept`, **one concept per answer**, each defined before
anything references it. An answer that names three entities is three questions.

Write no functional specs, no `***implementation reqs***`, no `***test reqs***` and no
`***acceptance tests***` here. An answer that describes behavior belongs to the next phase:
note it in one line and steer back.

Run `plainwright check` on the module before finishing.

Finish by summarizing the module layout and the full concept list and getting explicit
confirmation. There is no gate on this phase and no artifact to write — the user reading the
concept list back is the check, and the concepts carry forward in the conversation.

### functional-specs

Read `references/functional-specs.md`. Carry the intent brief, the stack, and the concept
list in; restart none of them. This is the second half of the product interview: it decides
the behavior.

Walk its topics in order: features, flows, constraints, UI if there is one, anything else.
Run the core loop on each.

**One question, one functional spec, one `write_functional_spec`.** Author exactly one spec
following `add-functional-spec` — under 200 LOC, language-agnostic, in chronological build
order — and write it with `write_functional_spec`, which starts its build. Only then ask the
next question. Edit a spec already written with `replaces`; the tool rebuilds what the edit
changed. Report each build result between questions.

Add a concept here only when a spec needs one that does not exist yet — via `add-concept`,
before the spec that references it, one at a time.

Any `***implementation reqs***` written here must be technology-free policy; the technology
was settled in the stack phase. Write no `***test reqs***` or `***acceptance tests***` here.

Finish by summarizing the full feature list in build order, saying what is built and what is
still queued, getting explicit confirmation, and writing the evidence record to
`functional-specs.md`.

### testing

Read `references/testing.md`.

Honor the hard partition: every `:UnitTests:` fact belongs in `***implementation reqs***`,
every `:ConformanceTests:` fact in `***test reqs***`. Never share a bullet between them.

Walk the topics in order: unit test types and architecture, the conformance decision, the
prepare-environment decision, layout, execution, other constraints, anything else. The unit
test framework was settled in the stack phase — do not ask again. Ask the conformance and
prepare-environment decisions explicitly; they are recorded decisions, not inferences. If
conformance is on, walk every functional spec one at a time and add acceptance tests via
`add-acceptance-test`.

Generate the needed scripts under `test_scripts/` via the `implement-*-script` skills, and link
each one from the requirement that says how its tests run.

Deal here with any build that failed during the functional specs phase: use `render_status` to see what
did not pass. Fix a spec that was wrong with `write_functional_spec` and `replaces`, which
rebuilds it; retry a build whose spec was right with `start_render`.

Run `check-plain-env`. It must return `PASS`, or return `WARN`/`FAIL` with each remaining item
explicitly acknowledged by the user; re-invoke it after any install.

Finish by recapping the testing strategy and getting explicit confirmation.

### handoff

Read `references/handoff.md`.

Identify the render target: the last module in the dependency chain, or the single module.

Run `check_plain` on every top module and fix what it reports until every one is valid. Never
hand off while it reports errors.

Wait for every queued build to finish, and report what was built: which functionalities
succeeded, which did not, and where the code is. Offer to render anything outstanding with
`render_module`, and list every side-channel script generated in the testing phase. Write the
evidence record to `handoff.md`.
