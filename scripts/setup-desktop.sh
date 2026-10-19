#!/bin/zsh
# agentSwarm Desktop (R9): builds the helper and runs it as a LaunchAgent in your GUI session. Run as yourself, no sudo:
#   zsh scripts/setup-desktop.sh              build (when the source changed), sign and (re)load
#   zsh scripts/setup-desktop.sh --uninstall  unload and remove
#
# It is signed with your Apple Development certificate (or AGENTSWARM_SIGN_IDENTITY), so macOS keeps its
# Screen Recording and Accessibility grants across rebuilds. You grant those two once, in System Settings.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SRC="${ROOT}/native/desktop"
APP="${HOME}/Applications/agentSwarm Desktop.app"
BIN="${APP}/Contents/MacOS/agentswarm-desktop"
LABEL="dev.agentswarm.desktop"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
# In your own Library: workstation users cannot reach your home directory.
SUPPORT="${HOME}/Library/Application Support/agentSwarm"
SOCKET="${SUPPORT}/desktop.sock"
APPS="${SUPPORT}/apps"
LOG="${HOME}/Library/Logs/agentswarm-desktop.log"

say() { print -r -- "== $*"; }
die() { print -u2 -r -- "ERROR: $*"; exit 1; }

[[ $EUID -ne 0 ]] || die "Run as your normal user, without sudo."

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/${UID}/${LABEL}" 2>/dev/null || true
  rm -f "$PLIST" "$SOCKET"
  rm -rf "$APP" "$APPS"
  say "Removed. You can also delete \"agentSwarm Desktop\" from Privacy & Security."
  exit 0
fi

identity="${AGENTSWARM_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | sed -nE 's/.*"(Apple Development: [^"]+)".*/\1/p' | head -1)}"
[[ -n "$identity" ]] || die "No Apple Development certificate found; set AGENTSWARM_SIGN_IDENTITY to a code-signing identity."

hash="$( (cat "${SRC}"/Sources/*.swift "${SRC}/Info.plist"; print -r -- "$identity") | shasum -a 256 | cut -c1-16)"
if [[ ! -x "$BIN" || "$(cat "${APP}/Contents/Resources/source-hash" 2>/dev/null || true)" != "$hash" ]]; then
  say "Building agentSwarm Desktop"
  build="$(mktemp -d)"
  xcrun swiftc -O -swift-version 5 -o "${build}/agentswarm-desktop" "${SRC}"/Sources/*.swift
  rm -rf "$APP"
  mkdir -p "${APP}/Contents/MacOS" "${APP}/Contents/Resources"
  cp "${build}/agentswarm-desktop" "$BIN"
  cp "${SRC}/Info.plist" "${APP}/Contents/Info.plist"
  print -r -- "$hash" > "${APP}/Contents/Resources/source-hash"
  say "Signing with \"${identity}\" (macOS may ask to use the key: choose Always Allow)"
  codesign --force --options runtime --sign "$identity" --identifier "$LABEL" "$APP" >/dev/null
  rm -rf "$build"
else
  say "agentSwarm Desktop is up to date"
fi

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs" "$SUPPORT" "$APPS"
chmod 0700 "$SUPPORT" "$APPS"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${BIN}</string><string>--socket</string><string>${SOCKET}</string><string>--apps</string><string>${APPS}</string></array>
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
helper_status=""
for _ in {1..40}; do
  helper_status="$(print -r -- '{"cmd":"status"}' | nc -U "$SOCKET" 2>/dev/null || true)"
  [[ -n "$helper_status" ]] && break
  sleep 0.25
done
[[ -n "$helper_status" ]] || die "agentSwarm Desktop did not answer on ${SOCKET}; see ${LOG}"
if [[ "$helper_status" != *'"screenRecording":true'* || "$helper_status" != *'"accessibility":true'* ]]; then
  # Asked from inside the helper, so macOS names "agentSwarm Desktop" in its prompts.
  print -r -- '{"cmd":"request_access"}' | nc -U "$SOCKET" >/dev/null
  say "Grant agentSwarm Desktop both permissions in System Settings → Privacy & Security:"
  say "  • Screen & System Audio Recording   • Accessibility"
  say "Then run this script again (it restarts the helper so the grants apply)."
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" 2>/dev/null || true
elif [[ "$helper_status" != *'"watching":true'* ]]; then
  launchctl kickstart -k "gui/${UID}/${LABEL}"
  say "Restarted agentSwarm Desktop so it can notice when you use the Mac"
else
  say "agentSwarm Desktop is running with Screen Recording and Accessibility"
fi
