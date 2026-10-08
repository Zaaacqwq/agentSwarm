#!/bin/zsh
# P0 experiment: can a dedicated APFS volume on the external disk isolate macOS users?
# Creates volume "HiveWS" in container disk7 (shares /Volumes/Data's free space),
# enables ownership on it, then probes cross-user access with ws-hive-p0.
# /Volumes/Data itself is never modified. Nothing is deleted automatically.
#
# Usage: sudo zsh scripts/p0-hivews-volume-probe.sh
set -u

CONTAINER="disk7"
VOLUME="HiveWS"
MOUNT="/Volumes/${VOLUME}"
WS_USER="ws-hive-p0"
OWNER="${SUDO_USER:-}"
pass_count=0
fail_count=0

say() { print -r -- "$*"; }
check() {
  # check <description> <expected: allow|deny> <command...>
  local desc="$1" expected="$2"; shift 2
  local outcome
  if "$@" >/dev/null 2>&1; then outcome="allow"; else outcome="deny"; fi
  if [[ "$outcome" == "$expected" ]]; then
    say "PASS  ${desc} (${outcome})"; pass_count=$((pass_count + 1))
  else
    say "FAIL  ${desc} (expected ${expected}, got ${outcome})"; fail_count=$((fail_count + 1))
  fi
}

# --- preconditions -----------------------------------------------------------
if [[ $EUID -ne 0 || -z "$OWNER" ]]; then say "Run with sudo from your own account."; exit 64; fi
if ! dscl . -read "/Users/${WS_USER}" >/dev/null 2>&1; then say "User ${WS_USER} not found."; exit 65; fi
if ! diskutil info /Volumes/Data | grep -q "APFS Container:.*${CONTAINER}$"; then
  say "/Volumes/Data is not in container ${CONTAINER}; refusing to guess."; exit 66
fi
if [[ -e "$MOUNT" ]] || diskutil info "$VOLUME" >/dev/null 2>&1; then
  say "Volume ${VOLUME} already exists; not creating another. Inspect it or remove it first."; exit 67
fi

# --- create and configure the volume -------------------------------------------
say "== Creating APFS volume ${VOLUME} in ${CONTAINER}"
diskutil apfs addVolume "$CONTAINER" APFS "$VOLUME" || { say "addVolume failed"; exit 70; }
diskutil enableOwnership "$MOUNT" || { say "enableOwnership failed"; exit 71; }
# Remount so the mount picks up the ownership setting (P0 suspected a stale noowners mount).
diskutil unmount "$MOUNT" && diskutil mount "$VOLUME" || { say "remount failed"; exit 72; }

say "== Volume state"
diskutil info "$MOUNT" | grep -E "Owners|Mount Point|File System Personality"
mount | grep " on ${MOUNT} "

chown root:wheel "$MOUNT" && chmod 755 "$MOUNT"
owner_dir="${MOUNT}/probe-${OWNER}"
ws_dir="${MOUNT}/probe-${WS_USER}"
mkdir -p "$owner_dir" "$ws_dir"
chown "$OWNER" "$owner_dir" && chmod 700 "$owner_dir"
print -r -- "owner-secret" > "${owner_dir}/secret.txt"
chown "$OWNER" "${owner_dir}/secret.txt" && chmod 600 "${owner_dir}/secret.txt"
chown "$WS_USER" "$ws_dir" && chmod 700 "$ws_dir"
sudo -u "$WS_USER" /bin/sh -c "echo ws-secret > '${ws_dir}/secret.txt' && chmod 600 '${ws_dir}/secret.txt'"

# --- probes --------------------------------------------------------------------
say "== Probes"
check "${WS_USER} reads ${OWNER}'s 0600 file"        deny  sudo -u "$WS_USER" /bin/cat "${owner_dir}/secret.txt"
check "${WS_USER} lists ${OWNER}'s 0700 dir"         deny  sudo -u "$WS_USER" /bin/ls "$owner_dir"
check "${WS_USER} writes into ${OWNER}'s dir"        deny  sudo -u "$WS_USER" /usr/bin/touch "${owner_dir}/intrusion"
check "${OWNER} reads ${WS_USER}'s 0600 file"        deny  sudo -u "$OWNER" /bin/cat "${ws_dir}/secret.txt"
check "${WS_USER} writes in its own dir"             allow sudo -u "$WS_USER" /usr/bin/touch "${ws_dir}/ok"
check "${WS_USER} runs git init in its own dir"      allow sudo -u "$WS_USER" -H /usr/bin/git init -q "${ws_dir}/repo"
check "${OWNER} reads own file (sanity)"             allow sudo -u "$OWNER" /bin/cat "${owner_dir}/secret.txt"

# --- cleanup of probe files only -------------------------------------------------
rm -rf "$owner_dir" "$ws_dir"

say "== Result: ${pass_count} passed, ${fail_count} failed"
if (( fail_count > 0 )); then
  say "Isolation NOT confirmed. The empty volume was left in place for inspection."
  say "To remove it:  sudo diskutil apfs deleteVolume ${VOLUME}"
  exit 1
fi
say "Isolation confirmed on ${MOUNT}. Next check: reboot, then confirm 'Owners: Enabled' persists:"
say "  diskutil info ${MOUNT} | grep Owners"
