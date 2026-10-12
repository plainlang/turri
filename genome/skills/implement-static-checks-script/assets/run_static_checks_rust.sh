#!/bin/bash
# The static checks of a Rust build, as stdlib/lang/rust asks for them: rustfmt in check mode and clippy with every
# warning an error - clippy type checks the code as it lints it.
#
#   run_static_checks_rust.sh <build folder>          the checks: exit 0 when all of them pass
#   run_static_checks_rust.sh <build folder> --fix    rustfmt, written back into the build folder: exit 0 once it is applied
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
if ! command -v cargo >/dev/null 2>&1; then
  echo "Error: cargo is not installed on this machine."
  exit 69
fi
echo "cargo: $(command -v cargo) - $(cargo --version)"
if ! cargo fmt --version >/dev/null 2>&1; then
  echo "Error: rustfmt is not installed on this machine - rustup component add rustfmt"
  exit 69
fi
if [ "$FIX" -eq 0 ] && ! cargo clippy --version >/dev/null 2>&1; then
  echo "Error: clippy is not installed on this machine - rustup component add clippy"
  exit 69
fi

echo "===== [2/5] Working folder ====="
SOURCE="$(cd "$1" 2>/dev/null && pwd)" || { echo "Error: the build folder '$1' does not exist."; exit 2; }
WORKING_FOLDER="$(mktemp -d "/tmp/static_rust_$(basename "$SOURCE").XXXXXX")" || { echo "Error: could not create a working folder in /tmp."; exit 2; }
trap 'rm -rf "$WORKING_FOLDER"' EXIT
echo "Build folder: $SOURCE"
echo "Working folder: $WORKING_FOLDER"
tar -C "$SOURCE" --exclude=target --exclude=.cargo --exclude=.git -cf - . | tar -C "$WORKING_FOLDER" -xf - || { echo "Error: could not copy the build folder."; exit 2; }
cd "$WORKING_FOLDER" || exit 2
if [ ! -f Cargo.toml ]; then
  echo "Cargo.toml:1:1: there is no Cargo.toml - the build is a Cargo package or workspace"
  exit 1
fi

if [ "$FIX" -eq 1 ]; then
  echo "===== [3/5] Fixes ====="
  echo "+ cargo fmt --all"
  cargo fmt --all || exit $?
  echo "===== [4/5] Writing the fixes back ====="
  find . \( -name target -o -name .cargo -o -name .git \) -prune -o -type f -name '*.rs' -print |
    while IFS= read -r file; do
      if [ -f "$SOURCE/$file" ] && ! cmp -s "$file" "$SOURCE/$file"; then
        cp "$file" "$SOURCE/$file" && echo "fixed: ${file#./}"
      fi
    done
  exit 0
fi

echo "===== [3/5] Dependencies ====="
export CARGO_TARGET_DIR="$WORKING_FOLDER/target"
echo "+ cargo fetch"
cargo fetch || exit $?

echo "===== [4/5] Checks ====="
STATUS=0
echo "+ cargo fmt --all --check"
cargo fmt --all --check -- --files-with-diff | sed 's/$/:1:1: not formatted - rustfmt would reformat it/'
[ "${PIPESTATUS[0]}" -eq 0 ] || STATUS=1
echo "+ cargo clippy --all-targets --message-format short -- -D warnings"
cargo clippy --all-targets --message-format short --quiet -- -D warnings || STATUS=1

echo "===== [5/5] Summary ====="
echo "static checks exited $STATUS (working folder $WORKING_FOLDER)"
exit $STATUS
