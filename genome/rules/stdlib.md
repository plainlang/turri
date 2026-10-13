---
description: The ***plain standard library - import modules for a backend, a frontend, a command-line tool or a library, on a known stack
---

# Rules for the standard library

turri ships a standard library of import modules that settle everything about a generic piece
of software on one stack except what it does: its language and framework, its layout, its
configuration, how it handles errors, how it logs, how it stops, and how it is tested. A module that
imports one writes only what is its own - its concepts and its functional specs - and a requirement
only for what its stack does not settle.

```plain
---
import:
  - stdlib/backend/python-flask
  - stdlib/backend/conformance/python-flask
---
```

## How it is built up

- Each stack imports its language's template - `stdlib/lang/python` - and its kind's `common` -
  `stdlib/backend/common` - so importing the stack brings all three.
- Each stack's conformance tests are a template of their own, `stdlib/<kind>/conformance/<stack>`,
  which imports `stdlib/<kind>/conformance/common`.
- The `common` of a kind settles what every stack of it shares. For a backend: settings from the
  environment, checked at start; handler, service and repository layers; domain errors turned into
  one error body `{"error": {"code", "message"}}` with fixed codes and statuses; JSON logs with a
  request id; shutdown on a signal. For a command-line tool: `Error: <message>` on standard error,
  exit codes 0, 1, 2 and 130, logs on standard error with `--verbose` and `--debug`. For a frontend:
  one API layer with an `ApiError`, errors shown in place or at the root, one logger module. For a
  library: one public entry point, one base error type, no output of its own.

## When to use it

- When the person wants a backend, a frontend, a command-line tool or a library, import the stack
  that fits instead of writing its implementation reqs yourself.
- Pick the stack from what the person said, the project's other modules, and what the module talks
  to. With nothing to go on: `stdlib/backend/python-fastapi`, `stdlib/frontend/react-vite`,
  `stdlib/cli/python-typer`, `stdlib/library/python`.
- Import the conformance template only when the module has conformance tests - the person asked for
  them, and the project's config does not turn them off (`conformance-tests: false`). Without it
  the module has no test reqs, and no conformance tests are written or run for it. Turning them on
  later is adding that one import.
- Read the templates a module imports before writing its specs - the folder is named below - and
  write no requirement they already make (see `concise-specs.md`).
- Write a functional spec's errors in the templates' terms: a backend's failure by its status and
  `error.code` - `not_found`, `conflict`, `validation_error`, `unauthenticated`, `forbidden`, or a
  code of the module's own - and a command-line tool's by its exit code and message.
- Add a requirement on top for what the module needs beyond its stack - storage, an outside
  service, a library it must use. When the module differs from its stack on something the stack
  settles - another framework, another layout - write the stack yourself instead: an import cannot
  be taken back in part. For a language with no stack of the kind wanted, import its
  `stdlib/lang/<language>` and write the rest.
- `stdlib/` is a reserved name. An import that starts with it is always the standard library's
  template, and a project module at such a path - `stdlib/backend/python-fastapi.plain` in the
  spec's folder, its `template/` folder or `PLAIN_TEMPLATE_DIRS` - is an error. Never write a module
  under a `stdlib/` folder of the project; a project's own shared template goes in `template/`
  under a name of its own.

## What it does not do

- It defines no concepts: its requirements are on the predefined `:Implementation:`, `:UnitTests:`
  and `:ConformanceTests:` only, so it never collides with the module's own definitions.
- It holds no storage: a module with a database says which, and how it is reached, on top.
- It holds no testing scripts. The module still needs its unit testing script, and its conformance
  testing script when it has conformance tests - written with the `implement-unit-testing-script`
  and `implement-conformance-testing-script` skills for the stack's language and test framework. Each
  runs the static checks of what it tests - the formatter, linter and type checker its language template
  names, on the code or on the conformance tests - and they count as the tests do.
- It names its stack's toolchain - Python 3.12, Node.js 24, Java 21, Go 1.25, Rust - which the agents use from the
  machine turri runs on; they install none, so `turri doctor` says when the machine lacks it.
