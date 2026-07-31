/**
 * Print the AutoLaunchProtocolsFromOrigins plist fragment on stdout, for the one privileged
 * install step (`scripts/install-allowlist.sh`).
 *
 * A FILE rather than `npx tsx -e "…"`: an eval'd program is a virtual module with no
 * directory of its own, so a relative import of the policy table cannot resolve against the
 * repo (it looks beside `[eval]` and fails). Found the hard way on the first real run.
 *
 * Generated, never hand-copied — the installer and the doctor grader read the same table, so
 * they cannot drift into disagreeing about what should be on a host.
 */
import { autoLaunchProtocolsPlist } from "../src/remote/chrome-policy.js";

const xml = autoLaunchProtocolsPlist();
if (!xml) {
	console.error("AUTO_LAUNCH_PROTOCOLS is empty — nothing to install");
	process.exit(1);
}
process.stdout.write(xml);
