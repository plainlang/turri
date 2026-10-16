---
description: How turri regenerates the code from a spec change - by spec diff, in the chain's tip - what each kind of change sets off, what a coding agent sees, how bad code is fixed and where the cost really is, so a spec is placed and written by what it means, never by a guess at what regenerating it costs
---

# How turri regenerates the code

The other rules say what a spec means. This one says what turri does with a change to it, so that
where a change goes, and how it is made, is never decided by a wrong idea of how turri works. Each
section ends in the same place: decide by what the spec means.

## A change is regenerated as a spec diff

- turri regenerates the code from spec diffs: what changed between the spec the code was built from
  and the spec now
- A functional spec added, changed or taken out is that change alone, wherever it sits - first, in the
  middle or last of its module
- The specs around it are not regenerated because their position or numbering moved, and nothing after
  it is built again. A spec inserted in the middle is one addition
- "Specs render top to bottom, each knowing only the ones before it" is about what a spec may assume
  (`func-specs.md`), not about what a change costs

## A change is regenerated in the chain's tip

- A chain's code lives in its tip - the furthest module built on it. The modules below it keep the
  code they were built with
- A change to any module of the chain, the base's included, is regenerated in the tip's code - not in
  the module the change was made in
- Putting a change in a lower module costs no more than putting it in the tip, and saves nothing
  either
- Moving specs between modules of the chain renders nothing. Moving specs into a module the code was
  never built on is the exception: no change to the code brings that module in, so the chain has to be
  regenerated from scratch - never done without the person agreeing

## What each kind of change sets off

- A functional spec added is built, with its unit tests; one changed is patched in place; one taken
  out has its code, and the tests only it had, removed
- A definition changed patches every functional spec that uses its concept, directly or through other
  definitions. So does a change to a linked resource: the spec or definition linking it is changed
  though its text is not. A widely used definition is the costly edit - not a spec's position
- Implementation reqs alone, or definitions no functional spec uses, are a mechanical change: the code
  adapts, and no test is written or changes what it asserts
- Test reqs and acceptance tests reach the conformance tests only, never the code
- Definitions moved to a common module and reqs reordered are recorded, not rendered

## What a coding agent sees

- A coding agent sees its prompt and its module's code - nothing else. It cannot read `.plain` files,
  this conversation, AGENTS.md or the person
- What the code needs to know has to be in the spec. A fact said only in the conversation, AGENTS.md or
  notes never reaches the code, and is lost at the next regeneration
- Steering reaches the agents that plan the work - how it is cut and in what order - not what the code
  does. What the code does is changed in the spec

## How bad code is fixed

- Never edit the code under `plain_modules/`: the next regeneration does not keep it, and the code
  record no longer says what the code is
- In order of cost: change the spec where it is wrong or silent; regenerate the functional specs whose
  code went bad again, by name; regenerate the module from scratch, or its whole chain - only when the
  person asks for it or agrees to it
- A pulse that does not land is rolled back whole - code, tests and record together - and its module
  waits until the spec changes or the module is asked for again. Running it again unchanged usually
  ends the same way: look at why it did not land first

## Where the cost is

- The cost is the work regenerated: how many functional specs a change touches, directly or through
  the definitions they use, cut into pulses of at most `max-specs-per-pulse`
- Regenerating functional specs again, or a module or chain from scratch, costs most, and is only ever
  asked for outright
- Placement never adds cost. Put a functional spec in the module that owns the concern, at the point
  in its order where what it relies on has been said; never at the end of a module, or in the tip,
  only to spare regeneration - it spares none
- Never write placement for cost into AGENTS.md, a skill or notes: what is written there is read back
  later as how the project works
