#!/bin/zsh
# Installs the pinned Bun locally (no admin, no global changes), then workspace deps and the UI build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
BUN_VERSION="1.3.0"
cd "$ROOT"
mkdir -p .tmp/bun-cache
export BUN_INSTALL_CACHE_DIR="$ROOT/.tmp/bun-cache"

if command -v bun >/dev/null 2>&1 && [[ "$(bun --version)" == "$BUN_VERSION" ]]; then
  BUN="$(command -v bun)"
else
  BUN="$ROOT/.tmp/bootstrap/node_modules/bun/bin/bun.exe"
  if [[ ! -x "$BUN" ]]; then
    npm install --prefix "$ROOT/.tmp/bootstrap" --no-save "bun@$BUN_VERSION"
  fi
fi

"$BUN" install --frozen-lockfile
"$BUN" run --cwd apps/web build
echo "Ready. Start hived with: $BUN apps/hived/src/main.ts"
echo "Bun binary: $BUN"
