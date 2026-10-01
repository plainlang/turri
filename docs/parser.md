# The \*\*\*plain parser

`src/plain/` is a TypeScript port of the reference \*\*\*plain parser - `plain_file.py`,
`plain_spec.py`, `concept_utils.py`, and the `file_utils.py` helpers they depend on.

| module | ports |
|---|---|
| `src/plain/parser.ts` | `plain_file.py` - sections, acceptance tests, imports/requires, marshalling |
| `src/plain/spec.ts` | `plain_spec.py` - functionality ids, the per-functionality context, linked resources, ranges |
| `src/plain/concepts.ts` | `concept_utils.py` - concept extraction, validation, topological ordering |
| `src/plain/markdown.ts` | mistletoe's AST + `PlainRenderer` (mdast + a matching serializer) |
| `src/plain/liquid.ts` | `plain2code_nodes.py` + the two filters in `plain_spec.py` (liquidjs) |
| `src/plain/files.ts` | `file_utils.open_from` / `get_loaded_templates`, base64 blob detection |
| `src/plain/stdlib.ts` | nothing - turri's own: `stdlib/` is a reserved import prefix, read from turri's standard library only, and a project module at such a path is an error (see [the standard library](authoring-plain.md#the-standard-library)) |

## Checking a spec

```bash
turri validate <file.plain>        # one spec
turri validate .                   # every .plain file in a directory
turri validate <file.plain> --json
```

It uses this repo's own parser, so it needs no external tool, no API key and no credits: it parses
the file, resolves its imports and required modules, and reports every syntax, concept and
structure error with the line it is on.

```
PASS  d365_export.plain  6 functionalities (1, 2, 3, 4, 5, 6), requires d365_restore_api

FAIL  broken.plain  PlainSyntaxError
        Plain syntax error: Syntax error at line 3: Invalid specification heading
        (`Nope:`). Allowed headings: definitions, implementation reqs, test reqs, ...
```

The exit code is 0 only when every file passed. In a conversation the same check is `validate`.

## Two rules of inheritance

- A module that **`requires`** another inherits its functional specs, transitively: it is built on
  top of that module's code.
- A module that **`import`s** another inherits its definitions, implementation reqs and test reqs.

## The functional-spec iterator

`getFrids` walks functionalities depth-first through nested sections; `getSpecificationsForFrid`
builds what a single functionality is rendered with. `iterateFunctionalSpecs` pairs them:

```ts
import { plainFileParser, iterateFunctionalSpecs } from "./src/plain/index.ts";

const [moduleName, tree] = plainFileParser("my_app.plain", ["."]);

for (const { frid, specifications, codeVariables } of iterateFunctionalSpecs(tree)) {
  // definitions and reqs in scope from the outside in, every functionality up to and
  // including this one, and only this one's acceptance tests
  console.log(frid, specifications["functional specs"].length);
}
```

## Parsing once

A module's parse reads its imports and the whole of its `requires` chain, so a long chain asks for the same
files over and over: bringing an 18-module chain up to its spec parsed for minutes. Two caches keep it to once.
Inside `withParseCache`, one question about the specs, each file is parsed once. Between calls, a parse is kept
with a fingerprint of every file directly in its template folders and the current one - name, size,
modification time, and a `.plain` file's text - and handed out again, as a copy, while the fingerprint is the
same; a spec that does not parse is kept as that too. What a parse returns is unchanged: the cache only decides
whether to parse again.

## Fidelity

The port is checked against the Python implementation directly, not only against the ported
assertions. Both parsers are run over a corpus and their module name, marshalled tree, required
modules, functionality ids and per-functionality specifications compared:

| corpus | files | identical | differences |
|---|---|---|---|
| `tests/data/` fixtures | 84 | 80 | 4 error strings (below) |
| `hycu-dynamics-365-modules` | 47 | 47 | none |

The 4 differences are all the same thing: template partials (`implement.plain`,
`implement_2.plain`, `header.plain`, `pr_implement.plain`) are meant to be included with
arguments, not parsed alone. Both implementations reject them for the same reason - an undefined
Liquid variable - but the message text comes from the template engine, and liquidjs phrases it
differently from liquid2.

Real specs exposed three places where mdast and mistletoe disagree, each covered by
`tests/plain/renderer.test.ts`:

- **Inline decoding.** mdast resolves `\"` to `"` and forgets whether emphasis was written with `_`
  or `*`; mistletoe round-trips the source. Inline leaf nodes are pinned back to their original
  source slice at parse time.
- **List geometry.** mistletoe indents an item's continuation lines by its `prepend`, measured in
  coordinates with the enclosing item's indentation stripped - not by the column gap between parent
  and child. An acceptance test rendered detached from its functionality keeps 6 and 10 spaces where
  the naive reading gives 4 and 8.
- **Lazy continuation lines.** A paragraph's continuation lines carry leading whitespace that is not
  part of the text; keeping it in the raw slice indents the line twice.

Two deliberate differences from the Python source:

- The `test_plainfile.py` tests drive the acceptance-test helpers with `MagicMock` tokens and patch
  the inner helper to count calls. ESM has no equivalent, so those tests build real ASTs from
  markdown and assert the same observable outcome.
- `networkx`'s `topological_sort` is reimplemented rather than replaced with a generic one: it
  flattens `topological_generations`, so the ordering of independent concepts follows graph
  insertion order, and the Python tests assert that exact sequence.
