---
name: implement-static-checks-script
description: >-
  Implement the static checks script of a ***plain project - its formatter, linter and type checker - which turri runs
  with the unit testing script, both to pass, and in a fix mode that formats the code before each run. Ready-made
  scripts for the standard library's Python, TypeScript, Go and Rust are in assets/; for another stack, one is written
  for the tools its implementation reqs name. Use when a stack is settled, or the user wants the code type checked,
  linted or formatted by turri.
allowed-tools: [read, write, edit, bash, ls, grep, find]
---

# Implement Static Checks Script

This skill produces `test_scripts/run_static_checks_<language>.sh`: the project's formatter, linter and type checker,
run by turri on every build of the code.

## What turri does with it

turri finds it - `static-checks-script:` in `config.turri.yaml` (or the stack's `config.turri.<stack>.yaml`), else the
one `run_static_checks*.sh` in the project root, else the one in `test_scripts/` - and runs it two ways:

- **`run_static_checks_<language>.sh <build folder> --fix`** before every run of the unit testing script: it applies the
  formatter and the linter's safe fixes to the build folder, so every commit comes out formatted and no agent spends a
  turn on formatting. turri hands it a fresh copy of the code and writes back only what it changed in files the code
  already has. A fix mode that fails is skipped; a script without one changes nothing.
- **`run_static_checks_<language>.sh <build folder>`** beside the unit testing script, every time it runs: the formatter
  in check mode, the linter and the type checker. It counts as the unit tests do - the coding agent's work is done only
  when both pass, within the same rounds - and the agent is shown its findings: the lines that name a file and a line.

It is optional. A project without one is built as before, on its unit tests alone. It is not linked from the specs.

## For a standard library language: copy the asset

A stack on `stdlib/lang/python`, `typescript`, `go` or `rust` - a standard library stack imports one - gets the asset
for its language, copied unchanged into `test_scripts/` and made executable:

| Language | Asset | Checks | Fix mode |
| --- | --- | --- | --- |
| Python | [assets/run_static_checks_python.sh](assets/run_static_checks_python.sh) | `ruff format --check`, `ruff check`, `mypy` - from the `dev` dependency group, with uv | `ruff format`, `ruff check --fix` |
| TypeScript | [assets/run_static_checks_typescript.sh](assets/run_static_checks_typescript.sh) | `prettier --list-different`, `eslint --max-warnings 0`, `tsc --noEmit` (`vue-tsc` when installed; `--build` for a tsconfig of project references) - from devDependencies, with npm | `eslint --fix`, `prettier --write` |
| Go | [assets/run_static_checks_go.sh](assets/run_static_checks_go.sh) | `gofmt -l`, `go vet ./...` | `gofmt -w` |
| Rust | [assets/run_static_checks_rust.sh](assets/run_static_checks_rust.sh) | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` | `cargo fmt` |

They hold the code to what the language template already requires: ruff and mypy for Python, Prettier and ESLint for
TypeScript, gofmt and `go vet` for Go, rustfmt and clippy for Rust. Java's template names no formatter or linter, so a
Java stack has no static checks script unless its implementation reqs name the tools.

## For another stack: write one

When the implementation reqs name a formatter, a linter or a type checker - and only then - write a script for exactly
those tools, following the assets' pattern. With none named there is no script: do not invent checks the spec does not
ask for.

1. **Toolchain check.** The language's toolchain, and any tool the person installs on the machine (not the project):
   missing, print what to install and exit `69`.
2. **Arguments.** `<build folder>` required (exit `1` without it), and `--fix` as an optional second argument.
3. **Working folder.** `mktemp -d "/tmp/static_<language>_$(basename "$1").XXXXXX"`, removed on exit with a `trap`.
   Copy the build into it, leaving out installed dependencies and build output (`.venv`, `node_modules`, `target`).
   The `static_` prefix matters: turri reads paths under it as the build folder's, and it keeps the checks clear of the
   unit testing script's working folder when the two run side by side.
4. **Dependencies.** Install the project's dependencies in the working folder, from its manifest, so the tools are the
   versions the project pins - the same in the fix mode and the checks, or the formatter and its check disagree. A tool
   the manifest lacks is a finding (`pyproject.toml:1:1: ruff is not in the dev dependency group - add it`), exit `1` -
   never exit `69`: the manifest is the code's, for the agent to fix.
5. **Fix mode.** Run the formatter and the linter's safe fixes in the working folder, then copy back into the build
   folder every source file they changed that the build folder has - only the sources: never a lockfile, never a file
   the build folder does not have. Exit `0` once they are applied, whatever is left for the checks to find (`ruff check
   --fix --exit-zero`, `eslint --fix` with its exit ignored).
6. **Checks.** The formatter in check mode, the linter, the type checker - every one run, even after one fails. Each
   finding printed as **one line naming its file and its line**, relative to the build folder: `src/app.py:12:5: F401
   ...`, `src/app.ts(3,7): error TS2322 ...`. Use the tool's concise format (`--output-format concise`, `--pretty
   false`, `--message-format short`), turn a list of unformatted files into `file:1:1: not formatted - ... would
   reformat it`, and a JSON report into such lines. turri shows the agent these lines and little else.
7. **Exit.** `0` when every check passes, `1` otherwise.

Announce each step and echo each command, as `implement-unit-testing-script` asks of the unit testing script - but the
findings are what the agent reads, so keep them one line each.

## Where it goes

Save it as `test_scripts/run_static_checks_<language>.sh` beside the unit testing script, `chmod +x` it, and keep one
turri already finds rather than writing a second. A project whose parts are on different stacks names each stack's
script as `static-checks-script:` in that stack's `config.turri.<stack>.yaml`. When the project has only a
`config.yaml`, copy it to `config.turri.yaml` first and edit the copy; `config.yaml` may be another tool's.

Try it on a small build before finishing when the toolchain is on the machine: a file left unformatted, an unused
import and a type error should each come out as one line, and `--fix` should format the file in place.

## Anti-patterns

- Writing into the build folder in check mode, or anything but changed sources in fix mode.
- Exiting `69` for a tool the project's manifest should hold: that stops the pulse for the person to install something
  that is the code's to declare.
- A fix mode that runs other versions of the tools than the checks - a global `ruff` in one, the project's in the other.
- Printing the tools' long reports - diffs, code frames, summaries per file - in place of a line a finding.
- Checks the implementation reqs do not ask for.
