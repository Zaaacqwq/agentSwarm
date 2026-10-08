#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$PROJECT_ROOT"
mkdir -p "$PROJECT_ROOT/.tmp/bun-cache" "$PROJECT_ROOT/.hive-data"
chmod 700 "$PROJECT_ROOT/.hive-data"
export BUN_INSTALL_CACHE_DIR="$PROJECT_ROOT/.tmp/bun-cache"

if [[ ! -x "$PROJECT_ROOT/node_modules/.bin/bun" ]]; then
  npm install --prefix "$PROJECT_ROOT/.tmp/bootstrap" bun@1.3.0
  "$PROJECT_ROOT/.tmp/bootstrap/node_modules/.bin/bun" install --frozen-lockfile
fi
npm run build

PLIST_PATH="$HOME/Library/LaunchAgents/dev.hive.local.plist"
mkdir -p "$HOME/Library/LaunchAgents"
LAUNCHER_PATH="$HOME/.cache/hive-launcher.sh"
BIN_PATH="$HOME/.cache/hive/bin/bun"
mkdir -p "$HOME/.cache/hive/bin"
cp -p "$PROJECT_ROOT/node_modules/bun/bin/bun.exe" "$BIN_PATH"
cat > "$LAUNCHER_PATH" <<EOF
#!/bin/zsh
cd "$HOME" || exit 78
export HIVE_PROJECT_ROOT="$PROJECT_ROOT"
export HIVE_DATA_DIR="$PROJECT_ROOT/.hive-data"
exec 2>>"$PROJECT_ROOT/.hive-data/hive.err.log"
exec "$BIN_PATH" "$PROJECT_ROOT/src/server.ts"
EOF
chmod 700 "$LAUNCHER_PATH"
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.hive.local</string>
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>$LAUNCHER_PATH</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>$HOME/.cache/hive-launch.err.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
echo "Hive installed as a user LaunchAgent."
"$PROJECT_ROOT/scripts/open.sh"
