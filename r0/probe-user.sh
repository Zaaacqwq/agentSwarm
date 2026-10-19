#!/bin/zsh
# R0: a throwaway hidden user for testing what works without a login session
# (simulators, Claude Code and Codex on your subscriptions).
#
#   sudo zsh r0/probe-user.sh            create ws-probe and let you run commands as it
#   sudo zsh r0/probe-user.sh --remove   delete ws-probe and the sudoers rule
set -u

PROBE="ws-probe"
SUDOERS="/etc/sudoers.d/hive-r0"
say() { print -r -- "== $*"; }
die() { print -r -- "!! $*"; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo."
OWNER="${SUDO_USER:-}"
[[ -n "$OWNER" && "$OWNER" != "root" ]] || die "Run with sudo from your own account."

if [[ "${1:-}" == "--remove" ]]; then
  pkill -9 -u "$PROBE" 2>/dev/null
  sleep 1
  if dscl . -read "/Users/${PROBE}" >/dev/null 2>&1; then
    say "Deleting ${PROBE}"
    sysadminctl -deleteUser "$PROBE" >/dev/null 2>&1
    dscl . -read "/Users/${PROBE}" >/dev/null 2>&1 && dscl . -delete "/Users/${PROBE}"
  fi
  [[ -d "/Users/${PROBE}" ]] && rm -rf "/Users/${PROBE}"
  rm -f "$SUDOERS"
  visudo -c >/dev/null || say "WARNING: sudoers does not validate"
  say "Removed"
  exit 0
fi

if ! dscl . -read "/Users/${PROBE}" >/dev/null 2>&1; then
  say "Creating hidden user ${PROBE}"
  sysadminctl -addUser "$PROBE" -fullName "Hive R0 probe" -password "$(openssl rand -base64 24)" -home "/Users/${PROBE}" >/dev/null 2>&1 \
    || die "Could not create ${PROBE}"
  dscl . -create "/Users/${PROBE}" IsHidden 1
fi
createhomedir -c -u "$PROBE" >/dev/null 2>&1
[[ -d "/Users/${PROBE}" ]] || die "No home directory for ${PROBE}"

tmp="$(mktemp)"
print -r -- "${OWNER} ALL=(${PROBE}) NOPASSWD: ALL" > "$tmp"
visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; die "sudoers validation failed"; }
install -o root -g wheel -m 0440 "$tmp" "$SUDOERS"
rm -f "$tmp"
visudo -c >/dev/null || die "System sudoers no longer validates; inspect ${SUDOERS}"

sudo -u "$OWNER" sudo -n -u "$PROBE" /usr/bin/id -un >/dev/null 2>&1 && say "Verified: ${OWNER} can run commands as ${PROBE}" \
  || die "Verification failed"
say "Done. Remove later with: sudo zsh r0/probe-user.sh --remove"
