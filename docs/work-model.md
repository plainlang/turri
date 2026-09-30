# The work model

How plainwright decides what to build next. This page is the design, agreed before the work started,
and the stages it is being built in; each stage updates it, and when the last lands it is folded into
[rendering](rendering.md) and removed. Stages 1 to 3 have landed: the code track and the conformance track
run on it, and [rendering](rendering.md) describes them. The prompt for each case and the cleanup are
still to come.

## Why

Today the queue is a list of edits: every spec change is kept as a job holding its own diff, and a
later change can leave an earlier job's diff stale. The queue master - an agent - exists to bring the
queued diffs back in line with the spec, and around it grew one special case after another: jobs
that keep another job's id, stopping and rolling back the running job, conformance jobs tied to the
spec diffs they follow, functionality renders mixed in with spec diffs, requeueing the modules
above. Most of the queue's bugs come from there.

Yet what is left to build is already known without any of it: what the code was built from, and the
spec as it is now. After a restart the queue is rebuilt from exactly that. The new model keeps only
that.

## State

Two records per module, both committed in the module's `.plaingit`:

| | |
| --- | --- |
| `code/.plainwright.json` | the spec the code is built from - its whole requires chain's, the definitions and implementation reqs of the modules below tagged with their module - everything but the test reqs and acceptance tests |
| `tests/.plainwright.json` | the functional specs the conformance tests are written for - a subset of the code record's - and the test reqs they were written by |

- The conformance record is always a substate of the code's: conformance tests exercise
  functionality, and only functionality that lives in the code can be tested.
- Test reqs are for conformance only. Neither the code record nor any coding prompt has them.
- Each record has its notes beside it: `code/.plainwright-notes.md` and `tests/.plainwright-notes.md`.
- A module that requires another inherits both its code and its conformance tests, down the
  `requires` chain. A chain is built in its tip - its furthest-built module - where a change to a
  module below is made; the codebases below are left behind, their records saying what they are
  built from, and one is brought up to its own spec again only when a new module is to start from it.
- No migration: the old record format is dropped, and projects built with it are rebuilt.

## The work is derived, not stored

- **Code work** is `diff(code record, spec now without test reqs)`.
- **Conformance work** is `diff(tests record, the chosen functional specs of the code record + test
  reqs now)`. Chosen is every functional spec by default, with conformance on; or the part the person
  asks for.
- Only the running job is stored. Everything else - what the panel shows as the queue - is a plan
  worked out again whenever the spec changes or a job ends.
- A module's work is planned only once every module below it that is still to build has none left.
- `regenerate fs N` takes functional spec N out of the code record, so the next diff builds it again -
  changed or not. `render fs N` is gone: the work always runs to the spec as it is now.

### Stopping the running job

A fixed rule, no agent: when a spec change means a running job - code or conformance - is making
something the spec no longer wants (one of its changes is no longer in the work as derived now), it
is stopped, its work rolled back, and the work is planned again. Otherwise it finishes, and the next
plan starts from what it landed.

## Planning

- The planner cuts each track's work into jobs as the grouping and placement agents do today: each
  job is anchored on functional specs, with the definitions and reqs they use. The same cut serves
  code and conformance.
- It runs on the chat's model and takes the person's steering (`steer_queue`, AGENTS.md, a tool's
  `guidance`) as input.
- The harness still checks every cut: every change in exactly one job, the spec consistent after each,
  the last ending on the spec as it is now.
- There is no queue master.

## Order

- Code and conformance share one lane per module. After a code job lands, the conformance work it
  opened up runs before the next code job, so a bug is caught before more is built on it.
- Every conformance job also runs the whole inherited conformance suite: it is how a module is kept
  from breaking the functionality of the modules below it.
- A failing conformance test is triaged. A wrong test is fixed by the conformance agent. Wrong code
  gets a code fix job - with unit testing, adding a unit test that pins the failure. After two fixes
  that fail, the group is marked failed, stays out of the conformance record, and the person is told.

## Prompts

Each functional spec of a job falls in one case, and the case says what the agent is to do. A
functional spec is **patched** when its text changed or a concept it uses changed - the harness knows
which definitions each functional spec uses.

| case | when | code | conformance |
| --- | --- | --- | --- |
| fresh | the module requires none and nothing is built | set up the project and its unit testing script, then build these functional specs and their unit tests | set up `tests/` and the conformance testing script, which brings the tests together with `code/`, then write tests for these functional specs |
| add | a functional spec is new | build it and write its unit tests | write its tests |
| patch | its text changed, or a concept it uses did | a change: change the existing code and tests to match - do not build it again from scratch | a change: rewrite its existing tests to match |
| delete | a functional spec is gone | take out its code and the tests only it had | take out its tests |
| mechanical | no functional spec is touched - only reqs, or definitions no functional spec uses | adapt the code; existing tests may change only mechanically (imports, fixtures, setup), never an assertion; all must pass; write no new tests | the same, for test reqs, definitions or implementation reqs alone |

- Fresh applies only where nothing exists: a module that requires another starts from what it
  inherits, and its first job is add or patch.
- Every case has an implement prompt and a review prompt, for code and for conformance. A mechanical
  review checks only that no test was removed or weakened without reason; the others check that the
  code does what the spec says and its tests test it.
- A job holding several cases gets one prompt with a section for each, each section stating its
  case's rule, and the reviewer holds each section to its own.

## Stages

The new model is built beside the old one, not into it: the old queue's conformance links, and the
render paths stage 5 deletes, are not reworked on the way. Each stage lands on its own and is tried
with live runs before the next.

1. Records and work, as tested functions and nothing else yet: the two records, the code work and the
   conformance work derived from them, each job's cases, and the stop rule (`src/render/records.ts`,
   `src/render/work.ts`).
2. The new work loop, code track: in place of `queue.ts`, behind the tools the conversation calls. It
   derives the work, has the planner cut it, runs a job per lane and stops what the spec no longer
   wants. The old queue, the queue master and the conformance links go. Conformance is off from here to
   stage 3.
3. The conformance track in the loop: its record, its cases, triage, fix jobs rolled back whole when
   they fail, the inherited suite, and conformance for part of the spec.
4. The prompt matrix, for code and for conformance.
5. The functionality render and regeneration as job kinds, the older module chain, `queue-master.ts`
   and whatever else is left unused, deleted.
