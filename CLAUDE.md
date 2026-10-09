# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

turri is a harness that builds code from \*\*\*plain specs (`.plain` files). The harness, not the
agent, decides what runs next and when work is done. It runs as a [pi](https://github.com/earendil-works/pi)
extension (`turri`) and as a CLI for unattended runs. `docs/` describes the behaviour in
detail. `docs/growing.md`, `docs/sandbox.md` and `docs/skills-and-gates.md` are the ones to read
before changing the harness.

## Commands

```bash
npm install && npm link                        # `turri` on PATH, pointing at this clone (edits apply at once)
npm run typecheck                              # tsc --noEmit - covers src/ only, not tests/
npm test                                       # the whole vitest suite, about a minute
npx vitest run tests/grow/records.test.ts    # one file
npx vitest run tests/grow/loop.test.ts -t "one suite"   # matching tests in one file (-t alone still loads every file)
npm run chat                                   # pi with the extension loaded straight from src/
turri validate tests/data/simple.plain      # parse and validate a spec: no model, no API key
turri regrow <file.plain> --dry-run      # plan the work, print each codebase's first prompt, start nothing
turri init-config                        # a quick start config.turri.yaml in the current folder: the two models, every other key commented out
turri doctor                             # what the machine lacks (bash, the OS sandbox, a model provider; in a project, its toolchains)
```

Tests that run real commands behind the OS sandbox are wrapped in `runIf(sandboxAvailable().kind !== "none")` and
skipped silently on a machine without one; the rest run everywhere (the process-group ones skip on Windows).
`tests/setup.ts` kills every process group a file left when it finishes. The testing scripts run on this machine, as
in turri. The suite takes about a minute.

## TypeScript runs unbuilt

`bin/turri.mjs` checks for Node >= 22.19 and imports `src/cli.ts` directly. Node's own type
stripping runs the sources and nothing compiles them. So:

- imports use explicit `.ts` extensions;
- don't use syntax that type stripping can't erase: parameter properties
  (`constructor(readonly x: T)`), `enum`, `namespace`. Declare the field and assign it in the
  constructor. `tsc` and `tsx` (the `npm run regrow`-style scripts) both accept these, so they only
  fail when run through `turri`.

## Architecture

**The name.** turri was called plainwright. `src/legacy.ts` (imported first by `cli.ts` and `extension.ts`) reads
`PLAINWRIGHT_*` env vars as `TURRI_*`; `grow/migrate.ts` brings a project's files over the first time it is found (`.plainwright.json` →
`.turri.json`, `.plainwright-notes.md` → `.turri-notes.md`, both `.plainwright/` scratch folders → `.turri/`),
committing the renames alone. `plain_modules` and `.plaingit` are the ***plain language's and keep their names.

**Entry points.** `src/cli.ts` dispatches `turri <cmd>`: `regrow` (with frids: grown again), `glimpse` (regrow
`--dry-run`), `drift`, `bind`, `spec-diff`, `validate`, `lineage`, `release` and `cultivate` import `regrow-cli.ts`,
`drift-cli.ts`, `bind-cli.ts`, `spec-diff-cli.ts`, `validate-cli.ts`, `lineage-cli.ts`, `release-cli.ts` and
`cultivate-cli.ts`, each of which parses `process.argv` itself; the ones that build share `loop-cli.ts` `runLoop`,
which drives the work loop as the chat does. The old names (`module`, `regenerate`, `conformance`, `check`,
`deploy`, `skill`) are aliases. `setup` and `doctor` go to `setup.ts`, `init-config` to `init-config.ts`. `turri` alone - or with options, or `chat`, its old name - spawns pi through
`pi-launch.ts` with `src/extension.ts`, which registers every conversation tool and slash command (`regrow`,
`drift`, `glimpse`, `rejuvenate`, `bind`, `steer`, `engine`, `growth`, `halt`, `diagnose`, `lineage`, `validate`,
`cultivate`, `release`, `activate`, `/watch`, `/regeneration`, `/halt`, `/btw`, `/lineage`, `/engine`, `/turri-config`, `/stack`, ...).
`/turri-config` (`config-command.ts`, over `config-edit.ts`'s table of every key) writes config.turri.yaml line by line and
applies what turri fixed at its start - the chat's model, the coding model chosen this session, `parallel-jobs` - live.

**The \*\*\*plain parser (`src/plain/`)** is a faithful port of the Python reference parser
(`plain_file.py`, `plain_spec.py`, `concept_utils.py`). Marshalled trees are compared against the
Python output over a corpus, so behaviour, orderings and even list-indentation quirks are
deliberate. See `docs/parser.md` before "fixing" one. It resolves linked resources relative to the
process cwd, which is why vitest runs with `root: "."` and the fixtures in `tests/data/` use
repo-relative paths. A "frid" is a functionality id (`"1"`, `"2.1"`, ...).

**The standard library (`stdlib/`)** holds import modules that settle a generic piece of software
on one stack - `stdlib/backend/python-flask`, `stdlib/cli/go-cobra`, ... Each stack imports its
language's `stdlib/lang/<language>` and its kind's `common.plain`; its test reqs are a template of
their own, `stdlib/<kind>/conformance/<stack>`, so a spec that skips conformance tests leaves it out.
`stdlib/` is a reserved import prefix: `src/plain/stdlib.ts` reads such an import from turri's
folder only, and a project module at the same path is an error. The templates define no concepts,
and a `::` in them would be read as one. `src/stdlib.ts` appends the catalogue - every template, what
it is, and the folder - to the `stdlib` rule when the rules load, so the rule never drifts from the
files.

**Gated skills** (spec authoring): `genome/skills/*/SKILL.md` is parsed by `src/skill.ts` into steps (the
`###` headings under `## Steps`) and gates (`metadata.gates` in the frontmatter). `src/graph.ts`
compiles those into a LangGraph `StateGraph` (step -> gate -> route), and `src/judge.ts` runs
independent judge sessions with a quorum. `src/genome.ts` `runSkill()` is the single entry point that
both the CLI and the `cultivate` tool use. `src/rules.ts` appends every file in `genome/rules/` (the
authoring rules, ~40k tokens, byte-identical so it stays cached) to spec-writing agents, never to
coding agents. turri's own skills are found relative to the package, not the cwd. A skill that fails to parse
is reported as pending, not dropped. A project's own skills, in `.turri/skills/` and `.agents/skills/`, are found
beside them (`src/skills.ts`), turri's own winning a name; `.turri/.gitignore` lets `skills/` through.

**Growing the code (`src/grow/`)**, one unit of work at a time:

- A job is a spec diff: `regrow.ts` `renderSpecDiff` grows one in the code, landing on its unit
  tests. `prompt.ts` builds the only thing the agent sees; it can't read `.plain` files, and it is told
  what to do with each functional spec by the job's cases (`cases.ts`: fresh, add, patch, again, delete,
  mechanical; again is `rejuvenate`'s functional specs, marked `grow_again` in the code record). The agent works, then the harness runs the project's unit testing script
  itself and inventories test files to catch deleted tests, sending the agent back up to 20 times - and for a best-guess draft when a turn wrote nothing.
  Once they pass, `unit-review.ts` has a read-only reviewer - one session for the loop, shown the
  whole work diff first, then the diff since its last review (`workSnapshot`) and the coder's
  `submit_work` account (`submit-work.ts`) - check that the code does what the spec says and its unit tests test it - an optimiser, not a gate: two reviews at most, the second weighed by an arbiter
  agent that passes on only what it upholds; after that fix the work goes on once its tests pass - as
  spec changes and conformance tests do too.
- `conformance.ts` writes black-box conformance and acceptance tests into `plain_modules/<m>/tests`,
  labelled and checked by label; `bind.ts` runs it for a conformance job, then
  `regression.ts` runs the whole suite (a repair agent that may not touch tests).
- Nothing is queued (`docs/growing.md`). `loop.ts` works out what is left to grow - `drift.ts`
  `codeWork`, from the code record (`records.ts`: the spec of the codebase's whole requires chain, no test
  reqs or acceptance tests) to the spec now - has `chunk-plan.ts` cut it into jobs from the functional
  specs outward (an agent groups them, by default, up to `max-specs-per-pulse`, code gives each group the definitions it uses, an agent
  places the reqs), and runs the first; again whenever a job ends or the spec changes. A chain is built in
  its tip codebase; the ones below are left behind. A running job the spec no longer wants is stopped
  (`stillWanted`) - unless the change is inside what it grows, which steers it instead (`steering.ts`: its agent
told mid-turn or at its next turn, its record moved, twice a job at most). `regrow`, `write_spec_diff`, `turri spec-diff` and
  `turri regrow` all go through `bringUp`. Steering (`grow/steer.ts`: `steer`, AGENTS.md's
  queue section, a tool's `guidance`) reaches the planner's agents. Conformance is a second track in the loop: from `tests/.turri.json`
  to `conformanceTarget` (the chosen functional specs as built, with the test reqs), a conformance job - a
  spec diff's conformance run, the whole suite with it - once the module's code is built, before anything is built on it; `bind`
  turns it on for the session over `conformance-tests: false`.
- `spec-steps.ts`: a tree written out one item a line, diffed with git into changes by id, and a step
  (`makeStep`) made of some of them - its tree, its diff, its text diff laid out as the module's file.
- `records.ts`: `code/.turri.json` holds only the spec the code was built from, and
  `tests/.turri.json` what the conformance tests are written for. What is left is derived from
  them, never stored.
- `lineage.ts`: each `plain_modules/<m>` is a git repo with its git dir at `.plaingit`. Every unit of
  work starts from the last commit (`startWork`) and either commits or is rolled back whole
  (`abandonWork`), commits included. Code, tests and tree must never disagree.
- `notes.ts`: `code/.turri-notes.md`, the agents' working notes. Agents edit it only through
  the `update_notes` tool, and every line is stamped by the harness.
- `test-scripts.ts` finds and runs the project's `run_unittests_*.sh` / `run_conformance_tests_*.sh`,
  from `config.turri.yaml` (with the chosen stack's over it), then the project root, then `test_scripts/`. A script run is the only thing
  that decides pass or fail.

**Sandbox.** `confine.ts` rebuilds pi's file tools with a path check (argument and resolved path,
symlinks resolved) that fences each agent to its own module's folders - `code/`, and `tests/` for the conformance roles -
and gives it a `bash` on this machine behind `agent-shell.ts`: `command-check.ts` before each command, the module's
environment (`agent-env.ts`), the OS sandbox (`os-sandbox.ts`: Seatbelt, bubblewrap) where one is up, `audit.ts`
after, all run through the host runner `shell.ts` (a process group per command; `withPulse` kills what a pulse left
running; a watcher and a start-up sweep for a turri killed outright). The testing scripts run on this machine unfenced
(`testing-scripts-run-on: copy | in-place`), as does what `deploy` starts. turri turns off `AGENTS.md`/`CLAUDE.md`
loading and pi's skills for every agent it starts (`noContextFiles`, `noSkills` in `src/pi.ts`).

**Agent sessions.** An agent's whole initial prompt is its system prompt (`createExecutor`'s `task`,
opened with `BEGIN`), so pi's compaction never sums it up. The coding agent, the conformance agent,
the code fixer, the repair agent and both reviewers keep one session per job and are compacted by
the harness between turns past `compact-at` (`compactIfDue` in `pi.ts`, instructions per role in
`grow/compaction.ts`); the arbiter, judges, explorer and planners stay fresh. Each job tallies its
agents (`reportAgent`, `Job.agents`) into its log.

**Release (`grow/release.ts`, `release-tools.ts`, `release-cli.ts`).** Trying what is grown: the model
first looks for guidance on how the project is released (what the person said, AGENTS.md, a skill) and
passes it to `release` - then it is followed from the host codebase (`releaseInPlace`, nothing
exported); without guidance `release` exports the tip module's last `.plaingit` commit (`git archive`
of `code/`) to `<project>/dist/<module>`. The chat model - or `turri release`'s one-off agent on
`coding-model`, thinking low - starts it on the host, installing what it needs in its own shell: nothing is put to the person. `activate` owns what
keeps running, stopped on redeploy, `/halt activated <name>` and exit.

**Jobs and progress.** In the TUI, the tools that grow start background jobs (`loop.ts`, `jobs.ts`).
`lanes.ts` gives each job its spec's whole `requires` chain as lanes, so jobs whose chains overlap
wait for each other and the rest run side by side - up to `parallel-jobs` at once (the registry's `maxRunning`). In pi's
print/json/rpc modes the tools wait instead (`shouldWait`). Progress, usage and transcripts flow
through an `AsyncLocalStorage` sink in `activity.ts` (`withActivity`, `reportStage`, ...) to
`job-panel.ts` and the side panel (`jobs-tree.ts`), and to each pulse's log (`job-log.ts`).

**Projects.** A spec is built in its project: the nearest folder upwards holding `config.turri.yaml`, a
`config.turri.<stack>.yaml`, the old `config.yaml` or `plain_modules/` (`projectDirOf` in `paths.ts`).
`config.turri.yaml` (`src/config.ts`) holds `module`, `harness-model`, `coding-model`, `judge-model`,
`conformance-tests`, `testing-scripts-run-on` and the script paths. A project whose parts are on different stacks - a
backend and a frontend, each with its own testing scripts - keeps each stack's settings in `config.turri.<stack>.yaml`,
laid over `config.turri.yaml` key by key while that stack is chosen; it is chosen, never worked out - `/stack` and the
chat's `stack` tool (`src/stacks.ts`), `--stack <name>` on any command (`cli.ts`), or `TURRI_STACK` - for the session
only, a running pulse keeping the one it started with (`chosenStack`, `withStack`, `stackOf` in `config.ts`;
`configForSpec` reads the project's with the chosen stack's over it). turri never writes a `config.yaml` - it may be
another tool's: a folder with no `config.turri*.yaml` is still read from `config.yaml` (and `config.<name>.yaml` as
the stack `<name>`) until turri first writes a setting, which copies them to the new names first (`adoptLegacyConfig`).
`docs/config.md` documents every key.

## Testing patterns

- No test calls a model. Agent behaviour is scripted with
  `vi.mock("../../src/pi.ts", ...)` replacing `createExecutor` / `ask` with a stub that calls the
  session's tools directly (`write`, `run_unit_tests`, `update_notes`, ...). An agent's task comes as
  `opts.task` to `createExecutor` and its first `ask` is `BEGIN`: a stub that checks prompts reads the
  task from the session it made. The module under test is
  then loaded with a dynamic `await import(...)` after the mock. `tests/grow/conformance-loop.test.ts`
  is the reference example.
- `tests/test-scripts.ts` `writeTestScripts()` gives a temp project minimal Python testing scripts.
- The gate machinery (retry, escalation, no-artifact rejection) has no automated coverage. It is
  checked by live runs, see "Trying the gate semantics" in `docs/skills-and-gates.md`.

## Conventions

- The name is always **turri**, lowercase, even at the start of a sentence. \*\*\*plain is
  written `***plain` (escaped in Markdown).
- Prose in docs, comments and user-facing strings uses British spelling (behaviour, organised) and
  a spaced hyphen ` - ` rather than an em dash. Test names are sentences about behaviour
  (`it("renames a clashing file instead of overwriting it")`).
- When behaviour changes, update the `docs/` page that describes it in the same change.
- Commit subjects are one lowercase sentence (often long) that says what the system now does, not
  what was edited. See `git log`.
