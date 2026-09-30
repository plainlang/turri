# Rendering

What happens when a spec is turned into code - in which order, by which agents, and what has to
be true before the harness moves on. The order is the harness's, not the agents': an agent writes
code or tests, and the harness decides what runs next and whether the work is done.

## Where things go

A spec is built in its **project**: the nearest folder, from the spec's own up, that holds a
`config.yaml`, a module's own `config.<module>.yaml` or a `plain_modules/` - or, with none, the
spec's own folder. That is where its
`plain_modules/` is, its `config.yaml` read and its testing scripts found, wherever plainwright was
started: a project that keeps its specs in `plain/`, with `plain/config.yaml` and
`plain/plain_modules/`, builds `plain/hubspot.plain` in `plain/plain_modules/hubspot/`, named from
the folder above. Links in a spec are relative to the spec.

### Modules on different stacks

One project can hold modules that share nothing but a common module - a Python backend and a React
frontend side by side, each importing `base`, neither requiring the other. Each gets its testing
scripts, models and conformance in its own `config.<module>.yaml`, laid over `config.yaml`: see
[the project config](config.md#modules-on-different-stacks).

| | |
| --- | --- |
| `plain_modules/<module>/code/` | the implementation and its unit tests |
| `plain_modules/<module>/tests/` | the black-box conformance tests, organised however suits them |
| `plain_modules/<module>/code/.plainwright.json` | the tree the code is built from - see [below](#what-the-code-is-built-from) |
| `plain_modules/<module>/code/.plainwright-notes.md` | the agents' working notes - see [below](#working-notes) |
| `plain_modules/<module>/.plaingit` | the module's history - see [using](using.md#module-history) |

A module that `requires` another starts from a copy of that module's code and tests, and builds on
top of it; the latest module built in a chain is where later changes to any module of the chain
are made. What that code implements comes with it, as built: the other module's functional specs, as
ones it inherits, and every definition, implementation req and test req of its own spec that the other
module's code implements word for word - so none of them is new work for it.

## One functionality

```bash
plainwright render <file.plain> --list          # the functionality ids
plainwright render <file.plain> 1               # build functionality 1
plainwright render <file.plain> 1 --dry-run     # print the prompt, start nothing
```

### What the agent is given

The prompt, and nothing else - the agent cannot read the `.plain` files. Every prompt for an agent
that builds, tests or judges from the spec starts with how to read it: what each section is for
(the implementation reqs bind the whole codebase; acceptance tests carry the same authority as
their functionality) and what the predefined concepts mean - `:Implementation:`, `:UnitTests:`,
`:ConformanceTests:` and the rest, used in every spec and defined in none. It also says how a
failure is fixed without hiding it: no changing test data to get a pass, no mocking the system
under test, no skipping or silencing a failing test. It holds the definitions
and implementation and test reqs in scope, every functionality already built (the required
modules' too) marked as implemented, a map of the codebase as it stands, the contents of any
linked resources, and the one functionality to build now with its acceptance tests:

```
<definitions> … </definitions>
<implementation reqs> … </implementation reqs>
<test reqs> … </test reqs>
<already implemented> … </already implemented>
<codebase> … </codebase>
<linked resources> … </linked resources>
<functionality module="hello" id="1"> - Display "hello, world" </functionality>
<acceptance tests> … </acceptance tests>
```

Every section has one name, its tag's, in every prompt: how to read the spec introduces each one as
`<definitions>`, `<implementation reqs>`, `<test reqs>`, `<functional specs>` (each functional spec
a `<functionality module="…" id="…">`), `<acceptance tests>`, `<linked resources>` and
`<spec change>`, and the prompts' own words call each section by that name. The `***definitions***`
headings of a `.plain` file appear only where a spec change could not be told section by section
and the agent is given the raw diff: it is then told which tag each heading is. A spec in full -
the planner's, the spec-steps agent's, the conformance agents' - is laid out in the same tags.

A module that `requires` another inherits its functional specs; one that `import`s another
inherits its definitions, implementation reqs and test reqs.

Template search order: the plain file's own directory, then a sibling `template/`, then
`--template-dir`, then `PLAIN_TEMPLATE_DIRS`.

An agent that goes round in a circle - the same tool called with the same arguments again and again,
nothing in between, or a look (read, grep, find, ls) made again with nothing changed since, however
many other looks came between, so the same answer comes back - is let through three times; the next
such call is refused with what is happening, and past six its turn is stopped, and the harness goes on
from there as after any turn. The arguments are compared whatever order they come in.

The agents with one thing to decide have a budget of tool calls: the judge 30, the test review and the
explorer 40. Past it every tool but the one that hands the decision over refuses, telling it to decide
with what it knows; past twice the budget its turn is stopped. Handing the decision over starts the
count again - a reviewer kept for the next review gets its whole budget for it. And every turn of an agent a render
starts has two minutes (PLAINWRIGHT_TURN_LIMIT, in seconds; 0 for none). It is told so, and when they
are up its turn ends where it is and the harness takes it from there - it runs the tests, and judges.
A code fix has to build and pass the code's unit tests before the conformance suite runs again: one
that does not goes straight back to the coding agent, with the output, rather than to a judge. So is an agent whose calls to one tool fail ten times in a row with nothing going through
in between - arguments the tool refuses never reach it, so however they are reworded, no call-by-call
check sees them. A note's section is taken in any wording (`where`, "Where things are"), and one that is
no section is refused with the four that are.

### The tests must actually pass

While it works, the agent runs tests however it likes with `bash` - one file, one case, any
configuration - in the [sandbox](sandbox.md). Before it finishes, it calls `run_unit_tests`: a final
check that takes no command and runs the project's unit testing script exactly as the harness will.
But a functionality is not done on the agent's run, whatever it ran: after each turn **the harness
runs the unit testing script itself**, and only that run counts (see
[the testing scripts](#the-testing-scripts)). It sends the agent back, up to 20 times, when:

- **The harness's run of the unit testing script fails** - its output goes back to the agent, with how
  to fix it, as every failure an agent is sent back with does (unit tests, a conformance run, a test or
  code the judge found wrong): understand the failure from its whole trace; find the root cause in the
  lines it points at, against the spec; reproduce it with that one test; fix the cause; check it with
  that test and then the whole suite, the run that counts; and leave the cause and the fix in the notes.
- **Tests went missing.** The test files present before the turn are inventoried and compared
  afterwards; a deleted file or a file that lost cases is challenged by name.
- **It wrote nothing.** A turn can end with the agent having only thought the problem through, and
  the code folder as it found it (notes aside). That leaves nothing to test or review. So before the
  tests run, the agent is told to stop planning and write a draft: its best guess at what the spec
  asks, the code and its unit tests, with any assumption put in the notes. A draft that is wrong
  comes back from the tests and the review; nothing written cannot. A functionality is asked twice.
  A spec change or a regeneration is asked once, to write the change or say why it needs no code:
  one that only rewords a spec may need none. After that, the turn is taken as what it did.

A test may go only when it asserts nothing meaningful - it cannot fail, exactly duplicates
another, or tests something the spec does not require. Inconvenient, slow or failing are not
grounds. Justified removals are reported, not silent. The baseline is taken before the agent
starts, so breaking an earlier functionality's test is caught too.

### The code and its unit tests are reviewed

Passing unit tests prove only what they check, and a coding agent is quick to write tests that check
next to nothing - that a function exists, that a result is not empty, that a status is 200 - or code
that no test reaches. So once the unit testing script passes, a reviewer on the judge model reads
what the work wrote, beside the spec, and changes nothing. It reviews both halves. `review: false` in
the [config](config.md) turns it off - the conformance tests' review too - and the work goes on once
its tests pass.

- **The code.** Every behaviour, edge case, validation rule and error the spec states for this work
  is implemented as the spec says it, with nothing left as a stub, a placeholder or a hard-coded
  answer. The code keeps to the implementation reqs and does not break what was already built. A
  behaviour with no code for it is raised as not implemented. Such a problem is of kind `wrong`.
- **The unit tests.** Every behaviour, edge
case and error the spec states for this work has a test asserting the exact outcome the spec says,
  that fails when it breaks; that no test only checks something exists, asserts nothing, is skipped
  or swallows a failure; that the unit under test is never mocked - only what is outside it; and that
  the tests are deterministic. A test that is not there is `missing`, a weak one is `bad`.

For a spec change, what it adds or changes is what needs code and tests, and a change that adds no
behaviour needs neither. Code written another way than the reviewer would have written it is not a
problem, as long as it does what the spec says.

The review is told what to inspect, so it does not have to guess. One reviewer does every review of
the work - one session for the loop (see [agent sessions](#agent-sessions)) - so a review after the
first starts from what it already read and raised. Its instructions hold:

- **The spec as the coding agent had it**, laid out the same way: how to read a spec,
  `<definitions>`, `<implementation reqs>` and `<already implemented>`. What this work built is
  apart, in `<new in this work>`: for a functionality, its `<functionality module="m" id="N">` with
  its `<acceptance tests>`; for a spec change, the `<spec change>`, section by section.

And each review is shown:

- **The code the work wrote**, the first time: a diff of the code folder from the module's last
  commit, where every unit of work starts. It covers code and tests, and new files are shown whole.
  Lockfiles and the harness's own files are left out. Past 80,000 characters it is cut, and the files
  left out are named, to be read whole.
- **What changed since its last review**, every time after: the harness takes a snapshot of the code
  folder at each review - a git tree in `.plaingit`, no commit, the module's index untouched - and
  shows the diff from it. With it, the problems of the last review that went to the coding agent, and
  what the arbiter let go of it, not to be raised again.
- **The coding agent's account.** The coding agent ends each turn that goes to review with
  `submit_work`: what it did and why, and for each problem the last review raised, by its number,
  fixed or declined, why, and the files. It is a claim, and the reviewer is told so: it checks it
  against the diff, which the harness takes itself - a problem said to be fixed that the code does not
  fix is still a problem, and one declined is weighed on its reason. An account that leaves a problem
  unanswered sends the coding agent back once; with no account at all, the reviewer is told so and goes
  by the diff.

The reviewer is the exacting developer, opinionated about everything: it raises every problem it
finds, however small. Its problems go back to the coding agent, the unit testing script has to pass
again, and the next review checks those problems first rather than starting over. A problem that
leaves a behaviour of the spec not implemented, implemented wrong or untested - no test, or one that
cannot fail - is **blocking** and worked on first.

The work is reviewed twice at most. The first review that sends it back goes to the coding agent as it
is. The second, **the arbiter** weighs before it reaches the coding agent: the distinguished engineer, on the judge model, read-only, given the same spec and
code diff as the reviewer, the tests and every review so far. It rules on each problem. It upholds a problem when a behaviour the spec states for this work is
not implemented, implemented other than the spec says, or untested, or when a test cannot fail: the
reviewer is right, and the coding agent fixes it. It dismisses a problem that is out of scope or a
nitpick: the test already tests the behaviour, it is another case of one already covered, it is a
matter of style, or the code is written another way but does what the spec says. Only what it
upholds goes back. What it dismisses is let go, with why, in the working notes' pitfalls. When it
upholds nothing, the work is approved as it is. The review optimises the code and its tests; it never stops the work - whether it is done is the
unit testing script's to say. What the second review sends back is worked on once, and then the work
goes on without another review - once its unit tests pass, which they still must. For a spec change the review
is given the change section by section, and told that behaviour is what a functional spec, an
acceptance test or a req states: a page or a component only a definition names has no code yet. The
conformance tests are reviewed as black-box tests (see [conformance tests](#conformance-tests)).

Every time a review sends tests back, the agent that fixes them also leaves the lesson in the
working notes' pitfalls: not the fix, but the kind of test the review found weak or missing and how
to write it instead - "tests assert the exact response body, never only that one came back". One
that fixes the tests and leaves no lesson is asked once more. Every later agent on the codebase
starts from the notes, and is told to write its tests so they would pass those reviews the first
time - so the reviews of the next functionalities have less to send back, and finish sooner.

### Then

Once the unit tests pass: the conformance tests already in the codebase are run and kept passing
(repairing the code if needed), the functional spec goes into the tree the code is built from, and a
commit is made to the module's history. A render that does not pass is undone instead - see
[below](#what-the-code-is-built-from). A render that lands ends its report with the offer to try it -
"Want to try it? Just ask me" in the chat, `plainwright deploy <spec>` on the command line - and
trying it is [deploy](deploy.md)'s, not the render's. When the render's conformance tests follow as
a job of their own, the offer comes at the very end, from that job, once they pass too. Spec diffs,
conformance jobs and regenerations that land make the same offer.

## A whole module

```bash
plainwright module <file.plain>
```

Rendering a module - `render_module` in a conversation, `plainwright module` on the command line - is
not a job of its own, and nothing is queued: the work loop (`src/render/loop.ts`, see
[the work model](work-model.md)) works out what is left to build, has it planned into jobs, and runs
the first. What is left is the difference between what a codebase's code is built from - its code
record - and the spec of its requires chain as the `.plain` files have it now. When a job ends, or the
spec changes, it is worked out again; a plan is kept only while the spec and the record it was cut from
stay as they were.

Code accumulates up a `requires` chain: a module is built on a copy of the code of the one it requires.
So a chain's codebase is its furthest-built module - its tip - and its record holds the whole chain: the
definitions and implementation reqs of the modules below, each tagged with its module, their functional
specs among the ones it inherits, and its own. A change to a module below is made there. The codebases
below the tip are left as they were, their records saying what they are built from; one is brought up
to its own spec again only when a module not built yet is to start from it - the module below first,
then the new one on a copy of its code. With no module of a chain built, it is built bottom first, a
module waiting while the one it is built on has work left or a job running.

A module already built from the spec as it is gets nothing. A job that does not land is rolled back, and
halts its codebase: nothing more runs there until the spec changes or the module is asked for again. On
the command line, `plainwright module` runs until nothing more can start, one line as each job starts and
ends, and exits 1 when any failed.

### How the work is cut into jobs

A job that renders the whole of a new spec is too big to build well, and a render per functional spec,
the first carrying every definition and req, is no better: most of the work lands in one job. So the
work is cut from the functional specs outward (`chunk-plan.ts`), in three steps:

1. **Which new functional specs go together.** An agent groups them: at most three a job, only ones
   next to each other in the spec's order - the specs that build one component or feature together (a component
   and the parts only it uses), a spec alone when it stands on its own or is big.
2. **The definitions each group uses**, in code: the concepts its functional specs name, and the
   concepts those definitions name in turn. A definition goes with the first group that uses it; later
   groups have it built. One nothing uses goes with the last.
3. **Where each new implementation req goes.** An agent places each with the group it is about - or with
   the first, when it is about everything (the language, the framework).

Changes to what is built - an item edited or taken out, a functional spec built worded differently - go
first, in a job of their own. Every answer is checked: every new functional spec once, in order, next to
each other, at most three; every req placed once. One that does not hold goes back to its agent, twice at
most, and then the plan is a functional spec a job with every req in the first. A group past 120 lines
goes a functional spec a job. The planner runs on the chat's model in a conversation, and on the
harness model under `plainwright module`. No agent reviews its plan: the harness checks it - every
change in exactly one job, the spec holding together after each, the last ending on the spec as it is.

Each planned job knows its cases - which functional specs it adds, changes (their text, or a concept they
use) and takes out, or none: reqs and definitions only - and the loop says them, with each job's title,
where the person looks (`render_status`, and what `render_module` and `spec_changed` return).

**Steering.** How you want the work cut and ordered - "build the batch worker's helpers with the worker",
"models first" - goes to the grouping and placement agents with every plan, as a strong preference: it
never overrides the limits and checks. It comes from three places, each labelled with where it came from:
the conversation (`steer_queue`, for the whole project or one module, for the session); the project's
`AGENTS.md`, every section whose heading names the queue (`## Queue guidance`), read afresh with every plan;
and whatever asks for the work - `render_module`, `spec_changed`, `render_spec_diff` and `write_spec_diff`
take a `guidance` of their own, which the loop keeps with that module.

### When the spec changes

A spec change is a notice, not a diff to run: **`spec_changed`**, after the spec was edited by any means -
the file tools, a skill, you in an editor - has the loop work out the work again. A job running goes on
while every change it makes is still part of the work, measured from the same record; one that is making
something the spec no longer wants is stopped, rolled back, and the work planned again - a fixed rule, no
agent. Say a module of 50 functionalities is rendering and the spec changes while functionality 25 builds:
25 goes on if the change leaves it as it is, and the work after it is planned again from what 25 lands.
`render_spec_diff` and forge-plain's `write_spec_diff` are ways to make an edit and give the notice in one
call.

### Regenerating a functionality

`regenerate_functionality` builds one functionality again, changed or not: it is taken out of the record
of every codebase it is built in - committed, so the record says it is not built - and they are brought up
to their spec, which builds it again. A functionality whose spec changed needs none of it: `spec_changed`
builds it again by itself.

`plainwright regenerate <file.plain> 2` on the command line is the older path: it re-renders that
functionality over the existing code in the chain's latest codebase, and runs every conformance test.

### The testing scripts

Whether something is done is never the agent's call, and never a command it chose. It is the
project's own testing scripts, run by the harness the same way every time:

| Script | Run as | Decides |
| --- | --- | --- |
| `test_scripts/run_unittests_<lang>.sh` | `run_unittests_<lang>.sh <build>` | whether the unit tests pass |
| `test_scripts/run_conformance_tests_<lang>.sh` | `run_conformance_tests_<lang>.sh <build> <tests>` | whether the conformance tests pass - the whole suite in `plain_modules/<module>/tests`, every functionality's and those carried up from below, at once |

The `implement-unit-testing-script` and `implement-conformance-testing-script` skills write them.
They are looked for at the project root - the folder that holds `plain_modules` - in this order:

1. `config.yaml` - or the module's own `config.<module>.yaml`, for a project whose modules are on
   different stacks - naming them by path from the root:

   ```yaml
   unittests-script: test_scripts/run_unittests.sh
   conformance-tests-script: test_scripts/run_conformance_tests.sh
   ```

2. the root itself: the one `run_unittests*.sh` and `run_conformance_tests*.sh` there;
3. `test_scripts/`: the one of each there.

The same `config.yaml` holds the project's other defaults - `module`, `model`, `conformance-tests` -
for [unattended runs](headless.md). A folder holding two of a kind is not guessed between: name the
one to use in `config.yaml`, or in each module's own file. The
scripts are not linked from the specs; a link to one is ignored.

They are required: a build with no unit testing script, or with conformance on and no conformance
testing script, stops before it starts and says which skill adds it.

**Where they run.** In the module's VM by default - the same Alpine Linux VM the agents' `bash`
runs in, with the same toolchains and the packages they installed - so what passes in an agent's
shell passes in the run that decides. That is the only way the two scripts are ever run: the
harness's own runs, and the agents' `run_unit_tests` and `run_conformance_tests`, which run them
exactly as the harness does. A toolchain the script needs and the VM lacks (exit 69), the agent
installs with `install_system_packages`, and the next run has it.

Each run is given a fresh copy of the code, and of the whole conformance suite, in
`plain_modules/.plainwright/scripts/`, named for its module and the run, with the project's script
copied in beside it: the scripts work in `/tmp/<lang>_<basename of the build>`, and every module's
build is called `code`, so two modules testing at once never share that folder, and nothing a test
writes reaches the code. The unit tests run in the module's code VM, the conformance suite in its
tests VM.

`run-testing-scripts-in: host` in the project's `config.yaml` runs them on this machine instead, in place:
the project's own script at its own path, from the project's folder, on the real build and tests
folders, in this machine's environment with its toolchains, as codeplain did. An integration embedded
in a host codebase needs it - its scripts merge the generated code into the host and find the host
from their own path - and so does a project whose tests need something only this machine has:

```yaml
# plain/config.yaml
run-testing-scripts-in: host
```

Either way the agents are not moved: their file tools and `bash` stay fenced to `plain_modules` and
the VM, and only the scripts' output reaches them. The time limit and a stopped job end the script
and all it started. On the host the model providers' API keys are kept out of its environment, and
what the script does to the host - copying the package into it - it does, as it is written to. Code
the agents wrote runs on this machine there, so it is for projects that ask for it. The agents are
told the host's run is the one that counts, and a toolchain the host lacks (exit 69) cannot be
installed from their sandbox: they say what is missing, for you to install.

### What a job is given, and what it records

Every job is a spec diff: the agent that renders it is given the spec the code is built from - its
functional specs in `<already implemented>` - and the change to it, in `<spec change>`, section by
section - not the raw diff: each of `<definitions>`, `<implementation reqs>` and `<functional specs>` in
its own tag, `<definitions change="1 added, 2 changed">`, saying what is added, what changed with its text
before and now, and what is removed, measured from what is built to the spec the job ends on. A
definition is itself by its concept: one reworded or moved is shown as changed, not as removed and added.
Test reqs and acceptance tests are for conformance only: the code record holds neither, and no coding
agent is shown them.

It is told, too, what to do with each functional spec the job touches, by its case (`src/render/cases.ts`,
[the work model](work-model.md#prompts)): a fresh project is set up first, with its unit tests where the unit
testing script runs them; a new functional spec is built and unit tested; a changed one - its text, or a concept
it uses - is changed in place, its code and tests to match, never built again from scratch; one taken out has its
code and the tests only it had removed. A job holding several cases has a line for each. A job that touches no
functional spec - implementation reqs, or definitions none uses - is mechanical: the code adapts, no new test is
written, and an existing one may change only mechanically, never what it asserts. The unit test review holds each
part to its case, and a mechanical job only to its reqs and to no test removed or weakened. A conformance job's
agent and its reviewer are told the same, for the tests.

A job lands once its unit tests pass and are reviewed: the code record becomes the spec the job ends on,
committed with the code. Its conformance tests are not the code job's: they are a track of their own
([conformance tests in the work loop](#conformance-tests-in-the-work-loop)).

A change that renders nothing - definitions moved to a common module, reqs reordered, specs moved between
modules of the chain - is recorded, not rendered: the spec is recorded as it is now laid out and committed,
with no agent and no testing script. Moving specs into a module the code was not built on is different: no
change to the code brings that module's code in, so the codebase stops, saying its code has to be started
again on it.

## Conformance tests

The unit tests are written by the agent that wrote the code. Conformance tests are the other half:
black box, end to end, written from the spec.

```bash
plainwright conformance <file.plain> 1
plainwright conformance <file.plain> 1 --dry-run
```

It refuses to start before the functionality has been rendered. Conformance is on by default when
the module has `***test reqs***`, and can be turned off. Once a codebase has conformance tests,
they are always run and kept passing, whether or not the current render writes new ones, and they
are carried up to the modules built on top of it.

### Conformance tests in the work loop

In the work loop, conformance is a track beside the code's. What the conformance tests are written for is
recorded apart - `tests/.plainwright.json`: the functional specs they test, as built, with their acceptance
tests, the definitions and implementation reqs they were written against, and the test reqs they follow -
and the work is from that record to what they are to be: of the functional specs the code is built from,
those chosen - every one, or those `render_conformance` names - as the spec has them, with its test reqs. A
functional spec whose code is behind the spec keeps its tests until the code lands. The work is cut into jobs
as the code's is, anchored on functional specs, and a conformance job runs on the module's lane before its
next code job: after a job lands, the tests of what it built come before anything is built on it.

A conformance job is a spec diff's conformance run: the tests of its change written, changed or taken out,
a failure judged - the test or the code wrong - and fixed, then the whole suite with the unit tests, the
tests the module inherits with them. Passing, the tests record is written and committed with the tests;
otherwise all of it - code fixes included - is rolled back, and the module's conformance tests halt until
the spec or the code changes, or `render_conformance` asks again. The code goes on being built meanwhile.
With `conformance-tests: false` none is written unless the conversation asks with `render_conformance`, for
the session. A module built on another starts with an empty tests record: the tests it inherits are the
module below's, and none of its own is written yet.

### Conformance tests and acceptance tests, kept apart

The step writes two kinds of test, and never lets one stand in for the other:

| | Written from | Labelled |
| --- | --- | --- |
| Conformance tests | the functional spec itself - what it says the functionality does, its edge cases, its errors - as if no acceptance tests had been given | files whose names say conformance, each starting with a comment `conformance tests of functionality 3` |
| Acceptance tests | each acceptance test in the spec, implemented as a test of its own, doing what it says | files whose names say acceptance, each test with a comment `acceptance test 2 of functionality 3:` and the acceptance test's text |

Even when the acceptance tests seem to cover the functionality, the conformance tests are written
independently: tests drawn only from the acceptance tests check what the author thought to check,
and nothing the spec says beyond that. The acceptance tests reach the agent numbered, as their
labels number them.

The labels are checked, not trusted: before a passing run counts, the harness reads the tests and
sends the agent back for a functionality with no labelled conformance tests, or for any acceptance
test that has no test of its own. Anyone reading the tests - or the next agent - sees at a glance
which is which, and which acceptance test a test implements.

### Rendered apart from the code

The code and its conformance tests are rendered apart, each in its own folder and its own VM (see
[the sandbox](sandbox.md#commands-run-in-a-vm)). The test author writes only the tests folder; its file
tools can read the code too, and it is told so - read access, never write access - and to take how the
software is reached from the code, never what it should do. Its shell holds the tests folder only. The
coding agent that fixes the code is told the same of the tests: it can read them, never change them.
Before the test author starts, an explorer - an agent in
the code's folder and VM, which reads the code and runs it but changes nothing - hands over everything
the author needs, in parts: how to build and run it; how the conformance tests reach it as the project's
conformance testing script runs them - the explorer is given the script, and says what it builds or
installs and what the tests depend on or start (a package, a module, an entry point, by its exact name);
how each functionality is reached from outside
(the command, or the route, method and the request and response fields); what it needs around it; and
a plan for the conformance tests, its expectations taken from the spec. The account is checked before
it is used: it has to say how the functionality under test is reached and what to test for it (for a
spec diff, some of the module the change touches), and the plan has to carry out every acceptance test
of it (for a spec diff, of every functionality the change touches), each named "acceptance test N", with
how each of its steps is done from outside and what it asserts. One that does not is sent back saying
what is missing. It is kept focused: the interface to what is under test, not a survey of the codebase, in
words rather than code, under 12,000 characters. Each hand-over ends its turn, and it hands over three
times at most. If it never completes it, what it wrote as it worked goes along with it, so nothing it
found is lost. The tests are written from that account and the spec, and every assertion comes from the
spec. `run_conformance_tests` puts
the whole suite together with a copy of the build in a throwaway directory, in the tests' VM, so
tests cannot accumulate state between attempts and nothing they write reaches the code.

This is the same for a functionality's conformance tests and a spec diff's.

### When a conformance test fails

The harness runs the project's conformance testing script on the whole suite. When it passes, the
unit testing script runs too - and then the review gate: a reviewer reads the tests this run added or
changed, and the code, and checks that they test black box - through the entry points the test reqs
allow, never mocking or replacing any part of the software under test - that every test asserts what
the spec says, with no placeholder that cannot fail, and that each acceptance test does every step it
lists and asserts every expectation it states. It must pass, as the suite and the unit tests must:
when it does not, the conformance agent gets exactly what is missing and what is bad, file by file, and
the round goes again. One reviewer does every review of the run, as the unit tests' does: the first time
it is shown the diff of the tests folder from the module's last commit, each time after the diff since its
last review, and every time the conformance agent's account through `submit_work` - checked against the
diff, never taken instead of it. The first review is asked for every problem at once; each after it is
given what the last one found, checks that first, and raises something new only when it is serious - a test that
cannot fail, mocks the software, or leaves out what the spec asks for. It asks only for what can be seen
from outside: where the spec says one part calls another, the outcome, never the call. The reviewer is
the exacting developer, as the unit tests' is, and marks each problem blocking or not: blocking when the
functionality is not yet tested black box - a test or an acceptance test missing, cut down or skipping
what it checks, the software mocked or not reached from outside, a test that cannot fail.

The tests are reviewed twice at most, as the unit tests are: the first review that sends them back goes to
the conformance agent as it is, and the second the arbiter weighs first, as it does the unit
tests' (see [the code and its unit tests are reviewed](#the-code-and-its-unit-tests-are-reviewed)): it upholds what leaves the
functionality not tested black box, and dismisses what is out of scope or a nitpick. Only what it
upholds goes back to the conformance agent; when it upholds nothing, the tests are approved as they
are, and what it let go is kept in the result and the notes' pitfalls. The review optimises the tests,
it does not stop the run: what the second review sends back is worked on once, and then the tests go on
without another review - once the suite and the unit tests pass, which they still must. All three passing
is done.

A spec diff's conformance run holds its tests to the same bar. The functionalities the change touches -
a line of their functional spec, or of one of their acceptance tests, added or removed - are worked
out from the diff. The conformance agent is shown their acceptance tests, numbered as they are labelled;
the run does not finish until each one is a labelled test of its own; and the review checks each of
them as it would a functionality's own.

A failing run's output goes to the judge and whoever fixes it whole when it is up to 60,000 characters,
and otherwise its last 60,000 - where a test run says what failed and why - with the file the whole of
it is kept in.

Why something failed is never lost. Every agent that writes or fixes code is told that where the code
catches an error and turns it into a response, a status, a result or a retry, it logs the error with its
whole trace, and what it hands on names the cause - never a bare "failed". When the output does not show
why the software failed, the judge says the code is what is wrong, for hiding it, and the coding agent
makes the cause show first, then fixes it. No agent may make the code behave differently when a test runs
it. Both the conformance agent
and the coding agent can run the conformance suite themselves, to reproduce a failure and check their
fix - three times a turn: the third ends the turn, and the harness runs it and judges. The conformance
agent is told that a failure of the software itself - it does not build or start, or does what the
spec says it must not - is not the tests' to work around. When it fails, a judge - an agent that reads
the code and the tests, changes neither, and holds both to the spec - decides which is wrong. Like the
explorer it has a shell in a VM and the web (`web_search`, `web_fetch`), to try the software or ask a
service it calls what it answers; its file tools write nothing, and a file its shell changes anyway is
reported:

- **the code:** the coding agent - in the code's folder and VM, reading the tests but never changing them - fixes it,
  and keeps its unit tests passing;
- **the tests:** the conformance agent corrects them to what the spec says;
- **the spec:** two functional specs cannot both hold, whatever the code does.

When the code and the tests could both be wrong, the judge is told to choose the tests. A spec
conflict has to name the two functionalities, each by its module and id - they can be in different
modules, since a module's codebase and its conformance suite hold the functionalities of the modules
it requires too (functionality 1 of `accounts` and functionality 4 of `cognio`). In a functionality's
conformance run one of them must be the functionality under test - a conflict between two earlier ones would have
come up when the later of them was tested (a spec diff's run may name any two). One that breaks
these rules is sent back to the judge. A valid one is recorded, and the tests go back to the
conformance agent, so the next judgement is of a new run. It counts only once the same two
functionalities have been named three times. Then the run stops, and the person gets the conflict
whole: both functional specs as they read, and each time what could not hold. The conversation's
agent runs `analyze-2-func-specs` on the pair, then `resolve-spec-conflict` for the ways out, and
puts the decision to the person - it changes nothing in the spec before they have decided.

The judge holds only what the spec says against the code: anything it leaves open - a name,
coordinates, a version, a path, a package - is what the code already has, and the tests follow it.
The coding agents keep the build's identity - name, coordinates, version, package, main class - as it
is unless the spec asks for another. And the conformance agent is given the code's build files
(`pom.xml`, `package.json`, `pyproject.toml`, `go.mod`...) word for word, read by the harness: the one
place to take what its tests' build points at from, never a guess from a folder name.

When nothing changes - the same failure seen three times in the run, in a row or not, so a run
swinging between two failures counts too (runs that hang until the time limit count as well) - the
explorer is asked again, shown its last account and the failure,
for what the tests lack; most often it is how they reach the software. Its new account goes to the
conformance agent. If the same happens three rounds more, the run stops and says so, instead of
spending the rest of its 20 attempts on it. The conformance agent has the testing script in its prompt,
and is told to fit the tests' own build to it.

Every attempt is written into the working notes' pitfalls by the harness as cause and effect - what
the run failed with, how it was judged, and which files the agent sent to fix it changed; the next
attempt's line says what came of it - and each judge reads them first, so it does not send a
failure the way that already failed. A run that does not pass is undone whole, its notes with it.

Then the suite runs again. A run that never got to the tests - a toolchain missing, a time limit - goes
back to the conformance agent without a judge: the tests' environment is its. Unit tests failing after
the suite passes go to the coding agent. It goes round up to 20 times; still failing, the work is undone.

Before each run the harness checks for itself: both kinds of test are there and labelled, none of
them is in the code folder, and no test went missing without being justified.

Conformance and acceptance tests live in the module's `tests` folder and nowhere else. One found in
the code folder - by its label, or as a test file under a name or folder that says conformance or
acceptance - is sent back: to the agent writing the tests, to move it; to an agent writing the code,
to remove it, since those tests are not its to write. The conformance testing script refuses them too
(see `implement-conformance-testing-script`), so a suite in the wrong place fails rather than
passing unnoticed.

No agent runs the testing scripts itself. They are in its prompt so it knows what judges its work,
but they are not in its workspace: it calls `run_unit_tests` and `run_conformance_tests`, which run
them as the harness does. Its file tools refuse to write a copy of them, or a `.plain` spec, into the
codebase, and its working notes refuse a line telling the next agent to run them.

### Verified

After rendering a hello-world Python spec's functionality 1, the conformance test runs
the app as a subprocess and asserts on stdout, exit code and time - no import of internals:

```python
completed = subprocess.run([sys.executable, str(executable)], capture_output=True, text=True, timeout=1)
self.assertEqual(completed.returncode, 0, msg=completed.stderr)
self.assertEqual(completed.stdout.strip(), "hello, world")
```

Code that prints `goodbye` instead fails the test; the agent fixes the code, and the harness's own
runs - the suite, then the unit tests - pass (`tests/render/conformance-loop.test.ts`).

## Agent sessions

An agent's task - the spec, how to read it, what to do, the rules, the working notes as they were - is
its **system prompt**, not its first message: every agent plainwright starts opens with a one-line
"begin". Compaction sums up the conversation and never the system prompt, so however long an agent
works, what it works from stays word for word as it was, and stays in the cached prefix of every call.
The one exception is a skill's executor, which is given a step at a time.

The agents that work through a job keep **one session for it**: the coding agent of a render or a spec
change, its unit test reviewer, the conformance agent, its test reviewer, the code fixer of a
conformance run, and the regression repair agent. The code fixer used to start fresh for every fix; now
each fix starts from what the ones before it tried. The agents whose value is having taken no side stay
fresh, given what they need as text: the arbiter, the judge that says whether the code, the tests or the
spec is wrong, the explorer, the planners, the diagnosis and a skill's review judges. A job that fails
and is retried is undone whole, and every agent of the retry starts fresh.

An agent kept through a job re-reads everything it has done on every call. So between turns, once its
conversation - what it has done, past its instructions - passes `compact-at` tokens (100,000 unless
[the project config](config.md) says otherwise), the harness compacts it, with instructions for its role:
the coding agent and the fixer keep what is done, what still fails and why, the decisions and every
review problem's fate; a reviewer keeps every problem it raised and where each stands, and what it has
already checked. pi's own compaction, when the context window is nearly full, stays on beneath it.

What each agent of a job did - its turns, its compactions, its tokens and cost - is at the end of the
job's log in `.plainwright/jobs/`, and in `check_job`.

## Working notes

Every job's agents start fresh, and without help each one would spend its first turns finding its
bearings. So each agent working on a codebase - render, spec change, conformance, regression repair -
starts with the notes the agents before it left, and before it finishes it updates them: a line
added, changed or removed, never the whole thing rewritten. Four sections:

| | |
| --- | --- |
| Where things are | entry points, layout, where each functionality lives |
| How to build, run and test | the commands that work, what had to be installed |
| Assumptions | what an agent assumed where the spec is silent - a format, a default, a choice it leaves open |
| Pitfalls | what went wrong and what fixed it |

Stubborn on the specs, flexible on the assumptions: the spec is never an assumption and never
copied into the notes, and where the two disagree the spec wins. An agent builds on the assumptions
already there, and changes one the moment the code or the spec shows it wrong.

Every line says when and where it came from, stamped by the harness rather than written by the agent:

```
## Assumptions

- [2026-09-24 16:39 · version_api 1] The version response's capabilities follow the JSON in the spec
- [2026-09-24 16:52 · auth 1] Token responses carry `access_token` and `expires_in`
```

A line that is changed is stamped again, so an assumption one agent revised shows as newer than the
ones around it. Where two lines disagree, the later one is right. A line that says nothing - "none",
"N/A", "no new assumptions" - is refused: a section with nothing new is left alone.

Leaving notes is required, and only through the `update_notes` tool. The file tools refuse the
notes file, and a change made to it any other way - from the shell, by a script - is undone. An agent
that finishes without calling `update_notes` is asked again, up to three times; if it still has not,
the activity log says so.

The notes are disposable - delete the file and nothing breaks; the next agent just explores a little
more. They live in the code folder, so they are committed with it, reset with it after an
interrupted run, and copied up with it to a module that requires this one. They are not part of the
codebase: they are left out of the code map, the file lists and what `deploy` puts in `dist/`.

## What the code is built from

`plain_modules/<module>/code/.plainwright.json` holds one thing: the marshalled plain tree the code
in that folder is built from, as JSON - the definitions, the implementation and test reqs, the
module's own functional specs and those it inherits. Nothing about how a build went: whether tests
passed and which files a render touched are in the history, not here. A functionality is rebuilt
when its own spec no longer matches what the tree says it was built from.

What goes into it:

- **A functionality rendered:** the tree as it was, with that functional spec in its place, and the
  module's definitions, implementation reqs and test reqs as the spec has them. Every functional spec
  of a module shares those - each is rendered with all of them - so that is what it was built with.
- **A spec diff rendered:** the spec as parsed with the diff in, whole.
- **A required module's functionality rebuilt in a later module's codebase:** that spec, in the
  inherited ones of the later module's tree.
- **A module started from another's code:** everything the other's tree holds, as what it inherits.

A unit of work - a functionality with its conformance tests and the whole suite, a spec diff, a
conformance run, a regeneration - lands whole or is undone whole. It starts from the module's last
commit, putting back whatever an interrupted run left; a module with no commit yet is given one
first. When it does not pass, the module goes back to that commit: its changes, the files it added
and any commit it made on the way are gone, with the tree they came with. Installed dependencies
and caches stay. So the code, its tests and the tree they were built from never disagree.

In the chat, a render's or a spec diff's conformance tests are a job of their own, right behind it.
The render lands first - its code, committed with the tree - and counts as built only once they
pass: when that conformance job fails for good, the module goes back to the commit the render
started from, its code, tests and tree with it, before anything behind it could run.

The record is the harness's alone. No agent writes it: the file tools refuse it, and what the
harness records next is built on the record as its last commit has it, not the file on disk - so a
change an agent's shell made to it is never carried on.

A record written by an earlier version of plainwright is read as the tree it describes, up to the
first functionality that did not build; the next build writes the tree.
