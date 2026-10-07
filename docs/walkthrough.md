# Walkthrough: growing cognio

No project of your own yet? Follow this one. You will build **cognio** - a Strava for students, where they post
their study sessions, follow one another and give each other kudos - from an empty folder to a running backend
and web app, without writing a line of code or of spec yourself. Along the way you will see everything **turri**
does: the interview, the specs it writes, the pulses that grow the code, the regeneration that shows how far
it has grown, and what happens when you change your mind.

It takes an hour or so, most of it the agents' time, not yours.

## 1. Before you start

Install **turri** as the [quick start](../README.md#quick-start) says, and run `turri setup`. cognio's backend is
Python with FastAPI and its frontend React, so the machine needs what builds and tests them:
[uv](https://docs.astral.sh/uv/) (it fetches Python 3.12 itself) and Node 20 or newer with npm. Once the project
exists, `turri doctor` in its folder says what is missing.

## 2. A folder and a config

```bash
mkdir ~/cognio && cd ~/cognio
turri init-config
```

`init-config` writes a `config.yaml` with the two models **turri** works with:

```yaml
harness-model: anthropic/claude-opus-5-5     # you talk to it: it writes the specs and plans the work
coding-model: google/gemini-3.1-flash-lite   # it writes the code - or openai/gpt-6-luna
```

The one you talk to does the thinking - it interviews you, writes the specs and plans the work - so it is worth a
strong one. The coding agents work from specs that leave little to guess, so a smaller, cheaper model does well.

These two are only an example: you are not tied to a vendor. **turri** runs on [pi](https://pi.dev), so any model
pi supports works, signed in any way pi supports - an API key, `/login` with a subscription, a cloud account such
as Amazon Bedrock. Keep the split - a capable model to talk to, a smaller one for the coding - and change the two
lines to the models you have. Sign in to their providers, then start **turri**:

```bash
export ANTHROPIC_API_KEY=...   # or skip these, and type /login once turri has started
export GEMINI_API_KEY=...
turri
```

## 3. Say what you want to build

Tell it, in your own words - this is how cognio began:

> I want to build cognio - a Strava-like app for students where they can give one another kudos for their study
> sessions. Users register with an email, password, first and last name and a handle; handle and email are
> unique, and users can follow other users by searching for them. Users post their study session with a photo
> of their setup and a fact they learned, and its type - prep for an exam, class work and so on. Other users can
> give kudos and comments, and users are notified of new kudos, comments and follows. The feed is chronological,
> with posts only from the users I follow, and every user has a profile page with their study sessions. The
> backend is FastAPI, the frontend React. Let's start with the backend.

**turri** starts the `brood` skill: an interview that writes the spec as you answer. Every question comes with
choices - pick one, or type your own answer.

- **Intent.** Who is it for, what is the outcome, how will you know it works, and what is left out. It reads the
  brief back to you; confirm it, or correct it.
- **Stack.** It offers the standard library's stacks first - for cognio, `stdlib/backend/python-fastapi`: FastAPI,
  Pydantic, pytest, and a dozen decisions you would otherwise make yourself - then asks only what that leaves
  open: where the data lives (SQLite is fine here), how passwords are hashed, how users sign in, where photos go.
  It writes `backend.plain` and the unit testing script, and reads the stack back.
- **Testing.** Whether there are conformance tests - black-box tests of the running service, written from the
  spec, beside the unit tests. Say no for this walkthrough: it keeps the builds quick. (Say yes on a real project:
  they are what proves the code does what the spec says.)
- **Product.** Then the features, one question at a time: registering, signing in, following, posting a session,
  kudos, comments, notifications, the feed, profiles. **Every answer becomes one change to the spec**, and that
  change starts growing at once, in the background, while the interview goes on.

What it writes is \*\*\*plain - plain English with just enough structure. Concepts are defined once, between colons,
and every functional spec says what can be done and what the result is:

```plain
- :Handle: is the public name of a user: 3 to 30 characters, each one of `a-z`, `0-9` and `_`.

- A visitor can register a :User: via `POST /users` with the JSON body `{"email", "password", "first_name", "last_name", "handle"}`.
  - The response is `201` with the :AccountBody: of the new :User:.
  - An `email` or `handle` already used by another :User: returns `409` `conflict`, with a message naming the field.
```

That is what you review and keep. You never need to read the code.

## 4. Watch it grow

While you answer, the code grows. The panel above the input shows each **pulse** - one unit of work: a few
functional specs grown into the code by a coding agent, until their unit tests pass and a reviewer is satisfied -
with its time and cost, and the next ones queued behind it.

Press `ctrl+h` for the **regeneration**: the whole spec, every item marked with where it stands.

```
Regeneration  backend.plain   ██████████▓▓▓▓░░░░░░░░░░  4 of 10 functional specs built · pulse 5 of 7 growing
──────────────────────────────────────────────────────────────────────────────────────────────────────
› ▾ backend.plain  ████▓▓░░░░░░  4/10 built · pulse 5 of 7 growing
      │ ***functional specs***
  ✓   │ - A visitor can register a :User: via `POST /users` with the JSON body …
  ✓   │ - A :User: can log in via `POST /auth/login` with the JSON body `{"email", "password"}`.
  ⠋   │ - :CurrentUser: can follow a :User: via `PUT /users/{handle}/follow` …   ← growing now · 1m 12s
  6   │ - :CurrentUser: can post a :StudySession: via `POST /sessions`, …
  ·   │ - :CurrentUser: can read their :Feed: via `GET /feed`, …
```

`✓` is built, the spinner is growing now, a number is the pulse planned to grow it, and `·` is not planned yet - the
top line says why. `↑` `↓` move, `enter` opens an item, `p` turns to the pulses themselves, and `ctrl+h` or `esc`
goes back to the chat. What every mark means: [the side panel](using.md).

## 5. Try it

When the backend is built, ask:

> Release it.

**turri** takes what has grown, starts it on this machine, installing what it needs, and tells you where it
runs - the API, and FastAPI's interactive documentation at `/docs`. Register a user there, sign in, post a
session.

## 6. Change your mind

This is where **turri** differs from a coding agent. You do not ask for a code change - you change what the
software should do:

> Students should be able to edit their own comments.

**turri** writes it into the spec as a spec change - a new functional spec, and whatever it touches - and grows
just that: the regeneration shows the new item waiting, then planned, then growing, while everything already
built stays `✓`. Change a rule instead - *a handle may be up to 20 characters, not 30* - and the definition is
marked with the pulse that changes it; the specs that use it are grown again with it.

Nothing is patched by hand, and nothing drifts: the code is always grown from the spec as it is now.

## 7. The frontend

> Now the frontend: a React web app over this API.

The frontend is a module of its own, `frontend.plain`, on `stdlib/frontend/react-vite`, with its own unit testing
script. It usually links a resource file describing the backend's API, so the two agree, and it is interviewed and
grown the same way. The regeneration then has a row for each module; the one being grown is open, the other folded. When it is
built, *release it* again and open the web app.

## 8. Leave, and come back

Close **turri** whenever you like. Every pulse either lands as a commit or is rolled back whole - one cut off is
rolled back before the next one starts - so code, tests and spec never disagree. Start `turri` in the folder again and `ctrl+h` shows exactly what is built, from the files alone. Say
*regrow backend.plain*, and what is left is planned and grown again.

A few more things to ask for along the way:

| ask | what it does |
| --- | --- |
| *what is left to grow?* | `drift`: how far the code is from the spec, starting nothing |
| *show me the lineage of backend* | every generation of its code, as git commits - what grew into it, and when |
| *regrow the login again* | `rejuvenate`: grow a functional spec again from its spec, though nothing changed |
| *what would the next pulse do?* | `glimpse`: plan the work and show the first prompt, starting nothing |

## Where next

- [Using **turri**](using.md) - the conversation, the skills and tools, the side panel, the command line.
- [Authoring \*\*\*plain](authoring-plain.md) - how specs are written, and the skills that write them.
- [Growing](growing.md) - what a pulse does, step by step.
- [The project config](config.md) - every key of `config.yaml`.
