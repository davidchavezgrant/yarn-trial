import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { beats, type MapVersion, planTransfers, readAppmaps, type Source, summarise, syncAppmaps } from "../src/fleet/remote/appmaps.js";
import type { SshResult, SshRunner } from "../src/fleet/remote/ssh.js";
import { host, inventory } from "./fixtures.js";

/**
 * Appmap sharing, offline. Every ssh and every rsync is injected and every directory is a temp
 * dir: three colo Macs are live, and a test that reached one could overwrite a real grounding
 * pass with a fixture.
 *
 * The half worth the most attention is `beats`/`planTransfers`, because that is where a wrong
 * answer is expensive rather than merely broken — the failure mode is not an error, it is a
 * newer map being silently replaced by an older one, which nobody notices until an agent runs
 * against stale knowledge.
 */

function tmp(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "appmaps-test-"));
}

/** Write one app's pair into `dir`. Omit `capturedAt` for a prose-only map. */
function writeMap(dir: string, slug: string, capturedAt?: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${slug}.md`), `# ${slug}\n`);
	if (capturedAt) fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify({ app: slug, capturedAt, nodes: [] }));
}

function version(slug: string, capturedAt?: string): MapVersion {
	return { slug, capturedAt, hasGraph: !!capturedAt, files: capturedAt ? [`${slug}.md`, `${slug}.json`] : [`${slug}.md`] };
}

function source(name: string, ...maps: MapVersion[]): Source {
	return { name, dir: `/nowhere/${name}`, maps: new Map(maps.map((m) => [m.slug, m])) };
}

// ── reading ──────────────────────────────────────────────────────────────────────────────

test("readAppmaps__PairsBothHalves__When__MdAndJsonShareAStem", () => {
	const dir = tmp();
	writeMap(dir, "yarn", "2026-07-30T11:03:00.000Z");
	const maps = readAppmaps(dir);
	assert.equal(maps.size, 1);
	assert.deepEqual(maps.get("yarn")?.files, ["yarn.json", "yarn.md"]);
	assert.equal(maps.get("yarn")?.capturedAt, "2026-07-30T11:03:00.000Z");
	assert.equal(maps.get("yarn")?.hasGraph, true);
});

test("readAppmaps__ReportsNoGraph__When__OnlyProseExists", () => {
	const dir = tmp();
	writeMap(dir, "notion-calendar");
	const v = readAppmaps(dir).get("notion-calendar");
	assert.equal(v?.hasGraph, false);
	assert.equal(v?.capturedAt, undefined);
});

/**
 * The realistic way to meet an unparseable graph is to have rsynced a file mid-write. Leaving
 * that app alone this round is right; aborting the whole sync over it is not.
 */
test("readAppmaps__TreatsItAsUnstamped__When__TheGraphDoesNotParse", () => {
	const dir = tmp();
	writeMap(dir, "yarn");
	fs.writeFileSync(path.join(dir, "yarn.json"), '{"app":"yarn","captu');
	const v = readAppmaps(dir).get("yarn");
	assert.equal(v?.capturedAt, undefined);
	assert.equal(v?.hasGraph, false);
	assert.deepEqual(v?.files, ["yarn.json", "yarn.md"]);
});

test("readAppmaps__ReturnsEmpty__When__TheDirectoryIsAbsent", () => {
	assert.equal(readAppmaps(path.join(tmp(), "never-created")).size, 0);
});

test("readAppmaps__IgnoresIt__When__TheFileIsNeitherHalf", () => {
	const dir = tmp();
	writeMap(dir, "yarn", "2026-07-30T11:03:00.000Z");
	fs.writeFileSync(path.join(dir, "README.txt"), "not a map");
	assert.deepEqual([...readAppmaps(dir).keys()], ["yarn"]);
});

// ── comparing ────────────────────────────────────────────────────────────────────────────

test("beats__PrefersTheNewerStamp__When__BothAreStamped", () => {
	const older = version("yarn", "2026-07-29T09:00:00.000Z");
	const newer = version("yarn", "2026-07-30T11:03:00.000Z");
	assert.equal(beats(newer, older), true);
	assert.equal(beats(older, newer), false);
});

/** A graph carries scope-collision data prose cannot express; losing it turns the warnings off. */
test("beats__PrefersTheStampedMap__When__TheOtherHasNoGraph", () => {
	assert.equal(beats(version("yarn", "2026-07-30T11:03:00.000Z"), version("yarn")), true);
	assert.equal(beats(version("yarn"), version("yarn", "2026-07-30T11:03:00.000Z")), false);
});

/** No evidence either way. Overwriting on no evidence is how a good map is replaced by a worse one. */
test("beats__HoldsThemEqual__When__NeitherIsStamped", () => {
	assert.equal(beats(version("yarn"), version("yarn")), false);
});

test("beats__HoldsThemEqual__When__TheStampsAreIdentical", () => {
	const stamp = "2026-07-30T11:03:00.000Z";
	assert.equal(beats(version("yarn", stamp), version("yarn", stamp)), false);
});

// ── planning ─────────────────────────────────────────────────────────────────────────────

test("planTransfers__SendsToEveryone__When__OneMacGroundedAnApp", () => {
	const plan = planTransfers([
		source("local"),
		source("mac1", version("yarn", "2026-07-30T11:03:00.000Z")),
		source("mac2"),
	]);
	assert.deepEqual(plan, [
		{ slug: "yarn", from: "mac1", to: "local", reason: "missing" },
		{ slug: "yarn", from: "mac1", to: "mac2", reason: "missing" },
	]);
});

test("planTransfers__SaysOlder__When__TheDestinationHasAStaleCopy", () => {
	const plan = planTransfers([
		source("local", version("yarn", "2026-07-29T09:00:00.000Z")),
		source("mac1", version("yarn", "2026-07-30T11:03:00.000Z")),
	]);
	assert.deepEqual(plan, [{ slug: "yarn", from: "mac1", to: "local", reason: "older" }]);
});

test("planTransfers__MovesNothing__When__EveryCopyMatches", () => {
	const stamp = "2026-07-30T11:03:00.000Z";
	assert.deepEqual(planTransfers([source("local", version("yarn", stamp)), source("mac1", version("yarn", stamp))]), []);
});

/**
 * `local` is passed first by `syncAppmaps`, so this is what stops two equally-stamped copies
 * ping-ponging between the hub and a Mac on every dispatch.
 */
test("planTransfers__SendsFromTheFirstSource__When__TwoCopiesTie", () => {
	const stamp = "2026-07-30T11:03:00.000Z";
	const plan = planTransfers([source("local", version("yarn", stamp)), source("mac1", version("yarn", stamp)), source("mac2")]);
	assert.deepEqual(plan, [{ slug: "yarn", from: "local", to: "mac2", reason: "missing" }]);
});

/** Neither can prove it is better, so neither overwrites the other and the pair stays put. */
test("planTransfers__LeavesBothAlone__When__TwoUnstampedCopiesDiffer", () => {
	assert.deepEqual(planTransfers([source("local", version("yarn")), source("mac1", version("yarn"))]), []);
});

test("planTransfers__PlansEachAppIndependently__When__DifferentMacsGroundedDifferentApps", () => {
	const plan = planTransfers([
		source("mac1", version("yarn", "2026-07-30T11:03:00.000Z")),
		source("mac2", version("notion-calendar", "2026-07-28T08:00:00.000Z")),
	]);
	assert.deepEqual(plan, [
		{ slug: "notion-calendar", from: "mac2", to: "mac1", reason: "missing" },
		{ slug: "yarn", from: "mac1", to: "mac2", reason: "missing" },
	]);
});

// ── syncing ──────────────────────────────────────────────────────────────────────────────

/** Every host answers `doctor` with a data root, which is all syncAppmaps asks over ssh. */
function doctorRuns(root = "/Users/administrator/yarn-trial"): SshRunner {
	return async () => ({ code: 0, stdout: `${JSON.stringify({ ok: true, dataRoot: root })}\n`, stderr: "" });
}

/**
 * An rsync that moves real files, so the assertions are about the directories afterwards
 * rather than about argv. Remote paths are mapped back onto a local fixture dir by `roots`.
 */
function fakeRsync(roots: Record<string, string>, log: string[][] = []) {
	const localise = (spec: string): string => {
		const at = spec.indexOf(":");
		if (at < 0) return spec;
		const [, addr] = spec.slice(0, at).split("@");
		const remote = spec.slice(at + 1);
		const root = roots[addr];
		if (!root) return spec;

		return remote.replace(/^.*?yarn-trial\/docs\/appmaps/, root);
	};

	return async (argv: string[]): Promise<SshResult> => {
		log.push(argv);
		const paths = argv.filter((a) => !a.startsWith("-") && a !== argv[argv.indexOf("-e") + 1]);
		const dest = localise(paths[paths.length - 1]);
		const srcs = paths.slice(0, -1).map(localise);
		fs.mkdirSync(dest.endsWith("/") ? dest : path.dirname(dest), { recursive: true });
		for (const src of srcs) {
			if (src.endsWith("/")) {
				if (!fs.existsSync(src)) return { code: 23, stdout: "", stderr: `rsync: change_dir "${src}" failed: No such file or directory (2)` };
				fs.cpSync(src, dest, { recursive: true });
			} else fs.copyFileSync(src, path.join(dest, path.basename(src)));
		}

		return { code: 0, stdout: "", stderr: "" };
	};
}

test("syncAppmaps__BringsTheMapHome__When__OnlyAMacHasIt", async () => {
	const local = tmp();
	const stage = tmp();
	const mac1 = tmp();
	writeMap(mac1, "yarn", "2026-07-30T11:03:00.000Z");

	const r = await syncAppmaps({
		inventory: inventory(host("mac1", "10.0.0.1")),
		localDir: local,
		stageDir: stage,
		run: doctorRuns(),
		rsync: fakeRsync({ "10.0.0.1": mac1 }),
	});

	assert.deepEqual(r.adopted, ["yarn"]);
	assert.deepEqual(fs.readdirSync(local).sort(), ["yarn.json", "yarn.md"]);
});

/** Both halves or neither: a prose map without its graph is one whose scope warnings are off. */
test("syncAppmaps__SendsBothHalves__When__ItPushesToAMac", async () => {
	const local = tmp();
	const stage = tmp();
	const mac1 = tmp();
	const mac2 = tmp();
	writeMap(mac1, "yarn", "2026-07-30T11:03:00.000Z");
	fs.mkdirSync(mac2, { recursive: true });

	const r = await syncAppmaps({
		inventory: inventory(host("mac1", "10.0.0.1"), host("mac2", "10.0.0.2")),
		localDir: local,
		stageDir: stage,
		run: doctorRuns(),
		rsync: fakeRsync({ "10.0.0.1": mac1, "10.0.0.2": mac2 }),
	});

	assert.deepEqual(fs.readdirSync(mac2).sort(), ["yarn.json", "yarn.md"]);
	assert.deepEqual(r.hosts.find((h) => h.host === "mac2")?.received, ["yarn"]);
	assert.deepEqual(r.hosts.find((h) => h.host === "mac1")?.sent, ["yarn"]);
});

test("syncAppmaps__PushesTheHubsMap__When__AMacIsBehind", async () => {
	const local = tmp();
	const stage = tmp();
	const mac1 = tmp();
	writeMap(local, "yarn", "2026-07-30T11:03:00.000Z");
	writeMap(mac1, "yarn", "2026-07-29T09:00:00.000Z");

	await syncAppmaps({
		inventory: inventory(host("mac1", "10.0.0.1")),
		localDir: local,
		stageDir: stage,
		run: doctorRuns(),
		rsync: fakeRsync({ "10.0.0.1": mac1 }),
	});

	const graph = JSON.parse(fs.readFileSync(path.join(mac1, "yarn.json"), "utf8")) as { capturedAt: string };
	assert.equal(graph.capturedAt, "2026-07-30T11:03:00.000Z");
});

/** A Mac that is asleep costs a note, never a refusal — this runs on the path of ordinary runs. */
test("syncAppmaps__ConvergesTheRest__When__OneHostIsUnreachable", async () => {
	const local = tmp();
	const stage = tmp();
	const mac2 = tmp();
	writeMap(local, "yarn", "2026-07-30T11:03:00.000Z");
	const run: SshRunner = async (h) =>
		h.name === "mac1" ? { code: 255, stdout: "", stderr: "ssh: connect: Host is down" } : { code: 0, stdout: `${JSON.stringify({ ok: true, dataRoot: "/Users/administrator/yarn-trial" })}\n`, stderr: "" };

	const r = await syncAppmaps({
		inventory: inventory(host("mac1", "10.0.0.1"), host("mac2", "10.0.0.2")),
		localDir: local,
		stageDir: stage,
		run,
		rsync: fakeRsync({ "10.0.0.2": mac2 }),
	});

	assert.match(r.hosts.find((h) => h.host === "mac1")?.reason ?? "", /unreachable/);
	assert.deepEqual(fs.readdirSync(mac2).sort(), ["yarn.json", "yarn.md"]);
});

/** rsync exits 23 on a missing source. A Mac with no appmaps dir has no maps — it is not a failure. */
test("syncAppmaps__TreatsItAsEmpty__When__TheMacHasNoAppmapsDirectory", async () => {
	const local = tmp();
	const stage = tmp();
	const mac1 = path.join(tmp(), "never-created");
	writeMap(local, "yarn", "2026-07-30T11:03:00.000Z");

	const r = await syncAppmaps({
		inventory: inventory(host("mac1", "10.0.0.1")),
		localDir: local,
		stageDir: stage,
		run: doctorRuns(),
		rsync: fakeRsync({ "10.0.0.1": mac1 }),
	});

	assert.equal(r.hosts[0].reason, undefined);
	assert.deepEqual(r.transfers, [{ slug: "yarn", from: "local", to: "mac1", reason: "missing" }]);
});

test("syncAppmaps__MovesNothing__When__DryRun", async () => {
	const local = tmp();
	const stage = tmp();
	const mac1 = tmp();
	writeMap(mac1, "yarn", "2026-07-30T11:03:00.000Z");

	const r = await syncAppmaps({
		inventory: inventory(host("mac1", "10.0.0.1")),
		localDir: local,
		stageDir: stage,
		dryRun: true,
		run: doctorRuns(),
		rsync: fakeRsync({ "10.0.0.1": mac1 }),
	});

	assert.equal(r.transfers.length, 1);
	assert.deepEqual(r.adopted, []);
	assert.deepEqual(fs.readdirSync(local), []);
});

/** The post-grounding fan-out names the app it just grounded; nothing else should ride along. */
test("syncAppmaps__MovesOnlyThatApp__When__ASlugIsNamed", async () => {
	const local = tmp();
	const stage = tmp();
	const mac1 = tmp();
	writeMap(mac1, "yarn", "2026-07-30T11:03:00.000Z");
	writeMap(mac1, "notion-calendar", "2026-07-28T08:00:00.000Z");

	const r = await syncAppmaps({
		inventory: inventory(host("mac1", "10.0.0.1")),
		localDir: local,
		stageDir: stage,
		slug: "yarn",
		run: doctorRuns(),
		rsync: fakeRsync({ "10.0.0.1": mac1 }),
	});

	assert.deepEqual(r.adopted, ["yarn"]);
	assert.deepEqual(fs.readdirSync(local).sort(), ["yarn.json", "yarn.md"]);
});

/** No fleet configured is the local-only case: nothing to sync with, and nothing to complain about. */
test("syncAppmaps__DoesNothingQuietly__When__ThereAreNoHosts", async () => {
	const r = await syncAppmaps({ inventory: inventory(), localDir: tmp(), stageDir: tmp() });
	assert.deepEqual(r.transfers, []);
	assert.deepEqual(r.hosts, []);
});

test("summarise__SaysAlreadyInSync__When__NothingMoved", () => {
	assert.equal(summarise({ transfers: [], hosts: [], adopted: [], dryRun: false }), "already in sync");
});
