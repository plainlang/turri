---
name: init-plain-project
description: >-
  Lightweight initializer for a new ***plain project. Asks about the base
  technology and project kind, asks whether conformance testing is enabled,
  then scaffolds a template import module (with base implementation reqs and
  test reqs), a stub top-level module, the unit testing script, and
  (optionally) the conformance testing script under `test_scripts/`. Does NOT run `validate`. Use when the user wants a
  quick project skeleton to start writing functional specs against, without
  the full forge-plain interview.
allowed-tools: [read, write, edit, bash, ls, grep, find]
---

# Init Plain Project

## Scope

This skill is intentionally **minimal**. It produces a runnable project skeleton — not a complete spec. **No `***definitions***` sections are written by this skill — not in the template module, not in the top module.** No functional specs, no concepts, no acceptance tests, no validation. The user will fill those in afterwards with `add-feature`, `add-concept`, `add-functional-spec`, etc.

What this skill writes:

- `template/base.plain` — an import module with the project's base `***implementation reqs***` and `***test reqs***`.
- `<project>.plain` — a top-level module that imports `base`. Frontmatter only — no body sections. The user adds `***functional specs***` later.
- `test_scripts/run_unittests_<lang>.sh` — always.
- `test_scripts/run_conformance_tests_<lang>.sh` — only if conformance testing is enabled.

turri requires these scripts: a build with no unit testing script (or, with conformance on, no conformance testing script) stops before it starts. The harness runs them with Bash in a Linux VM, so they are `.sh` scripts.

What this skill does **not** do:

- Run `validate`.
- Author concepts, functional specs, or acceptance tests.
- Probe the host environment (`check-plain-env` is a separate step the user can run later).

## Workflow

### 1. Ask the project basics

Ask each with `ask_user`, one question per call, in this order:

- **Project name** — used as the top module filename and as `:AppName:` later. Free-form (`free_form: true`).
- **Base technology** — programming language and primary framework (e.g. Python + FastAPI, Node.js + Express, Go + net/http, Java + Spring Boot). Offer the most common stacks as options.
- **Project kind** — CLI tool, web app, REST API / backend service, library, desktop app, mobile app, other. Offer the common kinds as options.

Follow up with one free-form question for anything the options didn't cover (e.g. specific Python version, monorepo layout).

### 2. Ask about testing

Ask each with `ask_user`, one question per call:

- **Unit testing framework** — propose the canonical one for the chosen language (pytest, Jest, Go `testing`, JUnit, ...) and let the user override.
- **Conformance testing** — enabled or not. If the user is unsure, briefly explain it adds a `run_conformance_tests` script and per-spec acceptance tests later.

### 3. Author `template/base.plain`

Create the import module with `create-import-module`. It must contain:

- `***implementation reqs***` — the base stack as requirements **and everything about `:UnitTests:`**:
  - Programming language and version.
  - Primary framework (if any).
  - Dependency / package manager.
  - Project kind as a constraint (e.g. ":Implementation: should be a REST API service.").
  - `:UnitTests:` framework (pytest / Jest / JUnit / Go's `testing` / …) and the command used to run them — phrased in terms of `:UnitTests:` so the partition is explicit.
  - Anything else the user added in the free-form catch-all.
- `***test reqs***` — the base **conformance**-testing rules (only added if conformance testing is enabled):
  - ":ConformanceTests: must be implemented and executed - do not skip tests."
  - The `:ConformanceTests:` framework and the command used to run them.
  - **Do NOT** put unit-test framework / command here — that lives in `***implementation reqs***` above.

Do **not** add a `***definitions***` section to `template/base.plain`. This skill does not author any concepts. Use only the predefined concepts (`:Implementation:`, `:ConformanceTests:`) in the reqs — no project-specific concepts like `:AppName:` or `:App:`. Do not declare `required_concepts` either.

Do **not** add `***functional specs***` to `template/base.plain` — it is an import module.

### 4. Author the top module `<project>.plain`

Create it at the repo root with frontmatter:

```yaml
---
import:
  - base
description: <one-line project description>
---
```

Body: **none**. The file ends after the closing `---` of the frontmatter. Do **not** add `***definitions***`, do **not** add `***functional specs***`, do **not** add any other section. The user will add `***functional specs***` later via `add-functional-spec` / `add-functional-specs`, and any concepts via `add-concept`.

The file must still be created on disk — an empty body is fine, but the file itself is required.

### 5. Generate the testing scripts

Call the corresponding implementation skills in order. Each skill writes a Bash script, which is what the harness runs.

- `implement-unit-testing-script` — always.
- `implement-conformance-testing-script` — only if conformance testing was enabled. The script is self-contained: it stages the build, installs dependencies, and runs the module's whole conformance suite.

### 6. Check turri finds the scripts

turri finds the testing scripts in the project root, not through the specs: first in `config.yaml` (`unittests-script:`, `conformance-tests-script:`, paths relative to the root), then the one `run_unittests*.sh` / `run_conformance_tests*.sh` in the root, then the one of each kind in `test_scripts/`. It puts them into the prompts of the agents that write and run the tests itself, so do not link them from `template/base.plain` (a link to one is ignored). Confirm every generated script is in `test_scripts/` and is the only one of its kind there - or, if the project wants it, that a `config.yaml` at the root names the one to use and the path resolves. A project with modules on different stacks (e.g. a Python backend and a React frontend sharing an imported `base`) keeps one `config.yaml` for what they share and gives each module its own `config.<module>.yaml` beside it - `config.backend.yaml`, `config.frontend.yaml` - naming that module's `unittests-script:` and `conformance-tests-script:`.

Do **not** run `validate` here — keeping this skill light is the whole point. The user can run it when they want validation.

### 7. Recap

Tell the user what was created and what's next:

- Files written: `template/base.plain`, `<project>.plain`, the test scripts.
- Suggested next steps: add concepts with `add-concept`, add functional specs with `add-functional-spec` or `add-functional-specs`, or jump straight into `add-feature`.
- Mention that `validate` has not been run on `<project>.plain` yet.

## Validation checklist

Before the recap, walk `references/checklist.md` and confirm every box is met. It is a self-audit of this workflow — never a substitute for it. A box only counts as met when the file is on disk as described; complete any unmet step before recapping.

## Question style

Use simple grammatical structures: short direct sentences, one idea per sentence, plain words over jargon. Keep every constraint and edge case the user needs to answer accurately.
