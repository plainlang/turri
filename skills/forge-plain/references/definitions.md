# the definitions phase — What are the things?

The first half of the product interview. It decides the module and the vocabulary it is
written in: the `.plain` file itself, and the concepts in `***definitions***`. No
functionality is written here — that is the phase after this one, and it is written against
the concepts settled here.

Carry the confirmed intent brief and the settled stack in. Refine them rather than
repeating their questions.

## One question, one write

Every iteration is exactly one `ask_user` call followed by exactly one write to disk.

- **One question at a time.** Never bundle two, and never ask a question whose answer does
  not translate into a single writable snippet.
- **At most one concept at a time.** An answer that names three entities is three
  iterations: write the first concept, then ask about the second. Never author a batch of
  concepts from a single answer, even when the answer lists them all — the user is
  confirming them one at a time by answering the next question about each.
- **Write immediately.** The moment the answer arrives, the snippet goes to disk. Do not
  wait for more context.
- **Fix contradictions in place** before the next question.

## Author targets for this phase

- **Module structure** — create or update the `.plain` file(s) (single module, template +
  modules, or chained modules). Set up YAML frontmatter (`import`, `requires`,
  `description`) and the module name. If a template is used, create it in `template/`
  **without** a `***functional specs***` section. Use the `create-import-module` skill where
  applicable.
- **`***definitions***`** — one concept per answer: an entity, an attribute of an entity, a
  relationship, a role. Every concept is defined before anything references it. Use the
  `add-concept` skill; never hand-author the section.

Write **no** `***functional specs***`, no `***implementation reqs***`, no `***test reqs***`
and no `***acceptance tests***` in this phase. An answer that describes behavior belongs to
the next phase: note it, say so in one line, and steer back to the vocabulary.

## Topics (in order)

1. **Product description** — propose a one-sentence description and module name from the
   confirmed intent brief. State it back in one line, then author the stub `.plain`
   frontmatter.
2. **Users and product shape** — refine the primary user and identify whether this is a CLI,
   web app, API, desktop app, mobile app, library, or another shape. Author any concept the
   answer introduces.
3. **Scope** — translate the confirmed smallest-useful boundary and exclusions into a
   cohesive MVP, prototype, or product module structure. Ask only about unresolved
   boundaries.
4. **Core entities** — the main "things" in the system (Users, Tasks, Orders, Messages, …).
   One question per entity, then one question per attribute or relationship that is not
   obvious. Author one concept per answer.
5. **Roles and states** — any first-class role, status, or lifecycle state the entities
   have, one concept at a time.
6. **Anything else** — any other term the next phase will need to refer to.

Keep asking follow-ups within a topic until each concept is specific enough that a
functional spec could be written against it without guessing.

## Closing

Run `plainwright check` on the module so the next phase does not start writing
functionalities on top of a file that does not parse.

Summarize the module layout and the full concept list and get explicit confirmation. There
is no review gate on this phase — the user reading the concept list back is the check.
