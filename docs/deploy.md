# Trying what is built: deploy

Ask to try it - "let me try it", "run the app" - at any time, even while a render is running. The
chat calls `deploy`: it puts the module's code, as it was last built, in `dist/<module>` in the
project, and starts it on your machine. An app with a backend and a frontend is started whole, and
you are told where to open your browser. For a command-line tool or a library you get a few commands
to paste, run from `dist/<module>`, and what they print.

Every job that lands code - a render, a spec diff, a conformance run, a regeneration - ends with
"Want to try it? Just ask me - I'll set it up from what's built so far." When a render's conformance
tests follow as a job of their own, the conformance job says it, once they pass too.

## What goes in dist

- **The module on top.** Code accumulates up a `requires` chain: a module starts from a copy of the
  code of the one it requires. So deploy always takes the module on top of the spec's chain - the
  project's `module` from `config.yaml` unless another spec is named. Before the module on top has
  anything built, it takes the nearest one below it that has, and says so.
- **Its last commit.** Each `plain_modules/<module>` is a git repository (`.plaingit`), and every unit
  of work starts from a commit and ends with one. What a job is writing right now is half-done, so it
  is left out: deploy exports the commit - `git archive` of `code/` - which is the working tree with
  every unstaged and untracked change put back, and no `node_modules`, `.venv`, `target` or other
  build leftovers, whatever the stack. The working tree the job is using is never read or touched.
  The harness's own files - `.plainwright.json`, the agents' notes - are left out too.
- **Replaced whole.** Each deploy stops what the last one of the module started, empties
  `dist/<module>` and exports again. Change nothing there you want to keep. `dist/` is not added to
  `.gitignore`: whether it is committed is yours to decide.

## Starting it

It runs on your machine, outside the [sandbox](sandbox.md) - with your toolchains, where your
browser can reach it. The chat reads how the code runs (its README, manifests and entry points),
then:

1. **Checks the toolchains** it needs (`node`, `python3`, `go`, ...). One is missing: it says what to
   install, and starts nothing. It never installs a toolchain.
2. **Asks before it installs anything.** Dependencies into a virtual environment or `node_modules`, a
   build that downloads packages, an image pull: every command that installs or downloads is shown to
   you in a dialog, word for word, with what it installs and where, and runs only when you say yes.
   Say no, and nothing is installed - you are told what it needs instead. This is enforced, not only
   asked for: once something is deployed, the chat's own shell refuses any package manager, download,
   `make`, `just` or project script, and `start_deployed` refuses a command that fetches as it starts
   (`go run`, `cargo run`, `docker compose up`) until you agreed to that one too.
3. **Starts what serves** with `start_deployed`: in the background, in its own process group, its
   output in `.plainwright/deploy/<module>-<name>.log`. It waits until something answers at the
   server's URL - up to a minute - so the URL you are given has answered once; one that exits first
   comes back with the end of its output. A port something else holds is said, with what holds it,
   and nothing is started there: the app is not moved to a port you were not told about.

What it started is listed by **`/jobs`** and stopped by **`/stop deploy <name>`**, by
`stop_deployed`, by the next deploy of the module, and when the chat exits.

## On the command line

```bash
plainwright deploy [file.plain] [--in-module <module>] [--model <provider/id>]
```

The same, without the chat: it exports to `dist/<module>`, then a one-off agent on `harness-model`
(or `--model`; without either, pi's default) works out how to start it and starts it here, asking
at the terminal - `[y/N]` - before it installs anything. With no terminal to ask (CI, output piped),
nothing is installed and it says what is needed. It stays in the foreground with the servers'
output; `Ctrl-C` stops them. If it does not get there, deploy from the chat instead.

`plainwright render`, `module` and `spec-diff` end a build that landed with
`To try it: plainwright deploy <spec>`.
