---
name: mature
description: >-
  Mature a rough `***plain` spec until it is fully rendered, on its own: the goal is the spec built
  - every functionality from the spec as it stands, its tests passing - and the loop is render,
  watch the agents building it, and when one struggles on something the spec leaves open or
  unclear, settle it in the spec, stop that build and render again. It reads what the builds had to
  decide themselves - assumptions, pitfalls, a failed build's diagnosis, a spec that contradicts
  itself - and writes what the spec should have said, as spec diffs. It decides open choices itself
  and records every decision; it does not ask. It stops when the spec is fully rendered, or when it
  is stuck on something the spec cannot settle. Use when the user has a rough or hand-written spec
  and wants it made to build without steering it. Not for starting from nothing (`brood`,
  `spawn`) or adding a feature (`bud`).
allowed-tools: [read, write, edit, bash, ls, grep, find, write_spec_diff, regrow, drift, halt, watch_jobs, spec_findings]
metadata:
  # It writes its fixes one after another, from what the builds show: no answer between them.
  paced: false
---

# Mature

Load the `***plain` syntax rules before writing anything - they are in the system prompt under
`<plain-rules>`; read `forge/rules/<name>.md` for the full text of any rule you need to follow
closely.

## Role

Act as a `***plain` spec writer who hardens a spec by building it, on your own, until it builds.

**The goal:** the spec fully grown - `drift` says "Fully grown" for every module: every functionality
grown from the spec as it stands, its conformance tests too, and nothing growing or held back.

**The loop:** render what is not built; watch the agents building it; when one struggles on something
the spec leaves open or unclear, settle it in the spec, stop that build, and render again.

Where a spec is silent, the agent that renders it has to decide - a format, a default, an error, a
rule - and when the decision is hard, or the spec reads two ways, it struggles: its tests keep
failing, the judge keeps finding the tests or the code wrong, it runs far too long. Much of that is
the spec's to settle, and once the spec says it, the next build does not struggle. Some of it is not
- a bug the agent will fix, an environment problem, turri itself - and the spec stays out of
that.

You never ask the user: this runs on its own. Where the spec leaves a real choice, take the reading
that best fits the rest of the spec, the intent it states and what the builds already did, write it,
and record the decision for the report. You never change what the spec plainly means, never write the
spec to match code that does something else, never add features, never touch generated code, and
never edit a `.plain` file with the file tools once rendering has started - every change is a spec
diff, with `write_spec_diff`.

## Steps

### intake

1. Find the spec: the `.plain` file(s) the user named, or the project's modules. Read them whole,
   with their `import` and `requires` chains, and the project's `config.yaml` (and
   `config.<module>.yaml`).
2. Run `validate` on each, and fix only what stops it parsing - with the file tools, while nothing
   is built from it yet, otherwise with `write_spec_diff`.
3. Make sure a build can start: the unit testing script (and, with conformance tests on, the
   conformance testing script) turri finds. When one is missing, write it by following the
   `implement-unit-testing-script` (or `implement-conformance-testing-script`) skill, for the stack the
   spec's implementation reqs name.

Say in two lines what will be rendered, and go on.

### grow

Run cycles until the goal is met - or you are stuck - and at most twenty. Each cycle:

1. **Check the goal**: `drift` for every module. All fully grown: the goal is met - go to the report.
2. **Grow what is not grown**: `regrow` for each module that is not - one that requires
   another after the one it requires, modules that share nothing together. A module with builds still
   running or queued is left to them.
3. **Watch**: `watch_jobs`. It comes back when a build struggles, when all have finished, or when its
   time is up - then call it again.
4. **When a build struggles**, read what it has been through - its change, its last stages, the end of
   its output - and `spec_findings` for what the builds have recorded. Then judge:
   - **The spec's to settle** - the spec is silent where the build needs a decision (a format, a
     default, an error and its message, a limit, an order, an edge case); it reads two ways; two of
     its specs conflict; a test and the code disagree over something the spec never said. Write what
     the spec should say as a spec diff (below), then `halt` the struggling build - its `job_id`, and
     as `reason` what the spec now says - and `regrow`, so it grows again from the clarified spec, and go
     to the next cycle.
   - **Not the spec's** - a bug the agent is working through, a missing tool or package, a flaky
     service, turri itself. Leave the build to it, note it for the report, and keep watching.
     Stopping it would throw its work away for nothing.
5. **When the builds finish**, read `spec_findings`, and write into the spec every assumption about
   what the software does that a user, a caller or a test can see - as the build assumed it, unless
   that is not what the spec meant - so the next build does not have to guess. An assumption about how
   it is built inside - a library, a file layout, a name - stays out. A diagnosis that says the fix is
   in the spec is written; one that says code, environment or turri is noted. Then the next
   cycle: what failed, and what the new diffs changed, is rendered again.

**Writing a fix.** A git diff of the `.plain` file(s), paths from the project root, a few lines of
context, with `write_spec_diff`. One diff per concern - a functionality's missing rules together, a
concept and what it means together - never one diff for everything. Put each where it belongs: a rule
of one functionality into its functional spec, a policy for many into `***implementation reqs***`, a
term into `***definitions***`, following `add-concept`, `add-functional-spec` and
`add-implementation-requirement` for how it is written. Each diff is built as it is written: what is left
to build is worked out again from the spec - only what it changes is rendered again.

**When you are stuck, stop.** The same functionality struggling three times after you clarified the
spec for it is not something the spec can settle: stop maturing it, and report it. Two cycles in a
row with nothing newly built and nothing newly settled: stop, and report what is open. Twenty cycles:
stop, and report.

### report

A short account:

- whether the goal was met - `drift` for every module, as it is now;
- every cycle in a line: what was rendered, what struggled, what you did about it;
- every decision you wrote into the spec - what it settles, what the spec now says, and the spec diff
  job that renders it - with the ones where you chose between readings marked, for the user to check;
- what was not the spec's - code, environment, turri - with what the builds and diagnoses said;
- what is still open, when you stopped before the goal.

Then say that any further change is asked for in the conversation, as a spec diff: what is left to build
is worked out again from the spec.
