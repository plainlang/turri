# Rendering

What happens when a spec is turned into code - in which order, by which agents, and what has to
be true before the harness moves on. The order is the harness's, not the agents': an agent writes
code or tests, and the harness decides what runs next and whether the work is done.

## Where things go

| | |
| --- | --- |
| `plain_modules/<module>/code/` | the implementation and its unit tests |
| `plain_modules/<module>/tests/` | the black-box conformance tests, organised however suits them |
| `plain_modules/<module>/code/.plainwright.json` | the build record - see [below](#the-build-record) |
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

The agent runs its tests through `run_unit_tests`, which runs them in the [sandbox](sandbox.md) and
records the result for the harness. But the agent chooses those commands, so a functionality is
not done on the agent's run: once its own run passes, **the harness runs the whole unit test suite
itself**, and only that run counts. It uses the unit-test script the codebase carries - the one the
spec links to - or else the agent's last passing command, if that command runs the whole suite. A
run that only ever named one file, or ran nothing, is sent back to run everything. After each turn
the harness checks three things and sends the agent back if any is wrong, up to 20 times:

- **The suite is not green**, or was never run at all.
- **The harness's own run fails**, or the agent never ran the whole suite.
- **Tests went missing.** The test files present before the turn are inventoried and compared
  afterwards; a deleted file or a file that lost cases is challenged by name.

A test may go only when it asserts nothing meaningful - it cannot fail, exactly duplicates
another, or tests something the spec does not require. Inconvenient, slow or failing are not
grounds. Justified removals are reported, not silent. The baseline is taken before the agent
starts, so breaking an earlier functionality's test is caught too.

### Then

Once the unit tests pass: the conformance tests already in the codebase are run and kept passing
(repairing the code if needed), the build record is updated, and a commit is made to the module's
history. When someone is there to try it, the agent is also asked how to try the functionality:
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

### The whole-suite command

A regression is only a regression if the command runs everything. Left alone, a test agent
narrows to the file it just wrote, so the harness picks the command itself: the most recent
passing run that looks like a discovery run (`unittest discover`, `pytest`, `npm test`,
`go test ./...`, `mvn test`, `gradle check`, `cargo test`). When none is found it falls back to the
last passing command and warns that it may cover only part of the suite.

## A spec change, as a diff

`render_spec_diff` takes a change to the specs as a git diff of the `.plain` files - any section,
across any number of files, from scratch included. The diff is applied with git (or accepted as
already applied), and the spec is parsed with it in. One agent, given the diff and every relevant
spec as they now stand, makes the code match; then the conformance tests are brought in line, the
whole suite runs with repairs, and try-it is worked out and checked.

The build record is rewritten from the spec as parsed when the diff went in - every section, not
only the functional specs - and the diff is added to its `specDiffs`. A diff queued behind others
is rendered from its own parse, not from the files as they are by the time it runs.

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

When its own run passes, the harness checks for itself: it runs the whole conformance suite - a run
that only named one file is sent back - and, if the agent changed the code, the code's unit tests
too. Only that counts. It goes back and forth up to 20 times.

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

The notes are disposable - delete the file and nothing breaks; the next agent just explores a little
more. They live in the code folder, so they are committed with it, reset with it after an
interrupted run, and copied up with it to a module that requires this one. They are not part of the
codebase: they are left out of the code map, the file lists and the try-it copies.

## The build record

`plain_modules/<module>/code/.plainwright.json` says what the codebase was built from: the shared
sections once (definitions, implementation reqs, test reqs), then the functional specs - the
required modules' first - each with its hash, whether its unit and conformance tests passed, what
its render changed and the test command that passed. A render adds one functionality; a spec diff
rewrites the record to the spec it was rendered from. It is what staleness is judged by: a
functionality is rebuilt when its own spec no longer matches what it was built from.
