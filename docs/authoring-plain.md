# Authoring \*\*\*plain

Rendering turns a spec into code; authoring is the half that decides what gets built. The code is
only ever as good as the spec - a fact in the wrong section is silently ignored, a functional spec
that is too big comes out half-built, two specs that contradict each other break each other's
tests. So this repo carries as much for writing specs as for rendering them: the authoring rules,
a library of skills that apply them, and independent review of what they write.

The rule underneath all of it: **the specs are the source of truth**. The generated code in
`plain_modules/` is never edited by hand. A bug is fixed in the spec, and a change that is wanted
goes into the spec - that is what persists and what the next render builds from.

## A \*\*\*plain project

```
my-project/
  app.plain            # a root module: what the software does
  users.plain          # another module, perhaps one that `requires` app
  template/            # import modules: shared definitions and reqs
  resources/           # files specs link to: schemas, API specs, sample data
  test_scripts/        # scripts that run the unit and conformance tests
  plain_modules/       # generated - code, tests, history; never edited by hand
```

## What a spec is made of

A `.plain` file is one module: optional YAML frontmatter, then up to four sections, in this order.

| section | holds | e.g. |
| --- | --- | --- |
| `***definitions***` | the concepts, written `:CamelCase:` - every concept is defined before it is used | `- :Task: is a unit of work with a title and a due date.` |
| `***implementation reqs***` | HOW it is built: stack, architecture, coding standards, and everything about unit tests | `- :Implementation: is written in Python 3.12.` |
| `***test reqs***` | everything about the black-box conformance tests: framework, how they run, mocking | `- :ConformanceTests: use pytest and call the CLI as a subprocess.` |
| `***functional specs***` | WHAT it does - observable, language-agnostic behaviour, one functionality per item, in the order they are built | `- A :User: can add a :Task:.` |

Under a functional spec, a nested `***acceptance tests***` list states how that one
functionality is checked end to end.

The frontmatter connects modules:

| field | |
| --- | --- |
| `description` | one line on what the module is |
| `import` | take the definitions, implementation reqs and test reqs of an import module - shared content, no functional specs of its own |
| `requires` | build on top of another module: its functional specs and its generated code come first |
| `exported_concepts` | which concepts a module that `requires` this one may use |
| `required_concepts` | concepts an import module expects the importing module to define |

Beyond that: a spec links to files under `resources/` with markdown link syntax, and the file's
contents go to the renderer with the spec; lines starting with `>` are comments for people; and
files are processed with Liquid first, so a template can be included with parameters.

**Section ownership is the rule that bites.** The renderer reads each kind of fact only from the
section that owns it. A tech choice written into a functional spec, or a behaviour written into
the implementation reqs, is not flagged - it is simply not read.

## The standard library

turri ships a standard library of import modules in `stdlib/` that settle everything about a
generic piece of software on one stack except what it does: its language and framework, layout,
configuration, error handling, logging, shutdown, and how it is unit and conformance tested. A spec
imports one and writes only its own concepts and functional specs:

```plain
---
import:
  - stdlib/backend/python-flask
  - stdlib/backend/conformance/python-flask    # leave it out to skip conformance tests
---

***functional specs***

- ...
```

| kind | stacks - each with `stdlib/<kind>/conformance/<stack>` beside it |
| --- | --- |
| `stdlib/backend/` | `python-fastapi`, `python-flask`, `python-django`, `typescript-express`, `typescript-fastify`, `typescript-nestjs`, `java-springboot`, `go-nethttp`, `go-gin`, `rust-axum` |
| `stdlib/frontend/` | `react-vite`, `vue-vite`, `sveltekit-spa`, `angular` |
| `stdlib/cli/` | `python-typer`, `python-click`, `python-argparse`, `typescript-commander`, `go-cobra`, `go-flag`, `rust-clap`, `java-picocli` |
| `stdlib/library/` | `python`, `typescript`, `java-maven`, `java-gradle`, `go`, `rust` |

It is built in three layers, and a stack imports the other two:

- **The language** - `stdlib/lang/python`, `typescript`, `java`, `go`, `rust`: the version, the
  dependency manager, formatting, linting and type checking (ruff and mypy for Python; Prettier, ESLint
  and `tsc --noEmit` for TypeScript), how a failure is reported (an exception, a returned error, a
  `Result`), the logging library, and the unit test framework and layout. A module on a stack the library does not have can import its language alone.
  The formatter, linter and type checker a language names are enforced by the testing scripts, which
  run them with the tests - the unit testing script on the code, the conformance testing script on the
  tests - and count them as the tests (see [the static checks](regenerating.md#the-static-checks)).
- **The kind's `common`** - what every stack of a kind shares:

  | kind | settles |
  | --- | --- |
  | backend | settings from the environment into one typed object, checked at start (exit 1 when one is missing); handler, service and repository layers; domain errors turned in one place into `{"error": {"code", "message"}}` - `not_found` 404, `conflict` 409, `validation_error` 422 with `details` per field, `unauthenticated` 401, `forbidden` 403, `internal_error` 500 with no message and the stack trace logged; JSON logs on standard output with `timestamp`, `level`, `logger`, `message` and `request_id`, level from `LOG_LEVEL`, one line per request, never a secret or a body; `X-Request-ID` taken or made and sent back; shutdown on SIGTERM within 10 seconds |
  | frontend | one API layer that turns a failed call into an `ApiError` with the backend's error code, or `network_error`; errors shown in place, and a page for anything else at the root; one logger module, no `console` elsewhere; accessible roles and test ids |
  | cli | settings from flags, then `<TOOL>_<SETTING>`, then defaults; the work apart from parsing; errors as `Error: <message>` on standard error, exit 0, 1, 2 for a usage error, 130 on Ctrl-C, a stack trace only with `--debug`; logs on standard error, warnings by default, `--verbose`, `--debug` |
  | library | one public entry point; one base error type, with a dependency's errors wrapped; logs through the language's logging with no output set up; no environment variables, output or global state |

- **The stack** - the framework and how it does each of those: for `python-flask`, an application
  factory, one Blueprint per resource, Pydantic for bodies, `@app.errorhandler` for the error body,
  structlog JSON logs with the request id bound in a hook, Gunicorn. For `go-cobra`, `RunE`
  commands with Cobra's own error printing off, so `main` alone writes the error and picks the exit
  code, and slog on standard error.

Each conformance template imports its kind's `conformance/common`: a backend's tests start the
built service on a free port and reach it over HTTP only, checking a failure by status and
`error.code`; a frontend's run the served build in Chromium through Playwright with the backend
stood in; a command-line tool's run the built tool as a process; a library's go through its public
entry point.

- **Conformance tests apart.** A spec without the conformance template has no test reqs, so no
  conformance tests are written or run for it. Turning them on later is adding that one import.
- **A reserved name.** An import that starts with `stdlib/` is always turri's template, never
  a file of the project's. A project with a module at such a path - `stdlib/backend/python-fastapi.plain`
  beside the spec, in its `template/` folder or in `PLAIN_TEMPLATE_DIRS` - gets an error saying the
  name is reserved, so which one a spec builds on never depends on what is on disk beside it.
- **No concepts.** Its requirements are on the predefined `:Implementation:`, `:UnitTests:` and
  `:ConformanceTests:` only, so it never collides with a spec's own definitions.
- **Pinned to a toolchain.** It names its stack's toolchain - Python 3.12, Node.js 24, Java 21, Go 1.25, Rust -
  which the agents use from this machine; `turri doctor` says when the machine lacks it.
- **Not storage, not the testing scripts.** A module with a database says which on top of its
  stack. It still needs its unit testing script, and a conformance testing script when it has
  conformance tests.
- **Known to the agents.** The `stdlib` rule, in every spec-writing agent's system prompt, says when
  to import which, and lists every template with what it is and the folder it is in, read from
  `stdlib/` when the rules load. `spawn` and `brood` import a stack when the one chosen
  is in it, and its conformance template when conformance tests are on.
- **Only what this machine can build.** The agents use this machine's toolchains and install none, so
  a Go stack on a laptop without Go stops at its first build. Every spec-writing agent and the
  conversation are told which of the standard library's languages the machine can build now - Python
  needs `uv`, TypeScript and every frontend `node` and `npm`, Go `go`, Rust `cargo`, Java a JDK
  (`src/stack.ts`, `toolchainsBlock`) - and `spawn` and `brood` offer, and choose, only stacks in those.
  A stack the person names in a language the machine lacks is not refused: they are told what to install
  first, and that `turri doctor` checks it.

A requirement beyond the stack - storage, an outside service - is added on top of it. A module that
differs from its stack on something the stack settles - another framework, another layout - writes
its own instead: an import cannot be taken back in part.

## The rules

`genome/rules/` holds the authoring rules. They are in the system prompt of every agent that
writes specs - the conversation, the interview skills, the reviewers - so they are not something
an agent has to decide to go and read.

| rule | covers |
| --- | --- |
| `module-structure.md` | the file skeleton, frontmatter fields, section order, module kinds, section ownership |
| `definitions.md` | concept syntax, predefined concepts, define before use, no circular definitions, granularity |
| `func-specs.md` | voice, the complexity limit, chronological order, no conflicts, language agnosticism, testability, acceptance tests |
| `impl-reqs.md` | HOW not WHAT, unit tests live here, what belongs and what does not |
| `test-reqs.md` | conformance tests only, what belongs, test types |
| `concise-specs.md` (+ two example banks) | keeping specs short enough for a person to review: no obvious lines, plain words, no uncheckable adjectives, no hedging |
| `bullet-continuation.md` | bullets and continuation lines in every section |
| `linked-resources.md` | a linked resource is one text file on disk, or a PNG or JPEG image for a model that reads images; protocol artifacts are linked, never transcribed |
| `import-modules.md`, `requires-modules.md` | the two ways modules build on each other |
| `exported-concepts.md`, `required-concepts.md` | which concepts cross module boundaries |
| `integrations.md` (+ standalone, embedded, embedded testing) | specs for REST API integrations, deployed standalone or embedded in an existing codebase |
| `stdlib.md` | the standard library: when to import which template, and every template with what it is and where it is, read from `stdlib/` |

The ones that shape a spec most:

- **One functionality is at most ~200 lines of code.** A bigger one is split before it is written
  (`analyze-if-func-spec-too-complex`, `break-down-func-spec`).
- **Functional specs are in build order.** Each is rendered on top of the ones before it.
- **They state facts, with a concrete subject.** "A :User: can add a :Task:" - not "Implement
  adding tasks", not "The system should…".
- **Nothing a test cannot check.** No `robust`, `seamless`, `as appropriate`; state the checkable
  fact or cut the word.
- **No two specs contradict each other.** A conflict is found and resolved when a spec is added,
  not when its tests fail.

## Writing specs with turri

In a conversation (`turri`), say what you want and the matching skill runs. Two build a
project from scratch, and write each spec change as a git diff that is built in the background the
moment it is written. `brood` interviews you one question at a time and writes the specs as
you answer; `spawn`, its quick twin, asks only what you want to build and which stack - or leaves the stack
to it - and writes the rest on its own:

| skill | phases | how a spec change is written |
| --- | --- | --- |
| `brood` | intent → stack → testing → product, feature by feature | first, how many questions the stack and product phases may ask - light 3, medium 5, thorough 10 or best judgement, broader with fewer, covering the same ground - and what they leave open turri decides itself, each decision a spec change of its own; every product answer is still a spec change, built before the next question; in testing, whether there are conformance tests, their `***test reqs***` and script - written as files, building nothing; then one spec change per answer, across whatever sections it needs, as a git diff with `write_spec_diff`, rendered as a render spec diff job and conformance tested as it is built |
| `spawn` | intent → groundwork → product | only the intent and the stack are asked - the stack one question, `You choose` first, skipped when the user named one; the stack and the unit tests are written as files, with conformance tests off unless the user asks for them; then one spec change per feature, in build order, as a git diff with `write_spec_diff`, one after another with no answer between them. Changes after it are asked for in the conversation, as spec diffs, and what is left to build is worked out again from the spec |

`mature` starts from a spec you already have, rough or hand-written, and runs on its own until
it is fully rendered - every functionality built from the spec as it stands, its tests passing. It
renders what is not built and watches the agents building it; when one struggles on something the
spec leaves open or unclear - sent back again and again, the judge going back and forth, a spec
conflict - it writes what the spec should say as a spec diff, stops that build, and renders it again.
What the builds had to decide themselves - their assumptions, pitfalls, a failed build's diagnosis -
goes into the spec the same way, when a user, a caller or a test can see it. It never asks: it takes
the reading that fits the rest of the spec, and marks each such decision in its report. It leaves
code, environment and turri problems to the builds, and stops when a functionality keeps
struggling after the spec was clarified, when two cycles change nothing, or after twenty.

For an existing project, `bud` works the same way, scoped to one feature: intent → scope →
product → review. After a short feature-intent interview it asks product questions one at a time -
a trigger and its outcome, an edge case, a rule - and every answer is one spec change, a git diff
written with `write_spec_diff` and built the moment it is written. A change to something already
specified, built or still to build, is put to the user first and is a spec diff too: what is left to
build is worked out again from the spec.

What keeps the interview honest is the harness, not the interviewer:

- **Every question offers choices** (`ask_user` refuses a question without them), and each
  answer maps to one spec change.
- **Every answer is written before the next question.** In `brood`'s product phase `ask_user` refuses
  a new question until the last answer is a spec change - see [skills and gates](skills-and-gates.md).
- **Each phase ends on the person's confirmation** of a short summary, not on the interviewer's word.

## The skills

Every skill in `genome/skills/` can be run from a conversation; most are also used by the bigger ones. A project's own,
in `.turri/skills/` or `.agents/skills/`, can be too (see [skills and gates](skills-and-gates.md#a-projects-own-skills)).

| to… | skills |
| --- | --- |
| start a project | `brood`, `spawn`, `init-plain-project` |
| make a rough spec build | `mature` |
| add to a spec | `bud`, `add-functional-spec`, `add-functional-specs`, `add-concept`, `add-implementation-requirement`, `add-test-requirement`, `add-acceptance-test`, `add-resource`, `add-template` |
| check what is written | `analyze-if-func-spec-too-complex`, `analyze-2-func-specs`, `analyze-func-specs`, `resolve-section-ownership` |
| fix what is written | `break-down-func-spec`, `resolve-spec-conflict`, `debug-specs` |
| restructure modules | `create-import-module`, `create-requires-module`, `refactor-module`, `consolidate-concepts` |
| set up the project to build | `implement-unit-testing-script`, `implement-conformance-testing-script`, `check-plain-env` |

`debug-specs` is the one for a running application that misbehaves: it reads the generated code
to find the cause, traces it back to the spec, and fixes only the `.plain` files.

## Checking a spec

```bash
turri validate app.plain     # or validate in a conversation
```

It parses the spec with this repo's own parser, resolves its imports and required modules, and
reports every syntax, concept and structure error with its line - no model, no API key. The
interview skills run it before a phase ends, and `write_spec_diff`
refuses a change that leaves a file that does not parse. Pass the project directory to check every
module at once.

What `check` cannot see - a fact in the wrong section, a spec that is too big, two that conflict,
wording no test can check - is what the rules, the skills and the reviewers are for.
