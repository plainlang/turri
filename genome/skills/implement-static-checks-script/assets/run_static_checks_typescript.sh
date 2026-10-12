#!/bin/bash
# The static checks of a TypeScript build, as stdlib/lang/typescript asks for them: Prettier in check mode, ESLint and
# the TypeScript compiler's type check, each from the project's own devDependencies.
#
#   run_static_checks_typescript.sh <build folder>          the checks: exit 0 when all of them pass
#   run_static_checks_typescript.sh <build folder> --fix    Prettier and ESLint's fixes, written back into the build
#                                                           folder: exit 0 once they are applied, whatever is left to find
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
for tool in node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Error: $tool is not installed on this machine."
    exit 69
  fi
done
echo "node: $(command -v node) - $(node --version); npm: $(command -v npm) - $(npm --version)"

echo "===== [2/5] Working folder ====="
SOURCE="$(cd "$1" 2>/dev/null && pwd)" || { echo "Error: the build folder '$1' does not exist."; exit 2; }
WORKING_FOLDER="$(mktemp -d "/tmp/static_typescript_$(basename "$SOURCE").XXXXXX")" || { echo "Error: could not create a working folder in /tmp."; exit 2; }
trap 'rm -rf "$WORKING_FOLDER"' EXIT
echo "Build folder: $SOURCE"
echo "Working folder: $WORKING_FOLDER"
tar -C "$SOURCE" --exclude=node_modules --exclude=dist --exclude=.git -cf - . | tar -C "$WORKING_FOLDER" -xf - || { echo "Error: could not copy the build folder."; exit 2; }
cd "$WORKING_FOLDER" || exit 2
# The lockfile is npm's to write, never the formatter's.
echo "package-lock.json" >> .prettierignore

echo "===== [3/5] Dependencies ====="
if [ ! -f package.json ]; then
  echo "package.json:1:1: there is no package.json - the project's dependencies, prettier, eslint and typescript among them, go in it"
  exit 1
fi
if [ -f package-lock.json ]; then
  echo "+ npm ci"
  npm ci --no-audit --no-fund || exit $?
else
  echo "+ npm install (no package-lock.json)"
  npm install --no-audit --no-fund || exit $?
fi
MISSING=0
for tool in prettier eslint tsc; do
  if [ ! -x "node_modules/.bin/$tool" ]; then
    package=$([ "$tool" = tsc ] && echo typescript || echo "$tool")
    echo "package.json:1:1: $package is not in devDependencies - add it with \`npm install --save-dev $package\`"
    MISSING=1
  fi
done

if [ "$FIX" -eq 1 ]; then
  echo "===== [4/5] Fixes ====="
  if [ -x node_modules/.bin/eslint ]; then
    echo "+ eslint --fix ."
    node_modules/.bin/eslint --fix . >/dev/null 2>&1
  fi
  if [ -x node_modules/.bin/prettier ]; then
    echo "+ prettier --write --ignore-unknown ."
    node_modules/.bin/prettier --write --ignore-unknown --log-level warn . || exit $?
  fi
  echo "===== [5/5] Writing the fixes back ====="
  find . \( -name node_modules -o -name dist -o -name .git \) -prune -o -type f -not -name package-lock.json \( \
    -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.cts' -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' -o \
    -name '*.cjs' -o -name '*.vue' -o -name '*.svelte' -o -name '*.json' -o -name '*.css' -o -name '*.scss' -o \
    -name '*.html' -o -name '*.md' -o -name '*.yaml' -o -name '*.yml' \) -print |
    while IFS= read -r file; do
      if [ -f "$SOURCE/$file" ] && ! cmp -s "$file" "$SOURCE/$file"; then
        cp "$file" "$SOURCE/$file" && echo "fixed: ${file#./}"
      fi
    done
  exit 0
fi

echo "===== [4/5] Checks ====="
STATUS=$MISSING
if [ -x node_modules/.bin/prettier ]; then
  echo "+ prettier --list-different --ignore-unknown ."
  node_modules/.bin/prettier --list-different --ignore-unknown . | sed 's/$/:1:1: not formatted - prettier would reformat it/'
  [ "${PIPESTATUS[0]}" -eq 0 ] || STATUS=1
fi
if [ -x node_modules/.bin/eslint ]; then
  echo "+ eslint --max-warnings 0 --format json ."
  node_modules/.bin/eslint --max-warnings 0 --format json . > "$WORKING_FOLDER/.eslint.json"
  ESLINT=$?
  if [ -s "$WORKING_FOLDER/.eslint.json" ]; then
    # One line a finding: file:line:column: severity message (rule).
    node -e '
      const path = require("path");
      for (const file of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")))
        for (const m of file.messages)
          console.log(`${path.relative(process.cwd(), file.filePath)}:${m.line ?? 1}:${m.column ?? 1}: ${m.severity === 2 ? "error" : "warning"} ${m.message}${m.ruleId ? ` (${m.ruleId})` : ""}`);
    ' "$WORKING_FOLDER/.eslint.json"
  fi
  [ "$ESLINT" -eq 0 ] || STATUS=1
fi
CHECKER=tsc
[ -x node_modules/.bin/vue-tsc ] && CHECKER=vue-tsc
if [ -x "node_modules/.bin/$CHECKER" ]; then
  # A tsconfig made of project references - Vite's - checks its parts with --build; any other, with --noEmit.
  if grep -q '"references"' tsconfig.json 2>/dev/null; then ARGS=(--build --pretty false); else ARGS=(--noEmit --pretty false); fi
  echo "+ $CHECKER ${ARGS[*]}"
  "node_modules/.bin/$CHECKER" "${ARGS[@]}" || STATUS=1
fi

echo "===== [5/5] Summary ====="
echo "static checks exited $STATUS (working folder $WORKING_FOLDER)"
exit $STATUS
