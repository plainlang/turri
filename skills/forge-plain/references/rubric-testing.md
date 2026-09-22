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

## Phase 3 — How is testing done?

- [ ] **[record]** Read `phase-3-testing.md`; stated the planned `config.yaml` split (one per part) and confirmed it before topic 1.
- [ ] **[disk]** Honored the hard partition — every `:UnitTests:` fact in `***implementation reqs***`, every `:ConformanceTests:` fact in `***test reqs***`; never shared a bullet.
- [ ] **[record]** Walked topics in order (unit framework, unit types/architecture, conformance decision, prepare-environment decision, layout, execution, other constraints, anything else).
- [ ] **[disk]** Generated the needed scripts under `test_scripts/` via the `implement-*-script` skills and added each `*-script:` entry to the right `config.yaml`.
- [ ] **[both]** Conformance decision was asked explicitly; if yes, walked every Phase-1 functional spec one at a time for acceptance tests via `add-acceptance-test` (acceptance tests present on disk when the decision was yes).
- [ ] **[record]** Prepare-environment decision was asked explicitly and recorded.
- [ ] **[record]** Recapped the testing strategy; got explicit overall confirmation.
- [ ] **[record]** Ran `check-plain-env`; it returned `PASS`, or `WARN`/`FAIL` with each remaining item explicitly acknowledged by the user (re-invoked after any install).
