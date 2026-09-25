---
name: implement-conformance-testing-script
description: >-
  Implement a self-contained conformance-test runner script (Bash, run by the
  harness in a Linux VM; an optional PowerShell copy for running it by hand on
  Windows) for an arbitrary programming language. The script stages the build,
  installs its dependencies in isolation, and runs a module's whole conformance
  suite against it. Use when the user wants to add a conformance-test runner for
  a new language (Node.js, Go, Rust, Flutter, etc.) to a ***plain project, or
  wants to regenerate / adapt one of the existing runners.
---

# Implement Conformance Testing Script

This skill produces a single executable script that runs the **conformance tests** for a generated build folder, following a consistent, language-agnostic pattern.

The reference implementations are:

- [assets/run_conformance_tests_java.sh](assets/run_conformance_tests_java.sh) — Java.
- [assets/run_conformance_tests_python.sh](assets/run_conformance_tests_python.sh) — Python.
- [assets/run_conformance_tests_<lang>.ps1](assets/run_conformance_tests_*.ps1) — Windows PowerShell equivalents, for running the scripts by hand on Windows.

Read both `.sh` references before writing anything — every script you produce must be a faithful translation of the same pattern into the target language's tooling.

## How the harness uses the script

A module's conformance tests live in one folder, `plain_modules/<module>/tests` — the module's whole conformance suite: every functionality's tests, plus those carried up from the modules it requires. There are no per-functionality subfolders.

The harness (not the rendering agent) runs the script once per check, against the whole suite:

```
bash run_conformance_tests_<lang>.sh <build_folder> <conformance_tests_folder>
```

Both arguments are absolute paths: `<build_folder>` is the module's generated code (`plain_modules/<module>/code`), and `<conformance_tests_folder>` is the folder holding the whole suite. The harness runs the script in a Linux VM (Alpine), and its exit code alone decides whether the conformance tests pass.

Every conformance script is self-contained: toolchain check, argument validation, stage the build into `<temp>/<lang>_<basename of $1>`, install dependencies there in isolation, run the suite in `$2` against it, clean up on exit. Nothing is prepared ahead of time by another script.

## How conformance scripts differ from unit-test scripts

A conformance script is structurally very close to a unit-test script (see the sibling skill [`implement-unit-testing-script`](../implement-unit-testing-script/SKILL.md)) but with two important differences:

1. **Two positional arguments instead of one.** A conformance script takes both the **build folder** (source under test) and a **separate conformance tests folder** (the tests to execute against that build). Both arrive as **absolute paths** from current renderers (older renderer versions passed relative ones) — the script must work with both.
2. **Tests are loaded from outside the working folder.** The build is staged into the working folder `<temp>/<lang>_<basename>` (system temp directory + language id + basename of `$1` — see [Conventions](#conventions)) and the script `cd`s into it, but the test command is pointed at the conformance tests folder, resolved to an **absolute path** up front (`$CONFORMANCE_TESTS_FOLDER` below). Tests are never copied into the staging area.

Everything else — toolchain check, build staging, dependency isolation, exit codes — is the same.

## Pick the Shell

The harness runs only Bash (`.sh`) scripts, because it runs them in a Linux VM. Always write `run_conformance_tests_<lang>.sh`, and make it work on Alpine Linux as well as on macOS / Linux for people running it by hand.

A PowerShell (`.ps1`) copy is optional and only for people who run the script by hand on native Windows; the harness never runs it. Write one only if the user asks for it. The same pattern applies to both — only the syntax changes.

## The Pattern

1. **Toolchain check.** Verify that the required language runtime / build tool (and the required version, if any) is installed. If not, print an error and exit with code `69`.
2. **Argument validation.** Require **two** positional arguments: `<build_folder>` and `<conformance_tests_folder>`. If either is missing, print usage and exit with code `69`.
3. **Resolve the conformance tests folder to an absolute path.** Current renderers pass `$2` as an absolute path; older ones passed it relative to the invocation directory. Resolve it once, up front, into a variable the test command in step 8 uses:
   - Bash: `case "$2" in /*) CONFORMANCE_TESTS_FOLDER="$2" ;; *) CONFORMANCE_TESTS_FOLDER="$(pwd)/$2" ;; esac`
   - PowerShell: `if (-not [System.IO.Path]::IsPathRooted($ConformanceTestsFolder)) { $ConformanceTestsFolder = Join-Path (Get-Location) $ConformanceTestsFolder }`

   Never concatenate `$current_dir/$2` at the point of use — with an absolute `$2` that produces a doubled path (`/project//abs/path/...`), the classic symptom being `ImportError: Start directory is not importable` pointing at a path that contains the project root twice.
4. **Working directory setup.** Define a working folder at `<temp>/<lang>_<basename>` (`/tmp/<lang>_$(basename "$1")` in Bash, `Join-Path ([System.IO.Path]::GetTempPath()) "<lang>_$(Split-Path $BuildFolder -Leaf)"` in PowerShell). Wipe it (`rm -rf` / `Remove-Item -Recurse -Force`) and recreate it. Register cleanup so the folder is removed when the script exits — `trap 'rm -rf "$WORKING_FOLDER"' EXIT` in Bash, `Remove-Item -Recurse -Force` in the `finally` block in PowerShell. This folder — and **only** this folder — is where every subsequent write must land.
5. **Copy the build.** Recursively copy everything from `<build_folder>` (`$1`) into the working folder. **Do not** copy the conformance tests — they stay where they are. After this step both `$1` (build folder) and `$2` (conformance tests folder) are treated as **read-only** for the rest of the script.
6. **Enter the working directory.** `cd` / `Set-Location` into `<temp>/<lang>_<basename>`. If that fails, exit with code `69`. All remaining steps run from inside the working folder; they must never write back to `$1` or `$2`.
7. **Install dependencies into an isolated environment inside `<temp>/<lang>_<basename>`.** Set up a per-working-folder dependency location (a Python venv at `./.venv`, a local `./node_modules`, a project-scoped Maven repo at `./.m2`, etc.) and install/resolve all dependencies into it. **Never** install into the source build folder (`$1`), the conformance tests folder (`$2`), the user's global cache (`~/.m2`, system-wide `pip`, `~/.cargo`, `~/.npm`, ...), or anywhere outside `<temp>/<lang>_<basename>`. If the install command fails, propagate its exit code immediately and **do not** proceed to step 8. See [Dependency isolation](#dependency-isolation).
8. **Run the conformance tests.** Invoke the language's standard test command, **pointed at `$CONFORMANCE_TESTS_FOLDER`** (the absolute path resolved in step 3), so it runs the whole suite in one go. The script's final exit code is whatever the test command returns — except for the "no tests discovered" case below.

   The test command is **read-only** with respect to `$CONFORMANCE_TESTS_FOLDER`. It loads test files from there, but any artifacts the runner produces (caches, JUnit XML, coverage reports, compiled test classes, etc.) must land inside `<temp>/<lang>_<basename>`, not next to the test files. If your chosen runner defaults to writing output beside the tests, pass an explicit output-directory flag pointing inside the working folder (e.g. `pytest --basetemp=./.pytest_tmp`, `jest --cacheDirectory=./.jest_cache`, Maven `target/` under the working folder via `mvn -f "$CONFORMANCE_TESTS_FOLDER/pom.xml" -Dproject.build.directory="$(pwd)/target" test`).

### Read-only inputs — hard rule

A conformance script has **two** read-only inputs: the source build folder (`$1`) and the conformance tests folder (`$2`). Neither one may be written to under any circumstances. The script must never:

- install dependencies into `$1` or `$2` (no `pip install` inside `$1`/`$2`, no `npm install` inside them, no `mvn install` writing into them, no Cargo build artifacts ending up under them),
- write a virtualenv / `node_modules` / `.m2` / `.gocache` / `.cargo` directory inside `$1` or `$2`,
- run the test command with its `cwd` set to `$1` or `$2` (every test command runs from inside `<temp>/<lang>_<basename>` after the `cd` in step 6),
- create logs, caches, build outputs, JUnit XML, coverage reports, compiled test classes, or temp files inside `$1` or `$2`.

Why each input is read-only:

- **`$1` (build folder)** is shared with the renderer (`plain_modules/<module>/code` by default) and downstream tooling. Writing into it corrupts the renderer's view of "what was generated" and breaks subsequent renders. The whole point of staging into the system temp directory is so the source folder stays a clean, reproducible artifact of the render.
- **`$2` (conformance tests folder)** is the user's authored test source — typically checked into version control. Writing into it pollutes the working tree, churns git status, and (with frameworks that auto-discover) can make subsequent runs pick up generated files as if they were tests.

If you find yourself about to issue any command whose `cwd` is `$1` or `$2`, or whose target path starts with `$1/` or `$2/`, **stop**. Either move the operation into `<temp>/<lang>_<basename>`, or you're doing something the script must not do.

### "No tests discovered" detection

The Python reference script grep's the test runner output for `"Ran 0 tests in"` and exits `1` if no tests ran. Replicate the equivalent check for the target language wherever that language's test runner silently passes when given an empty test set:

- Python `unittest`: `"Ran 0 tests in"`
- Node.js `jest`: `"No tests found"`
- Go `go test`: `"no test files"` / `"no tests to run"`
- Rust `cargo test`: `"running 0 tests"`
- Java `mvn test`: usually fails loudly already; no extra check needed.

A silently-passing zero-test run is the most dangerous failure mode of a conformance runner — always guard against it.

## Conventions

Shared across both shell flavors:

- **Exit codes:**
  - `69` — unrecoverable invocation error: missing argument, missing toolchain, can't enter working folder, can't create venv. Matches the reference scripts' `UNRECOVERABLE_ERROR_EXIT_CODE`.
  - `1` — "no tests discovered" guard tripped (see above).
  - Any other non-zero code — propagated from the underlying test command.
- **Working folder naming:** `<temp>/<lang>_<basename>` — the system temp directory (`/tmp` in Bash, `[System.IO.Path]::GetTempPath()` in PowerShell) plus a short identifier for the language (`java`, `python`, `node`, `go`, `rust`, ...) and the **basename** of the *first* argument (the build folder — `$(basename "$1")` / `Split-Path $BuildFolder -Leaf`), never the conformance tests folder and never the raw argument (it may be absolute; concatenating it produces broken doubled paths). All dependency installs, build outputs, caches, test runner artifacts, and the test invocation itself live inside this folder. Nothing the script does should touch `$1` after step 5, or `$2` at any point.
- **Cleanup ownership:** the script owns its working folder and removes it on exit, success and failure alike (`trap 'rm -rf "$WORKING_FOLDER"' EXIT` in Bash; `Remove-Item -Recurse -Force` in the PowerShell `finally` block, after `Pop-Location`).
- **Logging — be as verbose as possible.** The script is the only thing the operator sees between a `plainwright` render and a green/red conformance result; when it fails, the only forensic evidence anyone has is its stdout/stderr. Treat the script like a production runbook, not a quiet helper. Concretely:
  - **Announce every step before doing it**, with the exact value of every variable involved — the resolved build folder, the resolved conformance-tests folder, the working folder, the language, the toolchain version detected, the isolation root being set up, and the test command about to run. "Running tests" alone is useless; "Running `python -m unittest discover -b -s /abs/path/to/tests` from working folder `/tmp/python_build/` with venv activated at `./.venv` (Python 3.11.6)" is triage-ready.
  - **Echo every non-trivial command before executing it.** In Bash, use `set -x` for the body of the script (or `echo "+ <cmd>"` immediately before each call); in PowerShell, set `$VerbosePreference = 'Continue'` and use `Write-Verbose` / `Write-Host` to print each command line with its arguments.
  - **Print clear section banners.** Each pattern step gets a banner like `===== [7/8] Install dependencies =====` so a long log can be navigated by eye.
  - **Print resolved absolute paths**, not just the relative names. Operators reading the log on a different machine need to know where the venv / `.m2` / `node_modules` / `.gocache` / `.cargo` actually landed, and what `$2` resolved to.
  - **Print the toolchain's own `--version` output** (and the path it resolved from) during step 1, even on success. This is the single most useful piece of forensic data when conformance passes locally but fails in the harness's VM.
  - **Surface the install output verbatim** — do not pipe it to `/dev/null`, do not redirect to a log file inside the working folder. The operator must see every dependency-resolver line in the script's own output stream. Drop the `VERBOSE`-gated wrapping from the Python reference — conformance output is where forensic data is most valuable.
  - **On failure, print what was about to run before exiting** — the exact test command, the working directory, the resolved `$CONFORMANCE_TESTS_FOLDER`, and the relevant environment variables (`PYTHONPATH`, `NODE_PATH`, `GOMODCACHE`, `CARGO_HOME`, `MAVEN_OPTS`, `PATH`, plus `VIRTUAL_ENV` for Python).
  - **Print a final summary line** that names the test command, the exit code, the resolved conformance-tests folder, and the working folder so the operator knows exactly what to re-run by hand if needed.
  Verbosity is not noise here — a chatty script that documents itself in its own output is the difference between a 30-second triage and a 30-minute one. Never trade verbosity for terseness.
- **Resolve `$2` before any `cd`.** This is the single most common bug in hand-written conformance scripts: using the conformance-tests argument after changing directory. Resolve it to an absolute path in step 3 (absolute → use as-is; relative → prefix the invocation directory) and use only the resolved variable afterwards. The resolved value must also appear in the verbose log (per the logging rule above) so misresolutions of `$2` are visible at a glance.

### Dependency isolation

The dependency environment must live **inside** `$WORKING_FOLDER` so the test run can't be polluted by — or pollute — the user's global caches. Pick the most idiomatic isolation mechanism for the language:

| Language | Isolation mechanism | Install command (run inside `$WORKING_FOLDER`) | Test command (point at `$CONFORMANCE_TESTS_FOLDER`) |
|---|---|---|---|
| Python | `venv` at `./.venv` | `python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt` | `python -m unittest discover -b -s "$CONFORMANCE_TESTS_FOLDER"` (or `pytest "$CONFORMANCE_TESTS_FOLDER"`) |
| Node.js | local `./node_modules` (default) | `npm ci` (preferred) or `npm install` | `npx jest --rootDir "$CONFORMANCE_TESTS_FOLDER"` |
| Java | project-scoped Maven repo at `./.m2` | `mvn -Dmaven.repo.local=./.m2 install -DskipTests` (build + install artifact so the test pom can resolve it) | `mvn -f "$CONFORMANCE_TESTS_FOLDER/pom.xml" -Dmaven.repo.local="$(pwd)/.m2" test` |
| Go | module cache at `./.gocache` | `GOMODCACHE="$PWD/.gocache" go mod download` (optional pre-warm) | `GOMODCACHE="$PWD/.gocache" go test "$CONFORMANCE_TESTS_FOLDER/..."` |
| Rust | cargo home at `./.cargo` | `CARGO_HOME="$PWD/.cargo" cargo fetch` (optional pre-warm) | `CARGO_HOME="$PWD/.cargo" cargo test --manifest-path "$CONFORMANCE_TESTS_FOLDER/Cargo.toml"` |

Notes:

- **Every path in the install command and test command is relative to `<temp>/<lang>_<basename>`.** That's why the script `cd`s into the working folder in step 6 — from that point on, `./.venv`, `./node_modules`, `./.m2`, etc. all resolve under `<temp>/<lang>_<basename>`, never under `$1` or `$2`.
- **Always pass the isolation flag/env var to both the install command and the test command.** They must agree on where deps live, otherwise the test command will silently fall back to the global cache **or** (worse) write into `$1` / `$2`.
- **Python is the only ecosystem where the venv is mandatory** to satisfy "into a virtual environment" literally. The others use language-native equivalents that achieve the same isolation.
- **Propagate the install exit code immediately.** In Bash: `<install cmd> || exit $?`. In PowerShell: check `$LASTEXITCODE` and `exit $LASTEXITCODE` if non-zero.
- **Time the dependency setup** with `date +%s.%N` (Bash) / `Get-Date` (PowerShell) and print `"Requirements setup completed in X.XX seconds"`.

### Bash specifics

- **Shebang:** `#!/bin/bash`.
- **File naming:** `run_conformance_tests_<lang>.sh`, placed in `assets/` (skill reference) or `test_scripts/` (target project).
- **Arguments:** `$1` = build folder, `$2` = conformance tests folder.
- **Make it executable:** `chmod +x` the produced script.
- **`cd` failure check:** the reference scripts use the `cd ... 2>/dev/null` + `[ $? -ne 0 ]` pattern. Keep it.
- **Alpine-friendly:** the harness runs the script in an Alpine Linux VM. Stick to POSIX tools and flags that BusyBox supports (e.g. `cp -R`, `mktemp`, plain `grep`), and let the toolchain check report clearly when the runtime is missing there.

### PowerShell specifics (by-hand Windows copy only)

The harness never runs `.ps1` scripts. These notes apply only to an optional copy for people running the suite by hand on Windows.

- **No shebang.** Use a `param([Parameter(Mandatory=$true)][string]$BuildFolder, [Parameter(Mandatory=$true)][string]$ConformanceTestsFolder)` block at the top instead.
- **File naming:** `run_conformance_tests_<lang>.ps1`.
- **Exit codes:** use `exit 69` etc. (PowerShell honors them just like Bash).
- **Toolchain check:** prefer `Get-Command <tool> -ErrorAction SilentlyContinue` and, where a specific version is needed, parse the tool's `--version` output.
- **Filesystem:** use `Test-Path`, `Remove-Item -Recurse -Force`, `New-Item -ItemType Directory`, `Copy-Item -Recurse`, `Set-Location`. Quote paths to handle spaces.
- **Resolve `$ConformanceTestsFolder` to absolute** with `[System.IO.Path]::IsPathRooted` + `Join-Path (Get-Location) ...` **before** any `Set-Location` call.
- **No `chmod` step needed.** If execution policy is likely to block the script, mention `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` to the user — don't bake it into the script.

## Workflow

1. Confirm the target **language** and **dependency manifest** (`pom.xml`, `requirements.txt` / `pyproject.toml`, `package.json`, `go.mod`, `Cargo.toml`, ...). Ask if either is unclear.
2. Read [assets/run_conformance_tests_java.sh](assets/run_conformance_tests_java.sh) and [assets/run_conformance_tests_python.sh](assets/run_conformance_tests_python.sh) to refresh the exact structure.
3. Translate each step into the equivalent Bash commands for the target language. The toolchain check, dependency install, and test invocation are the language-specific parts; the rest is mechanical.
4. Pick the right row from the [Dependency isolation](#dependency-isolation) table — use the same flag/env var in steps 7 and 8.
5. Add the language-appropriate "no tests discovered" guard from [No tests discovered detection](#no-tests-discovered-detection).
6. Save the new script as `test_scripts/run_conformance_tests_<lang>.sh` and `chmod +x` it. Write a `.ps1` copy only if the user wants to run it by hand on Windows.
7. **Make sure plainwright finds the script.** Do not link it from the specs - plainwright finds the conformance testing script in the project root (the folder that holds `plain_modules/`) and puts it, whole, into the prompts of the agents that write and review the conformance tests itself, whenever conformance tests are written for a build; a link to it from a spec is ignored. It looks, in order, at `config.yaml` in the root (`conformance-tests-script: <path relative to the root>`), then for the one `run_conformance_tests*.sh` in the root, then for the one in `test_scripts/`. Saving the script in `test_scripts/` (or the root) is enough when it is the only one there. If the project has more than one conformance testing script (e.g. a Python backend and a React frontend), or keeps it elsewhere, name the one to use in `config.yaml` as `conformance-tests-script:` - plainwright never guesses between two. The script is required: with conformance testing on, a build without one stops before it starts. The `***test reqs***` still describe the conformance framework and command in words; do not paraphrase the script into them.

## Anti-Patterns

- **(Hard mistake) Don't install into, build into, or otherwise write to the source build folder (`$1`) or the conformance tests folder (`$2`).** Both arguments are read-only input. Every install, cache, build artifact, log, JUnit XML, coverage report, compiled test class, and temp file must land in `<temp>/<lang>_<basename>`. This includes never running `pip install`, `npm install`, `mvn install`, or `cargo build` with `$1` or `$2` as their `cwd` or target; never letting a venv / `node_modules` / `.m2` / `.gocache` / `.cargo` directory appear inside `$1` or `$2`; and never running the test command from inside either folder. The whole point of staging into the system temp directory is so the build folder remains a clean artifact of the render and the conformance tests folder remains a clean tree under the user's version control — writing to either one corrupts those guarantees.
- **(Hard mistake) Don't build any path by concatenating a raw argument.** `$1` and `$2` arrive as absolute paths from current renderers. Patterns like `WORKING_FOLDER=.tmp/$1`, `WORKING_FOLDER=<lang>_$1`, or `"$current_dir/$2"` silently produce doubled paths (`/project//abs/path/...`) — the classic symptom is `ImportError: Start directory is not importable` or "folder does not exist" pointing at a path that contains the project root twice. Always derive the working folder from `$(basename "$1")` / `Split-Path -Leaf`, and use the `$CONFORMANCE_TESTS_FOLDER` resolved in step 3.
- **Don't rely on anything being set up before the script runs.** The script is self-contained: it stages the build and installs dependencies itself, every time. Don't look for a pre-warmed working folder or environment left by an earlier run.
- **Don't copy the conformance tests folder into the working folder.** Only the build folder is staged. The test folder is read in place from `$CONFORMANCE_TESTS_FOLDER`.
- **Don't compute the test path after `cd`.** Resolve `$2` to an absolute path in step 3; otherwise a relative `$2` will be resolved against the working folder and silently miss the tests.
- **Don't expect per-functionality subfolders in `$2`.** `$2` holds the module's whole conformance suite; point the test command at it and let the runner discover every test in it.
- **Don't skip the "no tests discovered" check.** A conformance suite that finds zero tests and exits `0` is the worst possible failure mode — it looks like success.
- **Don't skip the toolchain check**, even when "everyone has it installed" — exit code `69` is what the calling system relies on to detect a missing runtime.
- **Don't reuse the source folder in place.** Always copy into `<temp>/<lang>_<basename>` first; the renderer relies on this isolation.
- **Don't skip cleanup.** Register the `trap` / `finally` removal of the working folder right after creating it, so it is removed on success and failure alike.
- **Don't change the exit-code contract.** Other parts of the system branch on `69` and `1` specifically — and these codes must be identical between the Bash script and any PowerShell copy.
- **Don't write a cross-shell hybrid** (e.g. a `.sh` that detects PowerShell, or vice versa). Ship one script per shell, named with the appropriate extension.
- **Don't ship only a `.ps1`.** The harness runs `.sh` scripts only, in a Linux VM; a project with just a PowerShell runner has no conformance testing script as far as plainwright is concerned.
- **Don't install dependencies into the user's global location** (`~/.m2`, system-wide `pip`, `~/.cargo`, etc.). Always isolate inside `$WORKING_FOLDER` so concurrent runs and other projects can't interfere.
- **Don't run the test command without first verifying the install succeeded.** A failed install followed by a "test" run produces misleading errors that look like test failures.
- **Don't link the script from the specs, and don't leave plainwright guessing.** plainwright finds the script in `config.yaml`, the project root, or `test_scripts/`, shows it to the agents that write the conformance tests itself, and stops before the build starts without it; a link to it from a spec is ignored. Put it where it is found, and when there are two conformance testing scripts in one folder, name the one to use in `config.yaml` as `conformance-tests-script:` (see Workflow step 7).
- **Don't write a terse script.** Silent steps, `>/dev/null` redirects on the install output, missing `--version` prints, absent step banners, an un-logged resolved `$2`, and a missing final summary all make the script harder to debug than the tests it is running. Follow the *Logging — be as verbose as possible* rule under [Conventions](#conventions) literally: every step announces itself, every command is echoed, the resolved `$CONFORMANCE_TESTS_FOLDER` is printed, every failure prints what was about to run and where, and the final summary names the test command, exit code, and working folder.
