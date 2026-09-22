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

<!-- Included in the Phase 1-3 rubrics. -->

## Every loop iteration

- [ ] **[record]** Asked exactly one focused question each iteration — not two bundled together.
- [ ] **[both]** Wrote the snippet to disk immediately after the answer, using the dedicated edit skill — never hand-authored a `***plain` section directly.
- [ ] **[record]** Reviewed only what just changed (missing parts / extensions / ambiguities), applied the response back to disk, and got explicit approval before moving on.
- [ ] **[both]** Any answer that contradicted an earlier snippet was fixed in place before the next question — no stale spec left on disk.
- [ ] **[both]** Stayed within the current phase — no drafting of later-phase content on disk, no multi-question detours into later-phase topics.

## Phase 1 — What are we building?

- [ ] **[record]** Carried the confirmed Phase 0 intent brief into `phase-1-product.md`; refined it without restarting intent discovery.
- [ ] **[record]** Walked Phase 1 topics in order (description, users/product shape, scope, entities, features, flows, constraints, UI if any, anything else).
- [ ] **[disk]** `.plain` module structure created with YAML frontmatter; template (if any) has no `***functional specs***`.
- [ ] **[both]** Every concept authored in `***definitions***` via `add-concept`, defined before use.
- [ ] **[both]** Every feature authored as functional specs via `add-functional-spec(s)`, each ≤200 LOC, in chronological build order.
- [ ] **[disk]** No `***test reqs***` or `***acceptance tests***` written in this phase.
- [ ] **[disk]** Every `***implementation reqs***` bullet written this phase is technology-free policy — none names a language, framework, library, storage engine, or deployment target.
- [ ] **[record]** Summarized the full feature list and module/concept layout; got explicit overall confirmation.
