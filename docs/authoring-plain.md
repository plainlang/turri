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

## The rules

`forge/rules/` holds the authoring rules. They are in the system prompt of every agent that
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
| `linked-resources.md` | a linked resource is one text file on disk; protocol artifacts are linked, never transcribed |
| `import-modules.md`, `requires-modules.md` | the two ways modules build on each other |
| `exported-concepts.md`, `required-concepts.md` | which concepts cross module boundaries |
| `integrations.md` (+ standalone, embedded, embedded testing) | specs for REST API integrations, deployed standalone or embedded in an existing codebase |

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

## Writing specs with plainwright

In a conversation (`plainwright chat`), say what you want and the matching skill runs. The two
that build a project from scratch interview you one question at a time, write the specs as you
answer, and build each one in the background while the interview goes on:

| skill | phases | how a spec change is written |
| --- | --- | --- |
| `forge-plain` | intent → stack → definitions → functional specs → testing → handoff | one functional spec per answer, with `write_functional_spec`, which also queues its render |
| `forge-diff` | intent → stack → product, feature by feature | one spec change per answer, across whatever sections it needs, as a git diff with `write_spec_diff`, rendered as a render spec diff job |

For an existing project, `add-feature` runs a short feature interview and then writes the
concepts, reqs and functional specs the feature needs, one question at a time.

What keeps the interview honest is the harness, not the interviewer:

- **Every question offers choices** (`ask_user` refuses a question without them), and each
  answer maps to one spec change.
- **A reviewer reads along.** A read-only agent re-reads the module after every change and puts
  its findings on the interviewer's next tool result, to fix before the next question.
- **A gate closes the phase.** Two independent judges check the specs against the phase's rubric,
  and the phase advances only when both pass - see [skills and gates](skills-and-gates.md).

## The skills

Every skill in `skills/` can be run from a conversation; most are also used by the bigger ones.

| to… | skills |
| --- | --- |
| start a project | `forge-plain`, `forge-diff`, `init-plain-project` |
| add to a spec | `add-feature`, `add-functional-spec`, `add-functional-specs`, `add-concept`, `add-implementation-requirement`, `add-test-requirement`, `add-acceptance-test`, `add-resource`, `add-template` |
| check what is written | `analyze-if-func-spec-too-complex`, `analyze-2-func-specs`, `analyze-func-specs`, `resolve-section-ownership` |
| fix what is written | `break-down-func-spec`, `resolve-spec-conflict`, `debug-specs` |
| restructure modules | `create-import-module`, `create-requires-module`, `refactor-module`, `consolidate-concepts` |
| set up the project to build | `implement-unit-testing-script`, `implement-conformance-testing-script`, `check-plain-env` |

`debug-specs` is the one for a running application that misbehaves: it reads the generated code
to find the cause, traces it back to the spec, and fixes only the `.plain` files.

## Checking a spec

```bash
plainwright check app.plain     # or check_plain in a conversation
```

It parses the spec with this repo's own parser, resolves its imports and required modules, and
reports every syntax, concept and structure error with its line - no model, no API key. The
interview skills run it before a phase ends, and `write_functional_spec` and `write_spec_diff`
refuse a change that leaves a file that does not parse. Pass the project directory to check every
module at once.

What `check` cannot see - a fact in the wrong section, a spec that is too big, two that conflict,
wording no test can check - is what the rules, the skills and the reviewers are for.
