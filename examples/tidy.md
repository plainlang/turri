# A command-line tool: tidy

You will build **tidy**, a command-line tool that sorts a messy folder (your Downloads, say) into subfolders by kind
of file. It runs as a dry run first, shows what it would move, and moves nothing until you say so.

This is the quick way in: `spawn` asks only what you want to build and writes the rest itself. It takes half an
hour or so, most of it the agents' time.

## 1. The project

**tidy** is Go with Cobra, so it builds into one binary. The machine needs [Go](https://go.dev/dl/) 1.22 or newer.

```bash
mkdir ~/tidy && cd ~/tidy
turri init-config
turri
```

## 2. Say what you want

> Let's quickly build tidy - a command-line tool in Go with Cobra that sorts the files of a folder into subfolders
> by kind: images, documents, archives, audio, video, code and other. `tidy plan <folder>` prints what it would
> move, one line a file, and moves nothing. `tidy apply <folder>` moves them, never overwriting a file: a name
> that is taken gets ` (2)`, ` (3)` and so on. Hidden files and subfolders are left alone. `--by-date` sorts into
> `YYYY/MM` folders by modified time instead. I'd like conformance tests too.

Asking to build it quickly starts `spawn` rather than the full interview, `brood`. `spawn` reads the brief back to
you in five lines. Confirm it, and it chooses the rest:

- **The stack.** `stdlib/cli/go-cobra`, from the standard library. It settles what every CLI has to decide - flags
  falling back to `TIDY_<SETTING>` environment variables, `Error: <message>` on standard error, exit codes `0`, `1`,
  `2` and `130`, logs only on standard error, `--help` and `--version` - so the spec need not say any of it.
- **The unit testing script**, `run_unittests_go.sh`.
- **The conformance tests**, because you asked for them. `spawn` leaves them off otherwise. For a CLI they are
  black-box: they build the binary, run it on a temporary folder and check what it printed and what it moved.
  The stack's conformance template, `stdlib/cli/conformance/go-cobra`, sets out how.
- **The product**, feature by feature: what counts as each kind, `plan`, `apply`, names that clash, `--by-date`.
  Each feature is a spec change that starts growing as soon as it is written.

Open `tidy.plain` while it writes. A functional spec reads like this:

```plain
- `tidy apply <folder>` moves each file of :Folder: into the subfolder of its :Kind:, creating the subfolder when it is not there.
  - A file whose name is taken in its subfolder is moved as `<name> (2)<ext>`, or the first such name that is free.
  - It prints one line a file moved, `<from> -> <to>`, and a last line counting them.
```

## 3. Watch it grow

The panel above the input shows the pulse that is growing: a few functional specs, grown by a coding agent until
their unit tests pass and a reviewer is satisfied. `ctrl+h` opens regen, where each functionality has
two marks:

```
  ✓ ◆ │ - `tidy plan <folder>` prints one line a file it would move, `<from> -> <to>`, …
  ✓ 5 │ - `tidy apply <folder>` moves each file of :Folder: into the subfolder of its :Kind:, …
  ⠋   │ - `--by-date` sorts into `YYYY/MM` folders by each file's modified time, …
```

The first mark is the code: `✓` built, a spinner growing, a number the pulse planned to grow it. The second is
the conformance tests: `◆` once they pass, a number for the conformance pulse planned to write them. The
conformance pulses run once the code they test is built.

## 4. Try it

> Release it.

**turri** puts the code as last built in `dist/tidy`, builds it there, and gives you a few commands to paste, run from
`dist/tidy`, with what they print. Try it on a copy of a folder first:

```bash
cp -r ~/Downloads /tmp/downloads-copy
./tidy plan /tmp/downloads-copy
./tidy apply /tmp/downloads-copy
```

## 5. Change your mind

> Files bigger than 1 GB should go to a `large` folder, whatever their kind.

**turri** adds it to the spec and grows just that. The pulse that grows it may change code that `apply` and `plan`
already use. The unit tests and the conformance tests already written run again, so you know nothing that worked
before is broken.

## Where next

- [shorty](shorty.md), a backend service - conformance tests from the start, and `bind`.
- [The standard library](../docs/authoring-plain.md#the-standard-library) - the other CLI stacks: Python with Typer
  or Click, Rust with clap, TypeScript with Commander, Java with picocli.
