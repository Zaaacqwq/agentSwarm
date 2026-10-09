#!/bin/zsh
# Builds "Hive Desktop.app" and runs it as a LaunchAgent in your GUI session. No sudo.
#
#   zsh scripts/install-desktop-helper.sh              build (only if the source changed) and (re)load
#   zsh scripts/install-desktop-helper.sh --uninstall  unload and remove
#
# The helper is ad-hoc signed, so macOS ties Screen Recording and Accessibility to this exact build:
# it is rebuilt only when its source changes, and each rebuild needs the two permissions granted again.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SRC="${ROOT}/native/hive-desktop"
APP="${HOME}/Applications/Hive Desktop.app"
BIN="${APP}/Contents/MacOS/hive-desktop"
LABEL="dev.hive.desktop"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
# In your own Library (not the external HiveWS volume, which would need another macOS permission).
# Workstation users cannot reach your home directory.
SOCKET_DIR="${HOME}/Library/Application Support/Hive"
SOCKET="${SOCKET_DIR}/desktop.sock"
LOG="${HOME}/Library/Logs/hive-desktop.log"

say() { print -r -- "== $*"; }
die() { print -u2 -r -- "ERROR: $*"; exit 1; }

[[ $EUID -ne 0 ]] || die "Run as your normal user, without sudo."

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/${UID}/${LABEL}" 2>/dev/null || true
  rm -f "$PLIST" "$SOCKET"
  rm -rf "$APP"
  say "Removed. You can also delete \"Hive Desktop\" from Privacy & Security."
  exit 0
fi

hash="$(cat "${SRC}"/Sources/*.swift "${SRC}/Info.plist" | shasum -a 256 | cut -c1-16)"
if [[ ! -x "$BIN" || "$(cat "${APP}/Contents/Resources/source-hash" 2>/dev/null || true)" != "$hash" ]]; then
  say "Building Hive Desktop"
  build="$(mktemp -d)"
  xcrun swiftc -O -swift-version 5 -o "${build}/hive-desktop" "${SRC}"/Sources/*.swift
  rm -rf "$APP"
  mkdir -p "${APP}/Contents/MacOS" "${APP}/Contents/Resources"
  cp "${build}/hive-desktop" "$BIN"
  cp "${SRC}/Info.plist" "${APP}/Contents/Info.plist"
  print -r -- "$hash" > "${APP}/Contents/Resources/source-hash"
  codesign --force --sign - --identifier "$LABEL" "$APP" >/dev/null
  rm -rf "$build"
  rebuilt=1
else
  say "Hive Desktop is up to date"
  rebuilt=0
fi

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs" "$SOCKET_DIR"
chmod 0700 "$SOCKET_DIR"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${BIN}</string><string>--socket</string><string>${SOCKET}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/${UID}/${LABEL}" 2>/dev/null || true
# bootout returns before the old job is gone; bootstrap fails until it is.
for _ in {1..40}; do launchctl print "gui/${UID}/${LABEL}" >/dev/null 2>&1 || break; sleep 0.25; done
loaded=0
for _ in {1..5}; do
  if launchctl bootstrap "gui/${UID}" "$PLIST" 2>/dev/null; then loaded=1; break; fi
  sleep 1
done
(( loaded )) || die "launchctl could not load ${PLIST}"
# Wait until the new process answers (an old socket file may still be there for a moment).
helper_status=""
for _ in {1..40}; do
  helper_status="$(print -r -- '{"cmd":"status"}' | nc -U "$SOCKET" 2>/dev/null || true)"
  [[ -n "$helper_status" ]] && break
  sleep 0.25
done
[[ -n "$helper_status" ]] || die "Hive Desktop did not answer on ${SOCKET}; see ${LOG}"
if [[ "$helper_status" != *'"screenRecording":true'* || "$helper_status" != *'"accessibility":true'* ]]; then
  # Ask from inside the helper so macOS shows "Hive Desktop" in its prompts.
  print -r -- '{"cmd":"request_access"}' | nc -U "$SOCKET" >/dev/null
  say "Grant Hive Desktop both permissions in System Settings → Privacy & Security:"
  say "  • Screen & System Audio Recording   • Accessibility"
  say "Then rerun this script (or: launchctl kickstart -k gui/${UID}/${LABEL})."
  if (( rebuilt )); then say "(This build is new, so earlier grants for Hive Desktop no longer apply; remove the old entries first.)"; fi
else
  say "Hive Desktop is running with Screen Recording and Accessibility"
fi
