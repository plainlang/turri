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
are made.

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
<functionality id="1"> - Display "hello, world" </functionality>
<acceptance tests> … </acceptance tests>
```

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
with what it knows; past twice the budget its turn is stopped. And every turn of an agent a render
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

A test may go only when it asserts nothing meaningful - it cannot fail, exactly duplicates
another, or tests something the spec does not require. Inconvenient, slow or failing are not
grounds. Justified removals are reported, not silent. The baseline is taken before the agent
starts, so breaking an earlier functionality's test is caught too.

### The unit tests are reviewed

Passing unit tests prove only what they check, and a coding agent is quick to write tests that check
next to nothing - that a function exists, that a result is not empty, that a status is 200. So once
the unit testing script passes, a reviewer on the judge model reads the unit tests the work added or
changed, beside the code and the spec, and changes nothing. It checks that every behaviour, edge
case and error the spec states for this work has a test asserting the exact outcome the spec says,
that fails when it breaks; that no test only checks something exists, asserts nothing, is skipped or
swallows a failure; that the unit under test is never mocked - only what is outside it; and that
the tests are deterministic. For a spec change, what it adds or changes is what needs testing, and a
change that adds no behaviour needs no new test.

Its problems go back to the coding agent, the unit testing script has to pass again, and the next
review checks those problems first rather than starting over. A problem that leaves a behaviour of
the spec untested - no test, or one that cannot fail - is **blocking** and never let go: after eight
reviews with one still there, the work stops and is undone. The rest, ways to make tests that
already test it better, are let go after five reviews - the tests cannot be optimised further - and
what the last review suggested goes into the working notes. The conformance tests are reviewed the
same way, as black-box tests (see [conformance tests](#conformance-tests)).

### Then

Once the unit tests pass: the conformance tests already in the codebase are run and kept passing
(repairing the code if needed), the functional spec goes into the tree the code is built from, and a
commit is made to the module's history. A render that does not pass is undone instead - see
[below](#what-the-code-is-built-from). When someone is there to try it, the agent is also asked how to try the functionality:
a few plain steps - a command to paste or a thing to click, and what you should see - at most
five, one line each, and only commands that work in your own terminal. The harness runs every
command first, in a fresh copy (`plain_modules/.plainwright/try/`): a server is started, checked
to stay up, and the steps after it run against it before it is stopped. A step that does not work
goes back to the agent, up to three times; one that still does not is shown marked as not working.

## A whole module

```bash
plainwright module <file.plain>
plainwright module <file.plain> --from 3 --to 5
```

For each functionality in order: render the code and unit tests, write its conformance tests,
then run **every** conformance test in the codebase as one suite, and the unit testing script with
it. It advances only when both are green - a suite that passes on code whose unit tests fail is not
done. When it goes red, a repair agent works on the code with the module's spec and the
failure; the suite runs again after each repair, up to `--max-regression-rounds` (default 20). The
repair agent is not allowed to change the tests: the harness photographs them before it starts,
and puts back anything it changed before sending it to fix the code instead. A functionality is finished when it passes alongside
everything before it.

That is when the spec has only grown since the code was built: new functional specs at the end, and
nothing else - the definitions, the implementation and test reqs and the inherited functional specs
as they were built. When it has moved on in any other way - a functional spec changed in place, an
acceptance test changed, a definition or a req added or changed, a spec inserted or removed -
rendering the new ones would miss it. Then the tree the code is built
from is compared with the spec, and the changes are ordered into steps by an agent, checked to add
up to the spec and to hold together at every step (`src/render/spec-steps.ts`). Each step is
rendered as a spec diff, from the spec as that step leaves it, in order, up to the first that does
not pass. In a conversation each step is queued as a render spec diff job of its own, exactly as
forge-plain queues an answer: behind the module job, one after another, each shown in the panel
with its diff and read in full in `/watch`. On the command line they are rendered in turn, each
diff printed in full as it starts. `--from`, `--to` and `--force` always build functionality by functionality, as asked.

### Regenerating after a spec change

```bash
plainwright regenerate <file.plain> 2
```

Re-renders that functionality over the existing code - in the chain's latest codebase - updates
its conformance tests to the new spec, and then runs every conformance test, not just the ones up
to this point: a changed spec can break something built later as easily as something built
earlier. It also rebuilds a functionality whose spec has not changed, as it is. To make it come out
differently, change its spec first - the spec is what persists.
When specs change, only the functionalities whose own spec changed are queued for regeneration -
not everything after them.

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

**Where they run.** On this machine - the host - never in a VM: the project's own script, at its own
path, from the project's folder, in this machine's environment, with its toolchains. That is the only
way the two scripts are ever run: the harness's own runs, and the agents' `run_unit_tests` and
`run_conformance_tests`, which run them exactly as the harness does. Whatever an agent runs with its
own `bash` stays in its VM; its shell is Alpine Linux, so something that works there can still fail on
the host, and only the host's run counts - the agents are told so.

Each run is given a fresh copy of the code, and of the whole conformance suite, in
`plain_modules/.plainwright/scripts/`, named for its module and the run: the scripts work in
`/tmp/<lang>_<basename of the build>`, and every module's build is called `code`, so two modules
testing at once never share that folder, and nothing a test writes reaches the code.

An integration embedded in a host codebase needs its real folders: its scripts merge the generated
code into the host and find the host from their own path. For it, `testing-scripts: host` in the
project's `config.yaml` runs them in place - on the real build and tests folders, as codeplain did:

```yaml
# plain/config.yaml
testing-scripts: host
```

Either way the agents are not moved: their file tools and `bash` stay fenced to `plain_modules` and
the VM, and only the scripts' output reaches them. The time limit and a stopped job end the script
and all it started, and the model providers' API keys are kept out of its environment. What the
script does to the host - copying the package into it - it does, as it is written to. A toolchain the
host lacks (exit 69) cannot be installed by an agent from its sandbox: it says what is missing, for
you to install.

Turning conformance off (`conformance: false`, `--no-conformance`) sets the conformance testing script
aside, found or not: no conformance tests are written, the ones already in the codebase are not run,
and no agent is shown it. That is different from a module with no test reqs, which writes no
conformance tests of its own but still keeps the codebase's existing ones passing.

The scripts live in the project, outside `plain_modules`, where no agent can reach them - one
`config.yaml` names inside `plain_modules` is refused. Each run has the command time limit: two
minutes, or `PLAINWRIGHT_COMMAND_TIMEOUT` seconds.
A run that has not finished by then is stopped - with everything it started - and counts as failed.
The agent gets what it had printed by then, told that the output ends where the run hung, and what
most often keeps a test run from ending: a server started in the foreground, a prompt waiting for
input, a network call to a host the VM cannot reach, a lock or a loop that never ends.

The agents have the same scripts as their final check: `run_unit_tests` and `run_conformance_tests`
take no command, and run the unit and conformance testing scripts exactly as the harness does -
the conformance one on the code with the whole suite. Anything else, while they work, they run
with `bash`.

Each agent is shown the scripts its work is judged by, whole, at the start of its prompt: the unit
testing script always; the conformance testing script to the conformance and repair agents, and to
the coding agent only when conformance tests are written for its build. It gets the script's
output when a run fails.

Output an agent is shown - a script's, or a command's it ran itself - is shown whole up to 60,000
characters. A longer one keeps its last 60,000 (the failures, the stack traces, the summary), and says
how much was cut from the start; the whole of it is kept in
`plain_modules/.plainwright/logs/`, where the agent can read it, and the cut names the file. The
last 100 are kept.

## A spec change, as a diff

`render_spec_diff` takes a change to the specs as a git diff of the `.plain` files - any section,
across any number of files, from scratch included. The diff is applied with git (or accepted as
already applied), and the spec is parsed with it in. One agent, given the diff and every relevant
spec as they now stand, makes the code match; then the conformance tests are brought in line, the
whole suite runs with repairs, and try-it is worked out and checked.

In a conversation, rendering and conformance are separate jobs in the render queue. A render spec
diff job - forge-plain's, `render_spec_diff`'s, or one of the spec diffs `render_module` brings a
spec in as - lands the change on its unit tests, and a render spec diff conformance job is queued
right behind it, which brings the tests in line and runs the whole suite with repairs. It runs only
if the render landed. A functionality rendered through the queue is followed the same way by a
render functionality conformance job for it, and both conformance tools queue their jobs there too.
With conformance off, or no test reqs, no conformance job is queued and the render keeps the
existing tests passing itself. A call that waits - `wait: true`, or pi's print mode - still does it
all in one.

When it passes, the tree the code is built from becomes the spec as parsed when the diff went in -
every section, not only the functional specs - and the diff is committed with it. A diff queued
behind others is rendered from its own parse, not from the files as they are by the time it runs.

### Restructuring, new required modules, and changes across modules

Not every change to the `.plain` files is a change to the code. Before a spec diff renders, the
spec the codebase is built from is compared with the spec with the change in, as the parser
resolves them: the definitions and the implementation and test reqs as sets - in any order, from
the module's own file or one it imports - and the functional specs in order, those it inherits
then its own, whichever module each is written in. When they are the same - definitions moved to
a common module, reqs reordered, specs moved between modules of the chain, only the frontmatter
description changed - nothing is rendered: the spec is recorded as it is now laid out and
committed, with no agent, no testing script and no conformance job. In the queue such a job is
named "spec restructured - nothing to render" from the start, and the queue master leaves it be.
`render_module` takes a spec that is only restructured the same way.

Moving specs into a module the code was not built on is different: a module required now - a new
module the specs were split into, or an existing one required for the first time - whose code the
codebase does not hold. No change to the code brings that in, so it is not a spec diff. The queue
starts the chain's build instead: the new module is built, and every built module above it starts
again from scratch on its code - its code, conformance tests and record removed and committed, so
what was there stays in its history. `render_module` does the same whenever it finds a built
module that was not built on the whole chain below it (its record does not list a module as
inherited, or, with nothing inherited on record, its history never started from it).
`render_spec_diff` refuses such a change and says to render the module.

A change to several modules lands where each module's code lives. When a diff changes two modules
of a chain and the one above is not built yet, those are two codebases, so the queue cuts it into
a spec diff per codebase, bottom of the chain first: the module below renders its part in its own
codebase, and the one above starts from that code when its part runs. A file a module imports goes
with the lowest module that reads it. When the module above is built, the whole diff lands in its
codebase, as before. A part that lands in a codebase holding nothing yet, with nothing queued for
it, is given its module's whole spec as the change - not the files the modules below it read,
which come with their code.

### The queue master

Spec diffs queued for one codebase can overlap: a later change can undo, redo or rewrite what an
earlier one still waiting in the queue would render. Whenever a spec diff job is submitted while at
least one other is waiting, the queue master reworks the waiting ones. The harness works out the net
change - from the spec the code is built from (or the one the running spec diff lands) to the spec
as it now is - as numbered changes, and a proposal: each waiting job keeps the changes of its own
still in the net change, the rest going to the newest. An agent (the judge model, with the ***plain rules from `forge/rules`, as spec-writing agents have them) is given the queue,
every waiting job's diff, the spec before and after the new change and the `.plain` file itself, and
may delete, merge, reorder, rewrite and insert jobs, or ask the person when it is not sure. It commits
a queue of jobs, each a set of the numbered changes, and the harness holds it to where the queue has
to end: every change in exactly one job, no job without a change, the spec consistent after every job
(nothing used before it is defined), and the last job ending exactly on the `.plain` file as it is
now. A queue that does not check is refused with why; when the agent never commits one that does,
the harness takes its own proposal, and failing that the whole net change as one job.

A change that only adds on top - every queued job's changes still there as queued, the new job's
all that is left, as when `spark-plain` writes feature after feature - has nothing to rework, and
no agent is asked.

The harness's proposal keeps each queued job's own changes with it - as they were queued, or
edited since: when a later change takes the `My profile` link out of the nav bar a queued job adds,
the nav bar as it is now is still that job's, and a job only adding the profile page is left with
nothing. So taking something out of queued work is one spec diff that removes it from every spec
that names it; the queue master takes out the jobs it undoes and rewrites the ones it touches.

The spec diff rendering right now is not in the queue, and the work is measured from the spec it
will leave - unless the master stops it. It is told what the running job builds, and may stop it
when the new change undoes or rewrites most of that: stopping throws away what the job has done
so far, so a job near its end is left to finish. Stopped, the job ends and its module is put back at
its last commit before any queued job starts; the work is numbered again from what the code is
built from, and the running job's change comes back as the first job of the draft, to delete,
merge or rewrite like any other. A stop counts only with the queue committed after it. A job that
finishes just as it is stopped has landed: the next job renders from what it built, its diff taken
again from there. A change that undoes what the running job builds is never taken as only added on
top, so the master is always asked.

A planned job runs as the queued job it came from, keeping its place and id, wherever the order
allows; one that has to run earlier takes the place of a job the plan left out, and what does not
fit goes on after them as a new job. A job the rework leaves out never runs: it says where its
change went - to another job, or undone - its conformance job with it. A spec diff that has
started is never touched, and a functionality render still waiting on the codebase leaves the
queue as it is.

The tool that queued the change - `render_spec_diff`, `write_spec_diff` - waits for the queue
master's turn, up to two minutes, and says what became of it rather than that it was queued: a
removal folded into the jobs it touched is not a job of its own, and the jobs taken out and
rewritten are named. A job the master rewrites without renaming it is named for what it now
renders. In the TUI each rework is also a notice.

Conformance jobs are part of the queue it reworks. It sees which conformance job follows each spec
diff, and turns a job's conformance tests off - its conformance job cancelled, and it renders on its
unit tests alone - or on, when the config has them on and the module has test reqs: then the job
writes and runs them in its own render, since a conformance job added behind the queue would test
code that has moved on.

In a conversation, `rework_queue` has the queue master rework a codebase's queued spec diffs and
their conformance jobs as the person asks - run the feed first, merge two, split one, cancel the
conformance jobs - held to the same end; what would change
the spec itself takes a spec diff. Stopping a queued spec diff by hand does not take its change
out of the `.plain` files, so a spec diff that starts after one ahead of it did not land - stopped,
or failed - takes its diff again, from what the code is built from to the spec it leaves, and says
so: what it records is always what it built.

`render_spec_diff_conformance` is its conformance half, on its own - what `render_functionality_conformance`
is to `render_functionality`. It takes the same diff, applies it unless it already is, and has one
agent bring the conformance tests in line with it: write, change and remove them, from the diff and
the spec as it now stands. Then the whole suite runs. Nothing of the change itself is rendered, so it
is for a change that was rendered without conformance, or one only the tests follow - test reqs, an
acceptance test. The tests go where the code they check lives: the chain's current codebase, even
when the change is to a module it requires. Which functionalities have tests is read from their
labels.

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
the round goes again. The first review is asked for every problem at once; each after it is given what
the last one found, checks that first, and raises something new only when it is serious - a test that
cannot fail, mocks the software, or leaves out what the spec asks for. It asks only for what can be seen
from outside: where the spec says one part calls another, the outcome, never the call. What matters is
found in the first few reviews - the review optimises the tests, and after that they cannot be optimised
further - so after five that still found something, the tests are taken as they are: the run passes,
and what the last review suggested is kept in the result and the notes' pitfalls. Except a blocking
problem - the functionality not yet tested black box: a test or an acceptance test missing, cut down or
skipping what it checks, the software mocked or not reached from outside, a test that cannot fail. The
review marks each problem blocking or not, and a blocking one is never let go: the tests go back until
it is fixed. All three passing
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

## Working notes

Every agent is a fresh session, and without help each one would spend its first turns finding its
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
codebase: they are left out of the code map, the file lists and the try-it copies.

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

A record written by an earlier version of plainwright is read as the tree it describes, up to the
first functionality that did not build; the next build writes the tree.
