#!/usr/bin/env bash
# Force Chrome sync and browser sign-in OFF on the fleet Macs, at MANDATORY policy level.
#
# Usage:  ./scripts/lock-chrome-policy.sh [mac1 mac2 mac3]     (default: all three)
#         ./scripts/lock-chrome-policy.sh --check              (report only, no sudo, no writes)
#
# WHY THIS IS NOT PART OF `./run provision`. Mandatory policy on macOS means a plist in
# /Library/Managed Preferences, which is root-owned. Provisioning is a non-interactive
# `BatchMode=yes` ssh that cannot answer a password prompt, and the fleet account has no
# passwordless sudo (measured 2026-07-31: `sudo -n` fails on all three, no MDM enrolment).
# So this is the one deliberately interactive step — you type the admin password per Mac,
# once, and the policy is enforced from then on. `--check` is the half that stays automatable.
#
# WHY IT MATTERS. All three Macs had three people's PERSONAL Google accounts signed into one
# shared Chrome profile with sync on and 801 saved credentials each — the identical count is
# sync doing its job, one vault replicated. `./run browser-wipe` cleared the local copies, but
# a wipe is not a fix: sign the same account back in with sync and Chrome re-downloads the lot.
#
#   SyncDisabled=true   no sync, and the user cannot re-enable it. Nothing re-downloads.
#   BrowserSignin=0     Chrome cannot be signed into a profile at all. Website OAuth is
#                       unaffected — only browser-level sign-in, which is the thing that
#                       pulls down a password vault.
#
# WHY MANDATORY AND NOT THE RECOMMENDED LEVEL THE PROVISIONER USES. Recommended sits BELOW the
# user store in Chrome's precedence, and sync writes into the user store — so a recommended
# value is exactly what a returning synced profile overrides. Mandatory sits above it. Also,
# neither key accepts the recommended level at all: Chromium's template declares no
# `can_be_recommended` for them, so a recommended write is rejected outright.
#
# TWO TRAPS THIS SCRIPT EXISTS TO AVOID, both hit for real on 2026-07-31:
#
#   1. `sudo defaults write "/Library/Managed Preferences/com.google.Chrome" …` SILENTLY DOES
#      NOTHING. `defaults` routes through cfprefsd, which owns that location and declines to
#      create files there; it exits 0 having written nothing. The plist must be written as a
#      FILE. Hence the heredoc below.
#   2. `defaults read com.google.Chrome SyncDisabled` then reports "does not exist" EVEN WHEN
#      THE POLICY IS WORKING, because `defaults` reads the user domain and ignores managed
#      preferences. Verifying with it would call a working policy broken. The check below uses
#      CFPreferencesAppValueIsForced — the same API Chrome's own policy loader calls
#      (policy_loader_mac.mm) — which is the only honest test.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

RUNNER_DIR=${YARN_RUNNER_DIR:-$HOME/.yarn-runner}
PLIST=/Library/Managed\ Preferences/com.google.Chrome.plist

check_only=false
hosts=()
for arg in "$@"; do
	case $arg in
		--check) check_only=true ;;
		-h | --help)
			sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*) hosts+=("$arg") ;;
	esac
done
[[ ${#hosts[@]} -gt 0 ]] || hosts=(mac1 mac2 mac3)

# Addresses come from hosts.json rather than being duplicated here — one inventory, and a host
# that gets re-addressed does not leave a stale literal in a shell script.
addr_of() {
	# Straight out of hosts.json — one inventory, so a re-addressed host cannot leave a stale
	# literal here. Plain JSON, so no module loader is involved (an earlier `tsx -e` version
	# resolved its imports against a virtual [eval] path and could not find them).
	node -e '
		const inv = require("./hosts.json");
		const want = process.argv[1];
		const h = inv.hosts.find((x) => x.name === want || (x.aliases ?? []).includes(want));
		if (!h) { console.error("unknown host: " + want); process.exit(1); }
		process.stdout.write(h.ssh.user + "@" + h.ssh.host);
	' "$1"
}

# The same pinning every other fleet connection uses: our identity, our known_hosts, and no
# ~/.ssh config, so the security properties do not depend on a file we do not control.
ssh_opts=(-F /dev/null -i "$RUNNER_DIR/id_ed25519" -o IdentitiesOnly=yes
	-o UserKnownHostsFile="$RUNNER_DIR/known_hosts" -o StrictHostKeyChecking=yes)

# The WRITE needs a TTY: sudo has to prompt, which is the whole reason this step is interactive.
ssh_write() { ssh "${ssh_opts[@]}" -t "$1" "$2"; }
# The CHECK must not ask for one. Nothing on the read path prompts, and -t without a terminal
# prints a "Pseudo-terminal will not be allocated" warning onto the output being parsed.
ssh_read() { ssh "${ssh_opts[@]}" "$1" "$2"; }

# The verifier: `defaults read` CANNOT answer this question (trap 2 above), so the check calls
# CFPreferencesAppValueIsForced — the same API Chrome's policy loader uses. Compiled here and
# copied over, because the fleet Macs have no PyObjC and no Swift toolchain: the binary is
# built on this machine and runs anywhere (the Swift runtime ships with macOS).
VERIFY_SRC=$(mktemp -t chrome-policy-verify-src).swift
VERIFY_BIN=$(mktemp -t chrome-policy-verify)
trap 'rm -f "$VERIFY_SRC" "$VERIFY_BIN"' EXIT
cat >"$VERIFY_SRC" <<'SWIFT'
import Foundation
let domain = "com.google.Chrome" as CFString
var parts: [String] = []
for key in ["SyncDisabled", "BrowserSignin"] {
	let v = CFPreferencesCopyAppValue(key as CFString, domain)
	let forced = CFPreferencesAppValueIsForced(key as CFString, domain)
	let shown = v == nil ? "nil" : String(describing: v!)
	parts.append("\(key)=\(shown) forced=\(forced)")
}
print(parts.joined(separator: "  "))
SWIFT
if ! swiftc -O "$VERIFY_SRC" -o "$VERIFY_BIN" 2>/dev/null; then
	echo "could not build the verifier (needs Xcode command line tools on THIS machine)" >&2
	exit 1
fi

for host in "${hosts[@]}"; do
	target=$(addr_of "$host")
	printf '\033[1m%s\033[0m (%s)\n' "$host" "$target"

	if [[ $check_only == false ]]; then
		echo "  writing the managed plist — you will be asked for the admin password"
		# tee, not `defaults`: see trap 1 above. The heredoc is quoted so nothing local expands.
		ssh_write "$target" 'sudo mkdir -p "/Library/Managed Preferences" && sudo tee "/Library/Managed Preferences/com.google.Chrome.plist" >/dev/null <<'\''PLIST'\''
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>SyncDisabled</key>
	<true/>
	<key>BrowserSignin</key>
	<integer>0</integer>
</dict>
</plist>
PLIST
sudo chown root:wheel "/Library/Managed Preferences/com.google.Chrome.plist"
sudo chmod 644 "/Library/Managed Preferences/com.google.Chrome.plist"'
	fi

	# Verify through the API Chrome actually uses. `forced=true` is the property that matters:
	# it means the value sits ABOVE the user store, so a returning synced profile cannot win.
	scp "${ssh_opts[@]}" -q "$VERIFY_BIN" "$target:/tmp/chrome-policy-verify" 2>/dev/null || true
	result=$(ssh_read "$target" "chmod +x /tmp/chrome-policy-verify && /tmp/chrome-policy-verify 2>&1; rm -f /tmp/chrome-policy-verify" || true)
	result=${result//$'\r'/}
	if [[ $result == *"SyncDisabled=1 forced=true"* && $result == *"BrowserSignin=0 forced=true"* ]]; then
		printf '  \033[32m✓\033[0m %s\n' "${result% }"
	else
		printf '  \033[31m✗\033[0m %s\n' "${result:-no answer — is Chrome installed?}"
		printf '    not enforced. Re-run without --check, or the plist did not land.\n'
	fi
done

cat <<'NOTE'

What this does NOT do: it leaves the autofill keys alone (those are written at recommended
level by `./run provision`, and they are separate). It does not touch profiles — use
`./run browser-wipe` for that. Reverse it with:

  sudo rm "/Library/Managed Preferences/com.google.Chrome.plist"
NOTE
