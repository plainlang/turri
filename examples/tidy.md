# A command-line tool: tidy

You will build **tidy**, a command-line tool that sorts a messy folder (your Downloads, say) into subfolders by kind
of file. It runs as a dry run first, shows what it would move, and moves nothing until you say so.

This is the short way through the interview, `brood`: you keep the questions light, and **turri** decides the rest
itself. It takes half an hour or so, most of it the agents' time.

## 1. The project

Build it in whatever language you like - Python, TypeScript, Go, Rust or Java. The agents use the toolchains on your
machine and install none, so turri offers only the stacks your machine can build; `turri doctor` lists what is there.

```bash
mkdir ~/tidy && cd ~/tidy
turri init-config
turri
```

## 2. Say what you want

> Let's build tidy - a command-line tool that sorts the files of a folder into subfolders by kind: images, documents, archives, audio, video, code and other. `tidy plan <folder>` prints what it would
> move, one line a file, and moves nothing. `tidy apply <folder>` moves them, never overwriting a file: a name
> that is taken gets ` (2)`, ` (3)` and so on. Hidden files and subfolders are left alone. `--by-date` sorts into
> `YYYY/MM` folders by modified time instead.

**turri** starts `brood`, the interview. Its first question is how many questions you want to answer:

- **How many questions.** Light, medium or thorough - at most 3, 5 or 10 questions in each of the stack and product
  phases - or best judgement, where **turri** asks as much as it judges a phase needs. Fewer questions are broader
  ones, so every level covers the same ground. Choose **light**: your first message already says most of it.
  Whatever the questions leave open, **turri** decides itself, says in one line what it chose, and names it in the
  phase's summary, so you can change it when you confirm.

Then the phases, one question at a time:

- **Intent.** Its five questions - mostly confirming what you already said - and the brief, read back to you.
- **Stack.** The standard library's command-line stacks your machine can build - Python with Typer or Click,
  TypeScript with Commander, Go with Cobra, Rust with clap, Java with picocli. Whichever you choose, its template,
  `stdlib/cli/<stack>`, settles what every CLI has to decide - flags falling back to `TIDY_<SETTING>` environment
  variables, `Error: <message>` on standard error, exit codes `0`, `1`, `2` and `130`, logs only on standard error,
  `--help` and `--version` - so the spec need not say any of it. It writes `tidy.plain` and the unit testing script,
  `run_unittests_<language>.sh`, and reads the stack back.
- **Testing.** Whether there are conformance tests. Say **yes**. For a CLI they are black-box: they run the tool on
  a temporary folder and check what it printed and what it moved. The stack's conformance template,
  `stdlib/cli/conformance/<stack>`, sets out how, and the conformance testing script is written from it.
- **Product.** Three broad questions at most - the features and their order, say, with what fits your message
  proposed for you to confirm or correct. Each answer becomes spec changes that start growing as soon as they are
  written, before the next question. What the answers leave open - the details of `plan`, `apply`, names that clash,
  `--by-date` - **turri** decides and writes itself, a spec change for each.

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
`dist/tidy`, with what they print - how you run it depends on the stack. Try it on a copy of a folder first:

```bash
cp -r ~/Downloads /tmp/downloads-copy
tidy plan /tmp/downloads-copy     # as the commands it gave you run it
tidy apply /tmp/downloads-copy
```

## 5. Change your mind

> Files bigger than 1 GB should go to a `large` folder, whatever their kind.

**turri** adds it to the spec and grows just that. The pulse that grows it may change code that `apply` and `plan`
already use. The unit tests and the conformance tests already written run again, so you know nothing that worked
before is broken.

## Where next

- [shorty](shorty.md), a backend service - conformance tests from the start, and `bind`.
- [The standard library](../docs/authoring-plain.md#the-standard-library) - every stack, and what each settles.
