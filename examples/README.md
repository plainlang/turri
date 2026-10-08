# Examples

Each example is a project you grow with **turri** from an empty folder. You say what you want, **turri** writes the
\*\*\*plain specs and grows the code from them, and you change your mind by changing what the software should do. You
never write a line of code yourself.

| example | what you build | what it shows |
| --- | --- | --- |
| [cognio](cognio.md) | a Strava for students: a FastAPI backend and a React web app | the whole journey, step by step: the interview, the specs, the pulses, the regeneration, releasing, changing your mind, a second module |
| [tidy](tidy.md) | a command-line tool that sorts a folder of files into subfolders | the quick start with `spawn`, a CLI on the standard library, conformance tests that run the real binary |
| [shorty](shorty.md) | a backend service: a URL shortener with click counts, in TypeScript and Fastify | conformance tests from the start, `bind`, a rule changed and grown again |
| [hubsync](hubsync.md) | an integration that keeps a CSV of contacts in step with HubSpot | a third-party REST API: its contract in `resources/`, credentials for the agents, conformance tests against the live sandbox |

New to **turri**? Start with [cognio](cognio.md). It explains each step as it comes, and the other examples assume it.

## Before any of them

- Install **turri** as the [quick start](../README.md#quick-start) says, and run `turri setup`.
- Make a folder for the project, `cd` into it and run `turri init-config`. It writes a `config.yaml` with two models:
  a capable one to talk to and a smaller one for the coding. Change them to models you have.
- Each example says which toolchain its stack needs. Once the project exists, `turri doctor` in its folder says
  what is missing.
- Start `turri` in the folder and say what you want. Each example gives the words to start with. Use your own
  words if you prefer: the interview asks for whatever is missing.

What the agents build differs from run to run, as code written by any developer would. The specs are what stay the
same, and the conformance tests are what show that the code does what they say.
