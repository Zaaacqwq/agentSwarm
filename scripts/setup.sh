#!/bin/zsh
# agentSwarm workstation setup. Run from your own account:
#   sudo zsh scripts/setup.sh                 install (8 workstations) or repair
#   sudo zsh scripts/setup.sh --update-exec   reinstall ws-exec, its Node runtime and the CLI workers only
#   sudo zsh scripts/setup.sh --update-cli    (re)install the pinned Claude Code and Codex CLI workers only
#   sudo zsh scripts/setup.sh --update-tools  (re)install the simulator, browser and build tools only (R6)
#   sudo zsh scripts/setup.sh --firewall      (re)load the pf rules that keep workstations off the LAN and tailnet (R6)
#   sudo zsh scripts/setup.sh --uninstall     remove users, group, sudoers and /usr/local/libexec/agentswarm
#
# Creates: the SwarmWS APFS volume (ownership on) next to /Volumes/Data, the swarm-ws group, hidden users
# ws-1..ws-N, their directories, agentSwarm's own Node runtime, ws-exec, and one sudoers rule that lets you
# (and nothing else) start ws-exec as those users, each inside its own launchd session (ws-launch).
# swarmd itself never runs as root.
set -euo pipefail

COUNT=8
VOLUME_NAME="SwarmWS"
VOLUME="/Volumes/${VOLUME_NAME}"
DATA_VOLUME="/Volumes/Data"
LIBEXEC="/usr/local/libexec/agentswarm"
EXEC="${LIBEXEC}/ws-exec"
LAUNCH="${LIBEXEC}/ws-launch"
WSAPP="${LIBEXEC}/ws-app"
# R9: apps under test, staged by swarmd (you), read and run by workstation users.
APPS_DIR="${VOLUME}/desktop-apps"
SUDOERS="/etc/sudoers.d/agentswarm"
GROUP="swarm-ws"
NODE_VERSION="24.22.0"
NODE_SHA256="75ddfb875bbd868ebe57536f4442225f54dd10f6d2178dd439de869a5c648dc3"   # node-v24.22.0-darwin-arm64.tar.xz
# CLI workers (R4): the versions swarmd's event parsing was tested with. Copied from your own installs,
# but only if each file is exactly the pinned one (SHA-256) and signed by its vendor's Developer ID.
CLAUDE_VERSION="2.1.302"
CLAUDE_SHA256="5262ce9de86243fed0d21edc39b271555d56780d0112e2b194439fe1c6662d37"
CLAUDE_TEAM="Q6L2SF6YDW"   # Anthropic PBC
CODEX_VERSION="0.163.0"
CODEX_SHA256="8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31"
CODEX_RG_SHA256="27d09e29c478fddbfc750a2cb5fd06965bad0ea223e776f8667160a0de63c6e4"
CODEX_HOST_SHA256="79f123a85dbc61e8f5d0f0c050dfc3f4b81a8305d33a32b41e008b7f6e035698"   # codex-code-mode-host, next to codex
CODEX_TEAM="2DC432GLL2"    # OpenAI OpCo, LLC
CODEX_VENDOR="/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin"
# Eyes and hands (R6): downloaded from their publishers, checked against these hashes before anything is installed.
AXE_VERSION="1.8.0"
AXE_SHA256="7b76340b72e90d0f211bc7c4636f15009076eff07acef2f2b632b175debd8834"   # AXe-macOS-v1.8.0-universal.tar.gz
AXE_TEAM="BR6WD3M6ZD"
CHROMIUM_VERSION="156.0.8078.4"   # Chrome for Testing headless shell, the build Playwright 1.64.1 drives
CHROMIUM_SHA256="94e4337b70cbc5638f0935fbc46b9f242bc7416f657e3fbe924baf348404b53d"
PLAYWRIGHT_VERSION="1.64.1"
PLAYWRIGHT_SHA256="3af03703c967c95037454f2283f709d53ce804a4776d4219d319f5bbcc2a0185"   # playwright-core-1.64.1.tgz
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
OWNER="${SUDO_USER:-}"
mode="install"

for arg in "$@"; do
  case "$arg" in
    --update-exec) mode="update-exec" ;;
    --update-cli) mode="update-cli" ;;
    --update-tools) mode="update-tools" ;;
    --firewall) mode="firewall" ;;
    --uninstall) mode="uninstall" ;;
    *) print -u2 "Unknown argument: $arg"; exit 64 ;;
  esac
done

say() { print -r -- "== $*"; }
warn() { print -r -- "!! $*"; }
die() { print -u2 -r -- "ERROR: $*"; exit 1; }

[[ $EUID -eq 0 && -n "$OWNER" && "$OWNER" != "root" ]] || die "Run with sudo from your own account."
[[ "$(uname -m)" == "arm64" ]] || die "This script expects Apple silicon."
OWNER_HOME="$(dscl . -read "/Users/${OWNER}" NFSHomeDirectory | awk '{print $2}')"

# ---- checks that only warn -------------------------------------------------------------------
preflight() {
  local free_gb home_mode keys closed
  free_gb=$(( $(df -k / | awk 'NR==2 {print $4}') / 1024 / 1024 ))
  (( free_gb >= 10 )) || warn "The startup disk has only ${free_gb} GB free; macOS and Xcode misbehave when it fills up."
  home_mode="$(stat -f %Lp "$OWNER_HOME")"
  if (( (8#$home_mode & 8#007) != 0 )); then warn "${OWNER_HOME} is mode ${home_mode}: other users can list it. Suggested: chmod 750 ${OWNER_HOME}"; fi
  keys="$(find "$OWNER_HOME" -maxdepth 2 -type f \( -name '*.key' -o -name '*.pem' -o -name '*.p12' -o -name 'id_*' \) ! -name '*.pub' -perm -o+r 2>/dev/null || true)"
  [[ -z "$keys" ]] || warn "Readable by every user (suggest chmod 600):"$'\n'"$keys"
  closed="$(find /opt/homebrew/Cellar -mindepth 1 -maxdepth 1 -type d ! -perm -o+rx 2>/dev/null | xargs -n1 basename 2>/dev/null | tr '\n' ' ' || true)"
  [[ -z "$closed" ]] || warn "Homebrew packages workstations cannot use (mode 700): ${closed}"$'\n'"   Fix: find /opt/homebrew/Cellar -maxdepth 1 -mindepth 1 -type d ! -perm -o+rx -exec chmod go+rx {} +"
}

# ---- the volume ------------------------------------------------------------------------------
ensure_volume() {
  if ! diskutil info "$VOLUME" >/dev/null 2>&1; then
    mount | grep -q " on ${DATA_VOLUME} " || die "${DATA_VOLUME} is not mounted; SwarmWS lives in its APFS container."
    local container
    container="$(diskutil info "$DATA_VOLUME" | awk -F': *' '/APFS Container:/ {print $2}')"
    [[ "$container" == disk* ]] || die "Could not find the APFS container of ${DATA_VOLUME}."
    say "Creating APFS volume ${VOLUME_NAME} in ${container}"
    diskutil apfs addVolume "$container" APFS "$VOLUME_NAME" >/dev/null
  fi
  if ! diskutil info "$VOLUME" | grep -q "Owners:.*Enabled"; then
    say "Enabling ownership on ${VOLUME}"
    diskutil enableOwnership "$VOLUME" >/dev/null
  fi
  if ! mount | grep " on ${VOLUME} " | grep -qv noowners; then
    say "Remounting ${VOLUME} so ownership takes effect"
    diskutil unmount "$VOLUME" >/dev/null && diskutil mount "$VOLUME_NAME" >/dev/null
  fi
  diskutil info "$VOLUME" | grep -q "Owners:.*Enabled" || die "${VOLUME} still does not enforce ownership."
  if mount | grep " on ${VOLUME} " | grep -q noowners; then die "${VOLUME} is mounted with noowners."; fi
  chown root:wheel "$VOLUME" && chmod 0755 "$VOLUME"
  mkdir -p "${VOLUME}/ws" "${VOLUME}/inbox" "${VOLUME}/mirrors" "${VOLUME}/swarmd"
  chown root:wheel "${VOLUME}/ws" "${VOLUME}/inbox" && chmod 0755 "${VOLUME}/ws" "${VOLUME}/inbox"
  chown "${OWNER}:staff" "${VOLUME}/mirrors" && chmod 0755 "${VOLUME}/mirrors"
  chown "${OWNER}:staff" "${VOLUME}/swarmd" && chmod 0700 "${VOLUME}/swarmd"
  say "Volume ready: ${VOLUME} (ownership enforced)"
}

# ---- users -----------------------------------------------------------------------------------
ensure_group() {
  if ! dscl . -read "/Groups/${GROUP}" >/dev/null 2>&1; then
    dseditgroup -o create -r "agentSwarm workstations" "$GROUP"
  fi
  dscl . -read "/Groups/${GROUP}" PrimaryGroupID | awk '{print $2}'
}

ensure_user() {
  local user="$1" gid="$2" n="$3"
  if ! dscl . -read "/Users/${user}" >/dev/null 2>&1; then
    say "Creating user ${user}"
    sysadminctl -addUser "$user" -fullName "agentSwarm Workstation ${n}" -password "$(openssl rand -base64 24)" -home "/Users/${user}" >/dev/null 2>&1 \
      || die "Could not create ${user}"
    createhomedir -c -u "$user" >/dev/null 2>&1 || true
  fi
  dscl . -create "/Users/${user}" PrimaryGroupID "$gid"
  dscl . -create "/Users/${user}" UserShell /usr/bin/false
  dscl . -create "/Users/${user}" IsHidden 1
  dseditgroup -o edit -a "$user" -t user "$GROUP"
  dseditgroup -o checkmember -m "$user" staff >/dev/null 2>&1 && dseditgroup -o edit -d "$user" -t user staff >/dev/null 2>&1 || true
  mkdir -p "/Users/${user}"
  chown "${user}:${GROUP}" "/Users/${user}" && chmod 0700 "/Users/${user}"
  mkdir -p "${VOLUME}/ws/${user}"
  chown "${user}:${GROUP}" "${VOLUME}/ws/${user}" && chmod 0700 "${VOLUME}/ws/${user}"
  # The inbox: written by the workstation, read by swarmd (you are in staff).
  mkdir -p "${VOLUME}/inbox/${user}.git"
  chown "${user}:staff" "${VOLUME}/inbox/${user}.git" && chmod 2750 "${VOLUME}/inbox/${user}.git"
}

# ---- agentSwarm's Node runtime and ws-exec ---------------------------------------------------------
install_node() {
  local current=""
  [[ -x "${LIBEXEC}/node/bin/node" ]] && current="$("${LIBEXEC}/node/bin/node" --version 2>/dev/null || true)"
  if [[ "$current" == "v${NODE_VERSION}" ]]; then say "Node ${NODE_VERSION} already installed"; return; fi
  local tmp tarball
  tmp="$(mktemp -d)"
  tarball="${tmp}/node.tar.xz"
  say "Downloading Node ${NODE_VERSION} from nodejs.org"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.xz" -o "$tarball"
  [[ "$(shasum -a 256 "$tarball" | awk '{print $1}')" == "$NODE_SHA256" ]] || { rm -rf "$tmp"; die "Node download does not match the pinned SHA-256; nothing installed."; }
  tar -xJf "$tarball" -C "$tmp"
  mkdir -p "$LIBEXEC"
  rm -rf "${LIBEXEC}/node"
  mv "${tmp}/node-v${NODE_VERSION}-darwin-arm64" "${LIBEXEC}/node"
  rm -rf "$tmp"
  chown -R root:wheel "${LIBEXEC}/node" && chmod -R go-w "${LIBEXEC}/node"
  say "Installed Node $("${LIBEXEC}/node/bin/node" --version) in ${LIBEXEC}/node"
}

install_exec() {
  local src="${ROOT}/packages/ws-exec/src" dest="${LIBEXEC}/ws-exec.d" stage out f
  [[ -f "${src}/main.ts" ]] || die "ws-exec sources not found in ${src}"
  # Every source file except local-main.ts (the test entry), staged first and tried before it replaces
  # the installed copy: a missing module must not leave the workstations without a working ws-exec.
  stage="$(mktemp -d)"
  (cd "$src" && find . -name '*.ts' ! -name 'local-main.ts' -print) | while read -r f; do
    mkdir -p "${stage}/$(dirname "$f")"
    cp "${src}/${f}" "${stage}/${f}"
  done
  print -r -- '{ "type": "module" }' > "${stage}/package.json"
  out="$(print -r -- '{"op":"info"}' | /usr/bin/env -i "${LIBEXEC}/node/bin/node" --disable-warning=ExperimentalWarning "${stage}/main.ts" 2>&1 || true)"
  [[ "$out" == '{"ok":'* ]] || { rm -rf "$stage"; die "The new ws-exec does not start; nothing was replaced:"$'\n'"$out"; }
  rm -rf "$dest"
  mv "$stage" "$dest"
  chown -R root:wheel "$dest" && find "$dest" -type d -exec chmod 0755 {} + && find "$dest" -type f -exec chmod 0644 {} +
  cat > "$EXEC" <<EOF
#!/bin/sh
# Installed by agentswarm scripts/setup.sh. An empty environment: nothing from the caller reaches ws-exec.
exec /usr/bin/env -i /usr/local/libexec/agentswarm/node/bin/node --disable-warning=ExperimentalWarning ${dest}/main.ts
EOF
  # ws-launch: the only thing sudo runs as root. It checks the user, then runs ws-exec as that user in the
  # user's own launchd session; plain `sudo -u` would keep your GUI session (clipboard, Apple Events, screen).
  cat > "$LAUNCH" <<LAUNCHER
#!/bin/sh
# Installed by agentswarm scripts/setup.sh.
set -eu
fail() { printf '{"ok":false,"code":"bad_request","error":"%s"}\n' "\$1"; exit 0; }
user="\${1:-}"
case "\$user" in ws-[0-9]|ws-[0-9][0-9]) ;; *) fail "not a workstation user" ;; esac
/usr/bin/dscl . -read /Groups/${GROUP} GroupMembership 2>/dev/null | /usr/bin/grep -qw -- "\$user" || fail "\$user is not in ${GROUP}"
uid="\$(/usr/bin/id -u "\$user")"
exec /bin/launchctl asuser "\$uid" /usr/bin/sudo -n -H -u "\$user" ${EXEC}
LAUNCHER
  # ws-app (R9): an app under test runs as the run's workstation user, in your GUI session (so it has windows)
  # but with none of your files, keychain or clipboard. sudo runs it as root; it checks everything it is given.
  cat > "$WSAPP" <<WSAPP
#!/bin/sh
# Installed by agentswarm scripts/setup.sh.
#   ws-app ws-N open <path of a .app under ${APPS_DIR}>   starts it as ws-N and prints its pid
#   ws-app ws-N stop <pid>                                 ends that app (only a process of ws-N)
set -eu
fail() { echo "ws-app: \$1" >&2; exit 2; }
[ \$# -eq 3 ] || fail "usage: ws-app ws-N open|stop <arg>"
user="\$1"; cmd="\$2"; arg="\$3"
case "\$user" in ws-[0-9]|ws-[0-9][0-9]) ;; *) fail "not a workstation user" ;; esac
/usr/bin/dscl . -read /Groups/${GROUP} GroupMembership 2>/dev/null | /usr/bin/grep -qw -- "\$user" || fail "\$user is not in ${GROUP}"
uid="\$(/usr/bin/id -u "\$user")"
home="\$(/usr/bin/dscl . -read "/Users/\$user" NFSHomeDirectory | /usr/bin/awk '{print \$2}')"
case "\$cmd" in
  open)
    real="\$(/bin/realpath "\$arg")" || fail "no such app"
    case "\$real" in ${APPS_DIR}/*.app) ;; *) fail "not an app agentSwarm staged" ;; esac
    [ -d "\$real" ] || fail "not an app"
    exe="\$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "\$real/Contents/Info.plist")" || fail "no main program"
    case "\$exe" in ""|.*|*/*) fail "odd main program" ;; esac
    bin="\$real/Contents/MacOS/\$exe"
    [ -f "\$bin" ] && [ ! -L "\$bin" ] || fail "no main program"
    /usr/bin/sudo -n -u "\$user" /usr/bin/env -i HOME="\$home" USER="\$user" PATH=/usr/bin:/bin "\$bin" </dev/null >/dev/null 2>&1 &
    i=0
    while [ \$i -lt 100 ]; do
      pid="\$(/bin/ps -U "\$uid" -o pid=,comm= | while read -r p c; do [ "\$c" = "\$bin" ] && echo "\$p"; done | /usr/bin/head -1)"
      [ -n "\$pid" ] && { echo "\$pid"; exit 0; }
      i=\$((i + 1)); /bin/sleep 0.1
    done
    fail "the app did not start"
    ;;
  stop)
    case "\$arg" in ""|*[!0-9]*) fail "not a pid" ;; esac
    [ "\$(/bin/ps -o uid= -p "\$arg" | /usr/bin/tr -d ' ')" = "\$uid" ] || exit 0
    /bin/kill -TERM "\$arg" 2>/dev/null || true
    ( /bin/sleep 3; /bin/kill -KILL "\$arg" 2>/dev/null || true ) >/dev/null 2>&1 &
    ;;
  *) fail "unknown command" ;;
esac
WSAPP
  mkdir -p "$APPS_DIR" && chown "${OWNER}:staff" "$APPS_DIR" && chmod 0755 "$APPS_DIR"
  chown -R root:wheel "$LIBEXEC" && chmod 0755 "$LIBEXEC" "$EXEC" "$LAUNCH" "$WSAPP"
  say "Installed ${EXEC}, ${LAUNCH} and ${WSAPP}"
}

# ---- CLI workers (R4) -----------------------------------------------------------------------------
# Workstations cannot read your home or Homebrew's node_modules, so pinned copies live in ${LIBEXEC}/cli.
# Each file is copied first and checked as the copy (hash and vendor signature), so nothing can swap it
# between the check and the install; nothing from your account is ever executed as root.
pinned_copy() {  # source, destination, sha256, team id (empty: hash only)
  local src="$1" dst="$2" sha="$3" team="$4"
  [[ -f "$src" && ! -L "$src" ]] || return 1
  cp "$src" "$dst"
  [[ "$(shasum -a 256 "$dst" | awk '{print $1}')" == "$sha" ]] || { warn "${src} is not the pinned build (SHA-256 differs)"; return 1; }
  if [[ -n "$team" ]]; then
    codesign --verify --strict -R="anchor apple generic and certificate leaf[subject.OU] = \"${team}\"" "$dst" 2>/dev/null || { warn "${src} is not signed by team ${team}"; return 1; }
  fi
}

install_cli() {
  local dest="${LIBEXEC}/cli" stage
  mkdir -p "$dest"
  stage="$(mktemp -d)"
  if pinned_copy "${OWNER_HOME}/.local/share/claude/versions/${CLAUDE_VERSION}" "${stage}/claude" "$CLAUDE_SHA256" "$CLAUDE_TEAM"; then
    mkdir -p "${stage}/claude.d" && mv "${stage}/claude" "${stage}/claude.d/claude"
    rm -rf "${dest}/claude" && mv "${stage}/claude.d" "${dest}/claude"
    say "Installed Claude Code ${CLAUDE_VERSION} in ${dest}/claude"
  else
    warn "Claude Code ${CLAUDE_VERSION} not installed (install it as yourself with: claude install ${CLAUDE_VERSION}); skipped"
  fi
  mkdir -p "${stage}/codex/bin" "${stage}/codex/codex-path"
  if pinned_copy "${CODEX_VENDOR}/bin/codex" "${stage}/codex/bin/codex" "$CODEX_SHA256" "$CODEX_TEAM" \
    && pinned_copy "${CODEX_VENDOR}/bin/codex-code-mode-host" "${stage}/codex/bin/codex-code-mode-host" "$CODEX_HOST_SHA256" "$CODEX_TEAM" \
    && pinned_copy "${CODEX_VENDOR}/codex-path/rg" "${stage}/codex/codex-path/rg" "$CODEX_RG_SHA256" "$CODEX_TEAM"; then
    rm -rf "${dest}/codex" && mv "${stage}/codex" "${dest}/codex"
    say "Installed Codex ${CODEX_VERSION} in ${dest}/codex"
  else
    warn "Codex ${CODEX_VERSION} not installed (install it as yourself with: npm install -g @openai/codex@${CODEX_VERSION}); skipped"
  fi
  rm -rf "$stage"
  chown -R root:wheel "$dest" && find "$dest" -type d -exec chmod 0755 {} + && find "$dest" -type f -exec chmod 0755 {} +
}

# ---- eyes and hands (R6) --------------------------------------------------------------------------
# ${LIBEXEC}/tools: bin/ (xcodebuild, swift and swiftc wrappers, first on agents' PATH), axe/, chromium/,
# playwright-core/. A tool already at its pinned version is kept; anything new is downloaded and checked first.
fetch_pinned() {  # url, file, sha256
  curl -fsSL --retry 2 "$1" -o "$2" || { warn "Download failed: $1"; return 1; }
  [[ "$(shasum -a 256 "$2" | awk '{print $1}')" == "$3" ]] || { warn "$1 does not match the pinned SHA-256"; return 1; }
}

install_tools() {
  local dest="${LIBEXEC}/tools" stage tmp t
  stage="$(mktemp -d)"
  tmp="$(mktemp -d)"
  mkdir -p "${stage}/bin"
  cp "${ROOT}/packages/ws-exec/shims/xcodebuild" "${ROOT}/packages/ws-exec/shims/swift" "${ROOT}/packages/ws-exec/shims/swiftc" "${ROOT}/packages/ws-exec/shims/axe" "${stage}/bin/"
  # The browser driver runs inside the sandbox from here, never from a directory agents can write.
  cp "${ROOT}/packages/ws-exec/src/ops/browser-driver.ts" "${stage}/browser-driver.ts"

  if [[ "$(cat "${dest}/axe/.version" 2>/dev/null)" != "$AXE_VERSION" ]] \
    && fetch_pinned "https://github.com/cameroncooke/AXe/releases/download/v${AXE_VERSION}/AXe-macOS-v${AXE_VERSION}-universal.tar.gz" "${tmp}/axe.tgz" "$AXE_SHA256"; then
    mkdir -p "${tmp}/axe" && tar -xzf "${tmp}/axe.tgz" -C "${tmp}/axe"
    if codesign --verify --strict -R="anchor apple generic and certificate leaf[subject.OU] = \"${AXE_TEAM}\"" "${tmp}/axe/axe" 2>/dev/null; then
      print -r -- "$AXE_VERSION" > "${tmp}/axe/.version" && mv "${tmp}/axe" "${stage}/axe"
    else
      warn "AXe is not signed by team ${AXE_TEAM}; not installed"
    fi
  fi

  if [[ "$(cat "${dest}/chromium/.version" 2>/dev/null)" != "$CHROMIUM_VERSION" ]] \
    && fetch_pinned "https://cdn.playwright.dev/builds/cft/${CHROMIUM_VERSION}/mac-arm64/chrome-headless-shell-mac-arm64.zip" "${tmp}/chromium.zip" "$CHROMIUM_SHA256"; then
    mkdir -p "${tmp}/chromium" && unzip -q "${tmp}/chromium.zip" -d "${tmp}/chromium" \
      && print -r -- "$CHROMIUM_VERSION" > "${tmp}/chromium/.version" && mv "${tmp}/chromium" "${stage}/chromium"
  fi

  if [[ "$(cat "${dest}/playwright-core/.version" 2>/dev/null)" != "$PLAYWRIGHT_VERSION" ]] \
    && fetch_pinned "https://registry.npmjs.org/playwright-core/-/playwright-core-${PLAYWRIGHT_VERSION}.tgz" "${tmp}/pw.tgz" "$PLAYWRIGHT_SHA256"; then
    tar -xzf "${tmp}/pw.tgz" -C "$tmp" && print -r -- "$PLAYWRIGHT_VERSION" > "${tmp}/package/.version" && mv "${tmp}/package" "${stage}/playwright-core"
  fi

  # Whatever was not (re)installed keeps the copy already there: a failed download never removes a working tool.
  for t in axe chromium playwright-core; do
    [[ ! -d "${stage}/${t}" && -d "${dest}/${t}" ]] && cp -R "${dest}/${t}" "${stage}/${t}"
  done
  rm -rf "$tmp"
  # Nothing from an archive keeps setuid bits, and no link may point outside its tool.
  local link target
  find "$stage" -type l | while read -r link; do
    target="$(cd "$(dirname "$link")" && realpath "$(readlink "$link")" 2>/dev/null || true)"
    [[ "$target" == "${stage}/"* ]] || { warn "Removing a link that leaves the tools: ${link#${stage}/}"; rm -f "$link"; }
  done
  chown -R root:wheel "$stage" && chmod -R u-s,g-s,go-w,a+rX "$stage" && chmod 0755 "$stage" "${stage}/bin/"*
  # Swapped in by renames, so agents never see a half-installed directory.
  rm -rf "${dest}.old"
  [[ -d "$dest" ]] && mv "$dest" "${dest}.old"
  mv "$stage" "$dest"
  rm -rf "${dest}.old"
  for t in axe chromium playwright-core; do
    [[ -d "${dest}/${t}" ]] && say "Tools: ${t} $(cat "${dest}/${t}/.version")" || warn "${t} is not installed; agents cannot use it"
  done
}

# ---- firewall (R6) ---------------------------------------------------------------------------------
# Seatbelt filters by port only: it cannot keep agents off the LAN, the tailnet (your services behind
# tailscale serve), or a name that resolves there. pf can, per user: these rules match only the workstation
# users' sockets (by uid), refuse at once (TCP reset, ICMP unreachable), and leave everyone else alone.
PF_ANCHOR="com.apple/agentswarm"
PF_RULES="/etc/pf.anchors/agentswarm"
PF_DAEMON="/Library/LaunchDaemons/com.agentswarm.pf.plist"

install_firewall() {
  local uids user
  uids="$(for user in $(workstation_users); do id -u "$user"; done | paste -sd, -)"
  [[ -n "$uids" ]] || { warn "No workstation users; firewall rules not installed"; return; }
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<RULES
# Managed by agentswarm scripts/setup.sh: workstation users (uids ${uids}) may not reach the LAN, the tailnet,
# link-local or multicast addresses. Loopback (their own dev servers) and the internet stay open.
table <agentswarm_private> const { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16, 224.0.0.0/4, 0.0.0.0/8, fc00::/7, fe80::/10, fec0::/10, ff00::/8 }
block return out quick proto { tcp, udp } from any to <agentswarm_private> user { ${uids} }
RULES
  pfctl -nf "$tmp" -a "$PF_ANCHOR" >/dev/null 2>&1 || { rm -f "$tmp"; die "The firewall rules do not parse; nothing changed."; }
  install -o root -g wheel -m 0644 "$tmp" "$PF_RULES"
  rm -f "$tmp"
  # Loaded again at every boot: the main ruleset with Apple's anchor point loads by itself, ours does not.
  cat > "$PF_DAEMON" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.agentswarm.pf</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>/sbin/pfctl -E; /sbin/pfctl -a ${PF_ANCHOR} -f ${PF_RULES}</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
  chown root:wheel "$PF_DAEMON" && chmod 0644 "$PF_DAEMON"
  launchctl bootout system "$PF_DAEMON" >/dev/null 2>&1 || true
  launchctl bootstrap system "$PF_DAEMON" || warn "Could not register ${PF_DAEMON}"
  pfctl -E >/dev/null 2>&1 || true
  pfctl -a "$PF_ANCHOR" -f "$PF_RULES" 2>/dev/null || die "Loading the firewall rules failed"
  say "Firewall: workstation users (uids ${uids}) cannot reach the LAN or the tailnet"
}

# A workstation must be refused by the tailnet (Tailscale's own 100.100.100.100) and still reach the internet.
verify_firewall() {
  local user="$1" out
  out="$(print -r -- '{"op":"exec","scope":"cache","command":"curl -s -o /dev/null -m 5 http://100.100.100.100/; echo tailnet=$?; curl -s -o /dev/null -m 10 https://api.github.com/; echo internet=$?","timeoutMs":30000}' | sudo -u "$OWNER" sudo -n "$LAUNCH" "$user" 2>&1 || true)"
  if [[ "$out" == *"tailnet=7"* && "$out" == *"internet=0"* ]]; then say "Verified: ${user} is refused by the tailnet and reaches the internet"
  else warn "Firewall check for ${user} did not pass: ${out}"; fi
}

remove_firewall() {
  launchctl bootout system "$PF_DAEMON" >/dev/null 2>&1 || true
  pfctl -a "$PF_ANCHOR" -F all >/dev/null 2>&1 || true
  rm -f "$PF_DAEMON" "$PF_RULES"
}

write_sudoers() {
  local tmp user
  tmp="$(mktemp)"
  # One exact argument per workstation: ws-launch never sees anything else from you.
  {
    print -r -- "# Managed by agentswarm scripts/setup.sh"
    for user in $(workstation_users); do print -r -- "${OWNER} ALL=(root) NOPASSWD: ${LAUNCH} ${user}"; done
    # R9: open or stop an app under test as that workstation user (ws-app checks its arguments).
    for user in $(workstation_users); do print -r -- "${OWNER} ALL=(root) NOPASSWD: ${WSAPP} ${user} open *, ${WSAPP} ${user} stop *"; done
  } > "$tmp"
  visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; die "sudoers validation failed; nothing installed."; }
  install -o root -g wheel -m 0440 "$tmp" "$SUDOERS"
  rm -f "$tmp"
  visudo -c >/dev/null || die "System sudoers no longer validates; inspect ${SUDOERS}."
  say "Installed ${SUDOERS}"
}

verify() {
  local user="$1" out
  out="$(print -r -- '{"op":"info"}' | sudo -u "$OWNER" sudo -n "$LAUNCH" "$user" 2>&1 || true)"
  [[ "$out" == *"\"user\":\"${user}\""*'"sandbox":true'* ]] && say "Verified: ${OWNER} runs ws-exec as ${user}, sandboxed" || die "Verification failed for ${user}: ${out}"
}

workstation_users() { dscl . -list /Users | grep -E '^ws-[0-9]+$' || true; }

case "$mode" in
  uninstall)
    for user in $(workstation_users); do
      pkill -9 -u "$user" 2>/dev/null || true
      say "Deleting user ${user}"
      sysadminctl -deleteUser "$user" >/dev/null 2>&1 || true
      dscl . -read "/Users/${user}" >/dev/null 2>&1 && dscl . -delete "/Users/${user}"
      [[ -d "/Users/${user}" ]] && rm -rf "/Users/${user}"
    done
    remove_firewall
    dscl . -read "/Groups/${GROUP}" >/dev/null 2>&1 && dseditgroup -o delete "$GROUP"
    rm -f "$SUDOERS" && rm -rf "$LIBEXEC"
    visudo -c >/dev/null || warn "sudoers does not validate; inspect /etc/sudoers.d"
    say "Removed. The ${VOLUME_NAME} volume (database, mirrors, worktrees) is kept; delete it with: sudo diskutil apfs deleteVolume ${VOLUME_NAME}"
    ;;
  update-exec)
    install_node
    install_exec
    install_cli
    install_tools
    write_sudoers
    install_firewall
    for user in $(workstation_users); do verify "$user"; done
    verify_firewall "$(workstation_users | head -1)"
    ;;
  update-cli)
    install_cli
    ;;
  update-tools)
    install_tools
    ;;
  firewall)
    install_firewall
    verify_firewall "$(workstation_users | head -1)"
    ;;
  install)
    preflight
    ensure_volume
    gid="$(ensure_group)"
    for n in $(seq 1 "$COUNT"); do ensure_user "ws-${n}" "$gid" "$n"; done
    install_node
    install_exec
    install_cli
    install_tools
    write_sudoers
    install_firewall
    for n in $(seq 1 "$COUNT"); do verify "ws-${n}"; done
    verify_firewall "ws-1"
    say "Done. Next: npm run check (as yourself), then start swarmd."
    ;;
esac
