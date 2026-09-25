# the testing phase — How should testing be done?

Gather the testing strategy. This phase covers `***test reqs***`, `***acceptance tests***`, and the testing scripts under `test_scripts/`. Run the core loop (ask → author → review) from `SKILL.md` for each topic below, in order. When the user has no preference, propose a default that fits the language and stack chosen in the stack phase and ask them to confirm.

## Hard partition (applies to every topic)

- **Everything about `:UnitTests:`** — framework, layout, packages, conventions, execution command, coverage, mocking policy (every fact) — is authored into `***implementation reqs***` via `add-implementation-requirement`. The unit-test generator reads only that section.
- **Everything about `:ConformanceTests:`** — framework, layout, packages, execution command, mocking policy, environment prereqs (every fact) — is authored into `***test reqs***` via `add-test-requirement`. The conformance-test generator reads only that section.
- A topic that mixes both kinds of facts is split: unit facts go to impl reqs, conformance facts go to test reqs. They never share a bullet.

## Where the scripts live

The testing scripts are not linked from the specs. plainwright finds them in the project root
(the folder that holds `plain_modules/`), in this order: `config.yaml` at the root
(`unittests-script:` and `conformance-tests-script:`, paths relative to the root), then the one
`run_unittests*.sh` / `run_conformance_tests*.sh` in the root, then the one of each kind in
`test_scripts/`. It puts them, whole, into the prompts of the agents whose work they judge - the
unit testing script always, the conformance testing script when conformance tests are written.
A link to a testing script from a spec is ignored. The requirements still say in words how the
tests run (framework, command); they just don't link the script.

plainwright never guesses between two scripts of one kind in one folder. `config.yaml` names one
unit testing script and one conformance testing script for the whole project, so a multi-language
project (e.g. a Python backend and a React frontend) with a script per language must name the one
to use in `config.yaml`.

Write the scripts as `.sh` (Bash): the harness runs them in a Linux VM, and only `.sh` scripts are run. plainwright requires them - a build with no unit testing script (or, with conformance on, no conformance testing script) stops before it starts.

## Topics (in order)

1. **Unit tests** — their framework and their script were settled at the end of the stack phase; do not ask again.
   - Only if an answer since has changed how the unit tests are run, update the `:UnitTests:` requirement and regenerate the script via `implement-unit-testing-script`.
   - Review that the unit testing script is still the one plainwright finds (and `config.yaml`, if the project needs one).
2. **Unit-test types and architecture mapping** — which of unit tests and integration tests the user wants, and how tests map to the the stack phase architectural layers (e.g. one test module per service, repository tests with an in-memory store). Author a `:UnitTests:` scope / architecture requirement in `***implementation reqs***`, phrased in terms of `:UnitTests:` so the partition is visible. Review that requirement.
3. **Conformance testing** — explicitly ask whether conformance / end-to-end tests should be part of the project. This drives whether `run_conformance_tests` is generated and whether `***acceptance tests***` are authored. If the user is unsure, briefly explain the tradeoff (extra scripts + per-spec acceptance tests vs. lighter setup) and let them choose.
   - If **yes**: author a conformance-testing requirement in `***test reqs***` (framework, execution command, any constraints); generate `run_conformance_tests` via `implement-conformance-testing-script`; then **walk every functional spec authored in the functional specs phase, one at a time** — for each spec, ask one `ask_user` question whether it needs concrete verification, and if yes author one acceptance test under that spec via `add-acceptance-test`, then review that acceptance test as a snippet before moving to the next spec. Never bulk-write acceptance tests; never ask about more than one spec per call.
   - If **no**: record the decision; skip the conformance script and acceptance-test authoring entirely.
   - Review the conformance req (if any), the new script (if any), and each acceptance test snippet (if any).
4. **Test layout & conventions** — directory layout, naming conventions, fixtures / mocks strategy — anything that constrains the *shape* of test code beyond what topics 1–3 established. Ask about both kinds of tests where applicable; keep their facts in separate reqs in separate sections. Author `:UnitTests:` layout / convention requirements in `***implementation reqs***` and `:ConformanceTests:` layout / convention requirements in `***test reqs***` (only when conformance is enabled), each phrased with the predefined concept it shapes so the partition is visible. Review each requirement snippet.
5. **Execution & tooling** — how tests are run (commands, runners, options), coverage targets, CI integration, any environment setup tests rely on beyond what the scripts install. Split by concept the same way as topic 4. If the agreed execution command or options differ from what a script generated in topic 1 or 3 currently uses, update the affected script(s) now. Author `:UnitTests:` execution requirements in `***implementation reqs***` and `:ConformanceTests:` execution requirements in `***test reqs***`. Review each requirement snippet and any modified script.
6. **Other testing constraints** — performance / load expectations, deterministic seeds, network isolation, secrets handling — anything stack-wide that constrains *how* tests are written and hasn't already been covered. Author each constraint as its own requirement at the appropriate scope. Review each constraint snippet.
7. **Anything else** — anything the user wants to add or change that hasn't already been covered.

When all topics are complete, recap the full testing strategy: which scripts exist and how plainwright finds them (`test_scripts/` or `config.yaml`), the framework, the test types in scope, the conformance decision, and any cross-cutting constraints. Get an explicit overall confirmation, then verify the environment.

## Verify the environment

Delegate environment verification to the `check-plain-env` skill — do **not** probe the machine inline. It is the single source of truth for "can this machine render and test this project?" and derives the requirement list at runtime from the project's `.plain` files, `test_scripts/`, and `resources/`.

`check-plain-env` detects the host OS, builds the requirement list (language toolchains + their package managers, external services, system binaries that language packages wrap, hardware / drivers / accelerators, `plainwright` itself, credentials — the layers a package manager **cannot** install), probes each with a real version / availability command, and emits a `PASS` / `WARN` / `FAIL` report with OS-specific install commands for any gaps. It never probes individual language packages (`torch`, `numpy`, `FastAPI`, `react`, JARs, gems) — those are installed by the project's own unit-test and conformance-test scripts the moment they run. It is read-only and installs nothing itself.

Act on the return value:

- **`PASS`** — the machine is ready. Continue to the handoff phase.
- **`WARN`** — everything required is present but there is at least one soft warning (e.g. a service binary present but its daemon not running, a language-version mismatch). Show the warnings to the user; let them decide whether to address each one now or proceed knowing the corresponding scripts will surface the issue later.
- **`FAIL`** — at least one required item is missing. For every gap the report already gives what is missing, why the project needs it, and how to install it for the detected OS. Walk the gaps with the user: install now, swap to an alternative (which means revising the the stack phase / the testing phase decisions), or proceed knowing the corresponding scripts will fail. Re-invoke `check-plain-env` after the user installs anything so the report reflects the current state of the machine.

Do not move on to the handoff phase until `check-plain-env` returns `PASS`, or `WARN` / `FAIL` with the user's explicit acknowledgement of each remaining item.
