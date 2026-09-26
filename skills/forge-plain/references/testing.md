# the testing phase — How is what was built checked from the outside?

Decide whether the project has conformance tests, and if it does, say in `***test reqs***` how they
are written and run, and give it the script that runs them. This comes before the product phase, and
nothing here is built: a change to the test reqs is not a spec diff, so it is written with the
ordinary file tools, never `write_spec_diff`. What is settled here is what every build of the
product phase follows - with conformance on, each spec change is built with its conformance tests.
Run the core loop for each topic below, in order: ask, then write. When the user has no preference,
propose a default that fits the stack and the intent brief and ask them to confirm.

Conformance tests are black-box tests written from the spec: for each functional spec, tests that
run the built software from the outside - as a command, over HTTP, through its public entry point -
and check it does what the spec says, kept apart from the spec's acceptance tests. The harness runs
the whole suite after every spec change, so they catch one change breaking another. They cost time
and tokens on every build.

## Author target for this phase

- `***test reqs***` - one `:ConformanceTests:` requirement per fact, on the template if one exists
  (shared by every module), otherwise on the module. Follow `forge/rules/test-reqs.md`.
- `config.yaml` at the project root - the `conformance-tests:` decision. Change only that key, and
  create the file if there is none; everything else in it stays as it is.
- `test_scripts/` - the conformance testing script.

Write no `***acceptance tests***`, no functional specs and no `***implementation reqs***` here.

## Topics (in order)

1. **Conformance on or off** - ask it explicitly, with what it costs and what it catches; it is a
   recorded decision, never an inference. Write it to `config.yaml` as `conformance-tests: true` or
   `conformance-tests: false`. Off: say that no conformance tests will be written or run until it
   is turned on, and go to the end of the phase.
2. **Framework** - e.g. pytest, JUnit, Jest, Go's `testing`; one that fits the stack. Author it as a
   `:ConformanceTests:` requirement.
3. **How the tests reach the software** - as a subprocess of the CLI, over HTTP against a server the
   tests start, through the public entry point it exports. Author it.
4. **Setup and outside services** - fixtures, test data, databases, third-party APIs: started for
   real, faked, or mocked at the boundary. Author each decision as its own requirement.
5. **How the whole suite is run** - the one command that discovers every test. Author it.
6. **The conformance testing script** - if plainwright already finds one (named by
   `conformance-tests-script:` in `config.yaml`, or the one `run_conformance_tests*.sh` in the
   project root or in `test_scripts/`), check it runs the suite the way the test reqs now say, and
   keep it. Otherwise write `test_scripts/run_conformance_tests_<language>.sh` with
   `implement-conformance-testing-script`, to match the test reqs. Never link it from the specs.
   If `test_scripts/` would hold two of a kind, name the one to use in `config.yaml`.
7. **Anything else** - anything about testing the user wants to add or change.

Run `check_plain` on every module you changed. The product phase's first build needs the test reqs
and the conformance testing script both there: without them it stops before it starts.
