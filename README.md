<br>

<p align="center">
  <img src="docs/assets/banner.png" alt="plainwright - coding agent with the power of regenerative software.">
</p>

<h1 align="center">plainwright<br>coding agent with the power of<br>regenerative software<br>&nbsp;</h1>

You and an agent write down what the system should do, as \*\*\*plain specs. The agent builds the
code from them. From then on the specs are the durable source of truth: the code can always be
regenerated from them, and healed against them, as they change.

## Why

In the age of coding agents, writing code is getting easy. The hard and important part is
defining what the system should do. Agents can fix mistakes, ask questions and keep getting more
capable - but they still cannot read your mind. The question is not only whether an agent can
write the code, but whether it understands what it is building.

Code that is patched, prompt after prompt, drifts: every misunderstanding stays in it, and the
next change is made on top. When the agent can always regenerate the software from durable
information instead, that understanding is written down - explicit, reviewable and tested - and
the agent grows with the software rather than against it.

So with plainwright you maintain software at the level of its definition, not its code:

1. **Define.** Write the specs with the agent: it interviews you one question at a time and writes
   the `.plain` files, held to the \*\*\*plain authoring rules and reviewed by independent judges.
2. **Generate.** The agent builds the code one functionality at a time, each on top of the ones
   before it, into `plain_modules/`.
3. **Validate.** The harness - not the agent - runs the unit tests and black-box conformance tests
   written from the spec, and moves on only when every test so far passes - its own run, not the
   agent's word. A deleted test is challenged.
4. **Regenerate.** To change the system, change its definition. The functionalities whose spec
   changed are rebuilt, and everything built before is tested again. When code and spec disagree,
   the code is healed to match - never the other way round.

The generated code is never edited by hand. A bug is fixed in the spec; a new behaviour goes into
the spec; and the next regeneration carries it.

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

## What it does

- **Builds while you talk.** Interview skills (`forge-plain`, `forge-diff`) write the specs with
  you, and every answer is built in the background while the interview goes on.
- **Keeps agents inside the project.** A rendering agent sees only the prompt the harness gives it
  and `plain_modules`; every command it runs runs in a small Linux VM that holds nothing else - not
  your home directory, not your other projects, not your API keys.
- **Tells you how to try it**, with commands that were run first and marked with whether they
  worked, and **keeps a history**: every render, regeneration and repair is a commit.

It runs as an extension to [pi](https://github.com/earendil-works/pi), the coding agent, so you
work with it in a conversation, and as a command line for unattended runs.

## Install

```bash
git clone git@github.com:plainlang/plainwright.git && cd plainwright
npm install
npm link              # puts `plainwright` on your PATH
plainwright setup     # checks the machine and fixes what it can, asking first
```

`setup` checks for Node 22.18+, QEMU (which the sandbox VM runs on), a model provider for pi, and
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
- **`/watch`** shows a build's full transcript on a screen of its own (`q` back to the chat,
  `alt+w` to return);
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
plainwright render app.plain 1       # build functionality 1
plainwright module app.plain         # build every functionality in order
plainwright regenerate app.plain 3   # rebuild functionality 3 after its spec changed
```

More: [using plainwright](docs/using.md); to render a spec overnight, see
[running unattended](docs/headless.md).

## Documentation

Start at the [documentation index](docs/README.md), or go straight to a page:

| | |
| --- | --- |
| [Installation](docs/installation.md) | setup and doctor, the VM image, plainwright in every `pi`, environment variables |
| [Using plainwright](docs/using.md) | the conversation, skills, tools, background jobs, choosing models, the command line |
| [Running unattended](docs/headless.md) | rendering a spec overnight or in CI: the command, keeping it running, the results, resuming, rebuilding one functionality |
| [Authoring \*\*\*plain](docs/authoring-plain.md) | what a spec is made of, the authoring rules, the skills that write and fix specs, checking a spec |
| [Rendering](docs/rendering.md) | what each build does and in which order: functionalities, modules, regeneration, spec diffs, conformance tests, the build record |
| [The sandbox](docs/sandbox.md) | what agents can reach, and the VM every command runs in |
| [Skills and gates](docs/skills-and-gates.md) | the gate syntax, what the harness enforces, judges, rules |
| [The \*\*\*plain parser](docs/parser.md) | the TypeScript port, `plainwright check`, fidelity to the reference parser |
| [Theming](docs/theming.md) | the two brand themes |
| [Development](docs/development.md) | tests, layout, known edges |
