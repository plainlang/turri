# the functional specs phase — What does it do?

The second half of the product interview. The concepts are settled; this phase decides the
behavior: one functional spec at a time, each built the moment it is written.

Carry the confirmed intent brief, the settled stack, and the concept list in. Do not restart
any of them.

## One question, one spec, one build

Every iteration is exactly one `ask_user` call and one `write_functional_spec`:

1. **Ask one question** — a single trigger and its outcome, one edge case, one constraint.
   Never bundle two.
2. **Write exactly one functional spec** with `write_functional_spec`, authored following
   `add-functional-spec`: ≤200 lines of code change, language-agnostic, in chronological
   build order. It writes the spec into `***functional specs***` and starts building it in
   the same call - there is no separate render step. Go straight to the next question
   without waiting.

`write` and `edit` refuse to change the `***functional specs***` section; everything else in
the file they change as usual.

**Never write a second functional spec before asking about it.** Each spec is built on top
of the ones before it, so a spec the user was never asked about becomes a foundation they
never agreed to. An answer that decomposes into several specs is several questions: write
the first, ask about the next. `write_functional_spec` takes one spec per call and refuses a
new one until a question has been answered since the last.

**Fix contradictions in place.** If a later answer refines or contradicts a spec already on
disk, rewrite that spec now, before the next question: `write_functional_spec` with
`replaces` set to its id.

**Anything already built whose spec has since changed is rebuilt automatically.** Every
`write_functional_spec` call checks what has been built against the specification as it
stands and queues a regeneration for whatever has drifted, so editing functionality 1 while
writing functionality 4 rebuilds 1 first. `requeue_stale_renders` does the same check on
demand.

## Author targets for this phase

- **`***functional specs***`** — one per answer, written with `write_functional_spec`.
- **`***definitions***`** — only when a spec needs a concept that does not exist yet. Add it
  via `add-concept` before the spec that references it, one concept at a time, and say in one
  line that the vocabulary grew.
- **`***implementation reqs***`** — only a requirement that can be stated without naming a
  technology: an error-handling or retry policy, an idempotency or ordering guarantee, a
  data-format or precision rule. Use `add-implementation-requirement`, on the module whose
  behavior it constrains. The moment stating it takes a language, framework, library, storage
  engine, or deployment target, it was a stack answer — note it and steer back.

Write no `***test reqs***` and no `***acceptance tests***` here; they belong to the testing
phase.

## Topics (in order)

1. **Key features** — every distinct thing the app should do. For each feature, one question
   for the trigger and expected outcome, then one question per edge case or validation rule.
   One functional spec per answer, in chronological build order. If a feature is too large
   for one spec, break it down *with the user* — that is the next question, not a decision
   made alone.
2. **User flows** — walk through the app from the user's perspective: what happens first,
   what next, and at each decision point. Author the ordering and any missing intermediate
   spec, one at a time.
3. **Constraints and rules** — business rules, validation, permissions, error-handling
   behavior. Fold the observable part into the relevant functional spec; route the part that
   shapes how the behavior is built to `***implementation reqs***`.
4. **User interface (optional)** — skip entirely if there is no UI. Otherwise, one question
   per iteration: how it looks and feels, where the key elements are, what they do, the
   layout. Author UI-behavior specs, still language- and framework-agnostic.
5. **Anything else** — anything the user wants to add or change that has not been covered.

## The reviewer reading along

A read-only reviewer re-reads the module every time you write a functional spec, against the
same standard the phase is judged by: ≤200 LOC per spec, language-agnostic, explicit
interfaces, chronological order, no contradiction, concepts defined before use.

Its findings arrive on your next `write_functional_spec` or `render_status` result. Fix the
spec they name before the next question, with `write_functional_spec` and `replaces`. If a finding
carries a question, ask the user at your next turn, say it came from the review, write the
answer to disk, and pass it back with `reply_to_review`.

Never wait for the reviewer, and never ask the user to wait for it. Anything still
unresolved when the phase closes fails the phase gate, so an ignored finding is the one
thing here that can cost a whole phase.

## Reporting builds

Report each build result between questions, in a sentence: which functionality built, and
whether its unit tests passed. Never wait on a build. A failed build does not stop the
interview — note it and carry on, unless the failure shows the spec itself is wrong, in which
case fix the spec with `write_functional_spec` and `replaces`, which rebuilds it.

## Closing

Summarize the full feature list in build order, say which functionalities are built and which
are still queued, get explicit confirmation, and write the evidence record to
`functional-specs.md`.
