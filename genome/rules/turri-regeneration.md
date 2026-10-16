---
description: How turri regenerates the code from a spec change - by spec diff, in the chain's tip - so a spec is placed by what it means, never by what regenerating it would cost
---

# How turri regenerates the code

The other rules say what a spec means. This one says what turri does with a change to it, so that
where a change goes is never decided by a wrong idea of what it costs.

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

## So place a spec by what it means

- Put a functional spec where it belongs: in the module that owns the concern, at the point in its
  order where what it relies on has been said
- Never put a spec at the end of a module, or in the tip, only to spare regeneration - it spares none
- What does cost more is asked for outright, never brought on by placement: regenerating a functional
  spec again, or a module or chain from scratch
