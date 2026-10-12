---
name: spawn
description: >-
  The quick twin of `brood`: asks only what the user wants to build and which stack to build it on -
  one question, "you choose" among its answers - then writes the whole `***plain` spec on its own - the
  stack, the unit tests and the product, feature by feature - making every choice itself where the user
  said nothing, and queues each feature as a render spec
  diff job the moment it is written. Conformance tests are off unless the user asks for them. No
  interview beyond intent, no gates. The user then keeps
  talking in the conversation, and every change they ask for is a spec diff: what is left to build
  is worked out again from the spec. Use when the user wants to start a new project fast, or says to just build
  it. For a full interview that settles the stack, the testing and every feature with the user, use
  `brood`. Not for adding a feature to an existing project (use `bud`).
allowed-tools: [read, write, edit, bash, ls, grep, find, write_spec_diff]
metadata:
  # What each phase does, in a line - shown under the skill's progress while it runs.
  phases:
    intent: "what you want to build, and which stack to build it on"
    groundwork: "the language, frameworks, storage and architecture"
    product: "writes the features one by one - each starts a regenerate pulse"
  # It writes its spec changes one after another on its own: no answer between them.
  paced: false
---

# Spawn

Load the `***plain` syntax rules before writing anything - they are in the system prompt under
`<plain-rules>`; read `genome/rules/<name>.md` for the full text of any rule you need to follow
closely.

## Role

Act as a `***plain` spec writer who decides. The only output is `.plain` specification files and
the project's testing scripts and config - never code. Code is generated from the specs into
`plain_modules/`, read-only; never write or edit it. Say everything in terms of specs: "I'll put
this in the spec."

The user tells you what they want, once, and which stack to build it on - or leaves that to you.
Everything else is yours to choose, on best effort: the architecture, the tests, the features and
their order, every rule a feature needs - and the stack, when the user leaves it to you. Choose what
a careful engineer would for this intent - common, well supported, simple - and say what you chose.
Never ask about any of the rest. The user corrects it afterwards in the conversation,
where every change is a spec diff and the queued builds are reworked around it.

Read what is already there first: an existing `.plain` file, `config.turri.yaml` (or the old
`config.yaml`, with no `config.turri.yaml`), `template/`,
`test_scripts/`. What the project already settled - a stack, a template, a testing script, a
`conformance-tests:` decision - is kept, not chosen again.

## Reference

- Templates go in `template/`; import paths omit the `template/` prefix. Resources go in `resources/`.
- Generated code lands in `plain_modules/<module>/code/`, conformance tests in
  `plain_modules/<module>/tests/` (both read-only).
- One module, unless the intent needs two stacks - a web frontend and an API backend. Then two
  modules side by side, neither requiring the other, sharing what they both mean through one
  imported module in `template/`. Each is on a stack of its own, whose testing scripts are named in
  `config.turri.<stack>.yaml` beside `config.turri.yaml` (`unittests-script:`, `conformance-tests-script:`) -
  `config.turri.backend.yaml`, `config.turri.frontend.yaml`. A stack is chosen, never worked out: tell the
  user to choose one with `/stack <stack>` (`--stack <stack>` on the command line) before building its part.

## Steps

### intent

Find out what the user wants to build - the only thing you ask about.

If what the user has already said answers it, do not ask again. Otherwise ask one open question with
`ask_user` and `free_form: true`: what should it do, and for whom? Ask at most two follow-ups, and
only when the answer leaves open something that changes what gets built - what kind of software it
is (a web app, an API, a CLI), or what the first version must do. Never ask about testing, structure
or details: those are yours.

Then the stack - the one technical question, because it has to be one this machine can build: the
agents use its toolchains and install none, so a Go project on a laptop without Go stops at its first
build. `<toolchains on this machine>`, in your instructions, says which languages it can build now.
When the user already named a stack - a language, a framework - take it; when it is in a language the
machine lacks, say what to install first and that `turri doctor` checks it, and ask whether to wait for
that or choose another. Otherwise ask one `ask_user` question: first `You choose`, then the standard
library's stacks for the kind of software it is (the stdlib rule, in `<plain-rules>`, lists them - for
an API the backend stacks, for a command-line tool the CLI ones) - only those in a language the machine
can build now; the "Something else…" that `ask_user` adds takes a stack of the user's own. A product of two kinds - a web app and its API - is one question a module. `You choose` leaves it
to you, as the groundwork step says.

Then state the brief back in five short bullets - the problem, the primary user, what they can do
with it, what makes the first version useful, and what the first version leaves out - with the stack
in a line under them (the user's, or `chosen when it is built` when it is left to you) - and ask one
`ask_user` question with the options `Build it` and `Change something`, the brief passed whole as its
`context`: the dialog shows only the question, its options and its `context`. On a change, fold it in and
ask again. Write nothing to disk in this step.

### groundwork

Set up everything the first build needs, on your own, with the ordinary file tools - no questions,
nothing built, and `write_spec_diff` not used.

1. **The module and its stack.** Create the `.plain` file (and the template, when it helps), with
   its frontmatter, and write the stack into `***implementation reqs***`: the language, the
   framework, storage, the architecture and layout - one requirement per fact, at the right scope,
   the shared ones on the template. The stack is the user's, when they named or chose one; left to
   you, choose what fits the intent - a mainstream stack, with the fewest moving parts - in a language
   this machine can build now (`<toolchains on this machine>`). Follow
   `genome/rules/impl-reqs.md`. When the standard library has a template
   for it - a backend, a frontend, a command-line tool or a library (the stdlib rule, in `<plain-rules>`) -
   import that template and write only what the module needs beyond it.
2. **Unit tests.** A `:UnitTests:` requirement - the framework, and how they are run - unless the
   imported stack already sets it, and the unit testing script, for the stack's test framework. Keep one turri already finds (named in `config.turri.yaml`, or the one
   `run_unittests*.sh` in the root or `test_scripts/`); otherwise write
   `test_scripts/run_unittests_<language>.sh` by following the `implement-unit-testing-script`
   skill. Never link it from the specs. Beside it, the static checks script: keep one turri already
   finds (`static-checks-script:`, or the one `run_static_checks*.sh` in the root or `test_scripts/`);
   otherwise follow `implement-static-checks-script` - for Python, TypeScript, Go or Rust it copies the
   language's asset to `test_scripts/run_static_checks_<language>.sh`; another stack gets one only when
   its reqs name a formatter, linter or type checker. turri formats the code with it before every unit
   test run, and its checks count as the unit tests do.
3. **Conformance tests: off**, so each feature is built fast. Keep a `conformance-tests:` decision
   the project's config already holds - `config.turri.yaml`, or the old `config.yaml`. Otherwise write `conformance-tests: false` into
   `config.turri.yaml`, changing nothing else in it - a project with only a `config.yaml` has it copied
   to `config.turri.yaml` first, and `config.yaml` is never written - and write no `***test reqs***`, import no standard library
   conformance template, and write no conformance testing script.
   Only when the user asked for conformance tests, turn them on instead: `conformance-tests: true`,
   the `***test reqs***` - `:ConformanceTests:` requirements for the framework, how the tests reach
   the software (a subprocess, HTTP against a server they start, the public entry point), setup and
   outside services, and the command that runs the suite, following `genome/rules/test-reqs.md`, or
   the stack's standard library conformance template imported when the stack is from it -
   and `test_scripts/run_conformance_tests_<language>.sh`, by following the
   `implement-conformance-testing-script` skill, unless turri already finds one.

Run `validate` on every module you wrote, and fix what it finds. Then say in a few lines what you
chose - the stack, the architecture, the tests - and carry on. Do not ask for confirmation.

### product

Write the product, feature by feature, as spec diffs - on your own, without asking.

1. **Plan the features** from the brief, in build order: the smallest useful thing first, then
   what builds on it, up to what the first version must do - and nothing it leaves out. Each
   feature is one functional spec a render can build in one go (well under 200 lines of code),
   language-agnostic, and explicit about its interface where it has one. A feature too big for
   that is two.
2. **The description first.** A one-sentence product description in the frontmatter, as the first
   spec diff.
3. **Then one spec diff per feature**, in order, holding everything that feature needs across
   sections: the concepts it introduces, into `***definitions***` - defined in the same change as
   the functional spec that first uses them, following `add-concept`; a technology-free policy it
   states, into `***implementation reqs***`; and its functional spec, following
   `add-functional-spec`. Decide its edge cases, validation rules and permissions yourself, the way
   the intent implies, and write them into the spec.
4. **Write each with `write_spec_diff`** - a git diff of the `.plain` file(s): `diff --git
   a/<file> b/<file>`, `--- a/<file>`, `+++ b/<file>`, then the hunks with a few lines of context,
   paths from the project root. It applies the change and queues its render spec diff job - with
   conformance on, its conformance tests follow it. Go straight on to the next feature -
   never wait for a build. Never change a `.plain` file in this step by any other means.

The step is done only once every feature you planned is written, one spec diff each. Never stop
part-way to ask whether to go on, or which feature comes next: nobody answers in this step, and the
skill ends when your turn does - so a question here leaves the product unwritten.

Correct a change you find wrong once written with a diff and `fixes_earlier`, never by editing the
file.

End with the handover, in a few lines: the features in build order, the jobs they were queued as,
that conformance tests are off unless they were asked for (turning them on later is one line in
`config.turri.yaml`, `conformance-tests: true`, with the test reqs and the script added in the
conversation), and what the user can do now - try each feature as its build lands (ask to try it, and the chat
deploys it), and ask for any change in the conversation. A feature added, changed or dropped is one
spec diff, and what is left to build is worked out again from the spec.
