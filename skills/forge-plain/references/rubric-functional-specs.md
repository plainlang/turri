<!-- Included at the top of every phase rubric. -->

You are reviewing the **functional specs** phase of a `***plain` spec-authoring interview -
the second half of the product interview, which decides the behavior: the functionalities,
their order, and what gets built.

The artifact you were given is the **phase evidence record**: the ordered account of what
happened this phase — each question asked, its answer, the snippet written or edited in
response (for a functional spec, the `write_functional_spec` call and the job it started), and every explicit decision, including
the confirmation that closed the phase. You also have read-only access to the project, so you
can check the files yourself.

Verify each box by its tag:

- **[record]** — check against the evidence record. The disk cannot show it.
- **[disk]** — check against the files, independently. Ignore what the record claims.
- **[both]** — the record claims it and the disk must corroborate. Flag any mismatch, for
  example a spec the record says was written that is not on disk.

A box is met only when its own source confirms it. Read `forge/rules/` as needed so boxes
about ≤200 LOC, define-before-use and language-agnostic wording can actually be assessed.

## Every loop iteration

- [ ] **[record]** Asked exactly one focused question each iteration — not two bundled together.
- [ ] **[both]** Wrote the snippet to disk immediately after the answer, using the dedicated edit skill — never hand-authored a `***plain` section directly.
- [ ] **[record]** Said in one line what each write put on disk, and moved on without asking for approval of it.
- [ ] **[both]** Any answer that contradicted an earlier spec was fixed in place before the next question, with `write_functional_spec` and `replaces` — no stale spec left on disk.

## One spec at a time

- [ ] **[both]** At most one functional spec was written per answer, each with its own `write_functional_spec` call — which also started its build. Every functional spec on disk has a build job in the record.
- [ ] **[record]** An answer that decomposed into several specs became several questions, one spec each — not a batch written from one answer.
- [ ] **[record]** A feature too large for one spec was broken down with the user in the next question, never alone.
- [ ] **[both]** Any concept added here was added via `add-concept` before the spec that references it, one at a time.

## What this phase decides

- [ ] **[record]** Carried the confirmed intent brief, the settled stack, and the concept list in; restarted none of them.
- [ ] **[record]** Walked the phase topics in order (features, flows, constraints, UI if any, anything else).
- [ ] **[both]** Every feature is on disk as functional specs via `add-functional-spec`, each ≤200 LOC, in chronological build order.
- [ ] **[disk]** Every functional spec is language-agnostic — none names a language, framework or library.
- [ ] **[disk]** No `***test reqs***` or `***acceptance tests***` written in this phase.
- [ ] **[disk]** Every `***implementation reqs***` bullet written this phase is technology-free policy — none names a language, framework, library, storage engine, or deployment target.
- [ ] **[record]** The interview never waited on a build. Questions continued while renders ran, and build results were reported when they arrived rather than blocked on.
- [ ] **[record]** Summarized the full feature list in build order, said what is built and what is still queued, and got explicit confirmation.
