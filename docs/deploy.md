# Trying what is built: deploy

Ask to try it - "let me try it", "run the app" - at any time, even while a render is running. The
chat calls `deploy`: it puts the module's code, as it was last built, in `dist/<module>` in the
project, and starts it on your machine. An app with a backend and a frontend is started whole, and
you are told where to open your browser. For a command-line tool or a library you get a few commands
to paste, run from `dist/<module>`, and what they print.

Every job that lands code - a render, a spec diff, a conformance run, a regeneration - ends with
"Want to try it? Just ask me - I'll set it up from what's built so far." When a render's conformance
tests follow as a job of their own, the conformance job says it, once they pass too.

## When the project says how it is released

Every release starts the same way: the module's last commit - what last landed whole - goes in
`dist/<module>`, as below. Not everything is tried from there, though. An integration that a host
application loads goes on into the host's own tree, with the host's own scripts, and then the host
is started. So the model asks itself whether there is guidance for how this project is released -
in what you said, the project's AGENTS.md, a skill, anything it was given - and passes it to
`release` whole:

- **There is guidance.** The code goes on from `dist/<module>` as the guidance says, on your machine,
  from the host codebase - the git repository the project is in, or else where **turri** runs: the
  scripts it names, in their order, and any change it says the host needs. The code is taken from
  `dist`, never from `plain_modules`, where a job may be writing; where the host's tooling reads
  `plain_modules` itself, the model points it at `dist`, or does by hand from `dist` what it does. When
  to release - after every job, say - is the guidance's to say too. The rules below hold as they do for `dist`: a project script, an
  install or a download runs only once you agreed to it in a dialog, and what keeps running - a
  start script, a server - is started with `activate`. Nothing built is changed.
- **There is none.** The default: it is started from `dist/<module>`, as below, as best it can be.

Guidance is whatever says it, in any words - a line in AGENTS.md such as *integrations are released
with `scripts/deploy_integrations.sh`, then the app is started with `scripts/start.sh`*, or the
same said in the chat.

The chat reacts to every job that finishes as it finishes, without waiting for you to speak: guidance
that says to release after a build - *release each integration once it is grown* - is followed then.

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
  The harness's own files - `.turri.json`, the agents' notes - are left out too.
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
   you in a dialog, word for word, with what it does, and runs only when you allow it: **once**, **for
   this session** - the same commands in the same folder then run without asking until turri exits -
   or **always**, kept in the project's `.turri/allowed-commands.json` (delete it to take them back).
   **Don't allow**, and nothing runs. A guided release's project scripts are asked about the same way.
   Say no, and nothing is installed - you are told what it needs instead. This is enforced, not only
   asked for: once something is deployed, the chat's own shell refuses any package manager, download,
   `make`, `just` or project script, and `activate` refuses a command that fetches as it starts
   (`go run`, `cargo run`, `docker compose up`) until you agreed to that one too.
3. **Starts what serves** with `activate`: in the background, in its own process group, its
   output in `.turri/deploy/<module>-<name>.log`. It waits until something answers at the
   server's URL - up to a minute - so the URL you are given has answered once; one that exits first
   comes back with the end of its output. A port something else holds is said, with what holds it,
   and nothing is started there: the app is not moved to a port you were not told about.

What it started is listed by **`/growth`** and stopped by **`/halt activated <name>`**, by
`halt`, by the next deploy of the module, and when the chat exits.

## On the command line

```bash
turri release [file.plain] [--in-module <module>] [--guidance <text>] [--model <provider/id>]
```

The same, without the chat: a one-off agent on `harness-model` (or `--model`; without either, pi's
default) is given the project's AGENTS.md and what `--guidance <text>` says, looks for guidance in
them, and releases as above - as the guidance says, or to `dist/<module>` - then works out how to
start it and starts it here, asking at the terminal - `[y/N]` - before it installs or runs anything. With no terminal to ask (CI, output piped),
nothing is installed and it says what is needed. It stays in the foreground with the servers'
output; `Ctrl-C` stops them. If it does not get there, deploy from the chat instead.

`turri regrow`, `spec-diff`, `regenerate` and `conformance` end a build that landed with
`To try it: turri release <spec>`.
