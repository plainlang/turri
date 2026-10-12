# the intent phase — What is the intent?

Extract the user's intent before creating files or decomposing the product into specifications.
Keep this phase short. Ask exactly five core questions, one at a time, and do not write to disk.

The harness has already asked the first question of this phase: how many questions the stack and
product phases may ask - light (3), medium (5), thorough (10) or best judgement. Do not ask it
again; this phase's own questions are not capped by it.

## Questions

1. **Problem** — What problem should this software solve?
2. **Primary user** — Who is it mainly for?
3. **Desired outcome** — What should that user be able to accomplish with it?
4. **Success criterion** — What observable result would make the first version useful?
5. **Initial boundary** — What should the first version deliberately leave out?

Ask one focused follow-up only when an answer is too vague to summarize. Do not explore features,
entities, technology, architecture, or testing yet; those belong to later phases.

## Intent brief

Summarize the answers in five short bullets:

- Problem
- Primary user
- Desired outcome
- Observable success criterion
- Initial boundary and explicit exclusions

Ask the user to confirm or correct the brief with one `ask_user` question, the five bullets passed whole as its
`context` - the dialog shows only the question, its options and its `context`. The intent phase finishes only after
explicit confirmation.
Carry the confirmed brief into the stack and product phases so their questions refine it instead of restarting intent
discovery.
