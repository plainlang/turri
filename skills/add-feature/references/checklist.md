# Add Feature Checklist

Use this to verify the workflow was followed - never as a substitute for it. Walk it once in the
review step, before the handover. A box counts only when the change is in the `.plain` files, not
merely discussed; an unmet box is completed with a spec diff before finishing.

## Intent

- [ ] Asked the five core questions of `references/intent.md` one at a time - or confirmed in one
  line what the user had already said - with at most one clarification for a vague answer.
- [ ] Wrote nothing to disk before the brief was confirmed.
- [ ] Summarized motivation, affected user, desired outcome, observable success criterion, and
  boundary with explicit exclusions; got explicit confirmation.

## Scope

- [ ] Read the target `.plain` file(s) whole, with their `import` and `requires` chains, and the
  config that says whether conformance tests are on.
- [ ] Asked which module only when it was genuinely ambiguous.

## Every product question

- [ ] Asked exactly one question via `ask_user`, about the product - a trigger and outcome, an edge
  case, a rule, a permission, a step of a flow - never about a spec section.
- [ ] Turned the answer into exactly one spec change, across every section it needed, and wrote it
  with `write_spec_diff` - never with `write` or `edit`.
- [ ] Concepts defined in the same change as, or before, what first uses them; no cycles.
- [ ] Every functional spec follows `add-functional-spec`'s rules, passed its complexity and
  conflict checks, and sits in build order; one too big was split with the user.
- [ ] Every change to something already specified - built or still queued - was put to the user
  first (keep / augment / replace) and written as a diff with `fixes_earlier`.
- [ ] Every correction of this feature's own changes was a diff with `fixes_earlier`, before the
  next question.
- [ ] `***test reqs***` and `***acceptance tests***` only with conformance tests on.
- [ ] Asked whether the feature is fully covered before leaving the loop.

## Review

- [ ] Read the modified `.plain` file(s) whole and checked: concepts defined before use, no cycles,
  build order right end to end, functional specs language-agnostic, every external interface
  explicit, acceptance tests consistent with their functional specs.
- [ ] Ran `validate` on every module touched, and fixed what it reported with spec diffs.
- [ ] Handed over: the spec changes in order, the builds they queued and how they stand, and that
  further changes are asked for in the conversation as spec diffs.
