import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildGraphsData, mapsForApp, trimStep } from "../src/bench/graphs.js";
import type { DashState } from "../src/bench/dash.js";
import type { Manifest } from "../src/bench/manifest.js";
import type { StepRecord } from "../src/types.js";
import { withTemp } from "./fixtures.js";

/**
 * The graphs page's server module, offline: every read goes through YARN_RUNNER_DATA, so a
 * temp root exercises the same resolution the live server uses. State is hand-built — the
 * module consumes DashState, it never assembles one.
 */

const step = (over: Partial<StepRecord>): StepRecord => ({
	index: 0,
	timestamp: "2026-07-31T09:28:01.675Z",
	action: { kind: "tool", name: "click", args: { element_index: 3 } } as StepRecord["action"],
	expectation: { description: "" },
	verified: true,
	verificationNote: "",
	...over,
});

test("TrimStep__UnwrapsToolName__When__ActionRidesToolKind", () => {
	const t = trimStep(step({}));
	assert.equal(t.name, "click");
	assert.equal(t.verified, true);
	assert.equal(t.x, undefined);
});

test("TrimStep__CarriesCoordinates__When__PaintedTargetClickUsesArgs", () => {
	const t = trimStep(step({ action: { kind: "tool", name: "click", args: { x: 120, y: 340 } } as StepRecord["action"] }));
	assert.equal(t.x, 120);
	assert.equal(t.y, 340);
});

test("TrimStep__CarriesDragEndpoints__When__ActionIsDrag", () => {
	const t = trimStep(step({ action: { kind: "tool", name: "drag", args: { from_x: 1, from_y: 2, to_x: 30, to_y: 40 } } as StepRecord["action"] }));
	assert.equal(t.name, "drag");
	assert.equal(t.x, 1);
	assert.equal(t.y, 2);
	assert.equal(t.toX, 30);
	assert.equal(t.toY, 40);
});

test("TrimStep__CarriesWaitSeconds__When__ActionIsWait", () => {
	const t = trimStep(step({ action: { kind: "tool", name: "wait", args: { seconds: 120 } } as StepRecord["action"] }));
	assert.equal(t.seconds, 120);
});

test("TrimStep__TruncatesReasoning__When__ModelWroteAnEssay", () => {
	const t = trimStep(step({ modelReasoning: "x".repeat(1000) }));
	assert.ok((t.reasoning ?? "").length <= 281);
});

test("MapsForApp__FiltersByAppField__When__OtherAppsShareTheDir", () => {
	withTemp("graphs-maps-", (dir) => {
		const maps = path.join(dir, "docs", "appmaps");
		fs.mkdirSync(maps, { recursive: true });
		const mk = (slug: string, app: string) =>
			fs.writeFileSync(path.join(maps, `${slug}.json`), JSON.stringify({ app, capturedAt: "", provenance: "explore", nodes: [{ id: "a", title: "A", kind: "surface", scope: "app" }], edges: [] }));
		mk("yarn.ax", "Yarn");
		mk("yarn.cdp", "Yarn");
		mk("web-example.com", "example");
		const prev = process.env.YARN_RUNNER_DATA;
		process.env.YARN_RUNNER_DATA = dir;
		try {
			const got = mapsForApp("Yarn");
			assert.deepEqual(got.map((m) => m.slug), ["yarn.ax", "yarn.cdp"]);
		} finally {
			if (prev === undefined) delete process.env.YARN_RUNNER_DATA;
			else process.env.YARN_RUNNER_DATA = prev;
		}
	});
});

const stateWith = (passModel: string): DashState =>
	({
		arms: [{
			id: "p2-cdp-grounded", title: "Explored Task", phase: 2, kind: "task", n: 3, flags: "",
			app: "Yarn", perception: "DOM + vision", actuation: "CDP", targetKey: "Yarn",
			passes: [{ model: passModel, submitted: 0, collected: 0, successes: 0, usd: 0, unpriced: 0, assumed: 0, rejections: 0, documentScopeMutations: 0, failureBreakdown: "", entries: [] }],
		}],
	}) as unknown as DashState;

const MANIFEST: Manifest = { date: "2026-07-31", createdAt: "", entries: [] };

test("BuildGraphsData__ResolvesDefaultPass__When__ModelParamAbsent", () => {
	const got = buildGraphsData("p2-cdp-grounded", undefined, MANIFEST, stateWith("(default)"));
	assert.ok(!("error" in got), JSON.stringify(got));
	assert.equal(got.pass.model, "(default)");
	assert.deepEqual(got.runs, []);
});

test("BuildGraphsData__NamesAvailablePasses__When__ModelDoesNotMatch", () => {
	const got = buildGraphsData("p2-cdp-grounded", "nope", MANIFEST, stateWith("gpt-x"));
	assert.ok("error" in got);
	assert.match(got.error, /gpt-x/);
});

test("BuildGraphsData__ReportsUnknownArm__When__IdIsNotOnTheBoard", () => {
	const got = buildGraphsData("no-such-arm", undefined, MANIFEST, stateWith("(default)"));
	assert.ok("error" in got);
	assert.match(got.error, /unknown arm/);
});
