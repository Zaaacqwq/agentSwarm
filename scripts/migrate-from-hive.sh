#!/bin/zsh
# One-time: move an install made under the old "Hive" names to the agentSwarm names.
#   sudo zsh scripts/migrate-from-hive.sh
# Renames the HiveWS volume to SwarmWS (data stays), reinstalls under the new names with setup.sh,
# then removes the old group, sudoers rule and /usr/local/libexec/hive.
set -euo pipefail

say() { print -r -- "== $*"; }
die() { print -u2 -r -- "ERROR: $*"; exit 1; }
[[ $EUID -eq 0 && -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]] || die "Run with sudo from your own account."
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"

if diskutil info /Volumes/HiveWS >/dev/null 2>&1; then
  diskutil info /Volumes/SwarmWS >/dev/null 2>&1 && die "Both HiveWS and SwarmWS exist; resolve that by hand first."
  say "Renaming the HiveWS volume to SwarmWS"
  diskutil rename /Volumes/HiveWS SwarmWS >/dev/null
fi
if [[ -d /Volumes/SwarmWS/hived && ! -e /Volumes/SwarmWS/swarmd ]]; then
  say "Renaming the data directory hived to swarmd"
  mv /Volumes/SwarmWS/hived /Volumes/SwarmWS/swarmd
fi

say "Installing under the new names"
zsh "${ROOT}/scripts/setup.sh"

say "Removing the old names"
rm -f /etc/sudoers.d/hive
rm -rf /usr/local/libexec/hive
visudo -c >/dev/null || die "sudoers does not validate; inspect /etc/sudoers.d"
if dscl . -read /Groups/hive-ws >/dev/null 2>&1; then dseditgroup -o delete hive-ws; fi
for user in $(dscl . -list /Users | grep -E '^ws-[0-9]+$' || true); do
  [[ "$(id -gn "$user")" == "swarm-ws" ]] || die "${user}'s primary group is not swarm-ws"
done
say "Done: SwarmWS, swarm-ws, /usr/local/libexec/agentswarm, /etc/sudoers.d/agentswarm"
