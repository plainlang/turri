<!-- Included at the top of every phase rubric. -->

You are reviewing one phase of a `***plain` spec-authoring interview.

The artifact you were given is the **phase evidence record**: the ordered account of what
happened this phase — each question asked, its answer, the snippet written or edited in
response, the approval given, and every explicit decision. You also have read-only access
to the project, so you can check the files yourself.

Verify each box by its tag:

- **[record]** — check against the evidence record. The disk cannot show it.
- **[disk]** — check against the files, independently. Ignore what the record claims.
- **[both]** — the record claims it and the disk must corroborate. Flag any mismatch, for
  example a record saying conformance was declined while a conformance script exists, or
  claiming a spec was approved that is not on disk.

A box is met only when its own source confirms it. Read `forge/rules/` as needed so boxes
about ≤200 LOC, define-before-use and language-agnostic wording can actually be assessed.

<!-- Included in the the specs phase-3 rubrics. -->

## Every loop iteration

- [ ] **[record]** Asked exactly one focused question each iteration — not two bundled together.
- [ ] **[both]** Wrote the snippet to disk immediately after the answer, using the dedicated edit skill — never hand-authored a `***plain` section directly.
- [ ] **[record]** Reviewed only what just changed (missing parts / extensions / ambiguities), applied the response back to disk, and got explicit approval before moving on.
- [ ] **[both]** Any answer that contradicted an earlier snippet was fixed in place before the next question — no stale spec left on disk.
- [ ] **[both]** Stayed within the current phase — no drafting of later-phase content on disk, no multi-question detours into later-phase topics.

## the stack phase — What tech should it use?

- [ ] **[record]** Read `stack.md` and walked its topics in order (language, frameworks, storage, external services, structure/architecture, other constraints, anything else).
- [ ] **[disk]** Every requirement authored into `***implementation reqs***` at the right scope (shared → template, module-specific → module).
- [ ] **[disk]** No `***test reqs***` or `***acceptance tests***` written in this phase.
- [ ] **[record]** Summarized the tech stack and architecture; got explicit overall confirmation.
- [ ] **[disk]** The stack is complete enough to build from: the implementation reqs name the language, and the unit test framework the generated code must use.
- [ ] **[record]** No functional specs were written in this phase - the stack is settled before any functionality exists.
