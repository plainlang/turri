# Development

```bash
npm run typecheck   # types
npm test            # the whole suite; tests that run commands boot the sandbox VM
```

Working on plainwright itself, `npm link` points the global `plainwright` at this clone, so edits
take effect immediately. `npm run chat` starts pi with the extension loaded from `src/`.

## Layout

| path | what it is |
|---|---|
| `bin/plainwright.mjs` | the launcher: checks the Node version, then loads `src/cli.ts` |
| `src/cli.ts` | the `plainwright` command and its subcommands |
| `src/setup.ts`, `src/environment.ts` | `plainwright setup`, `doctor`, `vm-image`, and what they check |
| `src/extension.ts` | the pi extension: every tool and command the conversation has |
| `src/skill.ts` | parses `SKILL.md` into steps and gates |
| `src/graph.ts` | compiles a skill into a LangGraph `StateGraph`: step -> gate -> route |
| `src/judge.ts` | runs independent judges, applies the quorum, builds the critique |
| `src/forge.ts` | `runSkill()` - the one entry point the CLI and the extension share |
| `src/pi.ts` | pi session factories for executors, sub-agents and judges |
| `src/spec-tools.ts` | `write_spec_diff` |
| `src/plain/` | the \*\*\*plain parser - see [parser](parser.md) |
| `src/render/render.ts` | one functionality to code |
| `src/render/module.ts` | whole-module builds, regression runs, regeneration |
| `src/render/conformance.ts` | conformance tests: writing them, and fixing the test or the code until they pass |
| `src/render/spec-change.ts` | rendering a spec diff |
| `src/render/queue.ts`, `src/render/jobs.ts` | the render queue and background jobs |
| `src/render/spec-diff-parts.ts` | cutting a spec diff by the codebase each part lands in |
| `src/render/queue-master.ts` | reworking the queued spec diffs around each new one, held to ending on the spec as it is |
| `src/render/state.ts` | the tree the code is built from, `.plainwright.json` |
| `src/render/history.ts` | module history in `.plaingit` |
| `src/render/deploy.ts`, `src/deploy-tools.ts`, `src/deploy-cli.ts` | deploy: the last commit to `dist/<module>`, what installs software, what it starts on the host - see [deploy](deploy.md) |
| `src/render/confine.ts`, `src/render/vm.ts` | the file-tool fence and the sandbox VM - see [sandbox](sandbox.md) |
| `src/render/models.ts` | choosing and resolving render models |
| `src/render/job-panel.ts`, `src/render/transcript-view.ts` | the job panel and `/watch` |
| `src/render/debug-log.ts` | each render agent's whole conversation, always streamed to `.plainwright/debug/` |
| `vm/image.json` | what goes into the VM image |
| `skills/`, `forge/rules/` | the skill library and the \*\*\*plain authoring rules |

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
