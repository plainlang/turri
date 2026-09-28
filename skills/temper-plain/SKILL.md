---
name: temper-plain
description: >-
  Temper a rough `***plain` spec until it renders cleanly: render it, wait for the builds, read back
  what they had to decide on their own - the coding agents' assumptions, their pitfalls, the
  diagnosis of a build that failed, a spec that contradicts itself - and write into the spec what it
  should have said, as spec diffs that re-render only what they change. Round after round, until a
  round finds nothing new. Asks the user only for product decisions the spec leaves open. Use when
  the user has a rough or hand-written spec and wants it made to build, or says to render it and fix
  the spec as it goes. Not for starting from nothing (forge-plain, spark-plain) or adding a feature
  (add-feature).
allowed-tools: [read, write, edit, bash, ls, grep, find, write_spec_diff, render_spec, wait_for_jobs, spec_findings]
metadata:
  # It writes its fixes one after another, from what the builds recorded: no answer between them.
  paced: false
---

# Temper Plain

Load the `***plain` syntax rules before writing anything - they are in the system prompt under
`<plain-rules>`; read `forge/rules/<name>.md` for the full text of any rule you need to follow
closely.

## Role

Act as a `***plain` spec writer who hardens a spec by building it. The only output is changes to
`.plain` files (and the testing scripts a build needs) - never code: the code is rendered, and when
it is wrong because the spec was silent or unclear, the fix is in the spec.

Where a spec is silent, the agent that renders it decides - a format, a default, an error, a rule -
and writes that down as an assumption. A build can pass on a guess. Tempering turns every guess that
matters into something the spec says, so the next render does not have to guess, and turns every
failure the spec caused into the spec saying what was meant.

It does not rewrite the spec to taste, add features, or tidy wording nobody tripped over: what goes
in is what the builds needed. It never changes what the user meant, and never writes the spec to
match code that does something else.

## Steps

### intake

1. Find the spec: the `.plain` file(s) the user named, or the module(s) of the project if they said
   none - ask only when that is genuinely ambiguous. Read them whole, with their `import` and
   `requires` chains, and the project's `config.yaml` (and `config.<module>.yaml`).
2. Run `check_plain` on each. Fix only what stops it parsing: with the file tools while nothing is
   built from it, with `write_spec_diff` once something is. Nothing else changes before the first
   render - the builds say what is missing, not a read of the spec.
3. Make sure a build can start: the unit testing script (and, with conformance tests on, the
   conformance testing script) that plainwright finds - named in the config, or the one in the root
   or `test_scripts/`. When one is missing, write it by following the `implement-unit-testing-script`
   (or `implement-conformance-testing-script`) skill, for the stack the spec's implementation reqs
   name.

Say in two lines what will be rendered, and go on. Do not ask for confirmation.

### render

Queue the build of each module with `render_spec`: a module that requires another after the one it
requires; modules that share nothing together, since they build side by side. Say which jobs it
queued, and go on.

### temper

Run rounds until one finds nothing new, and at most five:

1. **Wait** with `wait_for_jobs` - again while some are still running - and note how each build ended.
2. **Read** what the builds recorded with `spec_findings` (pass the module's `plain_file`). Each
   finding is numbered and given once.
3. **Decide each finding**, and note the decision against its number:
   - **An assumption about what the software does** - a format, a default, a limit, an error and its
     message, a rule, an order, what happens in an edge case: something a user, a caller or another
     module can see, or a test checks. That belongs in the spec. Write it in as the build assumed it -
     the code already does it that way - unless it contradicts what the spec or the user meant; then
     write what was meant.
   - **An assumption about how it is built inside** - a library, a file layout, a name, a structure
     nobody outside sees: not the spec's. Leave it.
   - **A spec conflict** - two functional specs that cannot both hold: the user's to settle. Ask with
     `ask_user`, quoting both, and write their answer.
   - **A diagnosis** of a build that failed for good: when it says the fix is in the spec, write the
     fix it names; when it says code, environment or plainwright, the spec stays - note it for the
     report.
   - **A pitfall**: only one that points at the spec - a spec that was misread, a gap that sent the
     build the wrong way - is a finding for it. The rest are the builds' own.
   - **A choice the spec leaves open where more than one answer is plausible and it matters to the
     user** - which of two behaviours, what a user sees: ask with `ask_user`, with the options the
     builds considered, before writing it. Never ask what the builds already settled well.
4. **Write the fixes as spec diffs** with `write_spec_diff` - a git diff of the `.plain` file(s),
   paths from the project root, a few lines of context. One diff per concern: a functionality's
   missing rules together, a concept and what it means together; never one diff for everything. Put
   each where it belongs: a rule of one functionality into its functional spec, a policy for many
   into `***implementation reqs***`, a term into `***definitions***`, following `add-concept`,
   `add-functional-spec` and `add-implementation-requirement` for how it is written. Each diff is
   rendered as a spec diff job, and the queue master works it into what is still queued - only what
   it changes is rendered again. Never edit a `.plain` file with `write` or `edit` once rendering has
   started.
5. **Build what failed again**: a build that failed for good stops what was queued behind it on its
   module. Once its fixes are written, call `render_spec` for that module again - it queues what is
   still not built from the spec.

A round with no new finding that belongs in the spec, and no build that failed for a spec reason,
ends the tempering. So do five rounds: what is still open then goes in the report.

### report

A short account, in a few lines each:

- what was rendered, and how the builds stand now (`wait_for_jobs` once more if any are running);
- every finding written into the spec - its number, what the spec now says, and the spec diff job
  that renders it;
- every question put to the user, and the answer written;
- what was left out of the spec, and why - internal choices, and failures that were the code's, the
  environment's or plainwright's, with what the diagnosis said to do;
- what is still open after the last round.

Then say the spec is tempered as far as the builds pushed it, and that any further change is asked
for in the conversation, as a spec diff the queue master works into the builds still queued.
