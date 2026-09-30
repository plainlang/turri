# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

plainwright is a harness that builds code from \*\*\*plain specs (`.plain` files). The harness, not the
agent, decides what runs next and when work is done. It runs as a [pi](https://github.com/earendil-works/pi)
extension (`plainwright chat`) and as a CLI for unattended runs. `docs/` describes the behaviour in
detail. `docs/rendering.md`, `docs/sandbox.md` and `docs/skills-and-gates.md` are the ones to read
before changing the harness.

## Commands

```bash
npm install && npm link                        # `plainwright` on PATH, pointing at this clone (edits apply at once)
npm run typecheck                              # tsc --noEmit - covers src/ only, not tests/
npm test                                       # the whole vitest suite
npx vitest run tests/render/state.test.ts      # one file
npx vitest run tests/render/module.test.ts -t "one suite"   # matching tests in one file (-t alone still loads every file)
npm run chat                                   # pi with the extension loaded straight from src/
plainwright check tests/data/simple.plain      # parse and validate a spec: no model, no API key
plainwright render <file.plain> 1 --dry-run    # print the prompt a render would send, start nothing
plainwright doctor                             # what the machine lacks (QEMU, VM image, model provider)
```

Tests that boot the sandbox VM are wrapped in `describe.runIf(vmSupported())`. They need QEMU and
the VM image (`plainwright setup` / `npm run vm:image`), take up to a few minutes each, and are
skipped silently on a machine without them. `tests/setup.ts` closes every VM when a file finishes.

## TypeScript runs unbuilt

`bin/plainwright.mjs` checks for Node >= 22.19 and imports `src/cli.ts` directly. Node's own type
stripping runs the sources and nothing compiles them. So:

- imports use explicit `.ts` extensions;
- don't use syntax that type stripping can't erase: parameter properties
  (`constructor(readonly x: T)`), `enum`, `namespace`. Declare the field and assign it in the
  constructor. `tsc` and `tsx` (the `npm run render`-style scripts) both accept these, so they only
  fail when run through `plainwright`.

## Architecture

**Entry points.** `src/cli.ts` dispatches `plainwright <cmd>`. `render`, `module`, `regenerate`,
`conformance`, `check` and `skill` import `render-frid.ts`, `render-module.ts`, `regenerate-frid.ts`,
`conformance-frid.ts`, `check-cli.ts` and `run.ts`, each of which parses `process.argv` itself.
`setup`, `doctor` and `vm-image` go to `setup.ts`. `chat` spawns pi through `pi-launch.ts` with
`src/extension.ts`, which registers every conversation tool and slash command
(`render_*`, `run_skill`, `check_plain`, `set_render_model`, `/watch`, `/jobs`, `/stop`, ...).

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
`stdlib/` is a reserved import prefix: `src/plain/stdlib.ts` reads such an import from plainwright's
folder only, and a project module at the same path is an error. The templates define no concepts,
and a `::` in them would be read as one. `src/stdlib.ts` appends the catalogue - every template, what
it is, and the folder - to the `stdlib` rule when the rules load, so the rule never drifts from the
files.

**Gated skills** (spec authoring): `skills/*/SKILL.md` is parsed by `src/skill.ts` into steps (the
`###` headings under `## Steps`) and gates (`metadata.gates` in the frontmatter). `src/graph.ts`
compiles those into a LangGraph `StateGraph` (step -> gate -> route), and `src/judge.ts` runs
independent judge sessions with a quorum. `src/forge.ts` `runSkill()` is the single entry point that
both the CLI and the `run_skill` tool use. `src/rules.ts` appends every file in `forge/rules/` (the
authoring rules, ~40k tokens, byte-identical so it stays cached) to spec-writing agents, never to
coding agents. Skills are found relative to the package, not the cwd. A skill that fails to parse
is reported as pending, not dropped.

**Rendering (`src/render/`)**, one unit of work at a time:

- `render.ts` renders one functionality. `prompt.ts` builds the only thing the agent sees; it can't
  read `.plain` files. The agent works, then the harness runs the project's unit testing script
  itself and inventories test files to catch deleted tests, sending the agent back up to 20 times - and for a best-guess draft when a turn wrote nothing.
  Once they pass, `unit-review.ts` has a read-only reviewer - one session for the loop, shown the
  whole work diff first, then the diff since its last review (`workSnapshot`) and the coder's
  `submit_work` account (`submit-work.ts`) - check that the code does what the spec says and its unit tests test it - an optimiser, not a gate: from the third review that sends them back an arbiter
  agent weighs each one and passes on only what it upholds, and after ten all is let go - as spec
  changes do too.
- `conformance.ts` writes black-box conformance and acceptance tests into `plain_modules/<m>/tests`,
  labelled and checked by label. `module.ts` covers regeneration, the regression gate (a repair
  agent that may not touch tests) and the older in-process chain build. `spec-change.ts` and
  `spec-change-conformance.ts` render a spec change given as a git diff.
- Rendering a module is not a job: `queue.ts` `bringUpTo` queues, per module of the chain, one spec
  diff for everything not built yet - `render_module`, `plainwright module` and `spec_changed` all go
  through it. Every change re-plans the work not started: `chunk-plan.ts` cuts it into jobs from the
  functional specs outward (an agent groups 1-3 of them, code gives each group the definitions it uses,
  an agent places the reqs), and that plan is the queue master's proposal, which it reviews. A render is a spec diff that adds one functionality.
- `spec-steps.ts`: when the spec changed in ways other than appending functional specs, it diffs
  the built tree against the current one and has an agent order the changes into spec-diff steps.
- `state.ts`: `code/.plainwright.json` holds only the marshalled tree the code was built from. A
  functionality is stale when its spec no longer matches that tree.
- `history.ts`: each `plain_modules/<m>` is a git repo with its git dir at `.plaingit`. Every unit of
  work starts from the last commit (`startWork`) and either commits or is rolled back whole
  (`abandonWork`), commits included. Code, tests and tree must never disagree.
- `notes.ts`: `code/.plainwright-notes.md`, the agents' working notes. Agents edit it only through
  the `update_notes` tool, and every line is stamped by the harness.
- `test-scripts.ts` finds and runs the project's `run_unittests_*.sh` / `run_conformance_tests_*.sh`,
  from `config.yaml`, then the project root, then `test_scripts/`. A script run is the only thing
  that decides pass or fail.

**Sandbox.** `confine.ts` rebuilds pi's file tools with a path check (argument and resolved path,
symlinks resolved) that fences agents to `plain_modules`. `vm.ts` runs every command (agent `bash`,
test scripts) in a Gondolin micro-VM per module, leased through `AsyncLocalStorage`
and shut down when idle or when the project moves to another module. There is no host fallback,
except testing scripts under `run-testing-scripts-in: host`, and what `deploy` starts. plainwright turns off `AGENTS.md`/`CLAUDE.md`
loading for every agent it starts (`noContextFiles` in `src/pi.ts`).

**Agent sessions.** An agent's whole initial prompt is its system prompt (`createExecutor`'s `task`,
opened with `BEGIN`), so pi's compaction never sums it up. The coding agent, the conformance agent,
the code fixer, the repair agent and both reviewers keep one session per job and are compacted by
the harness between turns past `compact-at` (`compactIfDue` in `pi.ts`, instructions per role in
`render/compaction.ts`); the arbiter, judges, explorer and planners stay fresh. Each job tallies its
agents (`reportAgent`, `Job.agents`) into its log.

**Deploy (`render/deploy.ts`, `deploy-tools.ts`, `deploy-cli.ts`).** Trying what is built: `deploy`
exports the tip module's last `.plaingit` commit (`git archive` of `code/`) to `<project>/dist/<module>`
and the chat model - or `plainwright deploy`'s one-off agent on `harness-model` - starts it on the
host. `installsSoftware` tells installs apart; they run only through `propose_setup`, which asks the
person, and the chat's `bash` refuses them once something is deployed. `start_deployed` owns what
keeps running, stopped on redeploy, `/stop deploy <name>` and exit.

**Jobs and progress.** In the TUI, render tools start background jobs (`queue.ts`, `jobs.ts`).
`lanes.ts` gives each job its spec's whole `requires` chain as lanes, so jobs whose chains overlap
wait for each other and the rest run side by side - the render queue included, which claims no lane of
its own - up to `parallel-jobs` at once (the registry's `maxRunning`). In pi's
print/json/rpc modes the tools wait instead (`shouldWait`). Progress, usage and transcripts flow
through an `AsyncLocalStorage` sink in `activity.ts` (`withActivity`, `reportStage`, ...) to
`job-panel.ts` and `transcript-view.ts` (`/watch`).

**Projects.** A spec is built in its project: the nearest folder upwards holding `config.yaml`, a
`config.<module>.yaml` or `plain_modules/` (`projectDirOf` in `paths.ts`). `config.yaml`
(`src/config.ts`) holds `module`, `harness-model`, `coding-model`, `judge-model`,
`conformance-tests`, `run-testing-scripts-in` and the script paths; a module on a stack of its own lays
`config.<module>.yaml` over it, found down its `requires` chain (`configForSpec`). `docs/config.md`
documents every key.

## Testing patterns

- No test calls a model. Agent behaviour is scripted with
  `vi.mock("../../src/pi.ts", ...)` replacing `createExecutor` / `ask` with a stub that calls the
  session's tools directly (`write`, `run_unit_tests`, `update_notes`, ...). An agent's task comes as
  `opts.task` to `createExecutor` and its first `ask` is `BEGIN`: a stub that checks prompts reads the
  task from the session it made. The module under test is
  then loaded with a dynamic `await import(...)` after the mock. `tests/render/conformance-loop.test.ts`
  is the reference example.
- `tests/test-scripts.ts` `writeTestScripts()` gives a temp project minimal Python testing scripts.
- The gate machinery (retry, escalation, no-artifact rejection) has no automated coverage. It is
  checked by live runs, see "Trying the gate semantics" in `docs/skills-and-gates.md`.

## Conventions

- The name is always **plainwright**, lowercase, even at the start of a sentence. \*\*\*plain is
  written `***plain` (escaped in Markdown).
- Prose in docs, comments and user-facing strings uses British spelling (behaviour, organised) and
  a spaced hyphen ` - ` rather than an em dash. Test names are sentences about behaviour
  (`it("renames a clashing file instead of overwriting it")`).
- When behaviour changes, update the `docs/` page that describes it in the same change.
- Commit subjects are one lowercase sentence (often long) that says what the system now does, not
  what was edited. See `git log`.
