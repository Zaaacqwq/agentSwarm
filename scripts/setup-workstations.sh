#!/bin/zsh
# One-time (re-runnable) admin setup for Hive workstations. See docs/decisions/0004.
#
#   sudo zsh scripts/setup-workstations.sh [N] [--remove-p0]   create/update ws-1..ws-N (default 2)
#   sudo zsh scripts/setup-workstations.sh --update-exec       rebuild and reinstall hive-exec only
#   sudo zsh scripts/setup-workstations.sh --uninstall         remove users, group, sudoers, hive-exec
#
# Everything is idempotent. hived itself never runs as root; this script is the only admin step.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
VOLUME="/Volumes/HiveWS"
LIBEXEC="/usr/local/libexec/hive"
EXEC_BIN="${LIBEXEC}/hive-exec"
SUDOERS="/etc/sudoers.d/hive"
GROUP="hive-ws"
OWNER="${SUDO_USER:-}"
count=2
remove_p0=0
mode="install"

for arg in "$@"; do
  case "$arg" in
    --remove-p0) remove_p0=1 ;;
    --update-exec) mode="update-exec" ;;
    --uninstall) mode="uninstall" ;;
    <->) count="$arg" ;;
    *) print -u2 "Unknown argument: $arg"; exit 64 ;;
  esac
done

say() { print -r -- "== $*"; }
die() { print -u2 -r -- "ERROR: $*"; exit 1; }

[[ $EUID -eq 0 && -n "$OWNER" && "$OWNER" != "root" ]] || die "Run with sudo from your normal account."
(( count >= 1 && count <= 20 )) || die "Workstation count must be 1-20."

owner_home="$(dscl . -read "/Users/${OWNER}" NFSHomeDirectory | awk '{print $2}')"
find_bun() {
  local candidate
  for candidate in "$(sudo -u "$OWNER" zsh -lc 'command -v bun' 2>/dev/null || true)" \
                   "${owner_home}/.cache/hive/bin/bun" \
                   "${ROOT}/.tmp/bootstrap/node_modules/bun/bin/bun.exe"; do
    [[ -n "$candidate" && -x "$candidate" ]] && { print -r -- "$candidate"; return 0; }
  done
  return 1
}

install_exec() {
  local bun
  bun="$(find_bun)" || die "Bun not found; run scripts/bootstrap.sh first."
  say "Building hive-exec with ${bun}"
  sudo -u "$OWNER" "$bun" build --compile --minify "${ROOT}/packages/priv-helper/src/main.ts" --outfile "${ROOT}/.tmp/hive-exec" >/dev/null
  mkdir -p "${LIBEXEC}/bin"
  install -o root -g wheel -m 0755 "${ROOT}/.tmp/hive-exec" "$EXEC_BIN"
  install -o root -g wheel -m 0755 "$bun" "${LIBEXEC}/bin/bun"
  codesign --force --sign - "$EXEC_BIN" >/dev/null 2>&1
  codesign --force --sign - "${LIBEXEC}/bin/bun" >/dev/null 2>&1
  chown root:wheel "$LIBEXEC" "${LIBEXEC}/bin" && chmod 0755 "$LIBEXEC" "${LIBEXEC}/bin"
  say "Installed ${EXEC_BIN} and ${LIBEXEC}/bin/bun (root:wheel 0755)"
}

check_volume() {
  mount | grep -q " on ${VOLUME} " || die "${VOLUME} is not mounted."
  diskutil info "$VOLUME" | grep -q "Owners:.*Enabled" || die "${VOLUME} does not have ownership enabled."
  if mount | grep " on ${VOLUME} " | grep -q noowners; then die "${VOLUME} is mounted with noowners."; fi
}

ensure_group() {
  if ! dscl . -read "/Groups/${GROUP}" >/dev/null 2>&1; then
    say "Creating group ${GROUP}" >&2
    dseditgroup -o create -r "Hive workstations" "$GROUP"
  fi
  dscl . -read "/Groups/${GROUP}" PrimaryGroupID | awk '{print $2}'
}

ensure_user() {
  local user="$1" gid="$2" n="$3"
  if ! dscl . -read "/Users/${user}" >/dev/null 2>&1; then
    say "Creating user ${user}"
    # A random password nobody knows; the account is also given a non-login shell below.
    sysadminctl -addUser "$user" -fullName "Hive Workstation ${n}" -password "$(openssl rand -base64 24)" -home "/Users/${user}" >/dev/null 2>&1
    createhomedir -c -u "$user" >/dev/null 2>&1 || true
  fi
  dscl . -create "/Users/${user}" PrimaryGroupID "$gid"
  dscl . -create "/Users/${user}" UserShell /usr/bin/false
  dscl . -create "/Users/${user}" IsHidden 1
  dseditgroup -o edit -a "$user" -t user "$GROUP"
  if dseditgroup -o checkmember -m "$user" staff >/dev/null 2>&1; then
    dseditgroup -o edit -d "$user" -t user staff >/dev/null 2>&1 || true
  fi
  mkdir -p "/Users/${user}"
  chown "${user}:${GROUP}" "/Users/${user}" && chmod 0700 "/Users/${user}"

  mkdir -p "${VOLUME}/ws/${user}"
  chown "${user}:${GROUP}" "${VOLUME}/ws/${user}" && chmod 0700 "${VOLUME}/ws/${user}"
  # Inbox: written by the workstation user, readable by the owner's group (staff), not by other workstations.
  mkdir -p "${VOLUME}/inbox/${user}.git"
  chown "${user}:staff" "${VOLUME}/inbox/${user}.git" && chmod 2750 "${VOLUME}/inbox/${user}.git"
}

write_sudoers() {
  local tmp
  tmp="$(mktemp)"
  print -r -- "# Managed by agentswarm scripts/setup-workstations.sh
${OWNER} ALL=(%${GROUP}) NOPASSWD: ${EXEC_BIN}" > "$tmp"
  visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; die "sudoers validation failed; nothing installed."; }
  install -o root -g wheel -m 0440 "$tmp" "$SUDOERS"
  rm -f "$tmp"
  visudo -c >/dev/null || die "System sudoers no longer validates; inspect ${SUDOERS}."
  say "Installed ${SUDOERS}"
}

layout_dirs() {
  chown root:wheel "$VOLUME" && chmod 0755 "$VOLUME"
  mkdir -p "${VOLUME}/ws" "${VOLUME}/inbox" "${VOLUME}/mirrors" "${VOLUME}/hived"
  chown root:wheel "${VOLUME}/ws" "${VOLUME}/inbox" && chmod 0755 "${VOLUME}/ws" "${VOLUME}/inbox"
  chown "${OWNER}:staff" "${VOLUME}/mirrors" && chmod 0755 "${VOLUME}/mirrors"
  chown "${OWNER}:staff" "${VOLUME}/hived" && chmod 0700 "${VOLUME}/hived"
}

verify() {
  local user="$1" out
  out="$(print -r -- '{"op":"info"}' | sudo -u "$OWNER" sudo -n -u "$user" "$EXEC_BIN" 2>&1 || true)"
  if [[ "$out" == *'"ok":true'* ]]; then say "Verified: ${OWNER} can run hive-exec as ${user}"; else die "Verification failed for ${user}: ${out}"; fi
}

case "$mode" in
  update-exec)
    install_exec
    exit 0
    ;;
  uninstall)
    say "Uninstalling (data on ${VOLUME} is left in place)"
    rm -f "$SUDOERS"
    for user in $(dscl . -list /Users | grep -E '^ws-[0-9]+$' || true); do
      say "Deleting user ${user}"; sysadminctl -deleteUser "$user" >/dev/null 2>&1 || true
    done
    dscl . -read "/Groups/${GROUP}" >/dev/null 2>&1 && dseditgroup -o delete "$GROUP"
    rm -rf "$LIBEXEC"
    say "Done. Remove workstation data with: sudo rm -rf ${VOLUME}/ws ${VOLUME}/inbox"
    exit 0
    ;;
esac

check_volume
layout_dirs
gid="$(ensure_group)"
for n in $(seq 1 "$count"); do ensure_user "ws-${n}" "$gid" "$n"; done
install_exec
write_sudoers
if (( remove_p0 )) && dscl . -read /Users/ws-hive-p0 >/dev/null 2>&1; then
  say "Deleting P0 test user ws-hive-p0"
  sysadminctl -deleteUser ws-hive-p0 >/dev/null 2>&1 || die "Could not delete ws-hive-p0"
fi
for n in $(seq 1 "$count"); do verify "ws-${n}"; done
say "Workstations ready: $(seq -s ' ' 1 "$count" | sed 's/[0-9]*/ws-&/g')"
