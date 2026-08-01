import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { enrollHosts } from "../src/remote/control/enroll.js";
import { type FleetRow, fleetStatus, pickIdleHost, pickShortestQueue, stranded } from "../src/remote/control/fleet.js";
import { type HostEntry, type Inventory, HOSTS_SCHEMA, importHosts, loadHosts, parseRtsz, resolveHost } from "../src/remote/control/hosts.js";
import { applyCredentials, parseCredentials, TEAM_SCHEMA } from "../src/remote/control/team.js";
import { loadRunnerEnv } from "../src/remote/runner/spawn.js";
import { decodeSpec, encodeSpec, keyFingerprint, runnerArgv, sshArgv, tunnelArgv, writeKnownHosts } from "../src/remote/control/ssh.js";
import { host, inventory, withTemp } from "./fixtures.js";

/**
 * Fleet inventory, transport and status. Every test here is offline by construction: the SSH
 * call is an injected function and the only filesystem writes go to a temp dir. Nothing in
 * this file may touch ~/.ssh or ~/.yarn-runner — the real ones belong to the operator, and a
 * test that writes a known_hosts into them would be changing how their machine trusts a
 * remote.
 */

const PIN_A = "SHA256:724od0jL8u9KOWHaFi+t710VcSUmsFnN79hdOcoOI2c";
const PIN_B = "SHA256:eKIXn2OBstz+gBvH2u5WqOBBKv5YWQuXdLB8cfkTBfo";

/**
 * A Royal TSX workspace, reduced. Child order differs between the two connections and both
 * carry children this parser has never heard of, because that is the realistic failure mode
 * for a hand-rolled scan: Royal TSX writes ~40 children per element and reorders them across
 * versions. The credential elements are present precisely so a test would notice if anything
 * started reading them.
 */
const RTSZ = `<?xml version="1.0" encoding="utf-8"?>
<RTSZDocument>
  <RoyalFolder>
    <ID>1d3b</ID>
    <Name>Connections</Name>
  </RoyalFolder>
  <RoyalVNCConnection>
    <ID>c97a</ID>
    <Name>Lab Mac 1</Name>
    <URI>10.0.0.11</URI>
    <CredentialPassword>gAAAAAsecretblob==</CredentialPassword>
    <Port>5900</Port>
    <ScaleOSX>True</ScaleOSX>
  </RoyalVNCConnection>
  <RoyalVNCConnection>
    <Port>5901</Port>
    <SomeFutureElement>whatever</SomeFutureElement>
    <URI>10.0.0.12</URI>
    <Description />
    <Name>Lab Mac 2 &amp; spare</Name>
    <ID>326d</ID>
  </RoyalVNCConnection>
</RTSZDocument>
`;

test("parseRtsz__ReturnsHosts__When__DocumentHasVncConnections", () => {
	const entries = parseRtsz(RTSZ);
	assert.deepEqual(entries, [
		{ name: "Lab Mac 1", host: "10.0.0.11", vncPort: 5900 },
		{ name: "Lab Mac 2 & spare", host: "10.0.0.12", vncPort: 5901 },
	]);
	// The folder element is not a connection, and the password blob is not a field.
	assert.equal(JSON.stringify(entries).includes("Connections"), false);
	assert.equal(JSON.stringify(entries).includes("secretblob"), false);
});

test("parseRtsz__StripsBom__When__DocumentStartsWithBomMarker", () => {
	// Royal TSX writes a UTF-8 BOM. Left in place it becomes part of the first tag, every
	// match fails, and the import reports an empty document rather than an error.
	assert.deepEqual(parseRtsz(`\uFEFF${RTSZ}`), parseRtsz(RTSZ));
	assert.equal(parseRtsz(`\uFEFF${RTSZ}`).length, 2);
});

test("parseRtsz__ReturnsNothing__When__DocumentHasNoConnections", () => {
	assert.deepEqual(parseRtsz("<RTSZDocument><RoyalFolder><Name>Empty</Name></RoyalFolder></RTSZDocument>"), []);
});

test("importHosts__PreservesPinnedKey__When__EntryAlreadyExists", () => {
	// The load-bearing case: re-importing a document that carries no key material must not
	// downgrade a host that is already pinned. .rtsz has no fingerprint to offer, so a
	// merge that overwrote would silently turn a verified host into an unverified one.
	const existing = inventory({ ...host("mac1", "10.0.0.11", PIN_A), aliases: ["Lab Mac 1"] });
	const result = importHosts(RTSZ, existing, { user: "administrator" });

	assert.deepEqual(result.added, ["Lab Mac 2 & spare"]);
	assert.equal(result.skipped.length, 1);
	assert.match(result.skipped[0].reason, /pinned host key/);
	assert.equal(result.inventory.hosts.length, 2);
	assert.deepEqual(result.inventory.hosts[0], existing.hosts[0]);
	// New entries are explicitly unverified rather than defaulted to something connectable.
	assert.equal(result.inventory.hosts[1].hostKey, null);
	assert.equal(result.inventory.hosts[1].ssh.port, 22);
	assert.equal(result.inventory.hosts[1].vnc.port, 5901);
});

test("importHosts__MatchesByName__When__AddressChangedButLabelDidNot", () => {
	// Two of the fleet share a /24, so addresses are not identity; the alias catches a
	// machine whose address moved and stops it being added a second time.
	const existing = inventory({ ...host("mac2", "10.9.9.9", PIN_B), aliases: ["Lab Mac 2 & spare"] });
	const result = importHosts(RTSZ, existing, { user: "administrator" });
	assert.deepEqual(result.added, ["Lab Mac 1"]);
	assert.equal(result.skipped.length, 1);
});

test("loadHosts__Throws__When__InventoryIsMalformed", () => {
	withTemp("yarn-fleet-", (dir) => {
		const file = path.join(dir, "hosts.json");
		const cases: [unknown | string, RegExp][] = [
			["{not json", /not valid JSON/],
			[{ hosts: [] }, /schema/],
			[{ schema: HOSTS_SCHEMA, hosts: {} }, /"hosts" must be an array/],
			[{ schema: "yarn-runner/hosts@9", hosts: [] }, /not supported/],
			[{ schema: HOSTS_SCHEMA, hosts: [{ ...host("mac1", "10.0.0.1"), hostKey: "724od0" }] }, /fingerprint/],
			[{ schema: HOSTS_SCHEMA, hosts: [{ ...host("mac1", "10.0.0.1"), ssh: { host: "10.0.0.1", port: 0, user: "x" } }] }, /port/],
			[{ schema: HOSTS_SCHEMA, hosts: [{ ...host("mac1", "10.0.0.1"), ssh: { host: "10.0.0.1", port: 22 } }] }, /"user"/],
			[{ schema: HOSTS_SCHEMA, hosts: [host("mac1", "10.0.0.1"), host("MAC1", "10.0.0.2")] }, /duplicate host name/],
		];
		for (const [body, expected] of cases) {
			fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
			assert.throws(() => loadHosts(file), expected, `expected ${expected} for ${JSON.stringify(body)}`);
		}
	});
});

test("loadHosts__Throws__When__AnAddressOrLoginWouldBeReadAsShellSyntax", () => {
	// `user` and `host` are the only inventory strings that end up inside a command line a
	// REMOTE shell expands — rsync's destination is `user@host:path` and, unlike ssh's own
	// `user@host`, the whole string crosses the wire and is re-split on the far side.
	// rsyncDestination() re-checks it at the point of use; this rejects the FILE instead, which
	// is where the value entered. It can enter without anyone typing it: hosts.json is
	// generated by the .rtsz importer from a synced Royal TSX document.
	withTemp("yarn-fleet-", (dir) => {
		const file = path.join(dir, "hosts.json");
		const hostile: [string, string][] = [
			["10.0.0.1 -e sh", "a space ends the argument and starts a second one"],
			["$(id)", "command substitution"],
			["10.0.0.1;id", "a second command"],
			["../../etc", "path traversal, once it reaches a remote path"],
			["fe80::1", "IPv6 literal — the colon is rsync's own host/path separator"],
		];
		for (const [addr, why] of hostile) {
			fs.writeFileSync(file, JSON.stringify(inventory(host("mac1", addr))));
			assert.throws(() => loadHosts(file), /"host"/, `${JSON.stringify(addr)} should be refused: ${why}`);

			fs.writeFileSync(file, JSON.stringify(inventory({ ...host("mac1", "10.0.0.1"), ssh: { host: "10.0.0.1", port: 22, user: addr } })));
			assert.throws(() => loadHosts(file), /"user"/, `${JSON.stringify(addr)} should be refused as a login name: ${why}`);
		}

		// And the ordinary forms still load, since a check this strict is only safe if it does
		// not reject the fleet it is guarding.
		for (const addr of ["199.7.163.243", "mac-3.local", "lab_mac3"]) {
			fs.writeFileSync(file, JSON.stringify(inventory(host("mac1", addr))));
			assert.equal(loadHosts(file).hosts[0].ssh.host, addr);
		}
	});
});

test("loadHosts__ReadsCommittedInventory__When__RepoHostsFileIsUsed", () => {
	// The committed hosts.json is an input to every fleet call; a typo in it is a runtime
	// failure on three machines, so it is validated here rather than on first connect.
	const inv = loadHosts();
	assert.ok(inv.hosts.length >= 1);
	// Pinned-or-explicitly-unpinned rather than pinned-everywhere. All three currently carry
	// a fingerprint read off the machine's own /etc/ssh/ssh_host_ed25519_key.pub, but a Mac
	// imported from the Royal TSX document arrives with `null` and stays that way until
	// someone corroborates its key — fleetStatus refuses those rather than falling back to
	// trust-on-first-use. Demanding a pin here would only pressure the next person to paste
	// in whatever ssh-keyscan returned, which is the check being avoided.
	for (const h of inv.hosts) if (h.hostKey !== null) assert.match(h.hostKey, /^SHA256:/);
	assert.equal(resolveHost("mac1", inv).ssh.user, "administrator");
	assert.equal(resolveHost(inv.hosts[0].vnc.host, inv).name, inv.hosts[0].name);
	assert.throws(() => resolveHost("nope", inv), /unknown host/);
});

test("encodeSpec__RoundTripsVerbatim__When__TaskContainsShellMetacharacters", () => {
	// sshd joins the remote argv into one string and feeds it to a login shell, so a task
	// string is shell input on the far side. base64's alphabet shares no character with
	// shell syntax, which is the whole reason the spec is encoded rather than quoted.
	const task = `"; touch /tmp/pwned; #`;
	const spec = { task, app: "$(whoami)", flags: ["--record", "`id`", "a'b\\c\nd"] };
	const encoded = encodeSpec(spec);

	assert.deepEqual(decodeSpec(encoded), spec);
	assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/);

	const argv = sshArgv(host("mac1", "10.0.0.1"), runnerArgv("submit", spec));
	for (const arg of argv) {
		for (const meta of [";", "`", "$", "|", "&", "\n", "'", '"', ">", "<", "*"]) {
			assert.equal(arg.includes(meta), false, `argv entry ${JSON.stringify(arg)} carries shell metacharacter ${meta}`);
		}
	}
	assert.equal(argv.includes(encoded), true);
});

test("encodeSpec__RoundTripsTheArmFields__When__ABenchmarkSubmitCrosses", () => {
	// The benchmark arms cross the wire as typed spec fields — booleans stay booleans (the
	// runner's flag() gate refuses strings), and the recipe path is a plain relative string
	// the runner validates on its side. Nothing of it may surface on an argv position.
	const spec = {
		kind: "replay",
		app: "Yarn",
		backend: "cdp",
		noAx: true,
		axdomOff: false,
		noGrounding: true,
		useRecipe: false,
		noRescue: true,
		recipe: "docs/recipes/yarn.abc123.recipe.json",
	};
	assert.deepEqual(decodeSpec(encodeSpec(spec)), spec);

	const argv = sshArgv(host("mac1", "10.0.0.1"), runnerArgv("submit", spec));
	for (const token of ["--backend", "cdp", "--no-ax", "AXDOM", "NO_GROUNDING", "USE_RECIPE", "--no-rescue", "docs/recipes"])
		assert.equal(argv.some((a) => a.includes(token) && !/^[A-Za-z0-9+/=]+$/.test(a)), false, `${token} leaked onto the argv`);
});

test("tunnelArgv__CarriesTheSamePinning__When__ForwardingThePortalPort", () => {
	// A forwarded viewer stream through an unpinned tunnel would be the one unauthenticated
	// hop in an otherwise key-checked fleet, so the tunnel shares sshArgv's option block by
	// construction — this pins the properties that must never drift apart.
	const argv = tunnelArgv(host("mac1", "10.0.0.1"), 7682);

	assert.equal(argv.includes("StrictHostKeyChecking=yes"), true);
	assert.equal(argv.includes("IdentitiesOnly=yes"), true);
	assert.equal(argv.includes("BatchMode=yes"), true);
	// Multiplexing must be OFF: with a master socket already open for this host (the fleet
	// poll keeps one), ssh joins it as a client and REFUSES the forward — "Could not request
	// local forwarding" — leaving a port that accepts and instantly resets. Measured; it is
	// what made the sign-in viewer load into a dead socket and paint blank.
	assert.equal(argv.includes("ControlPath=none"), true);
	assert.equal(argv.includes("ControlMaster=no"), true);
	assert.equal(argv.includes("ExitOnForwardFailure=yes"), true);
	assert.equal(argv.includes("-L"), true);
	assert.equal(argv.includes("7682:127.0.0.1:7682"), true);
	assert.equal(argv.includes("-N"), true);
	// -N means the tunnel IS the job: the destination must be the last entry, with no remote
	// command after it for sshd to hand a shell.
	assert.equal(argv.at(-1), "administrator@10.0.0.1");
});

test("tunnelArgv__PutsAntiMuxOptionsBeforeTheBaseBlock__When__BothSetControlOptions", () => {
	// OpenSSH keeps the FIRST value it sees for a repeated option. sshBaseArgv sets
	// ControlMaster=auto and a real ControlPath, so the tunnel's anti-mux options are only
	// overrides if they PRECEDE the base block — appended after it they are dead letters, and
	// every tunnel silently joins the fleet poll's shared master (verified with `ssh -G`,
	// 2026-07-31: the effective config read `controlmaster auto` with the cm- socket path,
	// keepalives configured the mux client rather than the connection carrying the forward,
	// and killing a tunnel left its forward leaked in the master). Membership checks cannot
	// catch a regression here — only position can.
	const argv = tunnelArgv(host("mac1", "10.0.0.1"), 9222, 54321);
	const first = (pred: (a: string) => boolean): number => argv.findIndex(pred);

	const antiMaster = first((a) => a === "ControlMaster=no");
	const baseMaster = first((a) => a === "ControlMaster=auto");
	const antiPath = first((a) => a === "ControlPath=none");
	const basePath = first((a) => a.startsWith("ControlPath=") && a !== "ControlPath=none");

	assert.ok(antiMaster >= 0 && baseMaster >= 0 && antiPath >= 0 && basePath >= 0, "both the overrides and the base mux block must be present");
	assert.ok(antiMaster < baseMaster, "ControlMaster=no must precede the base ControlMaster=auto — first-value-wins would otherwise reinstate the mux");
	assert.ok(antiPath < basePath, "ControlPath=none must precede the base block's real socket path");
	// Each override rides its own -o, not a neighbouring option's.
	assert.equal(argv[antiMaster - 1], "-o");
	assert.equal(argv[antiPath - 1], "-o");
	// The localPort parameter: the local side binds the caller's port, the remote side the target's.
	assert.equal(argv.includes("54321:127.0.0.1:9222"), true);
});

test("tunnelArgv__Throws__When__ThePortIsNotForwardable", () => {
	for (const bad of [0, -1, 65536, 1.5, Number.NaN]) assert.throws(() => tunnelArgv(host("mac1", "10.0.0.1"), bad), /forwardable/);
});

test("runnerArgv__Throws__When__SubcommandIsNotABareToken", () => {
	// The API shape is the mitigation: there is no argv position a caller can interpolate
	// text into, so the attempt has to fail here rather than reach the remote shell.
	assert.throws(() => runnerArgv("status; rm -rf /"), /bare token/);
	assert.throws(() => runnerArgv("$(id)"), /bare token/);
	assert.deepEqual(runnerArgv("status"), ["runnerctl", "status", "--json"]);
});

test("sshArgv__NeverTouchesUserSshConfig__When__BuildingAnyCommand", () => {
	const prev = process.env.YARN_RUNNER_HOME;
	delete process.env.YARN_RUNNER_HOME; // exercise the real defaults, not a test override
	try {
		const argv = sshArgv(host("mac1", "10.0.0.1"), runnerArgv("status"));
		const joined = argv.join(" ");

		assert.equal(argv.includes("-i"), true);
		assert.match(joined, /-i \S*\.yarn-runner\/id_ed25519/);
		assert.equal(argv.includes("IdentitiesOnly=yes"), true);
		assert.equal(argv.includes("StrictHostKeyChecking=yes"), true);
		assert.ok(argv.some((a) => a.startsWith("UserKnownHostsFile=") && a.endsWith("/.yarn-runner/known_hosts")));
		assert.ok(argv.some((a) => a.startsWith("ControlPath=") && a.includes("/.yarn-runner/cm-")));
		assert.equal(argv.includes("ControlMaster=auto"), true);
		assert.equal(argv.includes("ControlPersist=60s"), true);
		// -F /dev/null: an operator's ~/.ssh/config can set ProxyJump, an IdentityAgent or a
		// laxer StrictHostKeyChecking, and none of this argv's guarantees may depend on it.
		assert.equal(joined.includes("-F /dev/null"), true);
		for (const arg of argv) assert.equal(/(^|[=\s])[^\s=]*\/\.ssh(\/|$)/.test(arg), false, `argv entry ${arg} points into ~/.ssh`);
	} finally {
		if (prev === undefined) delete process.env.YARN_RUNNER_HOME;
		else process.env.YARN_RUNNER_HOME = prev;
	}
});

/**
 * github.com's published ED25519 host key and its fingerprint — a public, stable pair, used
 * here only as a vector for the digest. Cross-checked against `ssh-keygen -lf`.
 */
const REAL_KEY_LINE = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const REAL_KEY_FP = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU";

test("keyFingerprint__MatchesOpenSsh__When__GivenAKnownHostsLine", () => {
	assert.equal(keyFingerprint(REAL_KEY_LINE), REAL_KEY_FP);
	// Marker-prefixed lines shift every field along; the key type is located, not assumed.
	assert.equal(keyFingerprint(`@cert-authority ${REAL_KEY_LINE}`), REAL_KEY_FP);
	assert.equal(keyFingerprint("garbage"), undefined);
});

test("writeKnownHosts__RefusesEntry__When__ScannedKeyDoesNotMatchPin", async () => {
	// This is what makes the first connection verified instead of trust-on-first-use: the
	// scanned key is untrusted input, and only a key whose own digest equals the pin is
	// written. A substituted key must produce no entry, never an accepted one.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yarn-fleet-"));
	const prev = process.env.YARN_RUNNER_HOME;
	process.env.YARN_RUNNER_HOME = dir;
	try {
		const inv = inventory(host("good", "10.0.0.1", REAL_KEY_FP), host("bad", "10.0.0.2", PIN_A), host("new", "10.0.0.3", null));
		const result = await writeKnownHosts(inv, {
			scan: async (h) => (h.name === "new" ? [] : [REAL_KEY_LINE.replace("github.com", h.ssh.host)]),
		});

		assert.deepEqual(result.pinned, ["good"]);
		assert.deepEqual(result.mismatched, ["bad"]);
		assert.deepEqual(result.unpinned, ["new"]);

		const written = fs.readFileSync(path.join(dir, "known_hosts"), "utf8");
		assert.equal(written.trim().split("\n").length, 1);
		assert.match(written, /^10\.0\.0\.1 ssh-ed25519 AAAAC3/);
		assert.equal(written.includes("10.0.0.2"), false);
	} finally {
		if (prev === undefined) delete process.env.YARN_RUNNER_HOME;
		else process.env.YARN_RUNNER_HOME = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("enrollHosts__SkipsHost__When__KeyAlreadyWorks", () => {
	// Enrollment has to be re-runnable: adding a fourth Mac should cost one password prompt,
	// not four. So a host that already answers to the key is never handed to ssh-copy-id.
	const working = new Set(["mac1"]);
	let copies = 0;
	const result = enrollHosts(inventory(host("mac1", "10.0.0.1"), host("mac2", "10.0.0.2")), {
		probe: (h) => working.has(h.name),
		copy: (h) => { copies++; working.add(h.name); },
	});
	assert.deepEqual(result.map((r) => r.state), ["already-enrolled", "enrolled"]);
	assert.equal(copies, 1);
});

test("enrollHosts__RefusesHost__When__HostKeyIsNotPinned", () => {
	// Copying a public key to an unpinned host means handing a credential to whatever
	// answered the address. It is reported, never attempted.
	let touched = false;
	const result = enrollHosts(inventory(host("new", "10.0.0.9", null)), {
		probe: () => { touched = true; return false; },
		copy: () => { touched = true; },
	});
	assert.equal(result[0].state, "unpinned");
	assert.equal(touched, false);
});

test("enrollHosts__IsolatesFailure__When__OneHostRefusesTheCopy", () => {
	// A powered-off colo box must not stop the other two being set up, and the report has to
	// name it so the operator can re-run for that one alone.
	const result = enrollHosts(inventory(host("up", "10.0.0.1"), host("down", "10.0.0.2")), {
		probe: (h) => false,
		copy: (h) => { if (h.name === "down") throw new Error("Connection refused\nsecond line"); },
	});
	assert.deepEqual(result.map((r) => r.state), ["unreachable", "failed"]);
	assert.equal(result[1].detail, "Connection refused");
});

test("writeKnownHosts__KeepsExistingEntry__When__ScanFails", async () => {
	// Running this offline used to truncate the file to empty, so a network blip cost every
	// pin and the next connection had nothing to verify against. Retained lines were each
	// written after matching the pin, so keeping them widens trust for no host.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yarn-fleet-"));
	const prev = process.env.YARN_RUNNER_HOME;
	process.env.YARN_RUNNER_HOME = dir;
	try {
		const inv = inventory(host("good", "10.0.0.1", REAL_KEY_FP));
		await writeKnownHosts(inv, { scan: async (h) => [REAL_KEY_LINE.replace("github.com", h.ssh.host)] });

		const result = await writeKnownHosts(inv, { scan: async () => { throw new Error("network is down"); } });
		assert.deepEqual(result.unreachable, ["good"]);
		assert.match(fs.readFileSync(path.join(dir, "known_hosts"), "utf8"), /^10\.0\.0\.1 ssh-ed25519 AAAAC3/);
	} finally {
		if (prev === undefined) delete process.env.YARN_RUNNER_HOME;
		else process.env.YARN_RUNNER_HOME = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("fleetStatus__IsolatesFailure__When__OneHostIsUnreachable", async () => {
	// One dead and one hanging host must cost their own rows and nothing else. A rejected
	// or stalled fan-out would blank the view for the two machines that are working, which
	// is exactly when an operator needs to see them.
	const inv = inventory(host("mac1", "10.0.0.1"), host("mac2", "10.0.0.2"), host("mac3", "10.0.0.3"));
	const started = Date.now();
	const rows = await fleetStatus({
		inventory: inv,
		timeoutMs: 120,
		run: async (h) => {
			if (h.name === "mac1") return { code: 0, stdout: JSON.stringify({ state: "busy", operator: "david", app: "Some App", elapsedSec: 42, tccOk: true }), stderr: "" };
			if (h.name === "mac2") return { code: 255, stdout: "", stderr: "ssh: connect to host 10.0.0.2 port 22: Operation timed out\n" };

			return new Promise(() => {}); // never settles
		},
	});

	assert.deepEqual(rows.map((r) => r.name), ["mac1", "mac2", "mac3"]);
	assert.deepEqual(rows[0], { name: "mac1", reachable: true, state: "busy", operator: "david", app: "Some App", elapsedSec: 42, tccOk: true });
	assert.equal(rows[1].reachable, false);
	assert.match(rows[1].reason ?? "", /Operation timed out/);
	assert.equal(rows[2].state, "unknown");
	assert.match(rows[2].reason ?? "", /timed out after 120ms/);
	assert.ok(Date.now() - started < 2000, "a hanging host stalled the fan-out");
});

test("fleetStatus__ReportsUnknown__When__RunnerIsMissingOrOutputIsNotJson", async () => {
	// runnerctl does not exist on the fleet yet, so "command not found" is the CURRENT
	// behaviour of every host and must be a row, not an exception.
	const inv = inventory(host("mac1", "10.0.0.1"), host("mac2", "10.0.0.2"), host("mac3", "10.0.0.3", null));
	const rows = await fleetStatus({
		inventory: inv,
		timeoutMs: 500,
		run: async (h) =>
			h.name === "mac1"
				? { code: 127, stdout: "", stderr: "bash: runnerctl: command not found\n" }
				: { code: 0, stdout: "Last login: Tue\n{ half", stderr: "" },
	});

	assert.equal(rows[0].state, "unknown");
	assert.match(rows[0].reason ?? "", /command not found/);
	assert.equal(rows[1].state, "unknown");
	assert.equal(rows[1].reachable, true, "the host answered — only its output was unusable");
	// An unpinned host is never contacted at all: connecting would mean accepting any key.
	assert.match(rows[2].reason ?? "", /no pinned host key/);
});

test("fleetStatus__ReadsTheFrame__When__ABannerPrecedesIt", async () => {
	// An MOTD or ssh warning ahead of the reply frame used to fail the whole-stdout parse,
	// so a healthy idle host degraded to "unknown" — which `--host auto` reads as "no idle
	// host in the fleet" while one is sitting there. Every other status reader already
	// tolerates the banner; this pins fleetStatus to the same rule.
	const rows = await fleetStatus({
		inventory: inventory(host("mac1", "10.0.0.1")),
		timeoutMs: 500,
		run: async () => ({
			code: 0,
			stdout: `Last login: Tue Jul 29 08:14:02 on ttys001\n${JSON.stringify({ state: "idle", tccOk: true })}\n`,
			stderr: "",
		}),
	});

	assert.deepEqual(rows[0], { name: "mac1", reachable: true, state: "idle", tccOk: true });
	assert.equal(pickIdleHost(rows)?.name, "mac1");
});

test("pickIdleHost__SkipsUnusableRows__When__FleetIsPartlyBusy", () => {
	const rows: FleetRow[] = [
		{ name: "mac1", reachable: true, state: "busy" },
		{ name: "mac2", reachable: false, state: "unknown" },
		{ name: "mac3", reachable: true, state: "idle" },
	];
	assert.equal(pickIdleHost(rows)?.name, "mac3");
	assert.equal(pickIdleHost(rows.slice(0, 2)), undefined);
});

test("fleetStatus__CarriesTheQueue__When__TheRunnerReportsOne", async () => {
	const rows = await fleetStatus({
		inventory: inventory(host("mac1", "10.0.0.1")),
		timeoutMs: 500,
		run: async () => ({
			code: 0,
			stdout: `${JSON.stringify({
				state: "busy",
				operator: "david",
				app: "Yarn",
				elapsedSec: 60,
				jobId: "j-running",
				queue: [
					{ jobId: "j-2", operator: "sam", app: "Yarn", kind: "explore", queuedAt: "2026-07-31T11:56:56Z" },
					{ notAJob: true },
				],
			})}\n`,
			stderr: "",
		}),
	});

	// The malformed entry is dropped — an id-less row can be neither followed nor cancelled.
	assert.deepEqual(rows[0].queue, [{ jobId: "j-2", operator: "sam", app: "Yarn", kind: "explore", queuedAt: "2026-07-31T11:56:56Z" }]);
});

test("fleetStatus__CarriesRecentOutcomes__When__TheRunnerReportsThem", async () => {
	// The pre-collect failure feed: these entries decide whether the dash paints a run FAILED
	// before any collect pass, so they get the queue's shape-check discipline — no string
	// jobId or a state outside the terminal set means dropped, not trusted.
	const rows = await fleetStatus({
		inventory: inventory(host("mac1", "10.0.0.1")),
		timeoutMs: 500,
		run: async () => ({
			code: 0,
			stdout: `${JSON.stringify({
				state: "idle",
				recent: [
					{ jobId: "j-dead", state: "failed", exitCode: 1, endedAt: "2026-08-01T10:05:00Z" },
					{ jobId: "j-fine", state: "done", exitCode: 0, endedAt: "2026-08-01T10:00:00Z" },
					{ jobId: "j-orphan", state: "orphaned", exitCode: null },
					{ state: "failed" }, // no jobId — cannot be matched to any entry
					{ jobId: "j-alive", state: "running" }, // not terminal — the current-job field owns it
					"garbage",
				],
			})}\n`,
			stderr: "",
		}),
	});

	assert.deepEqual(rows[0].recent, [
		{ jobId: "j-dead", state: "failed", exitCode: 1, endedAt: "2026-08-01T10:05:00Z" },
		{ jobId: "j-fine", state: "done", exitCode: 0, endedAt: "2026-08-01T10:00:00Z" },
		{ jobId: "j-orphan", state: "orphaned", exitCode: null },
	]);
});

test("pickShortestQueue__PrefersTheShortestLine__When__NobodyIsIdle", () => {
	const rows: FleetRow[] = [
		{ name: "mac1", reachable: true, state: "busy", queue: [{ jobId: "a" }, { jobId: "b" }] },
		{ name: "mac2", reachable: true, state: "busy" },
		{ name: "mac3", reachable: false, state: "unknown" },
	];
	assert.equal(pickShortestQueue(rows)?.name, "mac2");
	// Ties go to inventory order; an empty or unreachable fleet yields nothing.
	assert.equal(pickShortestQueue([rows[2]]), undefined);
	assert.equal(
		pickShortestQueue([
			{ name: "mac1", reachable: true, state: "busy" },
			{ name: "mac2", reachable: true, state: "busy" },
		])?.name,
		"mac1",
	);
});

test("parseCredentials__Rejects__When__BundleIsUnusable", () => {
	// Each of these reaches a teammate as "the app does not work" unless it is named here:
	// the bundle is the only thing between installing the app and having fleet access.
	assert.throws(() => parseCredentials("{nope"), /not valid JSON/);
	assert.throws(() => parseCredentials(JSON.stringify({ schema: "other", sshPrivateKey: "x PRIVATE KEY" })), /schema/);
	assert.throws(() => parseCredentials(JSON.stringify({ schema: TEAM_SCHEMA })), /no OpenSSH private key/);
	// A public key pasted where the private one belongs: plausible mistake, silent failure.
	assert.throws(() => parseCredentials(JSON.stringify({ schema: TEAM_SCHEMA, sshPrivateKey: "ssh-ed25519 AAAA" })), /no OpenSSH private key/);
});

test("applyCredentials__KeepsExistingKey__When__MachineIsAlreadyEnrolled", () => {
	// David ran enroll by hand before any bundle existed. Installing over that would swap the
	// access he has for access he may not have — "kept" is the correct outcome, not a failure.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yarn-team-"));
	const prev = process.env.YARN_RUNNER_HOME;
	process.env.YARN_RUNNER_HOME = dir;
	try {
		fs.writeFileSync(path.join(dir, "id_ed25519"), "MINE", { mode: 0o600 });
		const result = applyCredentials({ schema: TEAM_SCHEMA, sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n" });
		assert.equal(result.identity, "kept");
		assert.equal(fs.readFileSync(path.join(dir, "id_ed25519"), "utf8"), "MINE");
	} finally {
		if (prev === undefined) delete process.env.YARN_RUNNER_HOME;
		else process.env.YARN_RUNNER_HOME = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("applyCredentials__WritesKeyUnreadableByOthers__When__InstallingForATeammate", () => {
	// ssh refuses a key other local accounts can read, so a bundle installed at the default
	// umask would produce "permissions are too open" on first connect rather than access.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yarn-team-"));
	const prev = process.env.YARN_RUNNER_HOME;
	process.env.YARN_RUNNER_HOME = dir;
	try {
		const real = fs.readFileSync(genKey(dir), "utf8");
		fs.rmSync(path.join(dir, "seed"), { force: true });
		fs.rmSync(path.join(dir, "seed.pub"), { force: true });

		const result = applyCredentials({ schema: TEAM_SCHEMA, sshPrivateKey: real });
		assert.equal(result.identity, "installed");
		assert.equal(fs.statSync(path.join(dir, "id_ed25519")).mode & 0o077, 0, "the private key is readable by group or other");
		// The public half is derived rather than shipped, so the two cannot disagree.
		assert.match(fs.readFileSync(path.join(dir, "id_ed25519.pub"), "utf8"), /^ssh-ed25519 /);
		assert.match(result.fingerprint ?? "", /^SHA256:/);
	} finally {
		if (prev === undefined) delete process.env.YARN_RUNNER_HOME;
		else process.env.YARN_RUNNER_HOME = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("applyCredentials__WritesTheModelKeyWhereLaunchdWillFindIt__When__TheBundleCarriesOne", () => {
	// The runner on a fleet Mac starts from launchd: no login shell, no .zshrc, no exported
	// key. `<runnerDir>/env` is the only channel, so a bundle that installed ssh access and
	// nothing else would authenticate to the Mac and then fail every run at the model call.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yarn-team-"));
	const prevHome = process.env.YARN_RUNNER_HOME;
	const prevDir = process.env.YARN_RUNNER_DIR;
	process.env.YARN_RUNNER_HOME = dir;
	process.env.YARN_RUNNER_DIR = dir;
	try {
		const real = fs.readFileSync(genKey(dir), "utf8");
		fs.rmSync(path.join(dir, "seed"), { force: true });
		fs.rmSync(path.join(dir, "seed.pub"), { force: true });

		const written = applyCredentials({ schema: TEAM_SCHEMA, sshPrivateKey: real, openrouterKey: "sk-or-team" });
		assert.equal(written.modelKey, "written");
		assert.equal(loadRunnerEnv(dir).OPENROUTER_API_KEY, "sk-or-team");
		assert.equal(fs.statSync(path.join(dir, "env")).mode & 0o077, 0, "the model key is readable by group or other");

		// A host deliberately given its own key by hand must keep it: re-applying the bundle is
		// something the app does on EVERY launch, so an override that silently reverts would be
		// undone the next time anyone opened the app.
		fs.writeFileSync(path.join(dir, "env"), "OPENROUTER_API_KEY='per-host'\n", { mode: 0o600 });
		assert.equal(applyCredentials({ schema: TEAM_SCHEMA, sshPrivateKey: real, openrouterKey: "sk-or-team" }).modelKey, "kept");
		assert.equal(loadRunnerEnv(dir).OPENROUTER_API_KEY, "per-host");
	} finally {
		if (prevHome === undefined) delete process.env.YARN_RUNNER_HOME;
		else process.env.YARN_RUNNER_HOME = prevHome;
		if (prevDir === undefined) delete process.env.YARN_RUNNER_DIR;
		else process.env.YARN_RUNNER_DIR = prevDir;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * Two fleet Macs, enough to prove the per-host loop. `hostKey` is irrelevant to keychain seeding
 * and is only here because HostEntry requires the field to be a decision rather than a default.
 */
const VNC_HOSTS = [
	{ name: "mac1", ssh: { host: "10.0.0.1", port: 22, user: "administrator" }, vnc: { host: "10.0.0.1", port: 5900 }, hostKey: null },
	{ name: "mac2", ssh: { host: "10.0.0.2", port: 22, user: "administrator" }, vnc: { host: "10.0.0.2", port: 5901 }, hostKey: null },
];

test("applyCredentials__SeedsTheKeychainPerHost__When__TheBundleCarriesAScreenSharingPassword", () => {
	// The point of the whole strand: a teammate who has never been told the Macs' password can
	// still open Screen Sharing. If the item is filed under the wrong triple it is silently
	// ignored and they get a password prompt instead, so the arguments are asserted exactly.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yarn-team-"));
	const prev = process.env.YARN_RUNNER_HOME;
	process.env.YARN_RUNNER_HOME = dir;
	const calls: string[][] = [];
	try {
		const real = fs.readFileSync(genKey(dir), "utf8");
		const result = applyCredentials(
			{ schema: TEAM_SCHEMA, sshPrivateKey: real, vncPassword: "hunter2" },
			{ hosts: VNC_HOSTS, runSecurity: (args) => (calls.push(args), true) },
		);

		assert.deepEqual(result.vncSeeded, ["mac1", "mac2"]);
		assert.equal(calls.length, 2);
		const [first] = calls;
		assert.equal(first[0], "add-internet-password");
		assert.equal(first[first.indexOf("-s") + 1], "10.0.0.1");
		assert.equal(first[first.indexOf("-a") + 1], "administrator");
		// The trailing space is part of the FourCC. Without it Screen Sharing never finds the item.
		assert.equal(first[first.indexOf("-r") + 1], "vnc ");
		assert.equal(first[first.indexOf("-P") + 1], "5900");
		assert.equal(first[first.indexOf("-w") + 1], "hunter2");
		assert.ok(first.includes("-U"), "without -U a re-enroll leaves a stale duplicate item");
		// The second host must carry ITS port, not the first one's — the fleet is not uniform.
		assert.equal(calls[1][calls[1].indexOf("-P") + 1], "5901");
	} finally {
		if (prev === undefined) delete process.env.YARN_RUNNER_HOME;
		else process.env.YARN_RUNNER_HOME = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("applyCredentials__TouchesNoKeychain__When__TheBundleCarriesNoPassword", () => {
	// Most bundles will not carry one. Seeding must be entirely inert then — an empty
	// add-internet-password would overwrite a password the teammate had already saved by hand.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yarn-team-"));
	const prev = process.env.YARN_RUNNER_HOME;
	process.env.YARN_RUNNER_HOME = dir;
	const calls: string[][] = [];
	try {
		const real = fs.readFileSync(genKey(dir), "utf8");
		const result = applyCredentials(
			{ schema: TEAM_SCHEMA, sshPrivateKey: real },
			{ hosts: VNC_HOSTS, runSecurity: (args) => (calls.push(args), true) },
		);
		assert.deepEqual(result.vncSeeded, []);
		assert.equal(calls.length, 0);
	} finally {
		if (prev === undefined) delete process.env.YARN_RUNNER_HOME;
		else process.env.YARN_RUNNER_HOME = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("applyCredentials__StillInstallsTheIdentity__When__KeychainSeedingFails", () => {
	// A locked keychain is a password prompt later, not a broken install. If a refusing
	// `security` could fail the whole apply, one hardened laptop would lose fleet SSH too.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yarn-team-"));
	const prev = process.env.YARN_RUNNER_HOME;
	process.env.YARN_RUNNER_HOME = dir;
	try {
		const real = fs.readFileSync(genKey(dir), "utf8");
		fs.rmSync(path.join(dir, "seed"), { force: true });
		fs.rmSync(path.join(dir, "seed.pub"), { force: true });

		const result = applyCredentials(
			{ schema: TEAM_SCHEMA, sshPrivateKey: real, vncPassword: "hunter2" },
			{ hosts: VNC_HOSTS, runSecurity: () => false },
		);
		assert.equal(result.identity, "installed");
		assert.deepEqual(result.vncSeeded, [], "a host whose item did not store must not be reported as seeded");
	} finally {
		if (prev === undefined) delete process.env.YARN_RUNNER_HOME;
		else process.env.YARN_RUNNER_HOME = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("parseCredentials__CarriesTheScreenSharingPassword__When__TheBundleHasOne", () => {
	const bundle = { schema: TEAM_SCHEMA, sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n", vncPassword: "hunter2" };
	assert.equal(parseCredentials(JSON.stringify(bundle)).vncPassword, "hunter2");
	// Typed rather than coerced: a number here would reach `security` as "1234" and store a
	// password nobody can reproduce by typing it.
	assert.throws(() => parseCredentials(JSON.stringify({ ...bundle, vncPassword: 1234 })), /vncPassword must be a string/);
});

test("applyCredentials__TrustsOnlyExistingScreenSharingPaths__When__SeedingTheKeychain", () => {
	// The load-bearing bug this asserts against: `security add-internet-password` ABORTS the
	// whole command on the first -T path that does not exist (SecTrustedApplicationCreateFromPath
	// → No such file or directory), writing no item. The app moved to /System/Applications/
	// Utilities on modern macOS and left CoreServices behind, so naming BOTH made every seed
	// fail everywhere. Only existing paths may be trusted — asserted by checking each -T points
	// at a real file on THIS machine (whichever location it happens to have).
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yarn-team-"));
	const prev = process.env.YARN_RUNNER_HOME;
	process.env.YARN_RUNNER_HOME = dir;
	const calls: string[][] = [];
	try {
		const real = fs.readFileSync(genKey(dir), "utf8");
		applyCredentials(
			{ schema: TEAM_SCHEMA, sshPrivateKey: real, vncPassword: "hunter2" },
			{ hosts: VNC_HOSTS.slice(0, 1), runSecurity: (args) => (calls.push(args), true) },
		);
		const trusted = calls[0].flatMap((a, i) => (calls[0][i - 1] === "-T" ? [a] : []));
		for (const p of trusted) assert.ok(fs.existsSync(p), `a trusted -T path must exist on disk, got ${p}`);
		// A real macOS runner has exactly one Screen Sharing.app; CI without either just seeds
		// with no -T (still a valid item, only the ACL prompt is not pre-granted).
		assert.ok(trusted.length <= 1, "at most one Screen Sharing.app location can exist");
	} finally {
		if (prev === undefined) delete process.env.YARN_RUNNER_HOME;
		else process.env.YARN_RUNNER_HOME = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/** A real ed25519 key, because applyCredentials shells out to ssh-keygen to derive the public half. */
function genKey(dir: string): string {
	execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "test", "-f", path.join(dir, "seed")], { stdio: "ignore" });

	return path.join(dir, "seed");
}

test("stranded__MovesAQueuedJobToTheHostThatFreedFirst__When__AnotherMacIsIdle", () => {
	// The queue is per host and jobs never migrate, so the host holding the line may not be
	// the one that finishes first. Observed 2026-07-31: mac2 idle for six minutes while an
	// explore waited behind a long pass on mac1.
	const rows: any = [
		{ name: "mac1", reachable: true, state: "busy", jobId: "long-run", queue: [{ jobId: "waiting", queuedAt: "2026-07-31T22:32:00Z" }] },
		{ name: "mac2", reachable: true, state: "idle" },
		{ name: "mac3", reachable: true, state: "busy", jobId: "other" },
	];
	assert.deepEqual(stranded(rows), [{ job: rows[0].queue[0], from: "mac1", to: "mac2" }]);
});

test("stranded__MovesNothing__When__EveryHostIsBusy", () => {
	// Nothing to move to: queueing behind a busy host was the right call and stays right.
	const rows: any = [
		{ name: "mac1", reachable: true, state: "busy", queue: [{ jobId: "a", queuedAt: "2026-07-31T22:00:00Z" }] },
		{ name: "mac2", reachable: true, state: "busy" },
	];
	assert.deepEqual(stranded(rows), []);
});

test("stranded__NeverMovesMoreJobsThanIdleHosts__When__QueuesAreLong", () => {
	// One job per idle Mac, or a caller acting on the list would oversubscribe the free host
	// and recreate the queue it was draining.
	const rows: any = [
		{ name: "mac1", reachable: true, state: "busy", queue: [
			{ jobId: "a", queuedAt: "2026-07-31T22:00:00Z" },
			{ jobId: "b", queuedAt: "2026-07-31T22:05:00Z" },
			{ jobId: "c", queuedAt: "2026-07-31T22:10:00Z" },
		] },
		{ name: "mac2", reachable: true, state: "idle" },
	];
	const moves = stranded(rows);
	assert.equal(moves.length, 1);
	// And it is the one that has waited LONGEST, not whichever happens to be first in the array.
	assert.equal(moves[0].job.jobId, "a");
});

test("stranded__IgnoresUnreachableHosts__When__OneIsDown", () => {
	// An unreachable host is not idle capacity, however its last-known state reads.
	const rows: any = [
		{ name: "mac1", reachable: true, state: "busy", queue: [{ jobId: "a", queuedAt: "2026-07-31T22:00:00Z" }] },
		{ name: "mac2", reachable: false, state: "idle" },
	];
	assert.deepEqual(stranded(rows), []);
});
