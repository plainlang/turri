# plainwright documentation

plainwright implements regenerative software: the \*\*\*plain specs are the durable definition of
what a system does, and the code is generated from them, validated against them, and regenerated
as they change. The [project README](../README.md) says why, and how to install and start; these
pages go into each part.

## Start here

1. [Installation](installation.md) - get a machine ready: `plainwright setup`, `doctor`, and the
   VM image every command runs in.
2. [Using plainwright](using.md) - the conversation, the skills and tools, background jobs and
   `/watch`, choosing the model that renders, the command line.
3. [Authoring \*\*\*plain](authoring-plain.md) - writing the specs: what a spec is made of, the
   authoring rules, the skills that write and fix specs.
4. [Rendering](rendering.md) - turning the specs into code: what each build does, in which order,
   and what has to pass before it moves on.

## By question

| to find out… | read |
| --- | --- |
| what my machine needs, and why a check failed | [installation](installation.md) |
| how to build the full VM image, and what the stock one cannot do | [installation](installation.md#building-the-vm-image) |
| how to start a project, or add a feature, in a conversation | [using](using.md#in-a-conversation) |
| which model renders, and how to change it | [using](using.md#choosing-a-model) |
| how to render a spec overnight, and resume it | [running unattended](headless.md) |
| how to rebuild one functionality | [running unattended](headless.md#rebuilding-one-functionality) |
| what goes in which section of a spec | [authoring \*\*\*plain](authoring-plain.md#what-a-spec-is-made-of) |
| which skill does what | [authoring \*\*\*plain](authoring-plain.md#the-skills) |
| what happens when a spec changes | [rendering](rendering.md#a-spec-change-as-a-diff) |
| why a test was not allowed to be deleted | [rendering](rendering.md#the-tests-must-actually-pass) |
| what the agents can and cannot reach | [the sandbox](sandbox.md) |
| how skill review gates and judges work | [skills and gates](skills-and-gates.md) |
| how the parser matches the reference implementation | [the \*\*\*plain parser](parser.md) |
| where the code for something lives | [development](development.md#layout) |

## All pages

| page | covers |
| --- | --- |
| [Installation](installation.md) | setup and doctor, building the VM image, the stock image's limits, plainwright in every `pi`, environment variables |
| [Using plainwright](using.md) | the conversation, the tools, background jobs, choosing a model, module history, the command line |
| [Running unattended](headless.md) | rendering overnight or in CI: before you leave it, the command, the results, resuming, rebuilding one functionality |
| [Authoring \*\*\*plain](authoring-plain.md) | a \*\*\*plain project, what a spec is made of, the rules, writing specs with the agent, the skills, checking a spec |
| [Rendering](rendering.md) | where things go, one functionality, a whole module, spec diffs, conformance tests, what the code is built from |
| [The sandbox](sandbox.md) | what an agent can reach, the file-tool fence, the VM, installing what the image lacks |
| [Skills and gates](skills-and-gates.md) | the gate syntax, what the harness enforces, what a step can do, the rules, trying the gates |
| [The \*\*\*plain parser](parser.md) | the TypeScript port, `plainwright check`, inheritance, the iterator, fidelity |
| [Theming](theming.md) | the forge themes, contrast, backgrounds, the font |
| [Development](development.md) | tests, the source layout, known edges |
