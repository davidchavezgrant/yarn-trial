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
xml=$(npx tsx -e "
import { autoLaunchProtocolsPlist } from './src/remote/chrome-policy.js';
process.stdout.write(autoLaunchProtocolsPlist() ?? '');
")
[[ -n $xml ]] || { echo "AUTO_LAUNCH_PROTOCOLS is empty — nothing to install"; exit 1; }

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
