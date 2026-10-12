#!/bin/bash
# The static checks of a Python build, as stdlib/lang/python asks for them: ruff's formatter in check mode, ruff's
# linter and mypy, each from the project's own `dev` dependency group.
#
#   run_static_checks_python.sh <build folder>          the checks: exit 0 when all of them pass
#   run_static_checks_python.sh <build folder> --fix    ruff's formatter and its safe fixes, written back into the build
#                                                       folder: exit 0 once they are applied, whatever is left to find
#
# turri runs the checks with the unit testing script, and both must pass; it runs the fix mode before each run.
# Every finding is one line naming its file and its line, relative to the build folder.
# Exit codes: 1 bad usage or findings, 2 a filesystem problem, 69 a toolchain missing; any other, the tool's own.

set -u

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <build folder> [--fix]"
  exit 1
fi
FIX=0
[ "${2:-}" = "--fix" ] && FIX=1

echo "===== [1/5] Toolchain check ====="
if ! command -v uv >/dev/null 2>&1; then
  echo "Error: uv is not installed on this machine (https://docs.astral.sh/uv/)."
  exit 69
fi
echo "uv: $(command -v uv) - $(uv --version)"

echo "===== [2/5] Working folder ====="
SOURCE="$(cd "$1" 2>/dev/null && pwd)" || { echo "Error: the build folder '$1' does not exist."; exit 2; }
WORKING_FOLDER="$(mktemp -d "/tmp/static_python_$(basename "$SOURCE").XXXXXX")" || { echo "Error: could not create a working folder in /tmp."; exit 2; }
trap 'rm -rf "$WORKING_FOLDER"' EXIT
echo "Build folder: $SOURCE"
echo "Working folder: $WORKING_FOLDER"
EXCLUDES=(--exclude=.venv --exclude=venv --exclude=__pycache__ --exclude=.mypy_cache --exclude=.ruff_cache --exclude=.pytest_cache --exclude=.git)
tar -C "$SOURCE" "${EXCLUDES[@]}" -cf - . | tar -C "$WORKING_FOLDER" -xf - || { echo "Error: could not copy the build folder."; exit 2; }
cd "$WORKING_FOLDER" || exit 2

echo "===== [3/5] Dependencies ====="
if [ ! -f pyproject.toml ]; then
  echo "pyproject.toml:1:1: there is no pyproject.toml - the project's dependencies, ruff and mypy among them, go in it"
  exit 1
fi
echo "+ uv sync (the dev dependency group into ./.venv)"
UV_PROJECT_ENVIRONMENT="$WORKING_FOLDER/.venv" uv sync || exit $?
MISSING=0
for tool in ruff mypy; do
  if [ ! -x ".venv/bin/$tool" ]; then
    echo "pyproject.toml:1:1: $tool is not in the dev dependency group - add it with \`uv add --dev $tool\`"
    MISSING=1
  fi
done

if [ "$FIX" -eq 1 ]; then
  echo "===== [4/5] Fixes ====="
  [ -x .venv/bin/ruff ] || exit 1
  echo "+ ruff format ."
  .venv/bin/ruff format . || exit $?
  echo "+ ruff check --fix --exit-zero ."
  .venv/bin/ruff check --fix --exit-zero --quiet . || exit $?
  echo "===== [5/5] Writing the fixes back ====="
  # Only the Python sources: what ruff changes. uv.lock, which uv sync may have brought up to date here, stays as it was.
  find . \( -name .venv -o -name __pycache__ -o -name .mypy_cache -o -name .ruff_cache -o -name .pytest_cache -o -name .git \) -prune -o -type f \( -name '*.py' -o -name '*.pyi' \) -print |
    while IFS= read -r file; do
      if [ -f "$SOURCE/$file" ] && ! cmp -s "$file" "$SOURCE/$file"; then
        cp "$file" "$SOURCE/$file" && echo "fixed: ${file#./}"
      fi
    done
  exit 0
fi

echo "===== [4/5] Checks ====="
STATUS=$MISSING
if [ -x .venv/bin/ruff ]; then
  echo "+ ruff format --check --output-format concise ."
  .venv/bin/ruff format --check --output-format concise . || STATUS=1
  echo "+ ruff check --output-format concise ."
  .venv/bin/ruff check --output-format concise --no-fix . || STATUS=1
fi
if [ -x .venv/bin/mypy ]; then
  # `files` in [tool.mypy] says what to check; without it, the whole build.
  if grep -Eq '^\s*files\s*=' pyproject.toml; then TARGETS=(); else TARGETS=(.); fi
  echo "+ mypy ${TARGETS[*]:-}"
  .venv/bin/mypy --no-color-output --show-column-numbers ${TARGETS[@]+"${TARGETS[@]}"} || STATUS=1
fi

echo "===== [5/5] Summary ====="
echo "static checks exited $STATUS (working folder $WORKING_FOLDER)"
exit $STATUS
