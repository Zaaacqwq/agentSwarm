#!/bin/zsh
# agentSwarm workstation setup. Run from your own account:
#   sudo zsh scripts/setup.sh                 install (8 workstations) or repair
#   sudo zsh scripts/setup.sh --update-exec   reinstall ws-exec and its Node runtime only
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
SUDOERS="/etc/sudoers.d/agentswarm"
GROUP="swarm-ws"
NODE_VERSION="24.22.0"
NODE_SHA256="75ddfb875bbd868ebe57536f4442225f54dd10f6d2178dd439de869a5c648dc3"   # node-v24.22.0-darwin-arm64.tar.xz
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
OWNER="${SUDO_USER:-}"
mode="install"

for arg in "$@"; do
  case "$arg" in
    --update-exec) mode="update-exec" ;;
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
  chown -R root:wheel "$LIBEXEC" && chmod 0755 "$LIBEXEC" "$EXEC" "$LAUNCH"
  say "Installed ${EXEC} and ${LAUNCH}"
}

write_sudoers() {
  local tmp user
  tmp="$(mktemp)"
  # One exact argument per workstation: ws-launch never sees anything else from you.
  {
    print -r -- "# Managed by agentswarm scripts/setup.sh"
    for user in $(workstation_users); do print -r -- "${OWNER} ALL=(root) NOPASSWD: ${LAUNCH} ${user}"; done
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
    dscl . -read "/Groups/${GROUP}" >/dev/null 2>&1 && dseditgroup -o delete "$GROUP"
    rm -f "$SUDOERS" && rm -rf "$LIBEXEC"
    visudo -c >/dev/null || warn "sudoers does not validate; inspect /etc/sudoers.d"
    say "Removed. The ${VOLUME_NAME} volume (database, mirrors, worktrees) is kept; delete it with: sudo diskutil apfs deleteVolume ${VOLUME_NAME}"
    ;;
  update-exec)
    install_node
    install_exec
    write_sudoers
    for user in $(workstation_users); do verify "$user"; done
    ;;
  install)
    preflight
    ensure_volume
    gid="$(ensure_group)"
    for n in $(seq 1 "$COUNT"); do ensure_user "ws-${n}" "$gid" "$n"; done
    install_node
    install_exec
    write_sudoers
    for n in $(seq 1 "$COUNT"); do verify "ws-${n}"; done
    say "Done. Next: npm run check (as yourself), then start swarmd."
    ;;
esac
