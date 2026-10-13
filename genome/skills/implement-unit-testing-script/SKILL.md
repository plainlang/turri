---
name: implement-unit-testing-script
description: >-
  Implement a unit-test runner script (Bash, which turri runs; a PowerShell copy on request, for
  Windows) for an arbitrary programming language, following the same conceptual
  pattern as the bundled Java reference script in assets/. The script runs the
  code's static checks - formatter in check mode, linter, type checker - with
  its unit tests, and both count. Use when the user
  wants to add a testing script for a new language (Python, Node.js, Go, Rust,
  etc.) to a ***plain project, or wants to regenerate / adapt the existing
  Java runner.
allowed-tools: [read, write, edit, bash, ls, grep, find]
---

# Implement Unit Testing Script

This skill produces a single executable script that runs the static checks and the unit tests for a generated build folder, following a consistent, language-agnostic pattern.

The reference implementation is [assets/run_unittests_java.sh](assets/run_unittests_java.sh). Read it first — every script you produce must be a faithful translation of that pattern into the target language's tooling **and** the user's shell environment. There are also Windows PowerShell equivalents of these scripts in [assets/run_unittests_*.ps1](assets/run_unittests_*.ps1).

## Always Bash

turri requires this script and runs it itself, as `bash run_unittests_<lang>.sh <build_folder>` on the person's machine - macOS, Linux or WSL: its exit code decides whether a functionality's unit tests pass. So the script is always **Bash (`.sh`)**, and stays portable across them - POSIX tools and flags, nothing only one of them has.

A **PowerShell (`.ps1`)** copy is written only when the user asks for one, to run the tests by hand on native Windows. turri never runs it, so a project with only a `.ps1` has no unit testing script.

The same eight-step pattern applies to both. Only the syntax changes.

## The Pattern

Every testing script must implement these steps **in this order**:

1. **Toolchain check.** Verify that the required language runtime / build tool (and the required version, if any) is installed. If not, print an error and exit with code `69`.
2. **Argument validation.** Require exactly one positional argument: the source build folder. If missing, print usage and exit with code `1`. The renderer passes this argument as an **absolute path** (older renderer versions passed a relative one) — the script must work with both, which is why the working-folder name in step 3 is built from the argument's *basename*, never from the raw argument.
3. **Working directory setup.** Define a working folder in the **system temp directory**: `/tmp/<lang>_$(basename "$1")` in Bash, `Join-Path ([System.IO.Path]::GetTempPath()) "<lang>_$(Split-Path $BuildFolder -Leaf)"` in PowerShell (written as `<temp>/<lang>_<basename>` below). If it exists, wipe its contents; otherwise create it. Register cleanup so the folder is removed when the script exits — `trap 'rm -rf "$WORKING_FOLDER"' EXIT` in Bash, a `Remove-Item -Recurse -Force` in the `finally` block in PowerShell. This folder — and **only** this folder — is where every subsequent write must land.
4. **Copy the build.** Recursively copy everything from the source folder into the working folder. After this step the source folder (`$1`) is treated as **read-only** for the rest of the script.
5. **Enter the working directory.** `cd` / `Set-Location` into `<temp>/<lang>_<basename>`. If that fails, exit with code `2`. All remaining steps run from inside the working folder; they must never write back to the source build folder.
6. **Install dependencies into an isolated environment inside `<temp>/<lang>_<basename>`.** Set up a per-working-folder dependency location (a Python venv at `./.venv`, a local `./node_modules`, a project-scoped Maven repo at `./.m2`, etc.) and install/resolve all dependencies into it. **Never** install into the source build folder, the user's global cache (`~/.m2`, system-wide `pip`, `~/.cargo`, `~/.npm`, ...), or anywhere outside `<temp>/<lang>_<basename>`. If the install command fails, propagate its exit code immediately and **do not** proceed to step 7. See [Dependency isolation](#dependency-isolation) for per-language specifics.
7. **Run the static checks.** The formatter in check mode, the linter, and the type checker where the language has one apart from its compiler - see [Static checks](#static-checks) - on the staged copy, with the tools installed in step 6. Run **every** check, even after one fails, and print each one's whole output. Remember whether any failed; do not exit yet.
8. **Run the tests.** Invoke the language's standard test command (e.g. `mvn test`, `pytest`, `npm test`, `go test ./...`, `cargo test`), pointed at the same isolated environment from step 6 - whatever the checks in step 7 said, so one run reports both. Then exit: the test command's own non-zero code when the tests failed; else `80` when only the static checks failed; else `0`.

### The build folder is read-only — hard rule

The source build folder passed in as `$1` is **input only**. The script must never:

- install dependencies into it (no `pip install` inside `$1`, no `npm install` inside `$1`, no `mvn install` writing into `$1`, no Cargo build artifacts ending up under `$1`),
- write a virtualenv / `node_modules` / `.m2` / `.gocache` / `.cargo` directory inside it,
- run the test command from inside it (every test command runs from inside `<temp>/<lang>_<basename>` after the `cd` in step 5),
- create logs, caches, build outputs, or temp files inside it.

The build folder is shared with the renderer (`plain_modules/<module>/code` by default) and downstream tooling. Writing into it corrupts the renderer's view of "what was generated" and breaks subsequent renders. Every write must go into `<temp>/<lang>_<basename>` — the whole point of staging into the system temp directory is so the source build folder stays a clean, reproducible artifact of the render and no build debris is left inside the user's project.

If you find yourself about to issue any command whose `cwd` is the source folder, or whose target path starts with `$1/`, **stop**. Either move the operation into `<temp>/<lang>_<basename>`, or you're doing something the script must not do.

## Conventions

Shared across both shell flavors:

- **Exit codes:**
  - `1` — bad usage (missing argument).
  - `2` — filesystem problem (couldn't enter the working folder).
  - `69` — required toolchain / runtime is not installed - a static checker the person installs on the machine (not the project) included.
  - `80` — the tests passed and only the static checks failed. turri tells the coding agent so, and says it was the static checks when the work stops there.
  - Any other non-zero code — propagated from the underlying test command.
- **Working folder naming:** `<temp>/<lang>_<basename>` — the system temp directory (`/tmp` in Bash, `[System.IO.Path]::GetTempPath()` in PowerShell) plus a short identifier for the language (`java`, `python`, `node`, `go`, `rust`, ...) and the **basename** of the build-folder argument (`$(basename "$1")` / `Split-Path $BuildFolder -Leaf`). Never embed the raw argument in the path — it may be absolute, and concatenating it produces broken doubled paths. All dependency installs, build outputs, caches, and the test run itself live inside this folder. Nothing the script does should touch the source build folder after step 4.
- **Cleanup on exit:** the working folder is temporary — remove it when the script exits, on success and failure alike (`trap 'rm -rf "$WORKING_FOLDER"' EXIT` in Bash; `Remove-Item -Recurse -Force` in the PowerShell `finally` block, after `Pop-Location`). No leftover build folders may accumulate in the temp directory or the user's project.
- **Logging — be as verbose as possible.** The script is the only thing the operator sees between a `turri` render and a green/red test result; when it fails, the only forensic evidence anyone has is its stdout/stderr. Treat the script like a production runbook, not a quiet helper. Concretely:
  - **Announce every step before doing it**, with the exact value of every variable involved — the resolved source folder, the working folder, the language, the toolchain version detected, the isolation root, the dependency-manifest path, the test command about to run. "Installing dependencies" alone is useless; "Installing dependencies from `./requirements.txt` into venv `./.venv` (Python 3.11.6 at `/usr/local/bin/python3`)" is triage-ready.
  - **Echo every non-trivial command before executing it.** In Bash, use `set -x` for the body of the script (or `echo "+ <cmd>"` immediately before each call); in PowerShell, set `$VerbosePreference = 'Continue'` and use `Write-Verbose` / `Write-Host` to print each command line with its arguments.
  - **Print clear section banners.** Each of the eight steps gets a banner like `===== [3/8] Working directory setup =====` so a long log can be navigated by eye.
  - **Print resolved absolute paths**, not just the relative names. Operators reading the log on a different machine need to know where things actually landed.
  - **Print the toolchain's own `--version` output** (and the path it resolved from) during step 1, even on success. This is the single most useful piece of forensic data when a test passes locally but fails in CI.
  - **Surface the install command's output verbatim** — do not pipe it to `/dev/null`, do not redirect to a log file inside the working folder. The operator must see every dependency-resolver line in the script's own output stream.
  - **On failure, print what was about to run before exiting** — the exact command, the working directory, the relevant environment variables (`PYTHONPATH`, `NODE_PATH`, `GOMODCACHE`, `CARGO_HOME`, `MAVEN_OPTS`, `PATH`).
  - **Print a final summary line** that names the test command, the exit code, and the working folder so the operator knows exactly what to re-run by hand if needed.
  Verbosity is not noise here — a chatty script that documents itself in its own output is the difference between a 30-second triage and a 30-minute one. Never trade verbosity for terseness.

### Dependency isolation

The dependency environment must live **inside** `$WORKING_FOLDER` so the test run can't be polluted by — or pollute — the user's global caches. Pick the most idiomatic isolation mechanism for the language:

| Language | Isolation mechanism | Install command (run inside `$WORKING_FOLDER`) | Test command |
|---|---|---|---|
| Python | `venv` at `./.venv` | `python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt` (or `pyproject.toml` / `uv sync` / `poetry install`) | `./.venv/bin/pytest` (or `./.venv/bin/python -m pytest`) |
| Node.js | local `./node_modules` (default) | `npm ci` (preferred) or `npm install` | `npm test` |
| Java | project-scoped Maven repo at `./.m2` | `mvn -Dmaven.repo.local=./.m2 dependency:resolve` (optional pre-warm) | `mvn -Dmaven.repo.local=./.m2 test` |
| Go | module cache at `./.gocache` | `GOMODCACHE="$PWD/.gocache" go mod download` (optional pre-warm) | `GOMODCACHE="$PWD/.gocache" go test ./...` |
| Rust | cargo home at `./.cargo` | `CARGO_HOME="$PWD/.cargo" cargo fetch` (optional pre-warm) | `CARGO_HOME="$PWD/.cargo" cargo test` |

Notes:

- **Every path in the install command and test command is relative to `<temp>/<lang>_<basename>`.** That's why the script `cd`s into the working folder in step 5 — from that point on, `./.venv`, `./node_modules`, `./.m2`, etc. all resolve under `<temp>/<lang>_<basename>`, never under the source build folder.
- **Always pass the isolation flag/env var to both the install command and the test command** — they must agree on where deps live, otherwise the test command will silently fall back to the global cache **or** (worse) the source build folder.
- **Python is the only ecosystem where the venv is mandatory** to satisfy "into a virtual environment" literally. The others use language-native equivalents that achieve the same isolation.
- **Pre-warming is optional for Java/Go/Rust** — their test commands will fetch deps on demand. Doing it as a separate step makes failures easier to diagnose and gives a clean "install failed vs test failed" signal.
- **Don't activate the venv** in Bash via `source .venv/bin/activate` — call `./.venv/bin/<tool>` directly. It's more portable and avoids subshell weirdness. In PowerShell, use `& .\.venv\Scripts\<tool>.exe` similarly.
- **Propagate the install exit code immediately.** In Bash: `<install cmd> || exit $?`. In PowerShell: check `$LASTEXITCODE` and `exit $LASTEXITCODE` if non-zero.

### Static checks

The checks hold the code to what the language's template - or the implementation reqs - asks of it: its formatter, its linter, its type checker. They run in step 7, on the staged copy, and count as the tests do. turri runs nothing else: there is no separate static checks script, and no fix mode - the coding agent runs the formatter itself, in its own shell, before its final run.

| Language | Formatter, in check mode | Linter | Type checker | Where the tools come from |
|---|---|---|---|---|
| Python | `ruff format --check --output-format concise .` | `ruff check --output-format concise --no-fix .` | `mypy --no-color-output --show-column-numbers` - on `files` in `[tool.mypy]`, else `.` | the project's `dev` dependency group, installed with uv in step 6 |
| TypeScript | `prettier --list-different --ignore-unknown .` | `eslint --max-warnings 0 .` | `tsc --noEmit --pretty false` (`vue-tsc` when installed; `--build` for a `tsconfig.json` made of project references) | `devDependencies`, installed with npm in step 6 |
| JavaScript | `prettier --list-different --ignore-unknown .` | `eslint --max-warnings 0 .` | none - unless the implementation reqs name one (`tsc --noEmit --allowJs --checkJs`) | `devDependencies` |
| Go | `gofmt -l .` - any file listed is a finding | `go vet ./...` | the compiler, in `go vet` and `go test` | the Go toolchain |
| Rust | `cargo fmt --all --check` | `cargo clippy --all-targets --message-format short -- -D warnings` | the compiler, in clippy and `cargo test` | rustup components `rustfmt` and `clippy` - missing: exit `69` |
| Java | only one the implementation reqs name (`mvn spotless:check`, a `google-java-format --dry-run --set-exit-if-changed`) | `javac -Xlint:all -Werror`, passed through the build tool (`-Dmaven.compiler.showWarnings=true -Dmaven.compiler.failOnWarning=true`, Gradle's `options.compilerArgs`) | the compiler | the build tool's plugins |
| Dart / Flutter | `dart format --output=none --set-exit-if-changed .` | `dart analyze --fatal-infos` (`flutter analyze` for Flutter) | the analyzer, in the same command | the Dart / Flutter SDK |

Notes:

- **The checks' tools are the project's**, where the language keeps tools per project: ruff and mypy in Python's `dev` group, Prettier, ESLint and TypeScript in `devDependencies`. A tool the manifest lacks is a finding - print `pyproject.toml:1:1: ruff is not in the dev dependency group - add it`, count the checks as failed - never exit `69`: the manifest is the code's, for the agent to fix. Only a tool installed on the machine (the toolchain, a rustup component) missing is `69`.
- **Pin the flags in the script.** What fails the check is decided here - `-D warnings`, `--max-warnings 0`, `--fatal-infos` - not by a configuration file in the code that the agent could relax. The tools still read the project's own configuration for everything else (ruff's line length, mypy's `files`, ESLint's rules).
- **One line a finding where the tool allows it** - the concise or short output formats above, `--pretty false` - so the agent reads `src/app.py:12:5: F401 ...`, not a page of diffs.
- **Only what the language and its template ask for.** No checks the implementation reqs do not name beyond the table; a language not in it gets the ones its implementation reqs name, and none otherwise.

### Bash specifics

- **Shebang:** `#!/bin/bash`.
- **File naming:** `run_unittests_<lang>.sh`, placed in `assets/` (skill reference) or `test_scripts/` (target project).
- **Argument:** `$1`.
- **Make it executable:** `chmod +x test_scripts/run_unittests_<lang>.sh`.

### PowerShell specifics

- **No shebang.** Use a `param([Parameter(Mandatory=$true)][string]$Subfolder)` block at the top instead.
- **File naming:** `run_unittests_<lang>.ps1`, placed next to the `.sh` script.
- **Exit codes:** use `exit 69` etc. (PowerShell honors them just like Bash).
- **Toolchain check:** prefer `Get-Command <tool> -ErrorAction SilentlyContinue` and, where a specific version is needed, parse the tool's `--version` output.
- **Filesystem:** use `Test-Path`, `Remove-Item -Recurse -Force`, `New-Item -ItemType Directory`, `Copy-Item -Recurse`, `Set-Location`. Quote paths to handle spaces.
- **No `chmod` step needed.** If execution policy is likely to block the script, mention `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` to the user — don't bake it into the script.

## Workflow

1. Confirm the target **language**, **shell flavor** (Bash or PowerShell), and **dependency manifest** (`pom.xml`, `requirements.txt` / `pyproject.toml`, `package.json`, `go.mod`, `Cargo.toml`, ...). Ask if any is unclear.
2. Read [assets/run_unittests_java.sh](assets/run_unittests_java.sh) to refresh the exact structure.
3. Translate each of the eight steps above into the equivalent commands for the target language **and** shell. The toolchain check, dependency install, static checks and test invocation are the language-specific parts; the rest is mechanical translation between Bash and PowerShell syntax.
4. Pick the dependency-isolation mechanism from the [Dependency isolation](#dependency-isolation) table and use it consistently in steps 6, 7 and 8, and the checks from the [Static checks](#static-checks) table.
5. Save the new script as `test_scripts/run_unittests_<lang>.sh` (a `.ps1` copy next to it only if the user wants to run it by hand on Windows). For Bash, `chmod +x` it.
6. **Make sure turri finds the script.** Do not link it from the specs - turri finds the unit testing script in the project root (the folder that holds `plain_modules/`) and puts it, whole, into the prompt of the coding agent itself; a link to it from a spec is ignored. It looks, in order, at `config.turri.yaml` in the root (`unittests-script: <path relative to the root>`) - with the chosen stack's `config.turri.<stack>.yaml` over it, then for the one `run_unittests*.sh` in the root, then for the one in `test_scripts/`. Saving the script in `test_scripts/` (or the root) is enough when it is the only one there. If the project keeps it elsewhere, name it in `config.turri.yaml` as `unittests-script:` - and when the project has only a `config.yaml`, copy it to `config.turri.yaml` first (and each `config.<name>.yaml` to `config.turri.<name>.yaml`) and edit the copy; `config.yaml` may be another tool's, and is never written. If the project has modules on different stacks - e.g. a Python backend and a React frontend side by side, sharing only an imported module - each part is on a stack of its own, and each stack names its own script in its own file beside `config.turri.yaml`: `unittests-script:` in `config.turri.backend.yaml` for the stack `backend`, in `config.turri.frontend.yaml` for the stack `frontend`. A stack is chosen, never worked out: tell the user to choose it with `/stack <stack>` (`--stack <stack>` on the command line) before building that part. turri never guesses between two. The script is required: a build without one stops before it starts.

## Anti-Patterns

- **(Hard mistake) Don't install into, build into, or otherwise write to the source build folder.** The build folder passed as `$1` is read-only input. Every install, cache, build artifact, log, and temp file must land in `<temp>/<lang>_<basename>`. This includes never running `pip install`, `npm install`, `mvn install`, or `cargo build` with the source folder as their `cwd` or target, never letting a venv / `node_modules` / `.m2` / `.gocache` / `.cargo` directory appear inside the source folder, and never running the test command from inside it. The whole point of staging the build into the system temp directory is so the source folder remains a clean, reproducible artifact of the render — writing to it corrupts the renderer's view and breaks subsequent renders.
- **(Hard mistake) Don't build any path by concatenating the raw build-folder argument.** `$1` arrives as an absolute path from current renderers. Patterns like `WORKING_FOLDER=.tmp/$1`, `WORKING_FOLDER=<lang>_$1`, or `"$current_dir/$1"` silently produce doubled paths (`/project//abs/path/...`) — the classic symptom is an `ImportError: Start directory is not importable` or "folder does not exist" pointing at a path that contains the project root twice. Always take `$(basename "$1")` / `Split-Path -Leaf`.
- Don't skip the toolchain check, even when "everyone has it installed" — exit code `69` is what the calling system relies on to detect a missing runtime.
- Don't reuse the source folder in place. Always copy into `<temp>/<lang>_<basename>` first; the renderer relies on this isolation.
- Don't leave the working folder behind. Register the cleanup (`trap … EXIT` / `finally`) before the first write so even an early failure removes it.
- Don't change the exit-code contract. Other parts of the system branch on `1`, `2`, `69` and `80` specifically — and these codes must be identical between the Bash and PowerShell variants.
- Don't stop at the first failing check, and don't skip the tests because a check failed. Every check and the tests run each time, so one run tells the agent everything; the exit code says which failed.
- Don't exit `80` when the tests failed. `80` means the tests passed and only the checks did not; failing tests keep their own exit code, the checks' findings printed above them.
- Don't format or fix anything. The checks run in check mode on the staged copy; the formatter is the coding agent's to run.
- Don't write a cross-shell hybrid (e.g. a `.sh` that detects PowerShell, or vice versa). Ship one script per shell, named with the appropriate extension.
- Don't install dependencies into the user's global location (`~/.m2`, system-wide `pip`, `~/.cargo`, etc.). Always isolate inside `$WORKING_FOLDER` so concurrent runs and other projects can't interfere.
- Don't run the test command without first verifying the install step succeeded. A failed install followed by a "test" run produces misleading errors that look like test failures.
- **Don't link the script from the specs, and don't leave turri guessing.** turri finds the script in `config.turri.yaml`, the project root, or `test_scripts/`, and shows it to the coding agent itself; a link to it from a spec is ignored. Put it where it is found, and when there are two unit testing scripts in one folder, name the one to use as `unittests-script:` - in each stack's `config.turri.<stack>.yaml` when they are for parts on different stacks (see Workflow step 6).
- **Don't write a terse script.** Silent steps, `>/dev/null` redirects on the install output, missing `--version` prints, and absent failure banners all make the script harder to debug than the code it is testing. Follow the *Logging — be as verbose as possible* rule under [Conventions](#conventions) literally: every step announces itself, every command is echoed, every failure prints what was about to run and where.
