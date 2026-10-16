---
description: The ***plain project model - the specs as source of truth, the repository layout, generated output, template parameters, and what an earlier test failing after a render means
---

# The ***plain project model

This rule covers the project as a whole. Section content is owned by the per-section rule files;
file structure by `module-structure.md`.

## Source of truth

- The `.plain` files are the source of truth. They state what the software does, how it is built,
  and how it is tested; the code is generated from them
- Every change to the software is a change to a `.plain` file, which the next render builds. A fix
  made anywhere else is lost the next time the code is regenerated

## Repository layout

```text
*.plain                  # root modules: what the software does
template/*.plain         # import modules: shared definitions and reqs
resources/               # files specs link to: schemas, API specs, fixtures
test_scripts/            # unit and conformance runners, found by turri (not linked)
config.turri.yaml        # the project's build decisions: models, conformance tests, the scripts in use
plain_modules/           # generated - one folder per module
  <module>/code/         #   implementation and unit tests
  <module>/tests/        #   the whole conformance suite of the module
```

Follow `module-structure.md`, `import-modules.md` and `linked-resources.md` for what these
directories may contain and how a spec refers to them.

## The config records the build decisions

`config.turri.yaml`, at the project root beside the specs, is where the project's decisions about how it
is built live: the models, whether conformance tests are written (`conformance-tests:`), and the scripts
it uses (`unittests-script:`, `conformance-tests-script:`,
`prepare-environment-script:`). turri can find a script by its name, but the config is what a person
reads to see how the project is set up, and what they change.

- Settle a decision, write it into the config in the same step - never leave it to be inferred from
  what is on disk. A testing script you write or keep is named by its key, by path
  from the root (`unittests-script: test_scripts/run_unittests_python.sh`); conformance tests
  turned on or off are `conformance-tests: true` or `false`
- Change only the keys you settled. Where the file has a key's example commented out, uncomment that
  line and set it; keep every other line and comment as it is
- A project whose parts are on different stacks keeps each stack's scripts in its own
  `config.turri.<stack>.yaml` beside it; what the stacks share stays in `config.turri.yaml`
- A project with only a `config.yaml` has it copied to `config.turri.yaml` first, and each
  `config.<name>.yaml` to `config.turri.<name>.yaml`; `config.yaml` may be another tool's, and is never
  written
- Say in your summary which lines you wrote

## Generated output is read-only

Everything under `plain_modules/` is generated - `code/` and `tests/` alike. Read it, run it, debug
it; never edit it. Fix the spec instead, in the section that owns the fact:

- behaviour, implementation or unit-test guidance → definitions, functional specs, or implementation
  reqs
- conformance-test guidance → test reqs
- acceptance-test guidance → the acceptance tests nested under their functional spec

Then render again.

## Template inclusion with parameters

Besides frontmatter `import`, a template can be included with parameters:

```plain
{% include "python-console-app-template.plain", main_executable_file_name: "my_app.py" %}
```

Parameters are key-value pairs; the template reads them as `{{ variable_name }}`.

## When an earlier test fails after a render

Each functional spec is written knowing the ones before it and none after it - a required module's
specs count as before - so a spec may rely on what earlier ones say, never on later ones. This is
about what a spec may assume, not what a change costs (`turri-regeneration.md`). After each
render every conformance test so far runs again. A test that passed before and fails now means one
of:

1. the new code does not satisfy its spec;
2. the test does not test its spec accurately;
3. the new spec and an earlier one conflict.

The harness triages the first two and repairs the code. The third is a spec problem: resolve it in
the `.plain` files with `resolve-spec-conflict`, and trace a misbehaving build back to its spec with
`debug-specs` - never by editing generated output.
