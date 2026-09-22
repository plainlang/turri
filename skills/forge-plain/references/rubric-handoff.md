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

## the handoff phase — Validate and hand off

- [ ] **[disk]** Identified the render target — the last module in the dependency chain (or the single module).
- [ ] **[both]** Ran `init-config-file` to build the final `config.yaml`(s); resolved any precondition gap with the user before validating.
- [ ] **[record]** Ran `plain-healthcheck`; worked its numbered list to `PASS` — never presented the render command on a `FAIL`.
- [ ] **[record]** Presented the render command only after the dry-run passed, plus every side-channel script actually generated in the testing phase.
