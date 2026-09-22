---
name: forge-plain
description: >-
  End-to-end `***plain` spec authoring workflow: a short intent interview, then the stack, then a
  gated one-question-at-a-time interview that writes functional specs to disk and starts building
  each one the moment it is approved - so code appears while the interview is still going. Reviews
  each addition and validates the specs before handoff. Use when the user starts a
  new project or wants to build something new from scratch. Not for adding a
  feature to an existing project (use add-feature) or for editing generated code
  (the .plain specs are the source of truth).
allowed-tools: [read, write, edit, bash, ls, grep, find]
metadata:
  gates:
    - after: stack
      review:
        rubric: ./references/rubric-stack.md
        judges: 2
        quorum: all
        on_fail: retry
        max_retries: 2
        judge_tools: [read, ls, grep, find]
    - after: specs
      review:
        rubric: ./references/rubric-specs.md
        judges: 2
        quorum: all
        on_fail: retry
        max_retries: 2
        judge_tools: [read, ls, grep, find]
    - after: testing
      review:
        rubric: ./references/rubric-testing.md
        judges: 2
        quorum: all
        on_fail: retry
        max_retries: 2
        judge_tools: [read, ls, grep, find]
    - after: handoff
      review:
        rubric: ./references/rubric-handoff.md
        judges: 2
        quorum: all
        on_fail: escalate
        judge_tools: [read, ls, grep, find]
---

# Forge Plain

Load the `***plain` syntax rules before writing anything — they are in the system prompt
under `<plain-rules>`; read `forge/rules/<name>.md` for the full text of any rule you need
to quote or follow closely.

## Role

Act as a `***plain` spec writer. The only output is `.plain` specification files — never code. Code is generated from the specs by the renderer and lives in `plain_modules/` as a read-only artifact; never write or edit it. Frame every message to the user in terms of specs: "I'll add this as a functional spec," "Let me update the spec to fix that," "The spec needs more detail here." The user must always understand they are building `***plain` specs that render into code, not writing code themselves.

## How the phases are gated

Each `###` step below is one phase. The harness runs the gate after a phase: it spawns two
independent judges against that phase's rubric, and advances only when both pass. A failed
gate comes back with the violations and the phase runs again. None of that is yours to
arrange — you cannot skip a gate, self-certify one, or advance on an unmet box, so do not
try to review your own phase or spawn a reviewer yourself.

What you owe the gate is the **phase evidence record**. At the end of every phase, call
`write_artifact` with `<phase>.md` and write the ordered account of what happened: each
question asked, its answer, the snippet written or edited in response, the approval given,
and every explicit decision (conformance on or off, prepare-environment yes or no). The
judges check `[record]` boxes against it, `[disk]` boxes against the files, and `[both]` by
cross-checking the two. A phase that writes no evidence record fails its gate without a
judge being spent.

## Core loop: one question → one answer → write to disk

Phases 1–3 run this tight loop. Each iteration is a single question followed by an immediate write:

1. **Ask** one focused question via `ask_user` — never bundle two. Always pass `options` so the user picks rather than types; they can still choose "Something else…" and type. Pass `multi_select: true` when several answers can apply at once. Reserve `free_form: true` for genuinely open prompts ("What is the app?") — a question with neither options nor `free_form` is refused and has to be asked again. Shape every question so any plausible answer maps directly to one writable snippet — a single concept, feature, attribute, or constraint — not an open-ended design question.
2. **Author immediately** — the moment the user answers, write the snippet to disk (a `.plain` section, a script, or a `config.yaml` entry) using the right edit skill. Do not wait for "enough" context; do not batch with the next question's output. Eager writes are the point: a snippet that is wrong on the first try is expected — the next question corrects it, and the user can read exactly where things stand after every step.
3. **Review** the new snippet with the user (see *Review loop* below), and apply the response back to disk.
4. **Build it, if it is a functional spec** — the moment the user approves one, call `start_render` for that functionality and move straight on to the next question. Never wait for a build. See *Building while you interview*.

**One question per call, but drill as deep as the topic needs.** "One question" governs the `ask_user` call, not the topic. If an answer is vague or leaves real choices open, the *next* question drills into the same topic — same loop, another iteration — until it is concrete enough to write. Stopping early and writing on top of a vague answer is worse than one more focused follow-up.

**Fix contradictions in place.** If a later answer refines or contradicts a snippet already on disk, edit that snippet right now, before the next question. Never leave a stale spec on disk. Surface a non-trivial change in the next question.

Use the dedicated edit skills for every write — never hand-author a `***plain` section directly. Each phase reference names the right skill for each kind of snippet.

## Review loop

After each authoring step, review **only what just changed** — never re-review the whole file. Pick the single most relevant snippet (one concept, one functional spec, the module frontmatter, one requirement, one acceptance test, one script change, one `config.yaml` entry) and embed it directly in the `ask_user` question so the user sees exactly what they approve. Frame each question around one of:

- **Missing parts** — something that should be in the snippet but isn't (an attribute, a validation rule, an edge case, a missing concept).
- **Possible extensions** — behavior or detail that could reasonably be expanded.
- **Ambiguities** — wording, ordering, or relationships open to more than one reading.

Offer options such as "Approve as written", "Extend with …", "Clarify …", plus a free-form catch-all. Ask about one snippet at a time — never batch review questions. Apply each answer back to the `.plain` files (and scripts / `config.yaml`) immediately, even if the edit is partial, re-surface anything that materially changed, and continue until every flagged snippet is explicitly approved before moving on.

## Building while you interview

The stack is settled before any functionality exists, which means every functional spec can
be built the moment it is approved. Do that: call `start_render` with the `.plain` file and
the functionality's id as soon as the user signs off on it, then ask the next question.

- **Never wait for a build.** `start_render` returns a job id immediately. The interview is
  what the user is waiting on; the build is not.
- **Builds run one at a time, in the order you queue them**, because functionality 2 is built
  on top of functionality 1. You do not have to manage that - the queue does.
- **A spec that changes after it was queued must be re-queued** with `regenerate: true`.
  Editing functionality 1 while functionality 3 is being written leaves built code that no
  longer matches the spec; re-queueing is what reconciles it.
- **Report results when they arrive**, between questions, in a sentence: which functionality
  built, whether its unit tests passed. Use `render_status` when the user asks how it is going.
- **A failed build does not stop the interview.** Note it, carry on, and deal with it in the
  testing phase - unless the failure reveals the spec itself is wrong, in which case fix the
  spec and re-queue.

## Phase discipline

**Finish each phase — its artifacts on disk *and* explicitly approved — before starting the
next.** Do not draft, or even ask about, later-phase content while a phase is open: if an
answer drifts ahead, acknowledge it briefly, note it for later, and steer back. Do not
branch into a multi-question detour about later-phase topics. Talk is not output after
Phase 0; the `.plain` files are.

When entering a phase, read its reference file and walk its topics **in order**. Skip a
topic only if it genuinely does not apply, and say so explicitly. Between phases, summarize
and get explicit overall confirmation before continuing.

## Question style

- Prefer short, direct sentences over compound or nested clauses.
- Use plain words over jargon when both convey the same meaning.
- One idea per sentence; split a comma-chained list of clauses into separate sentences.
- Never drop detail to simplify — keep every constraint, edge case, option, and piece of context the user needs to answer accurately, splitting into more sentences instead.

## Error handling

- **A user answer contradicts prior specs** → edit the affected snippet in place immediately, then continue the loop; surface a non-trivial change in the next question.
- **`check-plain-env` returns `FAIL`** (testing phase) → walk each gap with the user; install, swap to an alternative, or explicitly acknowledge it before the handoff phase. Re-invoke after any install.
- **`plain-healthcheck` returns `FAIL`** (handoff phase) → do not present the render command; work through its numbered list with the right edit skill and re-run until it passes.
- **Environment failure** (`plainwright` not on PATH, `PLAINWRIGHT_API_KEY` unset) → tell the user exactly what is missing and how to fix it; never pretend the check passed.

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

This phase has no gate: there is nothing on disk to review, and the user's confirmation is
the check. Still call `write_artifact` with `intent.md` holding the confirmed brief — later
phases and their judges rely on it.

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

Finish by summarizing the stack and architecture, getting explicit confirmation, and writing
the evidence record to `stack.md`.

### specs

Read `references/specs.md`. Carry the confirmed intent brief and the settled stack in; do not
restart either.

Walk its topics in order: description, users and product shape, scope, entities, features,
flows, constraints, UI if there is one, anything else. Run the core loop on each.

Author concepts into `***definitions***` via `add-concept`, defined before use. Author each
feature as functional specs via `add-functional-spec(s)`, each under 200 LOC, in chronological
build order.

**Queue each functional spec for building the moment the user approves it** — `start_render`
with the file and that functionality's id — then ask the next question. Re-queue with
`regenerate: true` anything you later edit. Report each build result between questions.

Any `***implementation reqs***` written here must be technology-free policy; the technology
was settled in the stack phase. Write no `***test reqs***` or `***acceptance tests***` here.

Finish by summarizing the full feature list and the module and concept layout, getting
explicit confirmation, and writing the evidence record to `specs.md`.

### testing

Read `references/testing.md`. State the planned `config.yaml` split — one per part — and
confirm it before the first topic.

Honor the hard partition: every `:UnitTests:` fact belongs in `***implementation reqs***`,
every `:ConformanceTests:` fact in `***test reqs***`. Never share a bullet between them.

Walk the topics in order: unit test types and architecture, the conformance decision, the
prepare-environment decision, layout, execution, other constraints, anything else. The unit
test framework was settled in the stack phase — do not ask again. Ask the conformance and
prepare-environment decisions explicitly; they are recorded decisions, not inferences. If
conformance is on, walk every functional spec one at a time and add acceptance tests via
`add-acceptance-test`.

Generate the needed scripts under `test_scripts/` via the `implement-*-script` skills, and add
each `*-script:` entry to the right `config.yaml`.

Deal here with any build that failed during the specs phase: use `render_status` to see what
did not pass, fix the spec, and re-queue with `regenerate: true`.

Run `check-plain-env`. It must return `PASS`, or return `WARN`/`FAIL` with each remaining item
explicitly acknowledged by the user; re-invoke it after any install.

Finish by recapping the testing strategy, getting explicit confirmation, and writing the
evidence record to `testing.md`.

### handoff

Read `references/handoff.md`.

Identify the render target: the last module in the dependency chain, or the single module.
Run `init-config-file` to build the final `config.yaml`(s), resolving any precondition gap
with the user before validating.

Run `plain-healthcheck` and work its numbered list until it passes. Never present the build
command on a `FAIL`.

Wait for every queued build to finish, and report what was built: which functionalities
succeeded, which did not, and where the code is. Then give the user the command to build
anything outstanding, plus every side-channel script generated in the testing phase. Write the
evidence record to `handoff.md`.
