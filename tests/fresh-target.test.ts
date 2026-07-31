import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { executeAction } from "../src/core/agent/step.js";
import type { Driver } from "../src/core/driver.js";
import { ACT_TOOL, DEMO_ACT_TOOL, DEMO_DRIVER_RULES, DRIVER_RULES } from "../src/core/harness.js";
import type { InteractiveElement, ObservationBundle } from "../src/core/harness.js";
import { chunkText, demoTranslate, type FreshSnapshot, resolveFresh, visibleCentroid } from "../src/core/harness/fresh-target.js";
import type { StepRecord } from "../src/types.js";

// --- Demo actuation (recorded runs). The forensic run 2026-07-31T05-45-03 established the
// failure classes these pin: AXPress clicks that focus nothing, typed text leaking into an
// auto-focused field, stale rects wrong at source, and a delivery counter that lies.

const win = { pid: 42, windowId: 7 };

const staleField: InteractiveElement = {
	handle: 5,
	role: "AXTextField",
	name: "Script",
	surface: "Editor",
	value: "",
	x: 100,
	y: 200,
	w: 300,
	h: 40,
};

test("DemoTranslate__EmitsClickThenChunks__When__TypeTextRecorded", () => {
	// The fresh tree moved the field by 10px — the click must land on the FRESH rect. No
	// screenshot in the snapshot, so the point falls back to the rect centre.
	const snap: FreshSnapshot = { elements: [{ role: "AXTextField", name: "Script", x: 110, y: 210, w: 300, h: 40 }] };
	const plan = demoTranslate({ name: "type_text", element_index: 5, text: "hello brave new world" }, win, staleField, snap);
	assert.ok(plan);
	assert.equal(plan.typedLive, true);

	const [first, ...chunks] = plan.seq.map((s) => s.request as { kind: "tool"; name: string; args: Record<string, unknown> });
	assert.equal(first.name, "click");
	assert.equal(first.args.delivery_mode, "foreground");
	// Coordinate, never element_index/AXPress — the AXPress "click" moves no pointer and did
	// not focus the field it pressed.
	assert.equal(first.args.element_index, undefined);
	assert.deepEqual([first.args.x, first.args.y], [110 + 150, 210 + 20]);

	assert.ok(chunks.length >= 2);
	for (const c of chunks) {
		assert.equal(c.name, "type_text");
		assert.equal(c.args.element_index, undefined); // CGEvent-at-focus is the path that delivers
		assert.equal(c.args.delay_ms, 70);
	}
	assert.equal(chunks.map((c) => c.args.text).join(""), "hello brave new world");
	assert.deepEqual(
		plan.seq.slice(1).map((s) => s.chunkText),
		chunks.map((c) => c.args.text),
	);
});

test("DemoTranslate__OmitsSetValue__When__Recorded", () => {
	const enumOf = (t: unknown) => (t as any).input_schema.properties.action.properties.name.enum as string[];
	assert.ok(!enumOf(DEMO_ACT_TOOL).includes("set_value"));
	assert.ok(enumOf(DEMO_ACT_TOOL).includes("type_text"));
	// The live tool keeps it — non-recorded runs are untouched.
	assert.ok(enumOf(ACT_TOOL).includes("set_value"));
	assert.match((DEMO_ACT_TOOL as any).input_schema.properties.action.properties.element_index.description, /clicks that field for real/);
	// The demo rules carry the flipped typing contract; the live rules do not change.
	assert.match(DEMO_DRIVER_RULES, /set_value does not exist on recorded runs/);
	assert.ok(!DRIVER_RULES.includes("Recorded-run actuation"));
	// And the translation has no set_value path — it falls back to the live request builder.
	assert.equal(demoTranslate({ name: "set_value", element_index: 3, text: "x" }, win, staleField, { elements: [] }), null);
});

test("Chunks__SplitAtWordBoundaries__When__TextExceedsChunkSize", () => {
	const text = "the quick brown fox jumps over the lazy dog again";
	const { chunks, delayMs } = chunkText(text);
	assert.equal(chunks.join(""), text);
	assert.equal(delayMs, 70);
	assert.ok(chunks.length > 1);
	for (const c of chunks) assert.ok(c.length <= 14, `chunk too long: "${c}"`);
	// No word here exceeds the chunk ceiling, so every break must fall after a space.
	for (const c of chunks.slice(0, -1)) assert.ok(c.endsWith(" "), `mid-word break: "${c}"`);

	// Past 200 chars the pacing trades legibility for a bounded step duration.
	const long = chunkText("word ".repeat(50).trim());
	assert.equal(long.delayMs, 40);
	for (const c of long.chunks) assert.ok(c.length <= 20, `long chunk too long: "${c}"`);
});

// Synthetic fixture for the centroid: an off-centre glyph hugging the left edge of an
// otherwise flat control. Written via python + PIL, the same decoder visibleCentroid shells
// to — when it is unavailable the test skips exactly like the pixelDelta tests do.
const centroidPng = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fresh-target-")), "offcentre.png");
const havePil = (() => {
	try {
		execFileSync(
			"python3",
			[
				"-c",
				[
					"from PIL import Image",
					'im = Image.new("RGB", (200, 100), (220, 220, 220))',
					"for x in range(0, 8):",
					"    for y in range(40, 60):",
					"        im.putpixel((x, y), (0, 0, 0))",
					`im.save(${JSON.stringify(centroidPng)})`,
				].join("\n"),
			],
			{ stdio: "ignore" },
		);

		return fs.existsSync(centroidPng);
	} catch {
		return false;
	}
})();

test("Centroid__ClampsToRectCore__When__ContentIsOffCenter", { skip: !havePil }, () => {
	// Raw contrast centroid sits at x≈4; the click point must stay inside the middle half of
	// the rect, so it clamps to x = rect.x + w/4.
	const p = visibleCentroid(centroidPng, { x: 0, y: 0, w: 200, h: 100 });
	assert.equal(p.x, 50);
	assert.ok(p.y >= 25 && p.y <= 75, `y=${p.y} escaped the rect core`);

	// A flat crop has no content to aim at: the rect centre is the answer.
	const flat = visibleCentroid(centroidPng, { x: 100, y: 0, w: 80, h: 100 });
	assert.deepEqual(flat, { x: 140, y: 50 });

	// No screenshot at all degrades the same way.
	assert.deepEqual(visibleCentroid(undefined, { x: 10, y: 10, w: 20, h: 20 }), { x: 20, y: 20 });
});

test("FreshResolve__FallsBackToStaleRect__When__Ambiguous", () => {
	const stale = { role: "AXButton", name: "Delete", x: 100, y: 100, w: 40, h: 20 };
	// Two same-named controls straddle the stale rect with EQUAL overlap: distinct candidates
	// with equal claim, so resolution must fall back rather than guess (replay.ts's rule).
	const straddling = [
		{ role: "AXButton", name: "Delete", x: 90, y: 100, w: 40, h: 20 },
		{ role: "AXButton", name: "Delete", x: 110, y: 100, w: 40, h: 20 },
	];
	const r = resolveFresh(stale, straddling);
	assert.equal(r.source, "stale");
	assert.deepEqual([r.x, r.y, r.w, r.h], [100, 100, 40, 20]);

	// A unique (role, name) match resolves fresh even when the control moved off the rect —
	// that is the whole point (the step-1 frame was ~43px off at source).
	const moved = resolveFresh(stale, [{ role: "AXButton", name: "Delete", x: 400, y: 300, w: 40, h: 20 }]);
	assert.equal(moved.source, "fresh");
	assert.deepEqual([moved.x, moved.y], [400, 300]);

	// Among ambiguous same-named candidates, a strictly larger overlap separates them.
	const separable = resolveFresh(stale, [
		{ role: "AXButton", name: "Delete", x: 102, y: 100, w: 40, h: 20 },
		{ role: "AXButton", name: "Delete", x: 500, y: 500, w: 40, h: 20 },
	]);
	assert.equal(separable.source, "fresh");
	assert.equal(separable.x, 102);
});

test("Verify__StillRuns__When__DriverReportsIncompleteDelivery", async () => {
	const bundle = (haystack: string): ObservationBundle => ({
		elementsText: "",
		haystack,
		screenshotB64: "",
		title: "Yarn",
		interactive: [],
		appContent: 1,
		domEnriched: 0,
		frames: new Map(),
	});
	// The exact failure shape from turn-00007: the driver errors with a delivery counter that
	// is wrong — the text landed, and the fresh observation proves it.
	const driver = {
		act: async () => {
			throw new Error("type_text failed (input_error): delivered 0 of 11 character(s) via CGEvent");
		},
	} as unknown as Driver;
	const records: StepRecord[] = [];
	const messages: any[] = [];
	const ctx = {
		driver,
		cdp: undefined,
		dom: undefined,
		win: { pid: 1, windowId: 2 },
		app: "Yarn",
		doObserve: async () => bundle("script says hello world"),
		overlay: { setDriving() {} },
		sync: { busy: false, lastActionAt: 0 },
		rec: { active: false, frameTimes: [], frameDrops: [] },
		records,
		messages,
		vision: false,
		noAx: false,
		cleanupMode: "off",
		journalPath: "",
		graph: undefined,
	};
	const ls = { obs: bundle("script is empty"), lastShot: undefined, blindStreak: 0 };
	await executeAction(ctx as any, ls as any, 1, { id: "tu_1", type: "tool_use", name: "act", input: {} } as any, {
		action: { name: "type_text", element_index: 3, text: "hello world" },
		expectation: { description: "the text lands in the script", textIncludes: ["hello world"] },
	});

	assert.equal(records.length, 1);
	// The old behavior short-circuited to "action errored" and never verified; now the
	// delivery claim is advisory and verification decides the step.
	assert.notEqual(records[0].verificationNote, "action errored");
	assert.equal(records[0].verified, true);
	assert.match(records[0].driverWarning ?? "", /delivered 0 of 11/);
	const resultText = messages.at(-1).content[0].content[0].text as string;
	assert.match(resultText, /Driver warning \(advisory\)/);
	assert.match(resultText, /Verification: PASSED/);
});

test("executeAction__RecordsTheTargetSurface__When__TheElementHasOne", async () => {
	// The write half of recipe replay's dual-scope disambiguation. Tested HERE rather than
	// against a StepRecord fixture because the fixture is what let this ship broken: recipe.ts
	// read `targetSurface` through an `as any`, compileRecipe's tests handed it one directly,
	// and nothing checked that a real step ever produced the field. It did not, for months.
	const el = (over: Partial<InteractiveElement> = {}): InteractiveElement => ({
		handle: 3,
		role: "AXPopUpButton",
		name: "Cursor Style",
		surface: "Brand Kit",
		value: "",
		x: 0,
		y: 0,
		w: 10,
		h: 10,
		...over,
	});
	const bundle = (): ObservationBundle => ({
		elementsText: "",
		haystack: "pointer-first",
		screenshotB64: "",
		title: "Yarn",
		interactive: [el()],
		appContent: 1,
		domEnriched: 0,
		frames: new Map(),
	});
	const records: StepRecord[] = [];
	const ctx = {
		driver: { act: async () => "ok" } as unknown as Driver,
		cdp: undefined,
		win: { pid: 1, windowId: 2 },
		app: "Yarn",
		doObserve: async () => bundle(),
		overlay: { setDriving() {} },
		sync: { busy: false, lastActionAt: 0 },
		rec: { active: false, frameTimes: [], frameDrops: [] },
		records,
		messages: [] as any[],
		vision: false,
		noAx: false,
		cleanupMode: "off",
		journalPath: "",
		graph: undefined,
	};
	const ls = { obs: bundle(), lastShot: undefined, blindStreak: 0 };
	await executeAction(ctx as any, ls as any, 1, { id: "tu_1", type: "tool_use", name: "act", input: {} } as any, {
		action: { name: "click", element_index: 3 },
		expectation: { description: "the style changes", textIncludes: ["Pointer-first"] },
	});

	assert.equal(records.length, 1);
	assert.equal(records[0].targetName, "Cursor Style");
	// The field a compiled recipe carries into resolveTarget's narrowing branch. Without it,
	// two same-named controls are unresolvable and the replay errors instead of running.
	assert.equal(records[0].targetSurface, "Brand Kit");
});
