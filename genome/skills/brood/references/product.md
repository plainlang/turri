# the product phase — What does it do?

The whole product interview, in one phase, walked **feature by feature** - not section by
section. There is no pass that fills in the definitions and then another that writes the
functional specs. Each question is about the product: a feature, a step in a flow, a rule.
Its answer becomes one spec change that touches whatever sections that answer needs - the
concepts the feature introduces, a policy it needs, its functional spec - and every spec change
is built the moment it is written.

Carry the confirmed intent brief and the settled stack in. Do not restart either.

## How many questions

The questioning level caps this phase's questions (light 3, medium 5, thorough 10, or best
judgement - `SKILL.md`, "How many questions"), and so sets how broad each is. Every level walks
all the topics below: light in a few broad questions - the features and their order in one, what
they do end to end in another, with what fits the brief proposed for the person to confirm or
correct; thorough in narrow ones, a feature, rule or edge case each. The level limits the
questions, never the spec changes:

- **Every answer is a spec change**, at every level: written with `write_spec_diff` and built at
  once, before the next question - `ask_user` refuses the next question until it is. A broad
  answer covering several features is a change for each.
- **What the questions leave open is yours** - the details under a broad answer, and everything
  still open once the questions are over (the cap reached, or `end_questions` called). Each
  feature, edge case and rule you decide is its own spec change, written with `write_spec_diff`
  with no answer needed before it, and said in one line. Write as many as the product needs.
  Decide from the intent brief and the answers so far; leave out what they do not call for rather
  than invent scope.

## One question, one answer, a spec change, a render

Every iteration is exactly this, at every questioning level:

1. **Ask one question** with `ask_user`, about the product: a feature, its trigger and outcome,
   one of its edge cases or rules, the next step of a flow - as broad as the level says. Never bundle two, and never ask about
   a spec section ("what concepts are there?", "what reqs apply?") - ask about what the product
   does, and let the answer decide which sections change.
2. **Turn the answer into a spec change** - one for each feature it covers - everything it calls for, across sections:
   - a concept the feature introduces, into `***definitions***`, following `add-concept`, defined
     in the same change as the functional spec that first uses it;
   - a technology-free policy the answer states, into `***implementation reqs***`;
   - the functional spec for the feature, or the change to one already written, following
     `add-functional-spec`.
   Write it as a git diff of the `.plain` file(s): `diff --git a/<file> b/<file>`,
   `--- a/<file>`, `+++ b/<file>`, then the hunks with a few lines of unchanged context. Paths
   are relative to the project root.
3. **Write it with `write_spec_diff`.** It applies the diff and starts a render spec diff job for
   it in the same call - whatever the change touches, a definition alone included. Write every
   change the answer calls for before the next question - `ask_user` refuses it until then - and
   any you decide yourself beside them. Move straight on to the next question; never wait for a
   build.

**One answer, at least one change.** A follow-up about the same feature - an edge case, a
validation rule - is its own answer and its own change to that feature's spec. An answer that
describes two features is two changes, both written before the next question. A change never
carries both an answer and something you decided: what you decide is a change of its own.

**Fix contradictions in place.** When a later answer refines or contradicts something already
written, write the correction as its own diff with `fixes_earlier` set, before the next
question. It is rendered like any other change.

**Never edit the `.plain` files with `write` or `edit` in this phase.** A change that does not
go through `write_spec_diff` is a change nothing renders.

## What a change may contain

- **`***definitions***`** - the concepts the change needs, each defined before, or in the same
  change as, what first uses it.
- **`***functional specs***`** - at most one new functionality per change: ≤200 lines of code
  change, language-agnostic, in chronological build order, externally explicit where it has an
  interface.
- **`***implementation reqs***`** - only technology-free policy: an error-handling or retry
  policy, an ordering guarantee, a data-format rule. The technology was settled in the stack
  phase; an answer that needs a new technology is a stack answer - note it and steer back.

Leave the `***test reqs***` as the testing phase wrote them, and write no `***acceptance tests***`.
With conformance on, every change is built with its conformance tests - from the test reqs as they
stand.

## Topics (in order)

1. **Product description** - propose a one-sentence description from the confirmed intent brief,
   state it back in one line, and write it into the frontmatter as the first change.
2. **Features, one at a time, in build order** - the smallest thing that is useful first, then
   what builds on it. For each feature: one question for what triggers it and what comes out,
   then one per edge case, validation rule or permission that is not obvious. Each answer is a
   change: the first brings the feature's concepts and its functional spec; the follow-ups refine
   them. A feature too large for one functional spec is split *with the user* - that is the next
   question.
3. **User flows** - walk the product from the user's side: what happens first, what next, and at
   each decision point. Each missing step is a feature, taken the same way.
4. **User interface (optional)** - skip entirely if there is none. Otherwise per screen or
   interaction: what the user sees and what it does, still language- and framework-agnostic.
5. **Anything else** - anything the user wants to add or change that has not been covered.

## The reviewer reading along

A read-only reviewer re-reads the module every time you write a spec change. Its findings
arrive on your next `write_spec_diff` or `drift` result. Fix what they name with a
diff and `fixes_earlier` before the next question. If a finding carries a question, ask the
user at your next turn, say it came from the review, write the answer as a diff, and pass it
back with `reply_to_review`. Never argue with a finding; the fix is the reply.

## Reporting builds

Report each build result between questions, in one sentence. A failed build does not stop the
interview - note it and carry on, unless it shows the spec itself is wrong, in which case fix
the spec with a diff and `fixes_earlier`.
