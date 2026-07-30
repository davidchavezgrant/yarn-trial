import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { type HostEntry, type Inventory, loadHosts } from "./hosts.js";
import { identityFile, knownHostsFile, runnerHome, sshArgv, writeKnownHosts } from "./ssh.js";
import { CREDENTIALS_FILENAME, describeCredentials, exportCredentials, provisionFromBundle } from "./team.js";

/**
 * First-time setup for one operator's machine: mint the fleet identity, pin the host keys,
 * and install the public key on each Mac.
 *
 * This exists because every other module here assumes it has already happened. `sshArgv`
 * names an identity file and a known_hosts that nothing else creates, and a teammate cloning
 * the repo has neither — so without this the fleet works only on the laptop that happened to
 * set it up by hand, which is exactly the failure the self-contained argv was meant to avoid.
 *
 * It is also the ONE step that cannot be automated end to end: installing a public key
 * requires proving you are already allowed in, and the only credential that does that is the
 * admin password. So this is interactive by design — it runs `ssh-copy-id`, which prompts,
 * and the password is typed by a person and never read, stored or logged here.
 *
 * Idempotent: a host that already accepts the key is reported and skipped, so re-running
 * after adding a fourth Mac costs one prompt, not four.
 */

/** Per-operator, not per-machine-pair: one identity reaches the whole fleet. */
const KEY_TYPE = "ed25519";

export interface EnrollStatus {
	host: string;
	state: "already-enrolled" | "enrolled" | "unreachable" | "unpinned" | "failed";
	detail?: string;
}

/**
 * Can this host already be reached with our key, without a password?
 *
 * `BatchMode=yes` is what makes this a test rather than a prompt: a host that would ask for
 * a password fails immediately instead of blocking, which is the difference between "not
 * enrolled" and "hung".
 */
export type Prober = (host: HostEntry) => boolean;

export function probeHost(host: HostEntry): boolean {
	try {
		execFileSync("ssh", [...sshArgv(host, ["true"])], { timeout: 8000, stdio: "ignore" });

		return true;
	} catch {
		return false;
	}
}

/**
 * Create the fleet identity if it does not exist. Returns true if a key was generated.
 *
 * No passphrase, deliberately: this key is used by an unattended UI poll every five seconds
 * and by a LaunchAgent-triggered dispatch, neither of which can answer a prompt. The
 * protection is that the key reaches only three machines that are already behind whatever
 * the colo requires, the private half never leaves ~/.yarn-runner (mode 0700), and revoking
 * it is deleting one line from three authorized_keys files.
 */
export function ensureIdentity(): boolean {
	fs.mkdirSync(runnerHome(), { recursive: true, mode: 0o700 });
	if (fs.existsSync(identityFile())) return false;

	execFileSync(
		"ssh-keygen",
		["-t", KEY_TYPE, "-N", "", "-C", `yarn-runner ${process.env.USER ?? "operator"}`, "-f", identityFile()],
		{ stdio: "ignore" },
	);

	return true;
}

/**
 * Install the public key on a host. Separated from the loop so the interactive step has one
 * name in a stack trace, and so a caller that already has a working channel can skip it.
 *
 * stdio is inherited rather than captured: ssh-copy-id's password prompt goes to the TTY,
 * and capturing it would leave the operator staring at a hang with no visible question.
 */
export function copyIdentity(host: HostEntry): void {
	execFileSync(
		"ssh-copy-id",
		[
			"-i", `${identityFile()}.pub`,
			"-o", "IdentitiesOnly=yes",
			// An operator with a populated ssh-agent has every one of those keys offered before
			// the password is ever reached, and sshd's MaxAuthTries (6) runs out first — the
			// failure surfaces as "Too many authentication failures", which reads like a wrong
			// password rather than a full queue. Nothing here wants the agent: the identity is
			// named explicitly one line up.
			"-o", "IdentityAgent=none",
			"-o", `UserKnownHostsFile=${knownHostsFile()}`,
			"-o", "GlobalKnownHostsFile=/dev/null",
			// The pin still applies here — this is the first real connection to the box, and it
			// is the one worth checking hardest. writeKnownHosts has already run, so a host that
			// fails this check is one whose key does not match what the inventory claims.
			"-o", "StrictHostKeyChecking=yes",
			"-p", String(host.ssh.port),
			`${host.ssh.user}@${host.ssh.host}`,
		],
		{ stdio: "inherit" },
	);
}

export interface EnrollOptions {
	probe?: Prober;
	copy?: (host: HostEntry) => void;
}

/**
 * Enroll every host in the inventory. Never throws for one host's sake: a colo box that is
 * powered off must not stop the other two from being set up, and the report says which is
 * which so the operator can re-run for just that one later.
 */
export function enrollHosts(inv: Inventory, opts: EnrollOptions = {}): EnrollStatus[] {
	const probe = opts.probe ?? probeHost;
	const copy = opts.copy ?? copyIdentity;

	return inv.hosts.map((host) => {
		// An unpinned host has no verified key, so there is nothing to check the far side
		// against. Copying a key to it would be handing credentials to whatever answered.
		if (!host.hostKey) return { host: host.name, state: "unpinned" as const, detail: "no pinned host key — pin it before enrolling" };

		if (probe(host)) return { host: host.name, state: "already-enrolled" as const };

		try {
			copy(host);
		} catch (err) {
			return { host: host.name, state: "failed" as const, detail: String((err as Error).message ?? err).split("\n")[0] };
		}

		return probe(host)
			? { host: host.name, state: "enrolled" as const }
			: { host: host.name, state: "unreachable" as const, detail: "key copied but the host still refuses it" };
	});
}

async function main(): Promise<void> {
	// The teammate path, and the reason it comes first: if a team bundle is present this
	// machine needs no password, no prompt and no terminal, so it must not be turned away by
	// the TTY guard below. Installing the shipped identity IS the whole of enrollment here.
	if (process.argv.includes("--export")) return exportMain();

	const provisioned = provisionFromBundle();
	if (provisioned) {
		console.log(`team credentials: ${provisioned.source}`);
		console.log(`  ssh identity ${provisioned.identity} — ${identityFile()} (${provisioned.fingerprint ?? "fingerprint unavailable"})`);
		console.log(`  model key ${provisioned.modelKey}`);
		console.log(
			provisioned.vncSeeded.length
				? `  screen sharing: password stored for ${provisioned.vncSeeded.join(", ")} — ./run signin <host> connects without a prompt`
				: "  screen sharing: no password in the bundle — you will be asked for one when signing an app in",
		);
		const pins = await writeKnownHosts(loadHosts());
		console.log(`  pinned ${pins.pinned.length} host key(s)`);
		console.log("\nnothing else to do — run ./run hosts to see the fleet.");

		return;
	}

	// Without a terminal, ssh-copy-id's prompt reads EOF and submits an empty password —
	// three times per host, by default. That is not a harmless no-op: the attempts count
	// against sshd's MaxAuthTries and, on a machine with any lockout policy, against the
	// account. Refusing here costs one line; discovering it costs three locked admins.
	if (!process.stdin.isTTY) {
		console.error("enroll needs a terminal: it types admin passwords into ssh-copy-id.");
		console.error("Run ./run enroll directly in a shell, not through a pipe, an editor task or an agent.");
		process.exit(1);
	}

	const inv = loadHosts();

	console.log(ensureIdentity() ? `generated ${identityFile()}` : `using existing ${identityFile()}`);

	// Pinning first: copyIdentity connects under StrictHostKeyChecking=yes, so without a
	// known_hosts written from the inventory the very first connection fails rather than
	// falling back to a prompt we deliberately disabled.
	const pins = await writeKnownHosts(inv);
	console.log(`known_hosts: ${pins.pinned.length} pinned${pins.unpinned.length ? `, ${pins.unpinned.length} unpinned (${pins.unpinned.join(", ")})` : ""}${pins.mismatched.length ? `, ${pins.mismatched.length} MISMATCHED (${pins.mismatched.join(", ")})` : ""}${pins.unreachable.length ? `, ${pins.unreachable.length} unreachable (${pins.unreachable.join(", ")})` : ""}`);
	if (pins.mismatched.length)
		console.log("  a mismatched host answered with a key that is not the pinned one — do not enroll it until you know why");

	console.log("\nenrolling (you will be prompted for each Mac's admin password once):");
	const results = enrollHosts(inv);
	for (const r of results) console.log(`  ${r.host}: ${r.state}${r.detail ? ` — ${r.detail}` : ""}`);

	if (results.some((r) => r.state === "enrolled" || r.state === "already-enrolled"))
		console.log(`\nto let teammates skip all of this: ./run enroll --export ${CREDENTIALS_FILENAME}`);
}

/**
 * `./run enroll --export [file]` — bundle this machine's working identity for the rest of the
 * team. Deliberately explicit rather than automatic: exporting a private key is a decision.
 */
function exportMain(): void {
	const target = process.argv[process.argv.indexOf("--export") + 1] ?? CREDENTIALS_FILENAME;
	if (target.startsWith("--")) throw new Error("usage: ./run enroll --export [file]");

	// Read from the environment, never from an argument: a secret on a command line is in the
	// shell history and in every `ps` on the machine.
	const vncPassword = process.env.YARN_VNC_PASSWORD;
	const written = exportCredentials(target, process.env.OPENROUTER_API_KEY, vncPassword);
	const { fingerprint } = describeCredentials();
	const extras = [process.env.OPENROUTER_API_KEY ? "OpenRouter key" : "", vncPassword ? "screen-sharing password" : ""].filter(Boolean);
	console.log(`wrote ${written} (0600) — fleet key ${fingerprint ?? "?"}${extras.length ? ` + ${extras.join(" + ")}` : ""}`);
	if (!vncPassword)
		console.log("Set YARN_VNC_PASSWORD to include the Macs' login password, so teammates never type it.");
	console.log("This file grants administrator SSH on every Mac in hosts.json. Ship it the way you");
	console.log("ship the OpenRouter key — never through git. A teammate drops it beside the app (or");
	console.log("in ~/.yarn-runner/) and it installs itself on first launch.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	main().catch((err) => {
		console.error(`enroll failed: ${err}`);
		process.exit(1);
	});
