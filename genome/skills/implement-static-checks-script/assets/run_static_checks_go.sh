#!/bin/bash
# The static checks of a Go build, as stdlib/lang/go asks for them: gofmt in check mode and go vet, which type checks
# every package as it vets it.
#
#   run_static_checks_go.sh <build folder>          the checks: exit 0 when all of them pass
#   run_static_checks_go.sh <build folder> --fix    gofmt, written back into the build folder: exit 0 once it is applied
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
for tool in go gofmt; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Error: $tool is not installed on this machine."
    exit 69
  fi
done
echo "go: $(command -v go) - $(go version)"

echo "===== [2/5] Working folder ====="
SOURCE="$(cd "$1" 2>/dev/null && pwd)" || { echo "Error: the build folder '$1' does not exist."; exit 2; }
WORKING_FOLDER="$(mktemp -d "/tmp/static_go_$(basename "$SOURCE").XXXXXX")" || { echo "Error: could not create a working folder in /tmp."; exit 2; }
trap 'chmod -R u+w "$WORKING_FOLDER" 2>/dev/null; rm -rf "$WORKING_FOLDER"' EXIT
echo "Build folder: $SOURCE"
echo "Working folder: $WORKING_FOLDER"
tar -C "$SOURCE" --exclude=.git --exclude=.gocache -cf - . | tar -C "$WORKING_FOLDER" -xf - || { echo "Error: could not copy the build folder."; exit 2; }
cd "$WORKING_FOLDER" || exit 2

if [ "$FIX" -eq 1 ]; then
  echo "===== [3/5] Fixes ====="
  echo "+ gofmt -w ."
  gofmt -w . || exit $?
  echo "===== [4/5] Writing the fixes back ====="
  find . \( -name .git -o -name vendor \) -prune -o -type f -name '*.go' -print |
    while IFS= read -r file; do
      if [ -f "$SOURCE/$file" ] && ! cmp -s "$file" "$SOURCE/$file"; then
        cp "$file" "$SOURCE/$file" && echo "fixed: ${file#./}"
      fi
    done
  exit 0
fi

echo "===== [3/5] Dependencies ====="
if [ ! -f go.mod ]; then
  echo "go.mod:1:1: there is no go.mod - the build is one Go module"
  exit 1
fi
export GOMODCACHE="$WORKING_FOLDER/.gocache"
echo "+ go mod download (into $GOMODCACHE)"
go mod download || exit $?

echo "===== [4/5] Checks ====="
STATUS=0
echo "+ gofmt -l ."
UNFORMATTED="$(gofmt -l . 2>&1 | grep -v '^\./\.gocache/' | grep -v '^\.gocache/')"
if [ -n "$UNFORMATTED" ]; then
  echo "$UNFORMATTED" | sed 's/$/:1:1: not formatted - gofmt would reformat it/'
  STATUS=1
fi
echo "+ go vet ./..."
go vet ./... || STATUS=1

echo "===== [5/5] Summary ====="
echo "static checks exited $STATUS (working folder $WORKING_FOLDER)"
exit $STATUS
