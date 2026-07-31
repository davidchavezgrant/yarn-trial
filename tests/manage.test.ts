import assert from "node:assert/strict";
import { test } from "node:test";
import { type HostEntry, HOSTS_SCHEMA, type Inventory } from "../src/remote/control/hosts.js";
import { clearAppAuth, deleteRemoteApp } from "../src/remote/control/manage.js";
import { decodeSpec, type SshResult, type SshRunner } from "../src/remote/control/ssh.js";
import { host } from "./fixtures.js";

/**
 * The laptop half of remote app/auth management, offline by construction: every ssh call is an
 * injected recorder. These wrappers forward destructive verbs, so the assertions that matter
 * are the wire ones — nothing variable ever lands on an argv position, and a refusal comes
 * back as an answer rather than as an exception a caller might swallow.
 */

const FLEET: Inventory = { schema: HOSTS_SCHEMA, hosts: [host("mac1", "10.0.0.1"), host("mac2", "10.0.0.2")] };

function ok(body: Record<string, unknown>): SshResult {
	return { code: 0, stdout: `${JSON.stringify({ ok: true, ...body })}\n`, stderr: "" };
}

function refused(body: Record<string, unknown>): SshResult {
	return { code: 1, stdout: `${JSON.stringify({ ok: false, ...body })}\n`, stderr: `${String(body.error ?? "refused")}\n` };
}

function recorder(reply: (h: HostEntry, argv: string[]) => SshResult): { run: SshRunner; calls: { host: string; argv: string[] }[] } {
	const calls: { host: string; argv: string[] }[] = [];

	return {
		calls,
		run: async (h, argv) => {
			calls.push({ host: h.name, argv });

			return reply(h, argv);
		},
	};
}

function specOf(argv: string[]): any {
	const at = argv.indexOf("--spec");

	return at < 0 ? undefined : decodeSpec(argv[at + 1]);
}

/** A space is the normal case; the rest is the adversarial part, and it feeds a delete. */
const HOSTILE_APP = 'Notion "Calendar"; rm -rf $HOME';

test("clearAppAuth__CarriesEverythingInTheSpec__When__TheNamesAreHostile", async () => {
	const { run, calls } = recorder(() =>
		ok({ app: HOSTILE_APP, operator: "da-ve", removedLive: ["Library/Application Support/Yarn"], removedProfile: "da-ve/yarn", ownershipCleared: true }),
	);

	const res = await clearAppAuth("mac2", HOSTILE_APP, "da ve", { inventory: FLEET, run });

	assert.equal(res.ok, true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].host, "mac2");
	assert.deepEqual(calls[0].argv.slice(0, 3), ["runnerctl", "authclear", "--json"]);

	const spec = specOf(calls[0].argv);
	assert.equal(spec.app, HOSTILE_APP, "the app name crosses verbatim, inside the spec");
	assert.equal(spec.operator, "da ve");
	// And no argv entry carries anything a remote login shell would react to.
	for (const arg of calls[0].argv)
		for (const meta of [";", "`", "$", "|", "&", "\n", "'", '"', ">", "<", "*", "(", ")"])
			assert.equal(arg.includes(meta), false, `argv entry ${JSON.stringify(arg)} carries ${meta}`);

	// The runner's audit trail survives the parse.
	assert.deepEqual(res.removedLive, ["Library/Application Support/Yarn"]);
	assert.equal(res.removedProfile, "da-ve/yarn");
	assert.equal(res.ownershipCleared, true);
});

test("clearAppAuth__ReportsTheHolder__When__TheLeaseRefuses", async () => {
	const { run } = recorder(() => refused({ error: "sam is running Yarn here (42s) — signing out would pull app data out from under their run", busy: true }));

	const res = await clearAppAuth("mac1", "Yarn", "bob", { inventory: FLEET, run });

	assert.equal(res.ok, false);
	assert.equal(res.busy, true);
	assert.match(String(res.error), /sam is running Yarn/);
	assert.deepEqual(res.removedLive, [], "a refusal removed nothing and must say so");
});

test("clearAppAuth__SaysTheHostIsUnreachable__When__NothingAnswers", async () => {
	const { run } = recorder(() => ({ code: 3, stdout: "", stderr: "cannot reach the runner at /Users/x/.yarn-runner/run.sock\n" }));

	const res = await clearAppAuth("mac1", "Yarn", "bob", { inventory: FLEET, run });

	assert.equal(res.ok, false);
	assert.match(String(res.error), /cannot reach the runner/);
});

test("deleteRemoteApp__ParsesTheReport__When__TheRunnerDeletes", async () => {
	const { run, calls } = recorder(() => ok({ app: "Yarn", bundle: "/Applications/Yarn.app", removedProfiles: ["alice/yarn", "bob/yarn"] }));

	const res = await deleteRemoteApp("mac1", "Yarn", { inventory: FLEET, run });

	assert.equal(res.ok, true);
	assert.deepEqual(calls[0].argv.slice(0, 3), ["runnerctl", "appdelete", "--json"]);
	assert.equal(specOf(calls[0].argv).app, "Yarn");
	assert.equal(res.bundle, "/Applications/Yarn.app");
	assert.deepEqual(res.removedProfiles, ["alice/yarn", "bob/yarn"]);
});

test("deleteRemoteApp__ShapeChecksTheProfileList__When__AnOlderRunnerAnswersOddly", async () => {
	// The list crossed a network from a runner of unknown vintage; a non-string entry must
	// drop out rather than reach a renderer.
	const { run } = recorder(() => ok({ app: "Yarn", bundle: "/Applications/Yarn.app", removedProfiles: ["alice/yarn", 42, null] }));

	const res = await deleteRemoteApp("mac1", "Yarn", { inventory: FLEET, run });

	assert.deepEqual(res.removedProfiles, ["alice/yarn"]);
});

test("deleteRemoteApp__RelaysTheRefusal__When__TheBundleIsMissing", async () => {
	const { run } = recorder(() => refused({ error: "could not delete Ghost: Ghost.app is not in /Applications or ~/Applications" }));

	const res = await deleteRemoteApp("mac2", "Ghost", { inventory: FLEET, run });

	assert.equal(res.ok, false);
	assert.equal(res.busy, undefined);
	assert.match(String(res.error), /Ghost\.app is not in/);
});
