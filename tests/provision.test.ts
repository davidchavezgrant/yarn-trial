import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { HostEntry } from "../src/remote/control/hosts.js";
import {
	type DoctorRow,
	type ProvisionOptions,
	type ProvisionResult,
	type RemoteDoctor,
	doctorHost,
	doctorProblems,
	provisionFleet,
	provisionHost,
	restartFleet,
	rsyncArgv,
	stageProvisioningFiles,
	LAUNCH_LABEL,
	REMOTE_CHECKOUT,
	STAGE_DIR,
} from "../src/remote/control/provision.js";
import { rsyncShell, type SshResult } from "../src/remote/control/ssh.js";
import { host, inTempDir, inventory, ok } from "./fixtures.js";

/**
 * Remote provisioning and the remote doctor. Offline by construction: both the ssh call and
 * the rsync call are injected functions, and the only filesystem writes are into temp dirs
 * this file creates and removes. Nothing here may touch a real Mac, ~/.ssh or ~/.yarn-runner —
 * the first would reconfigure a machine three people share, and the last two belong to the
 * operator.
 */

interface Recorder {
	opts: ProvisionOptions;
	/** Every remote argv, in order. The injection-safety assertions read this. */
	remote: string[][];
	rsync: string[][];
	/** Contents of the staged payload, captured while it still exists on disk. */
	staged: Map<string, { body: string; mode: number }>;
	stageDir?: string;
}

/**
 * A Mac that answers everything correctly, with hooks to make one answer wrong. `reply` is
 * consulted first and returning undefined falls through to the happy path, so each test states
 * only the failure it is about.
 */
function fleetDouble(source: string, reply: (argv: string[]) => SshResult | undefined = () => undefined): Recorder {
	const rec: Recorder = { opts: {}, remote: [], rsync: [], staged: new Map() };

	rec.opts = {
		source,
		// 0 makes `ready` a single probe: the poll interval is real time, and a test must not
		// spend it.
		readyTimeoutMs: 0,
		run: async (h, argv) => {
			rec.remote.push(argv);
			const override = reply(argv);
			if (override) return override;
			if (argv[0] === "true" || argv[0] === "mkdir") return ok();
			if (argv[0] === "sh" && argv[1].endsWith("install-runnerctl.sh")) return ok("runnerctl=/usr/local/bin/runnerctl\n");
			if (argv[0] === "sh" && argv[1].endsWith("install-launchagent.sh")) return ok(`launchagent=/Users/administrator/Library/LaunchAgents/${LAUNCH_LABEL}.plist\n`);
			if (argv[0] === "sh" && argv[1].endsWith("install-chrome-policy.sh")) return ok("chromePolicy=3/3 chrome=present running=no\n");
			if (argv[0] === "sh" && argv[1].endsWith("install-default-browser.sh")) return ok("defaultBrowser=com.google.Chrome\n");
			if (argv[0] === "runnerctl" && argv[1] === "status") return ok(`${JSON.stringify({ ok: true, state: "idle" })}\n`);

			return { code: 1, stdout: "", stderr: `unexpected remote argv ${JSON.stringify(argv)}` };
		},
		rsync: async (argv) => {
			rec.rsync.push(argv);
			if (!argv[argv.length - 1].endsWith("/.provision/")) return ok();

			// The staging dir is deleted as soon as the sync returns, so its contents are read
			// here — this is the only moment they exist.
			const src = argv[argv.length - 2].replace(/\/$/, "");
			rec.stageDir = src;
			for (const name of fs.readdirSync(src))
				rec.staged.set(name, { body: fs.readFileSync(path.join(src, name), "utf8"), mode: fs.statSync(path.join(src, name)).mode & 0o777 });

			return ok();
		},
	};

	return rec;
}

function stepNames(result: ProvisionResult): string[] {
	return result.steps.map((s) => s.step);
}

test("provisionHost__CompletesEveryStep__When__TheHostAnswers", async () => {
	await inTempDir("yarn-source-", async (source) => {
		const rec = fleetDouble(source);
		const result = await provisionHost(host("mac1"), rec.opts);

		assert.equal(result.ok, true, JSON.stringify(result.steps));
		assert.deepEqual(stepNames(result), ["reach", "sync", "runnerctl", "launchagent", "browser", "defaultbrowser", "ready"]);
		// The last row is the only proof that matters: launchd accepted the job AND the socket
		// the job holds is answering.
		assert.match(result.steps[6].detail ?? "", /runner is idle/);

		// Repo first, then the provisioning payload into the checkout's staging dir.
		assert.equal(rec.rsync.length, 2);
		assert.equal(rec.rsync[0][rec.rsync[0].length - 1], `administrator@10.0.0.1:${REMOTE_CHECKOUT}/`);
		assert.equal(rec.rsync[1][rec.rsync[1].length - 1], `administrator@10.0.0.1:${REMOTE_CHECKOUT}/.provision/`);
	});
});

test("provisionHost__SendsOnlyFixedTokens__When__ProvisioningAHost", async () => {
	await inTempDir("yarn-source-", async (source) => {
		const rec = fleetDouble(source);
		await provisionHost(host("mac1"), rec.opts);

		// sshd joins the remote argv into ONE string for a login shell, so a metacharacter in
		// any element is shell syntax on the far side. Everything this module sends is a
		// constant in its own source; the payload with content travels as files.
		for (const argv of rec.remote)
			for (const arg of argv)
				for (const meta of [";", "`", "$", "|", "&", "\n", "'", '"', ">", "<", "*", "(", ")", " "])
					assert.equal(arg.includes(meta), false, `remote argv entry ${JSON.stringify(arg)} carries shell metacharacter ${meta}`);

		// The local staging path never appears in a remote command either — the installers read
		// the copy rsync put inside the checkout.
		const flat = rec.remote.flat().join(" ");
		assert.equal(flat.includes(os.tmpdir()), false);
	});
});

test("provisionHost__RefusesHost__When__HostKeyIsNotPinned", async () => {
	await inTempDir("yarn-source-", async (source) => {
		const rec = fleetDouble(source);
		const result = await provisionHost(host("new", "10.0.0.9", null), rec.opts);

		assert.equal(result.ok, false);
		assert.match(result.steps[0].detail ?? "", /no pinned host key/);
		// Not "it failed to connect": nothing was sent. Syncing to an unverified host means
		// handing the checkout to whatever answered the address.
		assert.deepEqual(rec.remote, []);
		assert.deepEqual(rec.rsync, []);
	});
});

test("provisionHost__StopsAtTheFailedStep__When__TheSyncFails", async () => {
	await inTempDir("yarn-source-", async (source) => {
		const rec = fleetDouble(source);
		rec.opts.rsync = async (argv) => {
			rec.rsync.push(argv);

			return { code: 12, stdout: "", stderr: "rsync: connection unexpectedly closed\nrsync error: error in rsync protocol\n" };
		};
		const result = await provisionHost(host("mac1"), rec.opts);

		assert.equal(result.ok, false);
		assert.deepEqual(stepNames(result), ["reach", "sync"]);
		assert.equal(result.steps[1].detail, "rsync: connection unexpectedly closed");
		// Running the installers against a tree that did not arrive would load a LaunchAgent
		// pointing at nothing, and the host would then look provisioned.
		assert.equal(rec.remote.some((a) => a[0] === "sh"), false);
	});
});

test("provisionHost__FailsRunnerctl__When__TheShimIsNotOnTheNonInteractivePath", async () => {
	await inTempDir("yarn-source-", async (source) => {
		// The failure every host answers with today. `ssh host cmd` runs a non-interactive shell
		// whose PATH is /etc/paths, so installing into ~/.local/bin without the PATH line
		// produces a shim that exists and cannot be found.
		const rec = fleetDouble(source, (argv) =>
			argv[0] === "runnerctl" ? { code: 127, stdout: "", stderr: "zsh: command not found: runnerctl\n" } : undefined,
		);
		const result = await provisionHost(host("mac1"), rec.opts);

		assert.equal(result.ok, false);
		assert.deepEqual(stepNames(result), ["reach", "sync", "runnerctl"]);
		assert.match(result.steps[2].detail ?? "", /not on the non-interactive PATH/);
		assert.equal(rec.remote.some((a) => a[1]?.endsWith("install-launchagent.sh")), false);
	});
});

test("provisionHost__ReportsNotReady__When__TheRunnerNeverAnswers", async () => {
	await inTempDir("yarn-source-", async (source) => {
		// Exit 3 is runnerctl's own "cannot reach the runner": the shim is installed and found,
		// the socket behind it is not up. That must NOT read as a missing shim.
		const rec = fleetDouble(source, (argv) =>
			argv[0] === "runnerctl" ? { code: 3, stdout: "", stderr: "cannot reach the runner at /Users/administrator/.yarn-runner/run.sock: connect ENOENT\n" } : undefined,
		);
		const result = await provisionHost(host("mac1"), rec.opts);

		assert.equal(result.ok, false);
		assert.deepEqual(stepNames(result), ["reach", "sync", "runnerctl", "launchagent", "browser", "defaultbrowser", "ready"]);
		assert.equal(result.steps[2].ok, true, "an unreachable socket is not a missing shim");
		// First boot installs dependencies and compiles the shell, so the operator has to be
		// told this is plausibly "not yet" rather than "broken".
		assert.match(result.steps[6].detail ?? "", /npm install/);
	});
});

test("provisionHost__RemovesTheStagingDirectory__When__TheSyncFinishes", async () => {
	await inTempDir("yarn-source-", async (source) => {
		const rec = fleetDouble(source);
		await provisionHost(host("mac1"), rec.opts);

		assert.ok(rec.stageDir, "the provisioning payload was never staged");
		assert.equal(rec.stageDir?.startsWith(fs.realpathSync(os.tmpdir())) || rec.stageDir?.startsWith(os.tmpdir()), true, `staged outside the temp dir: ${rec.stageDir}`);
		assert.equal(fs.existsSync(rec.stageDir as string), false, "the staging dir outlived the sync");
	});
});

test("provisionHost__ShipsAnExecutableElectronServeAgent__When__StagingThePayload", async () => {
	await inTempDir("yarn-source-", async (source) => {
		const rec = fleetDouble(source);
		await provisionHost(host("mac1"), rec.opts);

		const serve = rec.staged.get("yarn-runner-serve");
		const plist = rec.staged.get(`${LAUNCH_LABEL}.plist.in`);
		const agent = rec.staged.get("install-launchagent.sh");
		assert.ok(serve && plist && agent, `staged only ${[...rec.staged.keys()].join(", ")}`);

		// TCC attributes Accessibility and Screen Recording to the responsible process and
		// children inherit them, so the thing launchd keeps alive has to be Electron itself —
		// a node daemon would hand every run an empty AX tree with no error.
		//
		// The BINARY, not `npx electron`. Measured on mac3: npx forks its child rather than
		// exec'ing it, which put `npm exec electron` in launchd's child slot with Electron two
		// levels below — so KeepAlive watched npm (Electron could die unrestarted) and npm, not
		// the app an operator grants, was the responsible process. This assertion used to match
		// the npx line, which still exists as the unknown-layout fallback, so it went on passing
		// through the whole defect.
		assert.match(serve.body, /exec "\$ELECTRON" dist-electron\/electron\/main\.js --serve/);
		assert.ok(
			serve.body.indexOf('exec "$ELECTRON"') < serve.body.indexOf("exec npx electron"),
			"the npx fallback must come after the direct exec, never before it",
		);
		// Dependencies freshen on the same mtime signal as the build. "[ -d node_modules ]"
		// alone stranded every already-provisioned host when playwright-core landed: the
		// directory existed, so the new dependency was never installed (2026-07-31, all three
		// Macs). Both manifests are compared against npm's own install marker.
		assert.match(serve.body, /package\.json -nt node_modules\/\.package-lock\.json/);
		assert.match(serve.body, /package-lock\.json -nt node_modules\/\.package-lock\.json/);
		assert.equal(/\[ -d node_modules \] \|\| npm install/.test(serve.body), false, "the existence-only install condition must stay gone");
		// And in the GUI domain: a user-domain job has no window server session.
		assert.match(agent.body, /launchctl bootstrap "gui\/\$U"/);
		assert.equal(/bootstrap "user\//.test(agent.body), false);
		// bootout before bootstrap, or the plist just written never takes effect (EALREADY).
		assert.ok(agent.body.indexOf("launchctl bootout") < agent.body.indexOf("launchctl bootstrap"));
		// ...and bootout alone is not enough: it returns before launchd finishes the teardown, so
		// a bootstrap landing in that window fails with EIO(5) rather than EALREADY. Measured on
		// mac3, and only on a RE-provision of a running host — the ordinary path. So the script
		// has to wait for the label to disappear and then retry.
		assert.match(agent.body, /while launchctl print .*&& \[ \$n -lt/);
		assert.match(agent.body, /until launchctl bootstrap/);

		assert.match(plist.body, /<key>KeepAlive<\/key>\s*<true\/>/);
		assert.match(plist.body, /<key>RunAtLoad<\/key>\s*<true\/>/);
		// A plist has no variable expansion; the remote home is substituted on the far side.
		assert.match(plist.body, /__HOME__\/\.local\/bin\/yarn-runner-serve/);

		// rsync --archive carries the mode across, and a shim that arrives non-executable fails
		// as "Permission denied" from launchd — minutes later, on the far side.
		assert.equal(serve.mode & 0o111, 0o111);
		assert.equal(rec.staged.get("runnerctl")?.mode ?? 0, 0o755);
		assert.equal(plist.mode, 0o644);
	});
});

test("stageProvisioningFiles__WritesTheWholePayload__When__GivenAnEmptyDirectory", async () => {
	await inTempDir("yarn-source-", (dir) => {
		const names = stageProvisioningFiles(dir);
		assert.deepEqual(names.sort(), ["com.yarn.runner.plist.in", "install-chrome-policy.sh", "install-default-browser.sh", "install-launchagent.sh", "install-runnerctl.sh", "runnerctl", "yarn-runner-serve"]);
		// Idempotent: a second provision reuses the same names, and writeFileSync's mode does
		// not apply to a file that already exists.
		fs.chmodSync(path.join(dir, "runnerctl"), 0o600);
		stageProvisioningFiles(dir);
		assert.equal(fs.statSync(path.join(dir, "runnerctl")).mode & 0o777, 0o755);
	});
});

test("stageProvisioningFiles__CarriesTheModelKeyAsA0600File__When__ProvisionerHasOne", async () => {
	await inTempDir("yarn-source-", (dir) => {
		// Absent is the ordinary case and not an error: a teammate with no key can still stand a
		// host up and supply one later from the credentials panel.
		assert.equal(stageProvisioningFiles(dir).includes("env"), false);
		assert.equal(fs.existsSync(path.join(dir, "env")), false);

		assert.ok(stageProvisioningFiles(dir, "sk-or-v1-abc123").includes("env"));
		const staged = path.join(dir, "env");
		assert.match(fs.readFileSync(staged, "utf8"), /^OPENROUTER_API_KEY='sk-or-v1-abc123'\n$/);

		// Both providers ship when both are present — one line each, still one 0600 file. The
		// far side merges per NAME, so this cannot clobber a hand-set host key.
		stageProvisioningFiles(dir, "sk-or-v1-abc123", "sk-ant-xyz");
		assert.equal(fs.readFileSync(staged, "utf8"), "OPENROUTER_API_KEY='sk-or-v1-abc123'\nANTHROPIC_API_KEY='sk-ant-xyz'\n");

		// Anthropic alone works too — a fleet keyed for one provider is not required to have
		// the other.
		fs.rmSync(staged);
		stageProvisioningFiles(dir, undefined, "sk-ant-xyz");
		assert.equal(fs.readFileSync(staged, "utf8"), "ANTHROPIC_API_KEY='sk-ant-xyz'\n");
		assert.equal(fs.statSync(staged).mode & 0o777, 0o600);

		// 0600 on the LOCAL staging copy too — it sits in /tmp, and rsync --archive is what
		// carries the mode to the far side, so a loose bit here is a loose bit everywhere.
		assert.equal(fs.statSync(staged).mode & 0o777, 0o600);

		// The Azure Responses pair travels together: makeClient refuses an azure/* model with
		// only one of them, so shipping half would turn a benchmark arm into a far-side error.
		fs.rmSync(staged);
		stageProvisioningFiles(dir, undefined, undefined, { key: "az-key", endpoint: "https://x.openai.azure.com/openai/v1" });
		assert.equal(
			fs.readFileSync(staged, "utf8"),
			"AZURE_OPENAI_API_KEY='az-key'\nAZURE_OPENAI_ENDPOINT='https://x.openai.azure.com/openai/v1'\n",
		);

		// Half a pair ships nothing rather than something unusable.
		fs.rmSync(staged);
		assert.equal(stageProvisioningFiles(dir, undefined, undefined, { key: "az-key" }).includes("env"), false);
		assert.equal(fs.existsSync(staged), false);

		// An endpoint is a URL, and it lands inside a single-quoted shell assignment — a quote,
		// a space or a non-https scheme is refused rather than written.
		for (const bad of ["http://x.openai.azure.com/openai/v1", "https://x/ v1", "https://x/'v1"])
			assert.throws(() => stageProvisioningFiles(dir, undefined, undefined, { key: "k", endpoint: bad }), /must be an https URL/);

		// A file, never an argv. Anything in an ssh argv is reassembled into a command line on
		// the remote, where `ps` shows it to every local account for as long as it runs.
		// Merged per key NAME now, not installed whole — the append is how a second provider's
		// key reaches a fleet keyed before that provider existed.
		const install = fs.readFileSync(path.join(dir, "install-launchagent.sh"), "utf8");
		assert.match(install, /printf '%s\\n' "\$LINE" >> "\$HOME\/\.yarn-runner\/env"/);
		assert.match(install, /chmod 600 "\$HOME\/\.yarn-runner\/env"/);
		// Kept, not clobbered: a host given a deliberate per-host key by hand must not lose it to
		// whoever re-provisions next. The GUI is the deliberate-overwrite path.
		assert.match(install, /KEY=kept/);
		// The report describes the HOST, not the shipment: a keyless provision against an
		// already-keyed host must say `present`, not `absent` — the old trio collapsed the
		// two and a healthy fleet read as one with no keys (misread that way 2026-07-31).
		assert.match(install, /KEY=present/);
		// And the staged secret does not outlive the install.
		assert.match(install, /rm -f "\$PROV\/env"/);

		// The launchagent line has to stay FIRST in stdout — provisionHost reports firstLine() as
		// that step's detail, so an echo above it would replace the path in every summary.
		assert.match(install, /^echo "launchagent=\$PLIST modelKey=\$KEY"$/m);

		// Refused, not mangled: the value is written inside single quotes into a file the
		// provisioning path sources with a shell.
		assert.throws(() => stageProvisioningFiles(dir, "sk-or-';id;'"), /does not look like an API key/);
	});
});

test("rsyncArgv__ExcludesSecretsAndJobOutput__When__SyncingTheCheckout", () => {
	const argv = rsyncArgv(host("mac1"), "/tmp/checkout/", REMOTE_CHECKOUT);
	const excluded = argv.filter((a, i) => argv[i - 1] === "--exclude");

	for (const pattern of ["/.env", "/team-credentials.json", "node_modules", ".git", "/dist-electron/", "/out/"])
		assert.ok(excluded.includes(pattern), `${pattern} is not excluded — ${excluded.join(" ")}`);
	// out/ is the remote's own job registry and run logs. --delete would take them, and the
	// exclude list is one typo away from letting it.
	assert.equal(argv.includes("--delete"), false);
	// Trailing slash on the source: without it rsync nests the tree one level deeper and the
	// checkout lands at ~/yarn-trial/checkout.
	assert.equal(argv[argv.length - 2], "/tmp/checkout/");
	assert.equal(argv[argv.length - 1], "administrator@10.0.0.1:yarn-trial/");
});

test("rsyncArgv__Throws__When__TheDestinationCouldBeShellInput", () => {
	// An rsync remote path is expanded by a shell on the far side, unlike ssh's own user@host.
	// hosts.json only requires these to be non-empty strings.
	assert.throws(() => rsyncArgv({ ...host("mac1"), ssh: { host: "10.0.0.1", port: 22, user: "a;touch /tmp/x" } }, "/tmp/src", REMOTE_CHECKOUT), /shell input/);
	assert.throws(() => rsyncArgv(host("mac1", "$(hostname)"), "/tmp/src", REMOTE_CHECKOUT), /shell input/);
});

test("rsyncShell__ReusesThePinnedSshTransport__When__BuiltForAHost", () => {
	const prev = process.env.YARN_RUNNER_HOME;
	delete process.env.YARN_RUNNER_HOME; // exercise the real defaults, not a test override
	try {
		const rsh = rsyncShell(host("mac1"));
		// Restating these options for rsync is how a second copy drifts into not checking the
		// host key; they are taken off the front of the real argv instead.
		assert.match(rsh, /^ssh /);
		assert.match(rsh, /-F \/dev\/null/);
		assert.match(rsh, /StrictHostKeyChecking=yes/);
		assert.match(rsh, /IdentitiesOnly=yes/);
		assert.match(rsh, /-i \S*\.yarn-runner\/id_ed25519/);
		assert.match(rsh, /UserKnownHostsFile=\S*\.yarn-runner\/known_hosts/);
		// The destination belongs to rsync's own argument, never to --rsh.
		assert.equal(rsh.includes("administrator@10.0.0.1"), false);
		for (const arg of rsh.split(" ")) assert.equal(/(^|=)[^\s=]*\/\.ssh(\/|$)/.test(arg), false, `--rsh points into ~/.ssh: ${arg}`);
	} finally {
		if (prev === undefined) delete process.env.YARN_RUNNER_HOME;
		else process.env.YARN_RUNNER_HOME = prev;
	}
});

test("rsyncShell__Throws__When__AnSshOptionContainsWhitespace", () => {
	// rsync splits --rsh on whitespace itself and honours no quoting, so this would silently
	// become two arguments and connect somewhere else — or nowhere.
	const prev = process.env.YARN_RUNNER_HOME;
	process.env.YARN_RUNNER_HOME = "/tmp/yarn runner home";
	try {
		assert.throws(() => rsyncShell(host("mac1")), /whitespace/);
	} finally {
		if (prev === undefined) delete process.env.YARN_RUNNER_HOME;
		else process.env.YARN_RUNNER_HOME = prev;
	}
});

test("provisionFleet__IsolatesFailure__When__OneHostIsUnreachable", async () => {
	await inTempDir("yarn-source-", async (source) => {
		const rec = fleetDouble(source);
		const results = await provisionFleet(inventory(host("mac1", "10.0.0.1"), host("mac2", "10.0.0.2"), host("mac3", "10.0.0.3", null)), {
			...rec.opts,
			run: async (h, argv) => {
				// A powered-off colo box must cost its own row and nothing else.
				if (h.name === "mac2") throw new Error("ssh: connect to host 10.0.0.2 port 22: Operation timed out");

				return (rec.opts.run as NonNullable<ProvisionOptions["run"]>)(h, argv, { timeoutMs: 1000 });
			},
		});

		assert.deepEqual(results.map((r) => r.host), ["mac1", "mac2", "mac3"]);
		assert.equal(results[0].ok, true, JSON.stringify(results[0].steps));
		assert.equal(results[1].ok, false);
		assert.match(results[1].steps[0].detail ?? "", /Operation timed out/);
		assert.match(results[2].steps[0].detail ?? "", /no pinned host key/);
	});
});

// --- Chrome autofill policy. Added after a liveview sign-in on mac2 streamed Chrome's
// autofill dropdown — real people's email addresses — to a teammate's browser. The policy
// table and its graders live in src/remote/chrome-policy.ts and are unit-tested there; what
// belongs here is that provisioning ships and runs the installer, and how it treats a refusal.

test("provisionHost__AppliesTheChromePolicy__When__ProvisioningAHost", async () => {
	await inTempDir("yarn-source-", async (source) => {
		const rec = fleetDouble(source);
		const result = await provisionHost(host("mac1"), rec.opts);

		const browser = result.steps.find((s) => s.step === "browser");
		assert.equal(browser?.ok, true, JSON.stringify(result.steps));
		assert.match(browser?.detail ?? "", /chromePolicy=3\/3/);

		// AFTER the runner is installed and BEFORE `ready`. Before launchagent, a Chrome problem
		// could stop a Mac becoming a runner; after `ready`, which legitimately times out for
		// three minutes on a first boot, it would be the step a slow host never reached — so the
		// privacy control would be missing on exactly the machines nobody watched finish.
		const order = stepNames(result);
		assert.ok(order.indexOf("browser") > order.indexOf("launchagent"));
		assert.ok(order.indexOf("browser") < order.indexOf("ready"));

		// It runs the script rsync put inside the checkout, like every other installer here —
		// never a command line carrying the policy, which sshd would flatten into shell text.
		assert.ok(rec.remote.some((argv) => argv[0] === "sh" && argv[1] === `${REMOTE_CHECKOUT}/${STAGE_DIR}/install-chrome-policy.sh`));
	});
});

test("provisionHost__StillFinishes__When__TheChromePolicyCannotBeApplied", async () => {
	await inTempDir("yarn-source-", async (source) => {
		// A Mac that cannot be told to stop offering autofill is still a working runner.
		// Abandoning the provision over it would leave the host with no runner AND the dropdown.
		const rec = fleetDouble(source, (argv) =>
			argv[0] === "sh" && argv[1].endsWith("install-chrome-policy.sh") ? { code: 1, stdout: "chromePolicy=0/3 chrome=present running=yes missing: AutofillAddressEnabled\n", stderr: "" } : undefined,
		);
		const result = await provisionHost(host("mac1"), rec.opts);

		// The pass CONTINUES rather than truncating — `ready` still ran and passed.
		assert.deepEqual(stepNames(result), ["reach", "sync", "runnerctl", "launchagent", "browser", "defaultbrowser", "ready"]);
		assert.equal(result.steps.find((s) => s.step === "ready")?.ok, true);
		// ...and is still graded a failure, so `./run provision` exits nonzero and nobody reads
		// a silent skip as a success.
		assert.equal(result.ok, false);
		assert.match(result.steps.find((s) => s.step === "browser")?.detail ?? "", /chrome policy not applied/);
	});
});

test("stageProvisioningFiles__ShipsAPolicyScriptThatTouchesNoProfileData__When__StagingThePayload", async () => {
	await inTempDir("yarn-source-", (dir) => {
		stageProvisioningFiles(dir);
		const script = fs.readFileSync(path.join(dir, "install-chrome-policy.sh"), "utf8");
		// Comments stripped: the script's header names these files precisely to say it does not
		// touch them, and that prose is the documentation this assertion exists to protect. What
		// must be clean is what RUNS.
		const code = script.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

		// It writes POLICY. The profile stores are synced to real people's Google accounts —
		// on mac2 all 801 saved credentials carry sync metadata (measured 2026-07-31) — so a
		// deletion here would propagate off the machine and out of our reach. No command in
		// this script may ever name those files.
		for (const store of ["Login Data", "Web Data", "Affiliation Database"])
			assert.equal(code.includes(store), false, `the policy script must never name ${store}`);
		for (const verb of ["rm ", "sqlite3", "DELETE", "mv ", "cp "]) assert.equal(code.includes(verb), false, `the policy script must not ${verb.trim()}`);

		// ...and it must not write the profile's own Preferences JSON either, which is the
		// tempting shortcut: `credentials_enable_service` is a SYNCABLE_PRIORITY_PREF, so that
		// write WOULD reach the signed-in account's other devices.
		assert.equal(code.includes("credentials_enable_service"), false);
		assert.equal(code.includes("Application Support"), false);

		// One key at a time. All three Macs already have a Chrome-written plist holding
		// LastRunAppBundlePath; writing the whole plist would take it with us.
		assert.match(script, /defaults write "\$DOMAIN" AutofillAddressEnabled -bool false/);
		assert.match(script, /defaults write "\$DOMAIN" PasswordManagerEnabled -bool false/);

		// The report is the read-back, not the write's exit status: `defaults write` can fail
		// without a nonzero exit. And the script exits nonzero when a key did not take.
		assert.match(script, /defaults read "\$DOMAIN"/);
		assert.match(script, /\[ -z "\$MISSING" \]/);

		// Same first-line contract as the other installers — provisionHost reports firstLine().
		assert.match(script, /^echo "chromePolicy=/m);
	});
});

test("stageProvisioningFiles__WritesTheChromePolicyScriptExecutable__When__StagingThePayload", async () => {
	await inTempDir("yarn-source-", (dir) => {
		stageProvisioningFiles(dir);
		// rsync --archive carries the mode across; a shim that arrives non-executable fails as
		// "Permission denied" on the far side, minutes later.
		assert.equal(fs.statSync(path.join(dir, "install-chrome-policy.sh")).mode & 0o777, 0o755);
	});
});

// --- Default browser. The CDP liveview transport can follow a sign-in's OAuth handoff into
// the external browser only if that browser IS the debug-flagged persistent-profile Chrome
// (docs/research/2026-07-31-liveview-transport-alternatives.md named this precondition as
// unverified). macOS confirms every programmatic default-browser swap with a dialog on the
// Mac's own console — there is no silent path without MDM — so the step triggers the swap,
// says a human must click once, and reports what LaunchServices actually answers.

test("provisionHost__PointsTheDefaultBrowserAtChrome__When__ProvisioningAHost", async () => {
	await inTempDir("yarn-source-", async (source) => {
		const rec = fleetDouble(source);
		const result = await provisionHost(host("mac1"), rec.opts);

		const step = result.steps.find((s) => s.step === "defaultbrowser");
		assert.equal(step?.ok, true, JSON.stringify(result.steps));
		assert.match(step?.detail ?? "", /defaultBrowser=com\.google\.Chrome/);

		// Same slot logic as `browser`: after the runner exists, before the step that can
		// legitimately spend three minutes timing out on a first boot.
		const order = stepNames(result);
		assert.ok(order.indexOf("defaultbrowser") > order.indexOf("browser"));
		assert.ok(order.indexOf("defaultbrowser") < order.indexOf("ready"));

		// The staged script, like every installer here — never a command line carrying data.
		assert.ok(rec.remote.some((argv) => argv[0] === "sh" && argv[1] === `${REMOTE_CHECKOUT}/${STAGE_DIR}/install-default-browser.sh`));
	});
});

test("provisionHost__StillFinishes__When__TheDefaultBrowserAwaitsItsHumanClick", async () => {
	await inTempDir("yarn-source-", async (source) => {
		// The ordinary first-provision outcome: LaunchServices posted its dialog and nobody was
		// watching the screen. The host still runs jobs — only liveview OAuth handoffs suffer —
		// so the pass continues, and the row grades non-ok so nobody reads pending as done.
		const rec = fleetDouble(source, (argv) =>
			argv[0] === "sh" && argv[1].endsWith("install-default-browser.sh")
				? { code: 1, stdout: 'defaultBrowser=com.apple.Safari pending human confirmation — click "Use Google Chrome" on the Mac\'s own screen (./run signin <host>), then re-check with --doctor\n', stderr: "" }
				: undefined,
		);
		const result = await provisionHost(host("mac1"), rec.opts);

		assert.deepEqual(stepNames(result), ["reach", "sync", "runnerctl", "launchagent", "browser", "defaultbrowser", "ready"]);
		assert.equal(result.steps.find((s) => s.step === "ready")?.ok, true);
		assert.equal(result.ok, false);
		// The detail is the script's OWN report — which browser still holds the role and that a
		// click is owed — not attempt()'s exit-code summary.
		const step = result.steps.find((s) => s.step === "defaultbrowser");
		assert.match(step?.detail ?? "", /com\.apple\.Safari/);
		assert.match(step?.detail ?? "", /pending human confirmation/);
	});
});

test("provisionHost__SkipsTheSwap__When__TheOperatorSaysOff", async () => {
	await inTempDir("yarn-source-", async (source) => {
		// The swap pops a dialog on the Mac's console. Re-provisioning mid-demo must be able to
		// leave it alone, and the skip has to grade ok — an operator who said so is not a fault.
		const prev = process.env.PROVISION_DEFAULT_BROWSER;
		process.env.PROVISION_DEFAULT_BROWSER = "off";
		try {
			const rec = fleetDouble(source);
			const result = await provisionHost(host("mac1"), rec.opts);

			assert.equal(result.ok, true, JSON.stringify(result.steps));
			assert.match(result.steps.find((s) => s.step === "defaultbrowser")?.detail ?? "", /skipped/);
			assert.equal(rec.remote.some((argv) => argv[1]?.endsWith("install-default-browser.sh")), false, "the script must not even be run");
		} finally {
			if (prev === undefined) delete process.env.PROVISION_DEFAULT_BROWSER;
			else process.env.PROVISION_DEFAULT_BROWSER = prev;
		}
	});
});

test("stageProvisioningFiles__ShipsADefaultBrowserScriptThatReadsBeforeItTriggers__When__StagingThePayload", async () => {
	await inTempDir("yarn-source-", (dir) => {
		stageProvisioningFiles(dir);
		const script = fs.readFileSync(path.join(dir, "install-default-browser.sh"), "utf8");
		assert.equal(fs.statSync(path.join(dir, "install-default-browser.sh")).mode & 0o777, 0o755);

		// Read BEFORE set: an already-converted host must exit without posing the dialog —
		// that is the idempotence that makes re-provisioning safe mid-demo.
		assert.ok(script.indexOf('"$BIN" read') < script.indexOf('"$BIN" set'), "the read must come before the trigger");

		// The trigger goes through the compiled LaunchServices helper, never a hand edit of
		// LaunchServices' own plists — the route that requires an lsregister reset and races
		// cfprefsd. The known-fragile spellings must not appear at all.
		for (const fragile of ["LSHandlers", "com.apple.LaunchServices", "lsregister"]) assert.equal(script.includes(fragile), false, `the script must not touch ${fragile}`);

		// The human-click story, stated where the operator will read it: the report line names
		// the button and the way to reach the screen.
		assert.match(script, /Use Google Chrome/);
		assert.match(script, /signin/);

		// The posture note rides with the step: one Chrome per Mac, and the handoff lands in
		// the RUNNING instance.
		assert.match(script, /portless Chrome/);

		// Same first-line contract as the other installers — provisionHost reports firstLine().
		assert.match(script, /^echo "defaultBrowser=/m);
	});
});

/** What serve.ts's `doctor` returns from a host that is fully set up. */
const HEALTHY: RemoteDoctor = {
	runnerDir: "/Users/administrator/.yarn-runner",
	packaged: false,
	envFile: { path: "/Users/administrator/.yarn-runner/env", present: true, mode: "0600" },
	tools: { ffmpeg: true, python3: true, npx: true },
	apiKey: "openrouter",
	permissions: { accessibility: true, screenRecording: true },
};

async function doctor(reply: SshResult | Error): Promise<DoctorRow> {
	return doctorHost(host("mac1"), {
		run: async () => {
			if (reply instanceof Error) throw reply;

			return reply;
		},
	});
}

test("doctorHost__ReportsReady__When__EveryCheckPasses", async () => {
	const row = await doctor(ok(`${JSON.stringify({ ok: true, ...HEALTHY })}\n`));
	assert.equal(row.reachable, true);
	assert.deepEqual(row.problems, []);
	assert.equal(row.report?.apiKey, "openrouter");
});

test("doctorHost__SkipsTheNoise__When__StdoutCarriesALoginBanner", async () => {
	// npx on a cold checkout prints install notices ahead of the payload, and a host that is
	// working must not be graded on them.
	const row = await doctor(ok(`Need to install the following packages:\ntsx@4.23.1\n${JSON.stringify({ ok: true, ...HEALTHY })}\n`));
	assert.deepEqual(row.problems, []);
	assert.equal(row.reason, undefined);
});

test("doctorHost__ReportsUnknown__When__OutputIsNotJson", async () => {
	const row = await doctor(ok("Last login: Tue\n"));
	assert.equal(row.reachable, true, "the host answered — only its output was unusable");
	assert.match(row.reason ?? "", /not JSON/);
});

test("doctorHost__ReportsTheRefusal__When__TheRunnerIsNotListening", async () => {
	const row = await doctor({ code: 3, stdout: "", stderr: "cannot reach the runner at /Users/administrator/.yarn-runner/run.sock: connect ENOENT\n" });
	assert.equal(row.report, undefined);
	assert.match(row.reason ?? "", /cannot reach the runner/);
});

test("doctorHost__RefusesHost__When__HostKeyIsNotPinned", async () => {
	let touched = false;
	const row = await doctorHost(host("new", "10.0.0.9", null), { run: async () => { touched = true; return ok(); } });
	assert.equal(touched, false);
	assert.match(row.reason ?? "", /no pinned host key/);
});

test("doctorProblems__FlagsANonElectronRunner__When__PermissionsAreNull", () => {
	// serve.ts reports permissions only when electron/main.ts injected the probe, so a null
	// means the socket is held by something that is not the Electron process. That is the
	// TCC failure the LaunchAgent exists to avoid, and it is otherwise invisible until a run
	// comes back with an empty AX tree and no error.
	const problems = doctorProblems({ ...HEALTHY, permissions: null });
	assert.equal(problems.length, 1);
	assert.match(problems[0], /not the Electron process/);
});

test("doctorProblems__NamesEveryGap__When__ToolsKeyAndGrantsAreMissing", () => {
	const problems = doctorProblems({
		...HEALTHY,
		apiKey: "MISSING",
		envFile: { present: true, mode: "0644", warning: "expected 0600, found 0644" },
		tools: { ffmpeg: false, python3: false, npx: false },
		permissions: { accessibility: false, screenRecording: true },
	});

	assert.match(problems.join("\n"), /no model API key/);
	assert.match(problems.join("\n"), /expected 0600/);
	assert.match(problems.join("\n"), /ffmpeg missing/);
	assert.match(problems.join("\n"), /python3 missing/);
	assert.match(problems.join("\n"), /npx missing/);
	assert.match(problems.join("\n"), /Accessibility not granted/);
	assert.equal(/Screen Recording not granted/.test(problems.join("\n")), false);
});

test("doctorProblems__IgnoresNpx__When__TheRunnerIsPackaged", () => {
	// A packaged runner ships its own node runtime and never shells out to npx.
	assert.deepEqual(doctorProblems({ ...HEALTHY, packaged: true, tools: { ffmpeg: true, python3: true, npx: false } }), []);
});

// --- grants that landed too late. mac1 graded "ready" while its live process still could not
// capture: TCC hands a process its answer at launch and the doctor probe reads the database.
// The run came back with steps 0 and frames 0, which reads as a broken agent.

test("doctorProblems__DemandsARestart__When__AGrantLandedAfterTheRunnerStarted", () => {
	// Note the permissions block is fully granted — this host would otherwise grade clean, which
	// is exactly how the afternoon was lost.
	const problems = doctorProblems({ ...HEALTHY, staleGrants: ["Screen Recording"] });
	assert.equal(problems.length, 1);
	assert.match(problems[0], /Screen Recording granted after the runner started/);
	assert.match(problems[0], /--restart/);
});

test("doctorProblems__FlagsTheSidecar__When__TheHostCannotRunIt", () => {
	// A degradation, not an outage: the run completes and every anonymous control comes back
	// unnamed. Nothing else about the host looks wrong, so this is the only place it can surface.
	const problems = doctorProblems({ ...HEALTHY, sidecar: { usable: false, problem: "not built — run npm run build:native, then re-provision" } });
	assert.equal(problems.length, 1);
	assert.match(problems[0], /sidecar unusable/);
	assert.match(problems[0], /build:native/);
});

test("doctorProblems__StaysQuiet__When__TheSidecarIsFineOrUnreported", () => {
	// The `undefined` arm is the compatibility case and matters more than it looks: until every
	// host is re-provisioned, an older runner answers doctor without the field at all, and
	// treating a missing field as a failure would light up the whole fleet over nothing.
	assert.deepEqual(doctorProblems({ ...HEALTHY, sidecar: { usable: true } }), []);
	assert.deepEqual(doctorProblems(HEALTHY), []);
});

test("doctorProblems__FlagsTheAutofillDropdown__When__ChromePolicyWasNeverApplied", () => {
	// The state every Mac was in on 2026-07-31. HEALTHY otherwise, so before this the host
	// graded clean while a sign-in stream could show a teammate saved form data.
	const problems = doctorProblems({
		...HEALTHY,
		chromePolicy: { chromeInstalled: true, keys: [{ key: "AutofillAddressEnabled", level: "unset" }] },
	});

	assert.equal(problems.length, 1);
	assert.match(problems[0], /AutofillAddressEnabled/);
	assert.match(problems[0], /sign-in stream/);
});

test("doctorProblems__FlagsTheDefaultBrowser__When__AnotherBrowserHoldsTheHandoff", () => {
	// The OAuth handoff opens the DEFAULT browser, and only the debug-flagged Chrome is one
	// the CDP screencast can follow into — a Safari-defaulted host runs jobs fine and fails
	// exactly the sign-in flow, which is why doctor has to say it out loud.
	const problems = doctorProblems({ ...HEALTHY, defaultBrowser: "com.apple.Safari" });

	assert.equal(problems.length, 1);
	assert.match(problems[0], /default browser is com\.apple\.Safari/);
	// The fix, including the half a re-provision alone cannot do: the click on the Mac's screen.
	assert.match(problems[0], /provision/);
	assert.match(problems[0], /Use Google Chrome/);
});

test("doctorProblems__StaysSilent__When__TheDefaultBrowserIsChromeOrUnreported", () => {
	assert.deepEqual(doctorProblems({ ...HEALTHY, defaultBrowser: "com.google.Chrome" }), []);
	// HEALTHY carries no `defaultBrowser` — an older runner, or one whose serve.ts does not
	// yet report the field. Never grade a question that was never asked.
	assert.deepEqual(doctorProblems(HEALTHY), []);
});

test("doctorProblems__StaysQuiet__When__TheRunnerIsTooOldToReportChromePolicy", () => {
	// HEALTHY carries no `chromePolicy` at all — an older runner answering doctor without the
	// field. Grading a question that was never asked would light up the whole fleet over
	// nothing, the same rule `sidecar` and `screenLocked` follow.
	assert.deepEqual(doctorProblems(HEALTHY), []);
	assert.deepEqual(
		doctorProblems({ ...HEALTHY, chromePolicy: { chromeInstalled: true, keys: [{ key: "AutofillAddressEnabled", level: "recommended", value: false }] } }),
		[],
	);
});

test("restartFleet__LeavesHealthyHostsAlone__When__NoGrantIsStale", async () => {
	// A restart drops the process holding the machine's TCC grants until launchd returns it.
	// Doing that to a host that was fine is a self-inflicted outage.
	const asked: string[] = [];
	const rows = await restartFleet(inventory(host("mac1"), host("mac2", "10.0.0.2")), {
		run: async (_h, argv) => {
			asked.push(argv.join(" "));

			return ok(`${JSON.stringify({ ok: true, ...HEALTHY })}\n`);
		},
	});
	assert.deepEqual(rows.map((r) => r.restarted), [false, false]);
	assert.match(rows[0].detail, /no stale grant/);
	assert.equal(asked.some((a) => a.includes("restart")), false, "a healthy host must not even be asked");
});

test("restartFleet__BouncesOnlyTheStaleHost__When__TheFleetIsMixed", async () => {
	const asked = new Map<string, string[]>();
	const stale = { ...HEALTHY, staleGrants: ["Screen Recording"] };
	const rows = await restartFleet(inventory(host("mac1"), host("mac2", "10.0.0.2")), {
		run: async (h, argv) => {
			asked.set(h.name, [...(asked.get(h.name) ?? []), argv.join(" ")]);

			return ok(`${JSON.stringify({ ok: true, ...(h.name === "mac2" ? stale : HEALTHY) })}\n`);
		},
	});
	assert.deepEqual(rows.map((r) => [r.host, r.restarted]), [["mac1", false], ["mac2", true]]);
	assert.equal(asked.get("mac1")?.some((a) => a.includes("restart")), false);
	assert.equal(asked.get("mac2")?.some((a) => a.includes("restart")), true);
});

test("restartFleet__SaysItCannotTell__When__TheHostDoesNotAnswer", async () => {
	// Unreachable is not "fine": reporting it as skipped-because-healthy would hide a host that
	// is out of the fleet entirely.
	const rows = await restartFleet(inventory(host("mac1")), { run: async () => ({ code: 3, stdout: "", stderr: "connect ENOENT\n" }) });
	assert.equal(rows[0].restarted, false);
	assert.match(rows[0].detail, /cannot tell/);
});

test("restartFleet__AsksEveryHost__When__AllIsSet", async () => {
	// The escape hatch for a host doctor cannot grade. It must not first ask a question whose
	// answer it is about to ignore.
	const asked: string[] = [];
	const rows = await restartFleet(inventory(host("mac1")), {
		all: true,
		run: async (_h, argv) => {
			asked.push(argv.join(" "));

			return ok(`${JSON.stringify({ ok: true, restarting: true })}\n`);
		},
	});
	assert.equal(rows[0].restarted, true);
	assert.deepEqual(asked.filter((a) => a.includes("doctor")), []);
});

test("restartFleet__ReportsTheRefusal__When__AJobIsInFlight", async () => {
	const rows = await restartFleet(inventory(host("mac1")), {
		all: true,
		run: async () => ({ code: 1, stdout: "", stderr: "job 2026-07-30T12-00-00-yarn is running (42s) — stop it first, or pass force\n" }),
	});
	assert.equal(rows[0].restarted, false);
	assert.match(rows[0].detail, /is running/);
});

test("doctorProblems__ReportsTheLock__When__TheHostSaysItsScreenIsLocked", () => {
	// A locked host grades clean on every other signal — permissions granted, runner idle,
	// tools present — and then fails every run with an empty AX tree (LIMITATIONS §12). Before
	// this the only way to find out was to spend a dispatch and read the failure.
	const problems = doctorProblems({ ...HEALTHY, screenLocked: true });
	assert.equal(problems.length, 1);
	assert.match(problems[0], /SCREEN LOCKED/);
	assert.match(problems[0], /\.\/run signin/);
});

test("doctorProblems__StaysSilent__When__TheRunnerIsTooOldToReportTheLock", () => {
	// Absent is not false. A runner predating the field was never asked the question, and
	// grading it as unlocked would be inventing an answer — so the omitted and the explicit
	// -false cases must both produce nothing rather than a reassurance.
	assert.deepEqual(doctorProblems({ ...HEALTHY, screenLocked: undefined }), []);
	assert.deepEqual(doctorProblems({ ...HEALTHY, screenLocked: false }), []);
});

test("provisionHost__ShipsCodeWithoutTouchingTheRunner__When__SyncOnly", async () => {
	// A full provision runs install-launchagent.sh, which does `launchctl bootout` before
	// bootstrap — so it RESTARTS the runner, and the restart's sweepOrphans() marks whatever
	// was in flight as `orphaned`. A completed 118-action explore was lost that way on
	// 2026-07-31 by a provision fired only to sync code before dispatching a different arm.
	await inTempDir("yarn-source-", async (source) => {
		const rec = fleetDouble(source);
		const res = await provisionHost(host("mac1"), { ...rec.opts, syncOnly: true });

		assert.equal(res.ok, true, JSON.stringify(res.steps));
		// Sync happened; nothing after it did.
		assert.deepEqual(stepNames(res), ["reach", "sync"]);
		// And nothing invoked the installer that boots the agent out.
		const flat = rec.remote.map((c) => c.join(" ")).join(" | ");
		assert.ok(!/install-launchagent/.test(flat), "syncOnly must never run the LaunchAgent installer");
	});
});

test("provisionHost__RefusesToBounceABusyRunner__When__AJobIsInFlight", async () => {
	// install-launchagent.sh does `launchctl bootout` DIRECTLY, reaching around the runner's
	// own restart guard (serve.ts refuses `restart` while a job holds the lease). So the
	// self-protection never fires on this path, and a provision fired to sync code costs the
	// in-flight job its observability: the child survives and finishes, but the new runner
	// was never its parent, so no exit status is readable and the reap files it `orphaned`
	// with a null exit code. A completed 118-action explore was recorded that way on
	// 2026-07-31.
	await inTempDir("yarn-source-", async (source) => {
		const rec = fleetDouble(source);
		const inner = rec.opts.run!;
		const busyOpts = {
			...rec.opts,
			run: async (h: any, argv: string[], o: any) =>
				argv[0] === "runnerctl" && argv[1] === "status"
					? ({ code: 0, stdout: `${JSON.stringify({ ok: true, state: "busy", jobId: "explore-in-flight" })}\n`, stderr: "" } as any)
					: inner(h, argv, o),
		};
		const res = await provisionHost(host("mac1"), busyOpts);

		// The pass still SUCCEEDS — the sync is the part a busy host can safely take, and
		// failing here would leave an operator thinking the host is broken.
		assert.equal(res.ok, true, JSON.stringify(res.steps));
		assert.deepEqual(stepNames(res), ["reach", "sync", "runnerctl", "launchagent"]);
		assert.match(res.steps.at(-1)!.detail ?? "", /SKIPPED/);
		// The installer that boots the agent out must never have run.
		const flat = rec.remote.map((c) => c.join(" ")).join(" | ");
		assert.ok(!/install-launchagent/.test(flat), "a busy runner must not be bounced");
	});
});

test("provisionHost__BouncesTheRunnerAnyway__When__ForceIsPassed", async () => {
	// The escape hatch has to exist: a wedged runner holding a lease it will never release
	// can only be fixed by going around it.
	await inTempDir("yarn-source-", async (source) => {
		const rec = fleetDouble(source);
		const inner = rec.opts.run!;
		const res = await provisionHost(host("mac1"), {
			...rec.opts,
			force: true,
			run: async (h: any, argv: string[], o: any) =>
				argv[0] === "runnerctl" && argv[1] === "status"
					? ({ code: 0, stdout: `${JSON.stringify({ ok: true, state: "busy" })}\n`, stderr: "" } as any)
					: inner(h, argv, o),
		});

		assert.ok(rec.remote.map((c) => c.join(" ")).join(" | ").includes("install-launchagent"), "force must bounce it");
	});
});

test("SYNC_EXCLUDES__WithholdsAppmaps__When__ShippingTheCheckout", async () => {
	// Appmaps are the fleet's OUTPUT. rsync cannot tell a newer map from an older one, so
	// shipping this directory pushes whatever the laptop holds over a map a Mac wrote minutes
	// ago — a completed phase-1 pass replaced by a stale local copy, leaving phase 2's
	// grounded arms grounded on the wrong map while still labelled grounded.
	// syncAppmaps() compares stamps via beats() and is the only thing that may move them.
	await inTempDir("yarn-source-", async (source) => {
		const rec = fleetDouble(source);
		await provisionHost(host("mac1"), { ...rec.opts, syncOnly: true });
		const rsyncArgs = rec.rsync.flat();
		const excluded = rsyncArgs.filter((a, i) => rsyncArgs[i - 1] === "--exclude");
		assert.ok(excluded.includes("/docs/appmaps/"), `appmaps must be withheld, got: ${excluded.join(" ")}`);
		// Recipes are NOT excluded here — syncRecipes owns them by the same argument, but this
		// assertion is about the map path that actually regressed.
		assert.ok(excluded.includes("/.env"), "the secret exclusions must survive any edit to this list");
	});
});
