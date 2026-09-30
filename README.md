<br>

<p align="center">
  <img src="docs/assets/banner.png" alt="plainwright - coding agent with the power of regenerative software.">
</p>

<h1 align="center">plainwright<br>coding agent with the power of<br>regenerative software<br>&nbsp;</h1>

You and **plainwright** write down what the system should do, as [\*\*\*plain](https://plainlang.org/) specs. **plainwright** builds
the code from them. From then on the specs are the durable source of truth: the code can always be
regenerated from them, and healed against them, as they change.

## Why

In the age of coding agents, writing code is getting easy. The hard and important part is
defining what the system should do. Agents can fix bugs, ask questions and keep getting more
capable - but they still cannot read your mind. The question is not only whether an agent can
write the code, but whether it understands what it is building.

Code that is patched, prompt after prompt, drifts: every misunderstanding stays in it, and the
next change is made on top. When the software can always be regenerated from durable information
instead, that understanding is written down - explicit, reviewable and tested - and it grows with
the software rather than against it.

## How it differs from a coding agent

With a coding agent you work on code: you ask for a change, it edits the code, and you review the
code it wrote.

With **plainwright** you work on [\*\*\*plain](https://plainlang.org/) specs. You say what the software must do, and **plainwright** updates the [\*\*\*plain](https://plainlang.org/) specs
and can always regenerate the code from that. You don't review the code or keep it - you review and
keep the intent: what the software must do, and what must hold as it changes. The specs are the
durable part. The code is a disposable artefact, rebuilt from them whenever they change.

| | ye old coding agent | **plainwright** |
| --- | --- | --- |
| **What you maintain** | the code, patched prompt after prompt | the [\*\*\*plain](https://plainlang.org/) specs; the code is generated from them and never edited by hand |
| **Who drives** | the agent picks what to do next | the harness, in a fixed order: one functionality or one spec diff at a time, or a whole module functionality by functionality, in the spec's order, each on top of the ones before it |
| **What counts as done** | the agent writes the code, runs the tests, and decides for itself that it is done | ye old coding agent writes the code; **plainwright** runs the whole test suite itself, with the project's own testing scripts, and decides deterministically when it is done - every test passes in its own run, or the work goes back |
| **Tests** | written and changed by whoever writes the code | conformance tests written from the spec, black box, and kept apart from your acceptance tests; an agent fixing the code cannot change them |
| **What the agent sees** | your whole machine | only the prompt the harness writes, `plain_modules`, and the public web through its search and fetch tools; every command runs in a small Linux VM that holds nothing else |
| **Memory** | one conversation that fills up | a fresh agent for every step, starting from working notes the agents before it left - dated, attributed, and never allowed to override the spec |
| **When it gets stuck** | it keeps trying, or quietly works around the problem | after 20 attempts it stops and tells you what to change in the spec - never in the code |
| **A change** | another patch on top | a change to the spec: what it touches is rebuilt, everything built before is tested again, and code that disagrees with the spec is healed to match |
| **History** | whatever you commit | every build, regeneration and repair is a commit; a build interrupted halfway starts again from the last one |

## How it works

1. **Define.** Write the specs with **plainwright**: it interviews you one question at a time and
   writes the `.plain` files, held to the [\*\*\*plain](https://plainlang.org/) authoring rules and reviewed by independent
   judges.
2. **Generate.** **plainwright** builds the code one functionality at a time, each on top of the ones
   before it, into `plain_modules/` - and builds each answer in the background while the interview
   goes on.
3. **Validate.** The harness runs the unit tests, then conformance tests written from the spec,
   then everything built so far, and moves on only when all of it passes.
4. **Regenerate.** To change the system, change its definition. The functionalities whose spec
   changed are rebuilt, and everything built before is tested again.

A bug is fixed in the spec; a new behaviour goes into the spec; and the next regeneration carries
it. When a build is done, ask to try it: **plainwright** puts what is built in `dist/<module>` and
starts it on your machine - an app, and it tells you where to open your browser.

A spec looks like this:

```plain
***definitions***

- :User: is a person with an account: an email address and a password.

***implementation reqs***

- :Implementation: is written in Python 3.12 with FastAPI.

***functional specs***

- A new :User: can register with an email address and a password.
  - Registering with an email address already in use fails with status 400.

- A registered :User: can sign in and receives a bearer token.
```

Each item under `***functional specs***` is one functionality, built on top of the ones before it.

**plainwright** runs as an extension to [pi](https://github.com/earendil-works/pi), so you work with it
in a conversation, and as a command line for unattended runs.

## Install

```bash
git clone git@github.com:plainlang/plainwright.git && cd plainwright
npm install
npm link              # puts `plainwright` on your PATH
plainwright setup     # checks the machine and fixes what it can, asking first
```

`setup` checks for Node 22.19+, QEMU (which the sandbox VM runs on), a model provider for pi, and
the VM image - and offers to build the image, which takes about 7 minutes. It ends by starting a
VM for real. `plainwright doctor` runs the same checks later without changing anything.

It runs on Apple Silicon macOS and on Linux. Details, and what each check means:
[installation](docs/installation.md).

## Use

In the project where your specs live:

```bash
cd ~/my-project
plainwright chat
```

Then talk to it:

> Let's start a new project: a small API where people can register and sign in.

It runs the interview skill, asks you about the problem, the stack and the product, writes the
specs, and builds each one as it is written. While it works:

- the **panel** above the input shows every build - its stage, what its agents are doing, its
  model and cost - and the queue behind it;
- ask to try it at any time - "let me try it" - and **`deploy`** puts what is built so far in
  `dist/<module>` and starts it, asking before it installs anything;
- the **side panel** (`ctrl+j`), on the right, shows the whole queue and each build's agents at work, one agent at a time if you like (`/watch` opens it on a build);
- **`/jobs`** lists every build, **`/stop`** stops one, **`/history`** shows what a module's
  builds changed.

Other things to ask for:

> Add password reset to the spec.
>
> Render the whole module again with conformance tests.
>
> Render spec changes with gpt 5.5.

The last one holds for the rest of the session; the model can be chosen separately for spec
changes and for functionalities, and a name that fits more than one model is asked about rather
than guessed.

Without a conversation, the same work is on the command line:

```bash
plainwright check app.plain          # validate a spec - no model, no API key
plainwright module app.plain         # build the spec: planned into jobs, run until it is built
plainwright regenerate app.plain 3   # build functionality 3 again, changed or not
```

More: [using **plainwright**](docs/using.md); to render a spec overnight, see
[running unattended](docs/headless.md).

## Documentation

Start at the [documentation index](docs/README.md), or go straight to a page:

| | |
| --- | --- |
| [Installation](docs/installation.md) | setup and doctor, the VM image, **plainwright** in every `pi`, environment variables |
| [Using **plainwright**](docs/using.md) | the conversation, skills, tools, background jobs, choosing models, the command line |
| [The project config](docs/config.md) | `config.yaml` and `config.<module>.yaml`: every key, models and their inheritance, conformance, the testing scripts, modules on different stacks |
| [Deploy](docs/deploy.md) | trying what is built: the last commit in `dist/<module>`, started on your machine, nothing installed without asking |
| [Running unattended](docs/headless.md) | rendering a spec overnight or in CI: the command, keeping it running, the results, resuming, rebuilding one functionality |
| [Authoring \*\*\*plain](docs/authoring-plain.md) | what a spec is made of, the authoring rules, the skills that write and fix specs, checking a spec |
| [Rendering](docs/rendering.md) | what each build does and in which order: functionalities, modules, regeneration, spec diffs, conformance and acceptance tests, working notes, what the code is built from |
| [The sandbox](docs/sandbox.md) | what agents can reach, the VM every command runs in, time limits, the web tools |
| [Skills and gates](docs/skills-and-gates.md) | the gate syntax, what the harness enforces, judges, rules |
| [The \*\*\*plain parser](docs/parser.md) | the TypeScript port, `plainwright check`, fidelity to the reference parser |
| [Theming](docs/theming.md) | the two brand themes |
| [Development](docs/development.md) | tests, layout, known edges |
