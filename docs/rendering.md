# Rendering

What happens when a spec is turned into code - in which order, by which agents, and what has to
be true before the harness moves on. The order is the harness's, not the agents': an agent writes
code or tests, and the harness decides what runs next and whether the work is done.

## Where things go

A spec is built in its **project**: the nearest folder, from the spec's own up, that holds a
`config.yaml` or a `plain_modules/` - or, with neither, the spec's own folder. That is where its
`plain_modules/` is, its `config.yaml` read and its testing scripts found, wherever plainwright was
started: a project that keeps its specs in `plain/`, with `plain/config.yaml` and
`plain/plain_modules/`, builds `plain/hubspot.plain` in `plain/plain_modules/hubspot/`, named from
the folder above. Links in a spec are relative to the spec.

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

The prompt, and nothing else - the agent cannot read the `.plain` files. It holds the definitions
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

### The tests must actually pass

While it works, the agent runs tests however it likes with `bash` - one file, one case, any
configuration - in the [sandbox](sandbox.md). Before it finishes, it calls `run_unit_tests`: a final
check that takes no command and runs the project's unit testing script exactly as the harness will.
But a functionality is not done on the agent's run, whatever it ran: after each turn **the harness
runs the unit testing script itself**, and only that run counts (see
[the testing scripts](#the-testing-scripts)). It sends the agent back, up to 20 times, when:

- **The harness's run of the unit testing script fails** - its output goes back to the agent.
- **Tests went missing.** The test files present before the turn are inventoried and compared
  afterwards; a deleted file or a file that lost cases is challenged by name.

A test may go only when it asserts nothing meaningful - it cannot fail, exactly duplicates
another, or tests something the spec does not require. Inconvenient, slow or failing are not
grounds. Justified removals are reported, not silent. The baseline is taken before the agent
starts, so breaking an earlier functionality's test is caught too.

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
then run **every** conformance test in the codebase as one suite. It advances only when that whole
suite is green. When it goes red, a repair agent works on the code with the module's spec and the
failure; the suite runs again after each repair, up to `--max-regression-rounds` (default 20). The
repair agent is not allowed to change the tests: the harness photographs them before it starts,
and puts back anything it changed before sending it to fix the code instead. A functionality is finished when it passes alongside
everything before it.

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

1. `config.yaml`, naming them by path from the root:

   ```yaml
   unittests-script: test_scripts/run_unittests.sh
   conformance-tests-script: test_scripts/run_conformance_tests.sh
   ```

2. the root itself: the one `run_unittests*.sh` and `run_conformance_tests*.sh` there;
3. `test_scripts/`: the one of each there.

The same `config.yaml` holds the project's other defaults - `module`, `model`, `conformance-tests` -
for [unattended runs](headless.md). A folder holding two of a kind is not guessed between: name the
one to use in `config.yaml`. The
scripts are not linked from the specs; a link to one is ignored.

They are required: a build with no unit testing script, or with conformance on and no conformance
testing script, stops before it starts and says which skill adds it.

**Where they run.** By default in the sandbox VM, from a copy: the script, the build and the
conformance suite staged in a folder of their own. A project whose tests only need what they are
given - most - is best off there: the VM has the toolchains, and the tests are sandboxed.

An integration embedded in a host codebase is not: its scripts merge the generated code into the host
and run the tests there, in the host's environment, which the VM does not hold. For it,
`testing-scripts: host` in the project's `config.yaml` runs them in place on this machine - from the
project's folder, at their own path, on the real build and tests folders, as codeplain did:

```yaml
# plain/config.yaml
testing-scripts: host
```

The agents are not moved: their file tools and `bash` stay fenced to `plain_modules` and the VM, and
only the scripts' output reaches them. The time limit and a stopped job still end the script and all
it started, and the model providers' API keys are kept out of its environment. What the script does
to the host - copying the package into it - it does, as it is written to.

Turning conformance off (`conformance: false`, `--no-conformance`) sets the conformance testing script
aside, found or not: no conformance tests are written, the ones already in the codebase are not run,
and no agent is shown it. That is different from a module with no test reqs, which writes no
conformance tests of its own but still keeps the codebase's existing ones passing.

The scripts live in the project, outside `plain_modules`, where no agent can reach them - one
`config.yaml` names inside `plain_modules` is refused. Each run
copies the script fresh from the project into the VM, stages the code under a name of its own -
the scripts work in `/tmp/<lang>_<basename of the build>`, and every module's build is called `code`
- and runs it with the command time limit: two minutes, or `PLAINWRIGHT_COMMAND_TIMEOUT` seconds.
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

Output an agent is shown - a script's, or a command's it ran itself - is at most 20,000 characters.
A longer one keeps its start (what ran, with which toolchain) and its end (the failures, the stack
traces, the summary), and says how much was cut from the middle; the whole of it is kept in
`plain_modules/.plainwright/logs/`, where the agent can read it, and the cut names the file. The
last 100 are kept.

## A spec change, as a diff

`render_spec_diff` takes a change to the specs as a git diff of the `.plain` files - any section,
across any number of files, from scratch included. The diff is applied with git (or accepted as
already applied), and the spec is parsed with it in. One agent, given the diff and every relevant
spec as they now stand, makes the code match; then the conformance tests are brought in line, the
whole suite runs with repairs, and try-it is worked out and checked.

When it passes, the tree the code is built from becomes the spec as parsed when the diff went in -
every section, not only the functional specs - and the diff is committed with it. A diff queued
behind others is rendered from its own parse, not from the files as they are by the time it runs.

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

### Black box in shape, not in blindness

The test author can read the implementation: to find out how the thing is invoked, never to decide
what it should do. The tests call the built software from outside, through its entry point, and
every assertion comes from the spec - a test written from the code agrees with the code by
construction and can never catch it being wrong. `run_conformance_tests` copies the build and the
tests into a throwaway directory and runs a command there, so tests cannot accumulate state
between attempts and nothing they write reaches the code.

### When a conformance test fails

It works like the unit tests: one agent goes back and forth until they pass. When a run fails, the
failure goes back to the same agent, which works out against the spec what is wrong and fixes that
one - a test that misreads the spec is corrected, code that does not do what the spec says is
fixed, and its unit tests kept passing. It is told never to change a test so it agrees with code
that contradicts the spec, and a test it deletes is challenged by name.

When its own run passes, the harness checks for itself: both kinds of test are there and labelled,
then it runs the project's conformance testing script on the whole suite, and - if the agent
changed the code - the unit testing script too. Only those runs count. It goes back and forth up to
20 times.

### Verified

After rendering a hello-world Python spec's functionality 1, the conformance test runs
the app as a subprocess and asserts on stdout, exit code and time - no import of internals:

```python
completed = subprocess.run([sys.executable, str(executable)], capture_output=True, text=True, timeout=1)
self.assertEqual(completed.returncode, 0, msg=completed.stderr)
self.assertEqual(completed.stdout.strip(), "hello, world")
```

Code that prints `goodbye` instead fails the test; the agent fixes the code, and the harness's own
runs - the suite, then the unit tests of the changed code - pass (`tests/render/conformance-loop.test.ts`).

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

- [2026-09-24 16:39 · d365_version_api 1] VersionResponseObject capabilities follow the JSON in the spec
- [2026-09-24 16:52 · d365_auth 1] Token responses carry `access_token` and `expires_in`
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

- **A functionality rendered:** the tree as it was, with that functional spec in its place - and the
  definitions it is the first to use, with the reqs that name them. What was built before stays as
  built: a definition changed since is not claimed as built, so the change is still there to render.
  The first functionality of a module is built with all of the spec's reqs, so they all go in.
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
