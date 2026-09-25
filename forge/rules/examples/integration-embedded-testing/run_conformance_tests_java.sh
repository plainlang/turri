#!/bin/bash

# Export Java 21
#export JAVA_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
#export PATH="$JAVA_HOME/bin:$PATH"
echo "JAVA_HOME: $JAVA_HOME"

# Check if build folder name is provided
if [ -z "$1" ]; then
  printf "Error: No build folder name provided.\n"
  printf "Usage: $0 <build_folder_name> <conformance_tests_folder>\n"
  exit 1
fi

# Check if conformance tests folder name is provided
if [ -z "$2" ]; then
  printf "Error: No conformance tests folder name provided.\n"
  printf "Usage: $0 <build_folder_name> <conformance_tests_folder>\n"
  exit 1
fi

current_dir=$(pwd)

# Resolve the conformance tests folder to an absolute path ($2 may be relative
# on older renderers; newer renderers pass it as an absolute path).
case "$2" in
  /*) CONFORMANCE_TESTS_SOURCE="$2" ;;
  *)  CONFORMANCE_TESTS_SOURCE="$current_dir/$2" ;;
esac

# Host-relative paths of the module, as declared in ***implementation reqs***.
# Replace the placeholders with the module's integration source path and its
# :UnitTests: source path (the same paths run_unittests_java.sh copies to).
INTEGRATION_CODE_PATH="<placeholder for integration code>"
INTEGRATION_TESTS_PATH="<placeholder for integration code tests>"

# Host codebase root: read from HOST_CODEBASE_ROOT (the one configured fact),
# defaulting to three levels up from this script.
MAIN_PROJECT_FOLDER="${HOST_CODEBASE_ROOT:-$(cd "$(dirname "$0")/../../.." && pwd)}"

# Stage the generated code into the host codebase (same copy as run_unittests_java.sh)
if [ "${VERBOSE:-}" -eq 1 ] 2>/dev/null; then
  printf "Copying generated code to main project folder: $MAIN_PROJECT_FOLDER\n"
fi

# Check if the main project folder exists
if [ ! -d "$MAIN_PROJECT_FOLDER" ]; then
  echo "Error: Main project folder '$MAIN_PROJECT_FOLDER' does not exist."
  exit 2
fi

# clean existing code of this module only from the main project folder
rm -rf "$MAIN_PROJECT_FOLDER/$INTEGRATION_CODE_PATH"/*
rm -rf "$MAIN_PROJECT_FOLDER/$INTEGRATION_TESTS_PATH"/*

# copy generated code to the main project folder
mkdir -p "$MAIN_PROJECT_FOLDER/$INTEGRATION_CODE_PATH"
mkdir -p "$MAIN_PROJECT_FOLDER/$INTEGRATION_TESTS_PATH"
cp -R "$1/$INTEGRATION_CODE_PATH"/* "$MAIN_PROJECT_FOLDER/$INTEGRATION_CODE_PATH"
cp -R "$1/$INTEGRATION_TESTS_PATH"/* "$MAIN_PROJECT_FOLDER/$INTEGRATION_TESTS_PATH"

# Move to the host codebase and build / install it, so the conformance project
# resolves this build from the local Maven repository (~/.m2), not a stale one.
echo "Moving to: $MAIN_PROJECT_FOLDER"
cd "$MAIN_PROJECT_FOLDER" 2>/dev/null

if [ $? -ne 0 ]; then
  printf "Error: Java build folder '$MAIN_PROJECT_FOLDER' does not exist.\n"
  exit 2
fi

# Remove target directory to avoid conflicts with a previous build
rm -rf ./target || echo "Warning: some files may be locked"

# -DskipTests is legitimate here: this step only installs the host build;
# the conformance tests run below.
echo "Running maven install in the host codebase..."
mvn clean install -Dspring-boot.repackage.skip=true -DskipTests

install_exit_code=$?
if [ $install_exit_code -ne 0 ]; then
  echo "Error: Maven install failed in the host codebase with exit code $install_exit_code..."
  exit 69
fi

# Scratch folder lives in the system temp directory so no build debris is left
# inside the project. It is removed again when the script exits.
CONFORMANCE_TESTS_FOLDER="/tmp/java_conformance"

trap 'rm -rf "$CONFORMANCE_TESTS_FOLDER"' EXIT

printf "Preparing Java conformance tests subfolder: $CONFORMANCE_TESTS_FOLDER\n"

# Check if the conformance tests scratch folder exists
if [ -d "$CONFORMANCE_TESTS_FOLDER" ]; then
  # Find and delete all files and folders
  find "$CONFORMANCE_TESTS_FOLDER" -mindepth 1 -exec rm -rf {} +

  if [ "${VERBOSE:-}" -eq 1 ] 2>/dev/null; then
    printf "Cleanup completed.\n"
  fi
else
  # print the current directory
  printf "Current directory: $(pwd)\n"

  printf "Subfolder does not exist. Creating it...\n"
  mkdir -p $CONFORMANCE_TESTS_FOLDER
fi

printf "Copying all files and folders from $CONFORMANCE_TESTS_SOURCE to $CONFORMANCE_TESTS_FOLDER...\n"
cp -R "$CONFORMANCE_TESTS_SOURCE"/* $CONFORMANCE_TESTS_FOLDER

# Move to the subfolder
printf "Moving to $CONFORMANCE_TESTS_FOLDER...\n"
cd "$CONFORMANCE_TESTS_FOLDER" 2>/dev/null

if [ $? -ne 0 ]; then
  printf "Error: Java conformance tests folder '$CONFORMANCE_TESTS_FOLDER' does not exist.\n"
  exit 2
fi

echo "Running maven install in the conformance tests folder..."
mvn clean install -DskipTests


if [ $? -ne 0 ]; then
  exit 2
fi

echo "Running maven test in the conformance tests folder..."

output=$(mvn test --no-transfer-progress 2>&1)
exit_code=$?

echo "Finished running maven test in the conformance tests folder..."

# Check if no tests were run
if echo "$output" | grep -q 'Tests run: [1-9][0-9]*, Failures: 0, Errors: 0, Skipped: 0'; then
    echo "All tests passed"
    echo "$output"
    exit $exit_code
else
    # Check if no tests were run
    if echo "$output" | grep -q 'Tests run: 0, Failures: 0, Errors: 0, Skipped: 0'; then
        echo "Tests run: 0"
        echo "Error: No tests were executed (Tests run: 0)"
        echo "You are seeing this cause the following appeared in the output: Tests run: 0, Failures: 0, Errors: 0, Skipped: 0"
    else
        echo "Some tests failed, had errors, or were skipped. This is not allowed. All tests must pass."
    fi
fi

# If there was an error, print the output and exit with the error code
if [ $exit_code -ne 0 ]; then
    echo "Error: Maven test failed in the conformance tests folder with exit code $exit_code..."
    echo "$output"
    exit $exit_code
fi

echo "Finished running conformance tests..."
echo "$output"
# Echo the original exit code of the unittest command
exit $exit_code
