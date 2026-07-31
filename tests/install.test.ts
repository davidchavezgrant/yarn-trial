import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { HostEntry } from "../src/remote/control/hosts.js";
import {
	type AppSource,
	type InstallOptions,
	type InstallResult,
	type DownloadFacts,
	appPresence,
	installApp,
	installFleet,
	kindFromDownload,
	matchBundle,
	parseAppSource,
	resolveAppSource,
	parseBundleList,
	payloadRsyncArgv,
	presenceArgv,
	stageInstallFiles,
	INSTALL_STAGE_DIR,
} from "../src/remote/control/install.js";
import { REMOTE_CHECKOUT } from "../src/remote/control/provision.js";
import type { SshResult } from "../src/remote/control/ssh.js";
import { host, inTempDir, inventory, ok } from "./fixtures.js";

/**
 * Getting an app onto a fleet Mac. Offline by construction: the ssh call and the rsync call are
 * injected, the shell scripts are executed against fake `hdiutil`/`ditto`/`curl` on a PATH this
 * file builds, and every path involved is inside a temp dir it creates and removes. Nothing
 * here may touch a real Mac, ~/.ssh, ~/.yarn-runner or /Applications.
 *
 * The scripts are RUN rather than pattern-matched wherever the behaviour is what matters. A
 * regex over the script body proves a `trap` line was written; only executing it proves the
 * image is detached when the copy underneath it fails, and that is the property a stuck mount
 * on a headless colo Mac costs a support call.
 */

/** A name with a space is the NORMAL case; the quote and the semicolon are the adversarial part. */
const HOSTILE_NAME = 'Notion "Calendar"; rm -rf $HOME';

/** What a fleet Mac's `find` prints back. Paths only — the probe reads nothing else. */
function findOutput(...bundles: string[]): string {
	return ["/Applications", "/System/Applications", ...bundles].join("\n");
}

interface Recorder {
	opts: InstallOptions;
	/** Every remote argv, in order. The injection-safety assertions read this. */
	remote: string[][];
	rsync: string[][];
	/** Contents of the staged payload, captured while it still exists on disk. */
	staged: Map<string, string>;
	stageDir?: string;
}

interface DoubleSpec {
	/** Bundles the host reports before the install. */
	before?: string[];
	/** Bundles it reports after `install-app.sh` has run. Defaults to `before` plus the app. */
	after?: string[];
	reply?: (argv: string[]) => SshResult | undefined;
}

/**
 * A Mac that answers everything correctly, with hooks to make one answer wrong. `reply` is
 * consulted first and returning undefined falls through to the happy path, so each test states
 * only the failure it is about.
 */
function fleetDouble(app: string, spec: DoubleSpec = {}): Recorder {
	const rec: Recorder = { opts: {}, remote: [], rsync: [], staged: new Map() };
	// Every Mac has at least one bundle, so a probe that comes back with none is a broken probe
	// rather than an empty machine — appPresence grades it that way, and the double has to be
	// realistic enough to exercise the distinction rather than trip over it.
	const baseline = "/Applications/Safari.app";
	const before = spec.before ?? [];
	const after = spec.after ?? [...before, `/Applications/${app}.app`];
	let installed = false;

	rec.opts = {
		dest: "/Applications",
		run: async (h, argv) => {
			rec.remote.push(argv);
			const override = spec.reply?.(argv);
			if (override) return override;
			if (argv[0] === "true" || argv[0] === "mkdir") return ok();
			if (argv[0].endsWith("find")) return ok(findOutput(baseline, ...(installed ? after : before)));
			if (argv[1]?.endsWith("fetch.sh")) return ok("fetched 4210688 bytes\n");
			if (argv[1]?.endsWith("install-app.sh")) {
				installed = true;

				return ok(`installed=/Applications/${app}.app\n`);
			}

			return { code: 1, stdout: "", stderr: `unexpected remote argv ${JSON.stringify(argv)}` };
		},
		rsync: async (argv) => {
			rec.rsync.push(argv);
			const src = argv[argv.length - 2].replace(/\/$/, "");
			// The staging dir is deleted as soon as the sync returns, so its contents are read
			// here — this is the only moment they exist.
			if (fs.existsSync(path.join(src, "request"))) {
				rec.stageDir = src;
				for (const name of fs.readdirSync(src)) rec.staged.set(name, fs.readFileSync(path.join(src, name), "utf8"));
			}

			return ok();
		},
	};

	return rec;
}

function stepNames(result: InstallResult): string[] {
	return result.steps.map((s) => s.step);
}

const DMG: AppSource = { app: "Notion Calendar", kind: "dmg", url: "https://example.test/download?os=mac&arch=arm64" };

test("appPresence__ReportsTheBundlePath__When__TheAppIsInstalled", async () => {
	const row = await appPresence(host("mac1"), "Notion Calendar", {
		run: async () => ok(findOutput("/Applications/Notion Calendar.app", "/Applications/Safari.app")),
	});

	assert.equal(row.present, true);
	assert.equal(row.path, "/Applications/Notion Calendar.app");
	assert.equal(row.scanned, 2);
});

test("appPresence__ReportsAbsentWithNeighbours__When__NothingMatchesTheName", async () => {
	// The `near` list is the whole value of a miss: "Yarn" absent while "Yarn Recorder" is
	// present is a naming problem, and without the list it reads like an empty machine.
	const row = await appPresence(host("mac1"), "Yarn", {
		run: async () => ok(findOutput("/Applications/Yarn Recorder.app", "/Applications/Safari.app")),
	});

	assert.equal(row.present, false);
	assert.equal(row.path, undefined);
	assert.deepEqual(row.near, ["/Applications/Yarn Recorder.app"]);
});

test("appPresence__AnswersFromTheHost__When__TheFindExitsNonZero", async () => {
	// ~/Applications does not exist on most Macs, so `find` exits 1 with the complete answer
	// already on stdout. Grading the exit code would report every host as unknown.
	const row = await appPresence(host("mac1"), "Safari", {
		run: async () => ({ code: 1, stdout: findOutput("/Applications/Safari.app"), stderr: "find: Applications: No such file or directory\n" }),
	});

	assert.equal(row.present, true);
	assert.equal(row.reason, undefined);
});

test("appPresence__SendsOnlyFixedTokens__When__TheAppNameIsShellSyntax", async () => {
	let sent: string[] = [];
	const row = await appPresence(host("mac1"), HOSTILE_NAME, {
		run: async (_h, argv) => {
			sent = argv;

			return ok(findOutput("/Applications/Safari.app"));
		},
	});

	// sshd joins the remote argv into ONE string for a login shell, so a metacharacter in any
	// element is shell syntax on the far side. The name is matched locally and never sent — that
	// is the mitigation, not quoting.
	assert.equal(sent.join(" ").includes("Notion"), false, `the app name reached the wire: ${sent.join(" ")}`);
	assert.deepEqual(sent, presenceArgv());
	for (const arg of sent)
		for (const meta of [";", "`", "$", "|", "&", "\n", "'", '"', ">", "<", "*", "(", ")", " "])
			assert.equal(arg.includes(meta), false, `remote argv entry ${JSON.stringify(arg)} carries shell metacharacter ${meta}`);
	assert.equal(row.present, false);
});

test("appPresence__RefusesHost__When__HostKeyIsNotPinned", async () => {
	let touched = false;
	const row = await appPresence(host("new", "10.0.0.9", null), "Safari", {
		run: async () => {
			touched = true;

			return ok();
		},
	});

	// Whatever answers an unpinned address gets to decide what we believe is installed there.
	assert.equal(touched, false);
	assert.equal(row.present, false);
	assert.match(row.reason ?? "", /no pinned host key/);
});

test("matchBundle__MatchesCaseInsensitively__When__TheHostReportsADifferentCase", () => {
	// APFS is case-insensitive by default, so "Notion calendar.app" names the directory a run
	// would open.
	assert.equal(matchBundle("Notion Calendar", ["/Applications/Notion calendar.app"]).present, true);
	assert.equal(matchBundle("Safari", ["/Applications/Safari.app", "/Applications/Safari Technology Preview.app"]).path, "/Applications/Safari.app");
});

test("parseBundleList__KeepsOnlyBundles__When__FindPrintsItsRoots", () => {
	assert.deepEqual(parseBundleList(findOutput("/Applications/Safari.app")), ["/Applications/Safari.app"]);
});

test("parseAppSource__Throws__When__TheUrlIsNotHttps", () => {
	// A URL is attacker-influenced data and both of these fetch.
	assert.throws(() => parseAppSource("Notion Calendar", "http://example.test/app.dmg"), /must be https/);
	assert.throws(() => parseAppSource("Notion Calendar", "file:///tmp/app.dmg"), /must be https/);
	// And the scheme is refused BEFORE the suffix: the scheme is the security check.
	assert.throws(() => parseAppSource("Notion Calendar", "http://example.test/app.exe"), /must be https/);
});

test("parseAppSource__KeepsTheQueryString__When__TheLinkIsARedirector", () => {
	// `&` is shell syntax and is also how every real release link separates its parameters, so
	// the URL must survive intact — it travels in the request file, not on a command line.
	const source = parseAppSource("Notion Calendar", "https://example.test/download.dmg?os=mac&arch=arm64");
	assert.equal(source.kind, "dmg");
	assert.equal(source.url, "https://example.test/download.dmg?os=mac&arch=arm64");
});

test("parseAppSource__Throws__When__TheArchiveIsNotSomethingMacOsOpens", () => {
	assert.throws(() => parseAppSource("Thing", "https://example.test/thing.pkg"), /expected a \.dmg, \.zip or \.app/);
});

/** A probe that answers from a table and records what it was asked, so no test opens a socket. */
function probeDouble(facts: DownloadFacts): { probe: (url: string) => Promise<DownloadFacts>; asked: string[] } {
	const asked: string[] = [];

	return {
		asked,
		probe: async (url) => {
			asked.push(url);

			return facts;
		},
	};
}

test("kindFromDownload__PrefersTheHeader__When__ThePathIsOpaque", () => {
	// The real shape of the Yarn link: a GitHub asset URL whose path is a UUID, with the only
	// mention of "dmg" in the Content-Disposition.
	assert.equal(
		kindFromDownload({
			finalUrl: "https://release-assets.githubusercontent.com/x/69183376-c521-4ef4-b386-7e8a38b6c007?sp=r&sig=abc",
			disposition: "attachment; filename=Yarn-0.0.119-arm64.dmg",
		}),
		"dmg",
	);
});

test("kindFromDownload__FallsBackToTheFinalUrl__When__ThereIsNoDisposition", () => {
	assert.equal(kindFromDownload({ finalUrl: "https://cdn.example.test/builds/Thing-1.2.zip" }), "zip");
});

test("kindFromDownload__ReadsTheBasename__When__TheFilenameIsQuotedOrTraversing", () => {
	assert.equal(kindFromDownload({ finalUrl: "https://x.test/d", disposition: 'attachment; filename="My App.dmg"' }), "dmg");
	// Server-controlled and reaching path.extname: cut to a basename rather than trusted.
	assert.equal(kindFromDownload({ finalUrl: "https://x.test/d", disposition: 'attachment; filename="../../etc/thing.zip"' }), "zip");
	assert.equal(kindFromDownload({ finalUrl: "https://x.test/d", disposition: "attachment; filename*=UTF-8''Caf%C3%A9.dmg" }), "dmg");
});

test("kindFromDownload__ReturnsNothing__When__NeitherSourceNamesAnArchive", () => {
	assert.equal(kindFromDownload({ finalUrl: "https://x.test/download", disposition: "attachment; filename=setup.pkg" }), undefined);
});

test("resolveAppSource__AsksNobody__When__TheUrlAlreadyNamesTheArchive", async () => {
	const { probe, asked } = probeDouble({ finalUrl: "https://never.test/x.zip" });
	const source = await resolveAppSource("Thing", "https://example.test/thing.dmg", probe);

	assert.equal(source.kind, "dmg");
	assert.deepEqual(asked, []);
});

test("resolveAppSource__KeepsTheOriginalUrl__When__TheKindCameFromARedirect", async () => {
	// The resolved asset URL is signed and expires within the hour; three Macs must each follow
	// the chain themselves rather than share one stale credential.
	const { probe } = probeDouble({
		finalUrl: "https://release-assets.githubusercontent.com/x/uuid?sig=abc",
		disposition: "attachment; filename=Yarn-0.0.119-arm64.dmg",
	});
	const source = await resolveAppSource("Yarn", "https://dl.yarn.so/download/mac_arm64", probe);

	assert.equal(source.kind, "dmg");
	assert.equal(source.url, "https://dl.yarn.so/download/mac_arm64");
});

test("resolveAppSource__Throws__When__TheUrlIsNotHttps", async () => {
	const { probe, asked } = probeDouble({ finalUrl: "https://x.test/x.dmg" });
	// The scheme check still precedes the network: an http link is refused without being fetched.
	await assert.rejects(() => resolveAppSource("Thing", "http://example.test/download", probe), /must be https/);
	assert.deepEqual(asked, []);
});

test("resolveAppSource__SaysWhereItLooked__When__TheServerNamesNoArchive", async () => {
	const { probe } = probeDouble({ finalUrl: "https://cdn.example.test/blob", disposition: "attachment; filename=setup.pkg" });
	await assert.rejects(
		() => resolveAppSource("Thing", "https://example.test/download", probe),
		/redirects to https:\/\/cdn\.example\.test\/blob and offers .*setup\.pkg/,
	);
});

test("resolveAppSource__ReportsTheProbeFailure__When__TheServerCannotBeAsked", async () => {
	await assert.rejects(
		() =>
			resolveAppSource("Thing", "https://example.test/download", async () => {
				throw new Error("getaddrinfo ENOTFOUND example.test");
			}),
		/asking the server where it goes failed — getaddrinfo ENOTFOUND/,
	);
});

test("installApp__SendsNothing__When__TheUrlIsNotHttps", async () => {
	const rec = fleetDouble("Notion Calendar");
	const result = await installApp(host("mac1"), { app: "Notion Calendar", kind: "dmg", url: "http://example.test/app.dmg" }, rec.opts);

	assert.equal(result.ok, false);
	assert.match(result.steps[0].detail ?? "", /must be https/);
	// Not "it failed to fetch": nothing was sent. The scheme is checked before the host is
	// reached, because the fetch happens on a machine three people share.
	assert.deepEqual(rec.remote, []);
	assert.deepEqual(rec.rsync, []);
});

test("installApp__CompletesEveryStep__When__TheHostAnswers", async () => {
	const rec = fleetDouble("Notion Calendar");
	const result = await installApp(host("mac1"), DMG, rec.opts);

	assert.equal(result.ok, true, JSON.stringify(result.steps));
	assert.deepEqual(stepNames(result), ["reach", "check", "stage", "deliver", "install", "verify"]);
	// The last row is the only one that means anything: a fresh probe found a launchable bundle.
	assert.equal(result.presence?.path, "/Applications/Notion Calendar.app");
	assert.equal(result.steps[5].detail, "/Applications/Notion Calendar.app");
});

test("installApp__CarriesTheNameAndUrlInAFile__When__BothAreShellSyntax", async () => {
	const rec = fleetDouble(HOSTILE_NAME);
	await installApp(host("mac1"), { app: HOSTILE_NAME, kind: "dmg", url: "https://example.test/a.dmg?os=mac&arch=arm64" }, rec.opts);

	// The round trip that matters: the exact bytes the operator typed are on line 2 of a file
	// rsync delivered, and the far side reads them with `sed` into a quoted variable.
	const request = rec.staged.get("request");
	assert.ok(request, `staged only ${[...rec.staged.keys()].join(", ")}`);
	assert.equal(request.split("\n")[1], HOSTILE_NAME);
	assert.equal(request.split("\n")[3], "https://example.test/a.dmg?os=mac&arch=arm64");

	// And nowhere else. Every remote argv is a fixed token, so nothing sshd flattens into a
	// login shell carries content.
	const flat = rec.remote.flat();
	assert.equal(flat.some((a) => a.includes("Notion") || a.includes("example.test")), false, `content reached the wire: ${flat.join(" ")}`);
	for (const argv of rec.remote)
		for (const arg of argv)
			for (const meta of [";", "`", "$", "|", "&", "\n", "'", '"', ">", "<", "*", "(", ")", " "])
				assert.equal(arg.includes(meta), false, `remote argv entry ${JSON.stringify(arg)} carries shell metacharacter ${meta}`);
	// The rsync destination is expanded by a shell on the far side too, so the payload lands
	// under a fixed stem and is renamed from the request file once it is there.
	for (const argv of rec.rsync) assert.match(argv[argv.length - 1], /^administrator@10\.0\.0\.1:[A-Za-z0-9._/-]+\/$/);
});

test("installApp__SkipsTheDownload__When__TheAppIsAlreadyInstalled", async () => {
	const rec = fleetDouble("Notion Calendar", { before: ["/Applications/Notion Calendar.app"] });
	const result = await installApp(host("mac1"), DMG, rec.opts);

	assert.equal(result.ok, true, JSON.stringify(result.steps));
	assert.deepEqual(stepNames(result), ["reach", "check"]);
	// Presence IS the goal. Re-fetching a few hundred MB to end in the state we are already in
	// also replaces a bundle whose TCC grants someone may have established by hand.
	assert.deepEqual(rec.rsync, []);
	assert.equal(rec.remote.some((a) => a[1]?.endsWith("fetch.sh")), false);
	assert.match(result.grants, /SIP blocks writing the TCC database/);
});

test("installApp__Reinstalls__When__ForceIsSet", async () => {
	const rec = fleetDouble("Notion Calendar", { before: ["/Applications/Notion Calendar.app"] });
	const result = await installApp(host("mac1"), DMG, { ...rec.opts, force: true });

	assert.equal(result.ok, true, JSON.stringify(result.steps));
	assert.deepEqual(stepNames(result), ["reach", "check", "stage", "deliver", "install", "verify"]);
	// Replacing a bundle invalidates its grants unless the code signature is unchanged, and a
	// new build's is not.
	assert.match(result.grants, /code signature is unchanged/);
});

test("installApp__StopsAtTheFailedStep__When__TheDownloadFails", async () => {
	const rec = fleetDouble("Notion Calendar", {
		reply: (argv) => (argv[1]?.endsWith("fetch.sh") ? { code: 22, stdout: "", stderr: "curl: (22) The requested URL returned error: 404\n" } : undefined),
	});
	const result = await installApp(host("mac1"), DMG, rec.opts);

	assert.equal(result.ok, false);
	assert.deepEqual(stepNames(result), ["reach", "check", "stage", "deliver"]);
	assert.match(result.steps[3].detail ?? "", /404/);
	// Mounting a 404 body would fail as "corrupt disk image", which reads as a broken installer
	// rather than a dead link.
	assert.equal(rec.remote.some((a) => a[1]?.endsWith("install-app.sh")), false);
});

test("installApp__Fails__When__TheInstallerExitsZeroAndNothingLanded", async () => {
	// The failure this module exists to catch. `curl` exiting 0 means a file arrived and
	// `hdiutil` exiting 0 means an image mounted; neither is evidence of a launchable bundle.
	const rec = fleetDouble("Notion Calendar", { after: ["/Applications/Notion Calendar Installer.app"] });
	const result = await installApp(host("mac1"), DMG, rec.opts);

	assert.equal(result.ok, false);
	assert.deepEqual(stepNames(result), ["reach", "check", "stage", "deliver", "install", "verify"]);
	assert.equal(result.steps[4].ok, true, "the installer did report success — that is the point");
	assert.match(result.steps[5].detail ?? "", /Notion Calendar Installer\.app/);
});

test("installApp__ReportsTheMissingGrants__When__TheAppIsNewlyInstalled", async () => {
	const rec = fleetDouble("Notion Calendar");
	const result = await installApp(host("mac1"), DMG, rec.opts);

	// A run against an app with no grants gets an empty AX tree and a black frame with no error,
	// which is the worst failure shape in this repo. The operator has to hear it before the demo.
	assert.match(result.grants, /holds NO Accessibility or Screen Recording grant/);
	assert.match(result.grants, /SIP blocks writing the TCC database/);
});

test("installApp__RemovesTheStagingDirectory__When__TheSyncFinishes", async () => {
	const rec = fleetDouble("Notion Calendar");
	await installApp(host("mac1"), DMG, rec.opts);

	assert.ok(rec.stageDir, "the request was never staged");
	assert.equal(fs.existsSync(rec.stageDir as string), false, "the staging dir outlived the sync");
});

test("installFleet__IsolatesFailure__When__OneHostIsUnreachable", async () => {
	const rec = fleetDouble("Notion Calendar");
	const results = await installFleet(inventory(host("mac1", "10.0.0.1"), host("mac2", "10.0.0.2"), host("mac3", "10.0.0.3", null)), DMG, {
		...rec.opts,
		run: async (h, argv) => {
			// A powered-off colo box must cost its own row and nothing else.
			if (h.name === "mac2") throw new Error("ssh: connect to host 10.0.0.2 port 22: Operation timed out");

			return (rec.opts.run as NonNullable<InstallOptions["run"]>)(h, argv, { timeoutMs: 1000 });
		},
	});

	assert.deepEqual(results.map((r) => r.host), ["mac1", "mac2", "mac3"]);
	assert.equal(results[0].ok, true, JSON.stringify(results[0].steps));
	assert.equal(results[1].ok, false);
	assert.match(results[1].steps[0].detail ?? "", /Operation timed out/);
	assert.match(results[2].steps[0].detail ?? "", /no pinned host key/);
});

test("payloadRsyncArgv__KeepsNodeModules__When__UploadingAnAppBundle", () => {
	// provision.ts's rsyncArgv excludes node_modules, and an Electron .app carries one inside
	// Contents/Resources/app. Reusing it would produce a bundle that copies, installs and
	// verifies as present, then crashes on launch.
	const argv = payloadRsyncArgv(host("mac1"), "/tmp/App.app", `${REMOTE_CHECKOUT}/${INSTALL_STAGE_DIR}/payload.app`, "directory");

	assert.equal(argv.includes("--exclude"), false);
	assert.ok(argv.includes("--archive"), "a .app is a directory whose executable bits are the app");
	assert.equal(argv[argv.length - 2], "/tmp/App.app/");
	assert.equal(argv[argv.length - 1], "administrator@10.0.0.1:yarn-trial/.install/payload.app/");
});

test("payloadRsyncArgv__OmitsTheTrailingSlash__When__ThePayloadIsAFile", () => {
	// The slash that stops rsync nesting a directory one level deeper is an error on a file
	// source ("not a directory"), and a dmg and a bundle both arrive as a path.
	const argv = payloadRsyncArgv(host("mac1"), "/tmp/App.dmg", `${REMOTE_CHECKOUT}/${INSTALL_STAGE_DIR}/payload.dmg`, "file");

	assert.equal(argv[argv.length - 2], "/tmp/App.dmg");
	assert.equal(argv[argv.length - 1], "administrator@10.0.0.1:yarn-trial/.install/payload.dmg");
	assert.equal(argv.includes("--delete"), false);
});

test("installApp__UploadsTheArchiveWithoutFetching__When__TheSourceIsALocalPath", async () => {
	await inTempDir("yarn-install-test-", async (dir) => {
		const local = path.join(dir, "Notion Calendar.dmg");
		fs.writeFileSync(local, "disk image");
		const rec = fleetDouble("Notion Calendar");
		const result = await installApp(host("mac1"), parseAppSource("Notion Calendar", local), rec.opts);

		assert.equal(result.ok, true, JSON.stringify(result.steps));
		assert.equal(rec.remote.some((a) => a[1]?.endsWith("fetch.sh")), false, "a local path must not be fetched");
		// Two syncs: the request and scripts, then the archive itself under the fixed stem.
		assert.equal(rec.rsync.length, 2);
		assert.equal(rec.rsync[1][rec.rsync[1].length - 1], "administrator@10.0.0.1:yarn-trial/.install/payload.dmg");
		assert.equal(rec.staged.get("request")?.split("\n")[3], "", "a local install has no url line");
	});
});

test("payloadRsyncArgv__Throws__When__TheDestinationCouldBeShellInput", () => {
	// An rsync remote path is expanded by a shell on the far side, unlike ssh's own user@host.
	assert.throws(() => payloadRsyncArgv({ ...host("mac1"), ssh: { host: "10.0.0.1", port: 22, user: "a;touch /tmp/x" } }, "/tmp/src", "d", "directory"), /shell input/);
	assert.throws(() => payloadRsyncArgv(host("mac1"), "/tmp/src", "yarn-trial/.install/My App.app", "directory"), /shell input/);
});

test("stageInstallFiles__Throws__When__TheAppNameCouldEscapeTheRequestFile", async () => {
	await inTempDir("yarn-install-test-", (dir) => {
		// The request file is line-oriented and the name is used as a path component on the far
		// side. Both break on these, and no real bundle has either.
		assert.throws(() => stageInstallFiles(dir, { app: "Two\nLines", kind: "dmg", url: "https://e.test/a.dmg" }, "/Applications"), /newline/);
		assert.throws(() => stageInstallFiles(dir, { app: "../../etc", kind: "dmg", url: "https://e.test/a.dmg" }, "/Applications"), /path separator/);
	});
});

/* ---------------------------------------------------------------------------------------- *
 * The shell scripts, executed. Fake hdiutil/ditto/curl on a PATH built here; HOME and TMPDIR
 * both point inside the temp dir, so nothing escapes it.
 * ---------------------------------------------------------------------------------------- */

interface Sandbox {
	home: string;
	stage: string;
	dest: string;
	/** Every fake-tool invocation, one per line. */
	log(): string;
	run(script: string, env?: Record<string, string>): { code: number; stdout: string; stderr: string };
}

function sandbox(dir: string, source: AppSource, dest = path.join(dir, "Applications")): Sandbox {
	const home = path.join(dir, "home");
	const stage = path.join(home, REMOTE_CHECKOUT, INSTALL_STAGE_DIR);
	const bin = path.join(dir, "bin");
	const logFile = path.join(dir, "tools.log");

	fs.mkdirSync(bin, { recursive: true });
	fs.mkdirSync(dest, { recursive: true });
	stageInstallFiles(stage, source, dest);

	const fake = (name: string, body: string): void => {
		fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '${name} %s\\n' "$*" >> "${logFile}"\n${body}\n`);
		fs.chmodSync(path.join(bin, name), 0o755);
	};

	// attach creates the bundle the script is expected to find, so the mount is real enough for
	// the copy logic without a disk image.
	fake(
		"hdiutil",
		`if [ "$1" = attach ]; then
	while [ $# -gt 0 ]; do
		if [ "$1" = "-mountpoint" ]; then shift; mkdir -p "$1/Fake App.app/Contents"; fi
		shift
	done
fi
exit 0`,
	);
	fake("ditto", `[ -z "\${DITTO_FAIL:-}" ] || exit 1\ncp -R "$1" "$2"`);
	fake("xattr", "exit 0");
	// CURL_EMPTY reproduces the 200-with-nothing case: a login wall or a redirect to an HTML
	// page leaves curl exiting 0 with a file the mount cannot read.
	fake("curl", `[ -z "\${CURL_FAIL:-}" ] || exit 22\nwhile [ $# -gt 0 ]; do if [ "$1" = --output ]; then shift; if [ -n "\${CURL_EMPTY:-}" ]; then : > "$1"; else printf 'payload' > "$1"; fi; fi; shift; done\nexit 0`);

	return {
		home,
		stage,
		dest,
		log: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : ""),
		run(script, env = {}) {
			const r = spawnSync("sh", [path.join(stage, script)], {
				encoding: "utf8",
				env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: dir, ...env },
			});

			return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
		},
	};
}

test("installScript__DetachesTheImage__When__TheCopyFails", async () => {
	await inTempDir("yarn-install-test-", async (dir) => {
		const box = sandbox(dir, { app: "Fake App", kind: "dmg", url: "https://example.test/a.dmg" });
		fs.writeFileSync(path.join(box.stage, "payload.dmg"), "not really a disk image");

		const r = box.run("install-app.sh", { DITTO_FAIL: "1" });

		assert.notEqual(r.code, 0, "a failed copy must fail the step");
		// An image left attached makes the NEXT attach of the same image fail with "resource
		// busy", so one bad install poisons every retry until someone ejects it over VNC.
		assert.match(box.log(), /hdiutil .*detach/);
		assert.equal(fs.readdirSync(box.dest).length, 0, "a half-copied bundle was left behind");
	});
});

test("installScript__InstallsTheBundleAndDetaches__When__TheImageMounts", async () => {
	await inTempDir("yarn-install-test-", async (dir) => {
		const box = sandbox(dir, { app: "Fake App", kind: "dmg", url: "https://example.test/a.dmg" });
		fs.writeFileSync(path.join(box.stage, "payload.dmg"), "not really a disk image");

		const r = box.run("install-app.sh");

		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /^installed=/m);
		assert.ok(fs.existsSync(path.join(box.dest, "Fake App.app")), `dest holds ${fs.readdirSync(box.dest).join(", ")}`);
		// Detached on the success path too, not only from the failure trap.
		assert.match(box.log(), /hdiutil .*detach/);
		// A payload is hundreds of MB and the remote checkout is rsynced but never pruned.
		assert.equal(fs.existsSync(path.join(box.stage, "payload.dmg")), false);
	});
});

test("installScript__NamesTheBundleFromTheRequest__When__TheNameCarriesASpaceAndAQuote", async () => {
	await inTempDir("yarn-install-test-", async (dir) => {
		// The end-to-end round trip. An rsync destination is shell input on the remote side, so a
		// bundle uploaded from a local path arrives under a fixed stem and can only be named
		// after the app once it is already there — by a script reading a quoted variable.
		const box = sandbox(dir, { app: HOSTILE_NAME, kind: "app", path: "/tmp/whatever.app" });
		fs.mkdirSync(path.join(box.stage, "payload.app", "Contents"), { recursive: true });

		const r = box.run("install-app.sh");

		assert.equal(r.code, 0, r.stderr);
		assert.deepEqual(fs.readdirSync(box.dest), [`${HOSTILE_NAME}.app`]);
		// The `rm -rf $HOME` in the name is a directory name and nothing else.
		assert.ok(fs.existsSync(box.home), "the app name executed as shell");
		assert.ok(fs.existsSync(path.join(box.dest, `${HOSTILE_NAME}.app`, "Contents")));
	});
});

test("installScript__Refuses__When__ThePayloadHoldsMoreThanOneBundle", async () => {
	await inTempDir("yarn-install-test-", async (dir) => {
		// A dmg routinely carries an uninstaller or a helper beside the app. Picking the first
		// would install whichever one sorts earliest, and it would verify as absent minutes later.
		const box = sandbox(dir, { app: "Something Else", kind: "app", path: "/tmp/whatever.app" });
		fs.mkdirSync(path.join(box.stage, "payload.app"), { recursive: true });
		fs.mkdirSync(path.join(box.stage, "Helper.app"), { recursive: true });

		const r = box.run("install-app.sh");

		assert.notEqual(r.code, 0);
		assert.match(r.stderr, /expected one \.app in the payload, found 2/);
	});
});

test("fetchScript__Refuses__When__TheRequestCarriesANonHttpsUrl", async () => {
	await inTempDir("yarn-install-test-", async (dir) => {
		const box = sandbox(dir, { app: "Fake App", kind: "dmg", url: "https://example.test/a.dmg" });
		// Hand-written, because stageInstallFiles will not produce one. This copy of the check is
		// the only one running on the machine that actually makes the request.
		fs.writeFileSync(path.join(box.stage, "request"), `dmg\nFake App\n${box.dest}\nhttp://example.test/a.dmg\n`);

		const r = box.run("fetch.sh");

		assert.equal(r.code, 2);
		assert.match(r.stderr, /non-https/);
		assert.equal(box.log().includes("curl"), false, "curl was invoked for a non-https url");
	});
});

test("fetchScript__Fails__When__TheDownloadIsEmpty", async () => {
	await inTempDir("yarn-install-test-", async (dir) => {
		const box = sandbox(dir, { app: "Fake App", kind: "dmg", url: "https://example.test/a.dmg" });

		// A login wall answers 200 and curl exits 0. Zero bytes does not prove the file is an
		// archive, but it does prove it is not one — and without this check the mount fails
		// instead, blaming the disk image for a dead link.
		const empty = box.run("fetch.sh", { CURL_EMPTY: "1" });
		assert.equal(empty.code, 2, empty.stderr);
		assert.match(empty.stderr, /0 bytes/);

		const fetched = box.run("fetch.sh");
		assert.equal(fetched.code, 0, fetched.stderr);
		assert.match(fetched.stdout, /fetched 7 bytes/);
		// The URL reaches curl as one argument, after `--`, with the query string intact.
		assert.match(box.log(), /https:\/\/example\.test\/a\.dmg/);
	});
});
