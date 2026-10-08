#!/bin/zsh
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
TOKEN_FILE="$PROJECT_ROOT/.hive-data/access-token"
for i in {1..30}; do
  if [[ -f "$TOKEN_FILE" ]] && curl -fsS "http://127.0.0.1:4317/" >/dev/null 2>&1; then
    open "http://127.0.0.1:4317/api/bootstrap?token=$(cat "$TOKEN_FILE")"
    echo "Opened Hive in your browser."
    exit 0
  fi
  sleep 1
done
echo "Hive did not start. Check $HOME/.cache/hive-launch.err.log" >&2
exit 1
