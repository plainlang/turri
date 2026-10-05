# Development

```bash
npm run typecheck   # types
npm test            # the whole suite, about two minutes; the tests about the VM boot one
```

The suite runs the projects' testing scripts on this machine, as turri does. The fixture scripts stage each run in a
folder of their own, as test files running side by side would otherwise share one.

## Mutation testing

`npm run mutation` runs [Stryker](https://stryker-mutator.io) over the core of growing - the parts in
`stryker.config.mjs` - one part at a time, each part's report in `reports/mutation/<part>/`. A part with a report is
skipped, so a run that is stopped goes on from the part it was in; `npm run mutation -- <part>` runs one again, and
`npm run mutation -- --summary` sums up the reports there are. It takes hours: each part runs the suite once to find
which tests reach which mutant (`vitest.stryker.config.ts`, the suite without the files that boot VMs), then each
mutant against those tests. `scripts/mutation.mjs` sets two things in Stryker's vitest runner the suite needs - forked
workers, and a test-name filter that matches vitest 5's names - again after every `npm install`.

Working on turri itself, `npm link` points the global `turri` at this clone, so edits
take effect immediately. `npm run chat` starts pi with the extension loaded from `src/`.

## Layout

| path | what it is |
|---|---|
| `bin/turri.mjs` | the launcher: checks the Node version, then loads `src/cli.ts` |
| `src/cli.ts` | the `turri` command and its subcommands |
| `src/setup.ts`, `src/environment.ts` | `turri setup`, `doctor`, `vm-image`, and what they check |
| `src/extension.ts` | the pi extension: every tool and command the conversation has |
| `src/skill.ts` | parses `SKILL.md` into steps and gates |
| `src/graph.ts` | compiles a skill into a LangGraph `StateGraph`: step -> gate -> route |
| `src/judge.ts` | runs independent judges, applies the quorum, builds the critique |
| `src/genome.ts` | `runSkill()` - the one entry point the CLI and the extension share |
| `src/pi.ts` | pi session factories for executors, sub-agents and judges |
| `src/spec-tools.ts` | `write_spec_diff` |
| `src/loop-tools.ts` | `regrow`, `drift` and `halt` - one definition each, for the conversation and the skills alike |
| `src/mature-tools.ts` | `mature`'s own two: `watch_jobs` and `spec_findings` |
| `src/plain/` | the \*\*\*plain parser - see [parser](parser.md) - and `highlight.ts`, which highlights \*\*\*plain with plyn's grammar, `plain.tmLanguage.json` (`npm run grammar:sync` refreshes it from [plyn](https://github.com/plainlang/plyn)) |
| `src/grow/conformance.ts` | conformance tests: writing them, and fixing the test or the code until they pass |
| `src/grow/regrow.ts`, `src/grow/bind.ts` | a code job - a spec diff rendered in the code - and a conformance job |
| `src/grow/loop.ts`, `src/grow/records.ts`, `src/grow/drift.ts`, `src/grow/jobs.ts` | the work loop, the records and the work derived from them, and background jobs |
| `src/grow/chunk-plan.ts`, `src/grow/cases.ts` | cutting the work into jobs, and what a job's agents are told by its cases |
| `src/grow/regression.ts` | the whole conformance suite run, and the repair agent that may not touch tests |
| `src/grow/lineage.ts` | module history in `.plaingit` |
| `src/grow/release.ts`, `src/release-tools.ts`, `src/release-cli.ts` | deploy: the last commit to `dist/<module>`, what installs software, what it starts on the host - see [deploy](deploy.md) |
| `src/grow/confine.ts`, `src/grow/vm.ts` | the file-tool fence and the sandbox VM - see [sandbox](sandbox.md) |
| `src/grow/engine.ts` | choosing and resolving render models |
| `src/grow/job-panel.ts`, `src/grow/transcript-view.ts`, `src/grow/diff-view.ts` | the job panel, `/watch`, and a spec diff as they show it - highlighted and banded |
| `src/grow/debug-log.ts` | each render agent's whole conversation, always streamed to `.turri/debug/` |
| `vm/image.json` | what goes into the VM image |
| `genome/` | what turri knows and can do: `genome/skills/`, the skill library, and `genome/rules/`, the \*\*\*plain authoring rules |

## Known edges

- Judges default to the executor's model. Real separation wants a different provider - set
  `model:` on the gate. An unconfigured model falls back to the executor's with a note rather than
  failing the run.
- The executor keeps one session across steps and retries, so context grows with attempts. Long
  skills want compaction or a session per step.
- A gate's escalation lives in memory (LangGraph's `MemorySaver`): it must be answered in the same
  run.
- The gate machinery has no automated coverage; see
  [trying the gate semantics](skills-and-gates.md#trying-the-gate-semantics).
- Jobs live in memory: there is no resuming a job after pi exits. The work itself is on disk, so a
  killed job leaves a partial build rather than nothing.
