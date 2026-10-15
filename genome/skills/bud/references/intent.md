# The intent step - what is the feature for?

Extract the intent of this feature before choosing files or authoring specifications. Ask exactly
five core questions, one at a time, and do not write to disk.

The harness has already asked the first question of this phase: how many questions the product
phase may ask - light (3), medium (5), thorough (10) or best judgement. Do not ask it again; this
phase's own questions are not capped by it.

## Questions

1. **Motivation** — What problem or limitation should this feature address?
2. **Affected user** — Who should benefit from or interact with this feature?
3. **Desired outcome** — What should that user be able to accomplish after the feature exists?
4. **Success criterion** — What observable result would prove the feature is useful and working?
5. **Boundary** — What should this feature deliberately leave unchanged or out of scope?

Ask one focused follow-up only when an answer is too vague to summarize. Do not choose concepts,
spec wording, implementation technology, or tests yet - the product questions decide those, one
spec change at a time.

## Feature-intent brief

Summarize the answers in five short bullets:

- Motivation
- Affected user
- Desired outcome
- Observable success criterion
- Boundary and explicit exclusions

Ask the user to confirm or correct the brief. The intent step finishes only after explicit
confirmation. Carry the brief into the scope step, so it maps the intent onto existing modules
instead of restarting the feature discussion.
