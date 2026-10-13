# An integration: hubsync

You will build **hubsync**, a command-line job that keeps a CSV of contacts in step with HubSpot. It creates the
contacts that are missing, updates the ones that changed, matches them by email, and reports what it did. Run it by
hand or from cron.

An integration is regenerated like any module, with three differences. The provider's contract is written down in
files rather than recalled from memory. The agents need a credential to reach the provider. And the conformance
tests call the real API.

It takes an hour or two. Read [cognio](cognio.md) first for the basics.

## 1. A HubSpot sandbox and a token

Never point an integration under construction at your production portal.

1. In HubSpot, create a **developer test account** (or a sandbox, if your plan has one).
2. In it, create a **private app** with the scopes `crm.objects.contacts.read` and `crm.objects.contacts.write`.
3. Copy its access token.

## 2. The project

Build it on any command-line stack your machine can build - Python, TypeScript, Go, Rust or Java. The agents use
the toolchains on your machine and install none, so the interview offers only the stacks it can build; `turri
doctor` lists what is there.

```bash
mkdir ~/hubsync && cd ~/hubsync
turri init-config
```

Put the token in a `.env` at the project root (and keep `.env` out of git):

```bash
HUBSPOT_ACCESS_TOKEN=pat-eu1-...
```

Then add these lines to `config.turri.yaml` so that the agents can use it:

```yaml
agent-env:
  files: [.env]
```

An agent's commands get none of your environment unless the config names it. With these lines, the variables in
`.env` reach every agent's commands, and only its commands. The file itself stays out of their reach. Wherever an
agent might see the token, in tool results or in the logs, it reads `[HUBSPOT_ACCESS_TOKEN]` instead.
[Credentials for the agents](../docs/config.md#credentials-for-the-agents) has the details.

## 3. Say what you want

```bash
turri
```

> Let's build hubsync - a standalone CLI that syncs a CSV of contacts into HubSpot.
> `hubsync push contacts.csv` matches each row to a HubSpot contact by email: it creates the contacts that are
> missing and updates the ones whose first name, last name, company or phone differ. Nothing is ever deleted.
> `--dry-run` prints what it would do. It prints a summary - created, updated, unchanged, failed - and exits 1
> if any row failed. The token comes from `HUBSPOT_ACCESS_TOKEN`.

**turri** starts the interview, `brood`. It asks first how many questions the stack and product phases may ask -
light, medium or thorough, at most 3, 5 or 10 a phase, or best judgement - fewer questions being broader ones.
Choose **thorough**: narrow questions, because an integration has more edge cases worth your say than most. It then follows **turri**'s rules for integrations, which come before the
features:

- **The documentation, fetched.** The agent searches for HubSpot's current CRM contacts API and fetches the pages:
  endpoints, auth, errors, pagination, rate limits. It doesn't write the spec from memory.
- **The live API, cross-checked.** It checks the token on a harmless read, then makes a few read-only calls to see
  what the API really returns. Where the docs and the API disagree, the API wins. It never makes a call that
  changes anything without asking you first.
- **The contract, in `resources/`.** What it learns goes into files the spec links to rather than restates:
  `resources/hubspot.openapi.yaml` for the endpoints it uses, `resources/error-map.yaml`, which errors are worth
  retrying, `resources/contract/` for the CSV's columns. The spec says what **hubsync** does with them.
- **Its shape and stack.** Standalone: **hubsync** is a CLI of its own, not a library inside another codebase - on
  the command-line stack you choose, `stdlib/cli/<stack>`, from those your machine can build.
- **Testing.** Whether there are conformance tests. Say **yes**: for an integration they are what shows it works
  against the real provider.

A functional spec then reads like this:

```plain
- `hubsync push <csv>` creates a :HubSpotContact: for each :ContactRow: whose email matches none, through the batch create endpoint of :HubSpotApi:.
  - A row that fails is reported with its line number and the error, and the rest go on.
```

The retries, the batching and the paging go into the implementation reqs (`***implementation reqs***`), because
they are how it works, not what it does.

## 4. Conformance tests against the live API

An integration's conformance tests call the HubSpot sandbox. Recorded responses or mocks would show only that the
code agrees with the recordings. The test reqs say so:

```plain
- :ConformanceTests: run against the live :HubSpotApi: sandbox - no mocking of HubSpot calls.
  - The conformance script reads `HUBSPOT_ACCESS_TOKEN` from the environment or from `.env`, and stops with an error if it is missing.
  - The 429 (rate limit) path uses a local stand-in for that endpoint alone; every other path is live.
```

The tests create their own contacts, with addresses on a domain kept for tests, and delete them afterwards. The
testing scripts run on this machine in your own environment, so they read `.env` themselves.

## 5. Watch it regenerate, and try it

regen (`ctrl+h`) shows the code track and the conformance track as for any module. If HubSpot behaves
differently from what the spec says, the fix is a spec change, and that is yours to make: say what **hubsync**
should do instead.

> Release it.

**turri** puts the code as last built in `dist/hubsync` and gives you the commands to run from there:

```bash
hubsync push contacts.csv --dry-run
hubsync push contacts.csv
```

## 6. Change your mind

> Also sync a `lifecycle_stage` column, but never move a contact backwards - a customer stays a customer.

The agent checks the property in HubSpot's documentation and the live API, adds it to the contract in
`resources/`, and regenerates the change. The conformance tests for it run against the sandbox too.

## Where next

- [Deploy](../docs/deploy.md) - releasing an integration, and following a project's own release steps.
- `genome/rules/integrations.md` - the rules the agents follow for integrations, including embedded ones that live
  inside an existing codebase.
