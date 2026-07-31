#!/bin/bash
# One-time, per Mac: allow the OAuth origin to launch the app's URL scheme without Chrome's
# "Open <App>?" confirmation.
#
# WHY THIS IS NOT IN `./run provision`. Every other Chrome policy this fleet sets is settable
# from the user domain, which the unattended provisioning path can reach. This one cannot:
# AutoLaunchProtocolsFromOrigins is MANDATORY-ONLY (Chromium documents "Can be recommended:
# No"), so it has to land in /Library/Managed Preferences, which needs root. The fleet Macs
# have no passwordless sudo — measured 2026-07-31 — so a human types a password once per Mac.
# `defaults write` to the user domain WOULD succeed and read back correctly while Chrome
# ignored it entirely, which is why chrome-policy.ts grades this key on LEVEL, not value.
#
# WHY IT MATTERS. Yarn's sign-in leaves through the main process: the page asks macOS to open
# https://y-prod-api.onrender.com's yarn:// deeplink, Chrome asks "Open Yarn?" first, and that
# dialog is browser chrome — a CDP page screencast cannot see or click it (Chrome refuses
# injected input on privileged UI, measured on mac3). With this policy the dialog never
# appears, and the whole sign-in stays on the CDP transport.
#
# RUN IT AS:  bash scripts/install-allowlist.sh mac1        (repeat per host)
# The password prompt is macOS's own, over your SSH session; nothing is stored.
#
# ONE-TIME: /Library/Managed Preferences survives reboots, Chrome updates and re-provisions.
# It does NOT survive a wipe of the Mac, and it is per-machine — a new fleet host needs it.
# Re-running is harmless (the write is idempotent).
#
# WORKS ON macOS 15 ONLY. On 26 that directory belongs to the MDM subsystem: the write
# succeeds, the bytes land, and Chrome manages nothing from them (see the gate below). Of
# this fleet that means mac1 today; mac2 and mac3 need real MDM enrolment or the SCK leg.
set -euo pipefail

host=${1:-}
[[ -n $host ]] || { echo "usage: bash scripts/install-allowlist.sh <mac1|mac2|mac3>"; exit 2; }

addr=$(python3 -c "
import json,sys
h=json.load(open('hosts.json'))['hosts']
m=[x for x in h if x['name']==sys.argv[1] or sys.argv[1] in x.get('aliases',[])]
if not m: sys.exit('unknown host: '+sys.argv[1])
print(m[0]['ssh']['user']+'@'+m[0]['ssh']['host'])
" "$host")

# The XML fragment is generated from AUTO_LAUNCH_PROTOCOLS so this script and the grader can
# never disagree about what SHOULD be there — the drift that makes a host report itself clean
# while the dialog is still armed.
xml=$(npx tsx scripts/print-allowlist.ts)
[[ -n $xml ]] || { echo "AUTO_LAUNCH_PROTOCOLS is empty — nothing to install"; exit 1; }


# macOS 26 gate. On 15.x a hand-written plist in /Library/Managed Preferences is honoured as
# forced policy; on 26 that directory belongs to the profile subsystem and a loose file dropped
# there manages NOTHING — `sudo defaults write` returns 0, the bytes land, and Chrome ignores
# them (measured across the fleet 2026-07-31, commit e51ffcc: mac1 on 15.5 honours a
# byte-identical file that mac2/mac3 on 26.4.1 discard).
#
# The route on 26 is a CONFIGURATION PROFILE, not MDM enrolment — an earlier reading of this
# said enrolment was required and that was wrong: none of the three Macs are enrolled
# (`profiles status -type enrollment` says No on all of them) yet a manually-installed
# .mobileconfig delivers BrowserSignin and SyncDisabled at MANDATORY level on mac3. So the
# allowlist belongs in that same profile, which is what this gate points at.
major=$(ssh -o ConnectTimeout=15 -i ~/.yarn-runner/id_ed25519 "$addr" 'sw_vers -productVersion' 2>/dev/null | cut -d. -f1)
if [[ ${major:-0} -ge 26 ]]; then
	cat >&2 <<EOF
$host runs macOS $major, where a hand-written plist in /Library/Managed Preferences is
ignored — the write succeeds and manages nothing.

Use the fleet's configuration profile instead. It already carries this allowlist:
    ssh $addr
    sudo profiles install -path /tmp/chrome-policy.mobileconfig
then quit and reopen Chrome (it re-reads platform policy on launch).

If the key still reads "Not set." afterwards, macOS kept the older payload despite the
version bump: remove the profile and install it again.
EOF
	exit 4
fi

# Refuse early without a terminal. `sudo` on the far side needs a pty to prompt, and ssh -t
# cannot allocate one when OUR stdin is not a tty — which is the case for anything run from a
# tool, a CI step, or Claude Code's `!` prefix. Without this guard the run gets as far as the
# SSH session before dying on sudo's own error, which names the -t flag rather than the real
# problem (there is no terminal to type into at all).
if [[ ! -t 0 ]]; then
	echo "This step needs a real terminal: it asks for ${host}'s admin password." >&2
	echo "Run it in your own terminal window (not through a tool or a pipe):" >&2
	echo "    cd $(pwd) && bash scripts/install-allowlist.sh $host" >&2
	exit 3
fi

echo "Installing the external-protocol allowlist on $host ($addr)."
echo "You will be asked for that Mac's admin password once."
echo

# -t: sudo needs a tty for its prompt. The plist is created if absent; a single key is written
# so anything else already managed there survives.
ssh -t -o ConnectTimeout=15 -i ~/.yarn-runner/id_ed25519 "$addr" "
  set -e
  sudo mkdir -p '/Library/Managed Preferences'
  sudo defaults write '/Library/Managed Preferences/com.google.Chrome' AutoLaunchProtocolsFromOrigins '$xml'
  sudo chmod 644 '/Library/Managed Preferences/com.google.Chrome.plist'
  echo
  echo 'installed. reading it back:'
  defaults read '/Library/Managed Preferences/com.google.Chrome' AutoLaunchProtocolsFromOrigins
"

echo
echo "Done. Quit and reopen Chrome on $host for it to take effect, then confirm with:"
echo "  ./run provision --doctor        # the allowlist line should disappear for $host"
