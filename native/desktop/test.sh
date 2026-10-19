#!/bin/zsh
# Compiles the helper's sources (not main.swift) with Tests/main.swift and runs the checks.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd -P)"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
sources=(${DIR}/Sources/*.swift)
xcrun swiftc -swift-version 5 -o "${OUT}/desktop-tests" ${sources:#*/main.swift} "${DIR}/Tests/main.swift"
"${OUT}/desktop-tests"
