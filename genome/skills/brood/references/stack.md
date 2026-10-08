# the stack phase — What technologies should it use?

Gather the technical stack **and** the project's structure/architecture. This phase affects only `***implementation reqs***`, and ends with the unit testing script every build needs — the rest of testing comes later. Run the core loop from `SKILL.md` for each topic below, in order: ask, then write the requirement into the `.plain` file with the ordinary file tools. Nothing is built in this phase. When the user has no preference, propose a sensible default that fits earlier answers and ask them to confirm.

## Author target for this phase

Write each requirement into `***implementation reqs***`:

- Shared, stack-wide reqs (language, framework, architecture, coding standards) go on the template module if one exists.
- Module-specific reqs (e.g. a data-storage choice or an external integration only one module uses) go on the module that needs them.

Do **not** add `***test reqs***` or `***acceptance tests***` in this phase — the test reqs belong to the testing phase, right after this one.

## First: a stack from the standard library

Before the topics, settle what kind of software each module is - a backend, a frontend, a
command-line tool, a library - and offer the standard library's stacks for that kind (the stdlib
rule, in `<plain-rules>`, lists them) that this machine can build: `<toolchains on this machine>`, in
your instructions, says which languages it can build now. The agents use its toolchains and install
none, so a stack in a language it lacks stops at its first build. Ask with `ask_user`: those stacks
as options, the one that fits earlier answers first, and "Something else…" for a stack of the user's
own. A stack the user names in a language the machine lacks: say what to install first and that
`turri doctor` checks it, and ask whether to wait for that or choose another.

- **A stack from the standard library.** Import it into the module's frontmatter as
  `stdlib/<kind>/<stack>`, and read the templates it brings: the stack, its `stdlib/lang/<language>`
  and its kind's `common` - the folder is in the stdlib rule. They settle topics 1, 2 and 5, error handling and
  logging in topic 6, and the unit-test framework in topic 8: do not ask about those, and write no
  requirement that restates them. Say in one line what the stack settles - its language, framework,
  layout, how it reports errors and logs - so the user knows what they chose. Then walk only topics
  3, 4, 6 (what the stack leaves open), 7, and the unit testing script in 8.
- **Something else.** Walk every topic below. When the language is one the standard library has, its
  `stdlib/lang/<language>` template can still be imported for the language-wide conventions.

A user who wants something the stack settles done differently - another framework, another layout -
has chosen something else: an import cannot be taken back in part.

## Topics (in order)

1. **Programming language** — e.g. Python, TypeScript, Java, Go. Author a language requirement at the appropriate scope (template if shared across modules, otherwise on the module). Review that requirement snippet.
2. **Frameworks** — e.g. Flask, FastAPI, Next.js, Spring Boot, Express, React, Vue. Author framework requirement(s) and any framework-specific architectural conventions. Review the new framework reqs.
3. **Data storage** — e.g. PostgreSQL, SQLite, file-based, in-memory, none. Author a storage requirement on the module that owns persistence (or the template if shared). Review that snippet.
4. **External services or APIs** — anything the app talks to: auth providers, payment gateways, email/SMS, third-party APIs, internal services. Author one requirement per integration on the module that uses it. Review each integration snippet.
5. **Project structure & architecture** — the architectural style and the layers/components the project should be organized into (managers, services, models, repositories, controllers, views, adapters, DTOs, …). Discuss naming conventions, directory layout, and the responsibilities/boundaries of each layer. If the user has no preference, propose a layout that fits the language, framework, and feature set, and confirm it. Author architecture/layering reqs in the template (if shared) and any module-specific deviations on the module. Review the architecture reqs and the resulting layer split.
6. **Other constraints** — deployment target, OS requirements, performance needs, coding standards, security policies, observability — anything stack-wide that hasn't already been covered. Author each constraint as its own requirement at the appropriate scope. Review the new constraint snippets.
7. **Anything else** — anything the user wants to add or change that hasn't already been covered.
8. **Unit tests and their script** — last, once the stack is settled: the first build needs both.
   - The unit-test framework, e.g. pytest, Jest, JUnit, Go's `testing` package. Suggest one that fits the language if the user has no preference. Author a `:UnitTests:` requirement in `***implementation reqs***` at the appropriate scope - e.g. "`:UnitTests:` should use pytest" plus how they are run. Review that snippet.
   - The unit testing script. If turri already finds one - named by `unittests-script:` in `config.yaml` at the project root, or the one `run_unittests*.sh` in the root or in `test_scripts/` - keep it. Otherwise generate `test_scripts/run_unittests_<language>.sh` (and any framework config it needs, e.g. `pytest.ini`) via `implement-unit-testing-script`. Do not link it from the specs. Without it, every build stops before it starts. Review the script's path and what it runs.

When all topics are complete, summarize the full tech stack and the chosen architecture, and get an explicit overall confirmation before moving to the product phase.
