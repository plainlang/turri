# A backend service: shorty

You will build **shorty**, a URL shortener: an HTTP API that turns a long URL into a short code, redirects anyone who
opens the code, and counts the clicks. It is TypeScript on Fastify, with conformance tests from the start. These
are black-box tests that start the service and call it over HTTP, so they show that it does what the spec says.

It takes an hour or so. [cognio](cognio.md) explains each step in more detail. This example is about the
conformance tests.

## 1. The project

The machine needs Node 20 or newer, with npm.

```bash
mkdir ~/shorty && cd ~/shorty
turri init-config
```

Turn the conformance tests on for every functional spec before you start, in `config.yaml`:

```yaml
conformance-tests: true
```

Leave it out and the interview asks you. Set it to `chosen` to have conformance tests only for the functional specs
you pick. [The project config](../docs/config.md) has the details.

## 2. Say what you want

```bash
turri
```

> Let's build shorty - a URL shortener API in TypeScript with Fastify. You post a long URL and get back a short
> code; opening `/<code>` redirects to the URL and counts the click. Codes are 7 characters, letters and digits,
> or a custom alias of my choice if it's free. A link can expire at a given time; after that, the code returns
> 410. I can list my links with their click counts, and delete one. Keep the data in SQLite. Requests are
> authenticated with an API key per user.

The interview, `brood`, asks one question at a time:

- **Intent**, read back for you to confirm.
- **Stack.** `stdlib/backend/typescript-fastify`, with what it leaves open: SQLite through which library, how API keys
  are stored (hashed), what a redirect returns (`302`).
- **Testing.** Conformance tests are already on from `config.yaml`, so it writes their test reqs (`***test reqs***`)
  and the conformance testing script, `run_conformance_tests_typescript.sh`, from the stack's template,
  `stdlib/backend/conformance/typescript-fastify`.
- **Product**, feature by feature: API keys, creating a link, the redirect, custom aliases, expiry, listing,
  deleting. Each answer is a spec change that starts growing at once.

## 3. Two tracks

Each module is grown on two tracks. The **code** track grows the functional specs into code that passes its unit
tests. The **conformance** track writes the black-box tests for what is built and runs the whole suite. A
conformance pulse starts once the module's code is built, and nothing is built on the module until it passes.

In the regeneration (`ctrl+h`) the second column is the conformance track's:

```
  ✓ ⊨ │ - A :User: can create a :Link: via `POST /links` with the JSON body `{"url", "alias"?, "expires_at"?}`.
  ✓ ⊨ │ - Opening `GET /{code}` redirects to the :Link:'s URL with `302` and adds one to its clicks.
  ✓ 6 │ - A :Link: past its `expires_at` returns `410` `gone` on `GET /{code}`, and is not counted.
  ⠋   │ - A :User: can list their :Link: items via `GET /links`, newest first, each with its clicks.
```

`⊨` means "satisfies": the conformance tests pass for the functional spec as it reads now. A number is the
conformance pulse planned to write its tests, and a spinner means they are being written now.

A conformance test that fails is not simply made to pass. A judge first works out what is wrong: the code, the
tests or the spec. The code or the tests are fixed. Two functional specs that contradict each other stop the pulse
and come back to you.

## 4. Bind ahead

With conformance tests off, or set to `chosen`, `bind` asks for them for some functional specs only:

> Bind the redirect and expiry specs.

From the command line, by functional spec number:

```bash
turri bind shorty.plain 2 3
```

When their code is not built yet, the conformance pulse is scheduled ahead of it. It shows a number in the
regeneration's second column and starts once the code is built.

## 5. Try it

> Release it.

**turri** starts the service on this machine and tells you where it is running. Make a key and a link:

```bash
curl -s -X POST localhost:3000/links -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"url": "https://codeplain.ai"}'
curl -si localhost:3000/<code>
```

## 6. Change a rule

> Codes should be 6 characters, not 7.

That is a change to a definition, not a feature. In the regeneration the definition gets the number of the pulse
that changes it. Every functional spec that uses it is grown again with it, and its conformance tests are written
again: `⊨` dims, then comes back once they pass for the new text.

## Where next

- [hubsync](hubsync.md), an integration - conformance tests against a live third-party API.
- [Growing](../docs/growing.md#conformance-tests) - what a conformance pulse does, step by step.
