#!/bin/bash

# Check that Java 21 is installed
if ! /usr/libexec/java_home -v 21 >/dev/null 2>&1; then
  echo "Error: Java 21 is not installed."
  exit 69
fi

export JAVA_HOME=$(/usr/libexec/java_home -v 21)
java --version

# Check if subfolder name is provided
if [ -z "$1" ]; then
  echo "Error: No subfolder name provided."
  echo "Usage: $0 <subfolder_name>"
  exit 1
fi

# Working folder lives in the system temp directory. $1 may be an absolute
# path, so only its basename is used to build the working folder name.
WORKING_FOLDER="/tmp/java_$(basename "$1")"

trap 'rm -rf "$WORKING_FOLDER"' EXIT

# Check if the java subfolder exists
if [ -d "$WORKING_FOLDER" ]; then
  # delete everything in the subfolder
  rm -rf "$WORKING_FOLDER"/*
else
  echo "Subfolder '$WORKING_FOLDER' does not exist. Creating it now..."
  mkdir -p "$WORKING_FOLDER"
fi


# copy all folders and files from the build folder to the subfolder
cp -R "$1"/* "$WORKING_FOLDER"
printf "Copied from $1 to $WORKING_FOLDER...\n"
# Move to the subfolder
cd "$WORKING_FOLDER" 2>/dev/null
printf "Moved to $WORKING_FOLDER...\n"
if [ $? -ne 0 ]; then
  echo "Error: Subfolder '$1' does not exist."
  exit 2
fi

# Static checks: the code compiled with every javac lint warning an error - the flags pinned here, not in the pom.
# A formatter runs only when the implementation reqs name one (mvn spotless:check, say). Every check runs, and the
# tests run whatever they said.
STATIC_CHECKS_FAILED=80
echo "Running the static checks in $(pwd)..."
echo "+ mvn -Dmaven.repo.local=./.m2 -Dmaven.compiler.showWarnings=true -Dmaven.compiler.failOnWarning=true -Dmaven.compiler.compilerArgument=-Xlint:all test-compile"
mvn -Dmaven.repo.local=./.m2 -Dmaven.compiler.showWarnings=true -Dmaven.compiler.failOnWarning=true \
  -Dmaven.compiler.compilerArgument=-Xlint:all test-compile
CHECKS=$?
[ "$CHECKS" -eq 0 ] && echo "Static checks: passed" || echo "Static checks: FAILED - the findings are above"

# Execute all Java unittests in the subfolder
echo "Running Java unittests in $(pwd)..."
echo "+ mvn -Dmaven.repo.local=./.m2 test"
mvn -Dmaven.repo.local=./.m2 test
TESTS=$?

# The tests' own exit code when they failed; 80 when only the static checks did; 0 when both pass.
if [ "$TESTS" -ne 0 ]; then
  STATUS=$TESTS
elif [ "$CHECKS" -ne 0 ]; then
  STATUS=$STATIC_CHECKS_FAILED
else
  STATUS=0
fi
echo "static checks: exit $CHECKS; unit tests: exit $TESTS; exit $STATUS (working folder $WORKING_FOLDER)"
exit "$STATUS"
