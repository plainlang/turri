# the handoff phase — Validate and hand off

Two halves. First **the agent** validates every spec with the `check_plain` tool, so nothing is left in a state a render would fail on for a fixable static error. Only after that passes does the agent **hand off**: what was built during the interview, what is still outstanding, and how to try it.

## 4a. Identify the render target

Find the **last module in the dependency chain** — the module that is not `requires`-ed by any other module. If there is only one module, use it. Call this module `<module>`.

- Chain `base.plain → features.plain → integrations.plain` → render target is `integrations.plain`.
- Single module `my_app.plain` → render target is `my_app.plain`.

## 4b. Validate every top module with `check_plain`

Run the `check_plain` tool on every top module — the modules no other module `requires`; a multi-part project has one per part. Checking a top module checks everything it `import`s and `requires`. Pass the project directory as the target to check every `.plain` file at once.

`check_plain` reports every syntax, concept and structure error with its file and line: undefined or cyclic concepts, broken `import` / `requires` chains, missing templates or linked resources, a module with no functional specs. Then:

- **All valid** → move on to 4c.
- **Errors** → do **not** hand off. Fix each one in the `.plain` files with the appropriate edit skill — never in generated code under `plain_modules/` — and run `check_plain` again until every top module is valid. An error you cannot resolve without a decision (two contradictory specs, a concept whose meaning is unclear) becomes a concrete question to the user.

`check_plain` sees syntax and structure, not meaning: a spec that is too big, two that conflict, or a fact in the wrong section all pass it. Those were handled in the loop by the analyzers and the reviewer.

## 4c. Hand off

Every functional spec was queued for rendering the moment it was written. Wait for the queue to finish — `render_status` shows it — then report:

- which functionalities were built and pass their tests, and where the code is (`plain_modules/<module>/code/`);
- which did not, and why, from each job's report;
- how to try what was built: each finished job reported try-it steps that were already run and checked.

If anything is outstanding — a functionality that failed, conformance tests the testing phase switched on after functionalities were built — offer to render it now with `render_module` on `<module>.plain`, which builds whatever is not built from the current spec and runs every conformance test. For a long run the user can leave, `plainwright module <module>.plain` does the same from the command line.

Also remind the user of any **side-channel commands** they may want to run themselves per the testing phase strategy — for example `./test_scripts/run_unittests.sh <module>`, `./test_scripts/prepare_environment.sh <module>`, or `./test_scripts/run_conformance_tests.sh <module> <conformance_tests_folder>`. Mention only the scripts that were actually generated in the testing phase.
