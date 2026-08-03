import assert from "node:assert/strict";
import { test } from "node:test";
import { applySnap, executeAction, snapPick, type StepContext, type StepLoopState } from "../src/core/agent/step.js";
import type { InteractiveElement, ObservationBundle } from "../src/core/harness.js";
import type { ActionRequest, StepRecord } from "../src/types.js";

/**
 * BEHAVIOURAL cover for the pixel-snap stage, against synthetic observations.
 *
 * The snap decision had tests before this file and they were `assert.match` over step.ts's own
 * SOURCE (tests/fresh-target.test.ts), which pinned the distance formula and the opt-in guard and
 * could not see which element got picked. Two bugs lived comfortably underneath: the caller
 * re-found the chosen element by (name, role) — matching the FIRST nameless combobox on a screen
 * full of them — and ties among containing rects went to tree order, handing a click inside a
 * button inside a clickable wrapper to the wrapper. Both are wrong-control actuations that logged
 * `snapApplied: true`, which is the worst available outcome: a mis-click that reads as a clean one
 * on the arm built to measure whether snapping works at all.
 *
 * So these tests drive the real selection (snapPick/applySnap, now module scope for exactly this
 * reason) and the real step loop, and assert on the element that came out.
 */

function el(over: Partial<InteractiveElement> & { handle: number | string }): InteractiveElement {
	return { role: "button", name: "", namedBy: "ax", surface: "", value: "", x: 0, y: 0, w: 10, h: 10, ...over };
}

function observation(interactive: InteractiveElement[], haystack = "Yarn"): ObservationBundle {
	return {
		elementsText: interactive.map((e) => `${e.role} "${e.name}"`).join("\n"),
		haystack,
		// Blank on purpose: no frame from this run means no pixel channel, which keeps the step
		// off the filesystem entirely.
		screenshotB64: "",
		title: "Yarn",
		interactive,
		appContent: interactive.length,
		domEnriched: 0,
		frames: new Map(),
	};
}

/** Yarn's settings shape: anonymous `combobox [ref=..]` rows, several on one screen. */
const NAMELESS_COMBOBOXES = [
	el({ handle: 4, role: "combobox", name: "", surface: "Screen Clip Settings", x: 400, y: 65, w: 280, h: 30 }),
	el({ handle: 9, role: "combobox", name: "", surface: "Screen Clip Settings", x: 400, y: 200, w: 280, h: 30 }),
];

/** One accepted act call through the real loop, with the driver, overlay and recorder faked out. */
async function runStep(
	action: Record<string, unknown>,
	obs: ObservationBundle,
	after: ObservationBundle = obs,
): Promise<{ record: StepRecord; acted: ActionRequest[] }> {
	const records: StepRecord[] = [];
	const acted: ActionRequest[] = [];
	const ls: StepLoopState = { obs, lastShot: undefined, blindStreak: 0 };
	const ctx: StepContext = {
		driver: {
			act: async (request: ActionRequest) => {
				acted.push(request);

				return { text: "ok" };
			},
		} as never,
		cdp: undefined,
		win: { pid: 1, windowId: 2 },
		app: "Yarn",
		doObserve: async () => after,
		overlay: { setDriving: () => {} } as never,
		sync: { busy: false, lastActionAt: 0 },
		rec: { trajectory: undefined } as never,
		records,
		messages: [],
		vision: false,
		// The snap stage's only arm: the model sees pixels, the harness keeps the element list.
		noAx: true,
		cleanupMode: "off",
		journalPath: "",
		graph: undefined,
	};
	await executeAction(ctx, ls, 1, { id: "t1", name: "act", type: "tool_use", input: {} } as never, {
		action,
		expectation: { description: "the draft opens", textIncludes: ["Yarn"] },
	});

	return { record: records[0], acted };
}

async function withSnapPx<T>(px: string | undefined, fn: () => Promise<T>): Promise<T> {
	const prev = process.env.SNAP_PX;
	if (px === undefined) delete process.env.SNAP_PX;
	else process.env.SNAP_PX = px;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env.SNAP_PX;
		else process.env.SNAP_PX = prev;
	}
}

test("snapPick__ChoosesTheControlUnderThePoint__When__EveryCandidateNameIsEmpty", () => {
	// The live bug, at the size that produced it. A CDP settings `<select>` reaches the snapshot
	// as `combobox [ref=..]` with an EMPTY name (tests/cdp.test.ts pins that row shape), so
	// (snapName, snapRole) is ("", "combobox") for every one of them and identifies none.
	const picked = snapPick({ name: "click", x: 450, y: 210 }, NAMELESS_COMBOBOXES);
	assert.equal(picked?.e.handle, 9, "geometry must choose the combobox the point is inside");
	// And the re-lookup that used to stand in for it disagrees — first match in tree order, an
	// unrelated control 135px away. This assertion is the regression: it fails only if someone
	// re-introduces identity lookup, because then the two agree by construction.
	const byIdentity = NAMELESS_COMBOBOXES.find((e) => e.name === picked?.snap.snapName && e.role === picked?.snap.snapRole);
	assert.equal(byIdentity?.handle, 4, "a name+role lookup returns the FIRST nameless combobox, not the chosen one");
});

test("applySnap__AddressesTheElementGeometryChose__When__TheActionIsRewritten", () => {
	// The rewrite takes the element, not its description, so the wrong-control path above cannot
	// exist. The coordinate goes away with it: leaving x/y behind would let toActionRequest
	// prefer the raw point (harness/actions.ts) and undo the whole stage.
	const action: Record<string, unknown> = { name: "click", x: 450, y: 210 };
	const picked = snapPick(action, NAMELESS_COMBOBOXES);
	applySnap(action, picked!.e, false);
	assert.equal(action.element_index, 9);
	assert.equal(action.x, undefined);
	assert.equal(action.y, undefined);
	// cdp speaks refs, ax speaks indices, and the handle is whatever the observation produced.
	const web: Record<string, unknown> = { name: "click", x: 450, y: 210 };
	applySnap(web, el({ handle: "e12" }), true);
	assert.equal(web.ref, "e12");
	assert.equal(web.element_index, undefined);
});

test("snapPick__ChoosesTheNearerTwin__When__TwoControlsShareNameAndRole", () => {
	// Yarn's Library really does carry two controls named "New Draft" (see targetOrdinal in
	// step.ts, and the replay that refused to guess between them). Identity cannot separate
	// them; position can, and position is the only thing a pixel click means.
	const twins = [
		el({ handle: 3, role: "button", name: "New Draft", x: 100, y: 50, w: 90, h: 30 }),
		el({ handle: 9, role: "button", name: "New Draft", x: 600, y: 400, w: 90, h: 30 }),
	];
	// Outside both, 10px past the second: distance ranking, not containment.
	assert.equal(snapPick({ name: "click", x: 700, y: 415 }, twins)?.e.handle, 9);
	assert.equal(snapPick({ name: "click", x: 95, y: 65 }, twins)?.e.handle, 3);
});

test("snapPick__ChoosesTheInnermostControl__When__NestedRectsContainThePoint", () => {
	/**
	 * Every rect containing the point scores distance 0, so ties are the common case rather than
	 * an edge one — and CDP admits containers to the interactive list on `cursor=pointer` alone
	 * (src/backends/cdp.ts), which is how a card, a row and a button end up stacked under one
	 * click. Tree order put the outermost first, so strict `<` snapped to the wrapper: an
	 * ancestor whose press does something else, or nothing.
	 */
	const nested = [
		el({ handle: 1, role: "generic", name: "Card", x: 0, y: 0, w: 300, h: 100 }),
		el({ handle: 2, role: "generic", name: "Row", x: 20, y: 10, w: 260, h: 60 }),
		el({ handle: 3, role: "button", name: "Publish", x: 40, y: 20, w: 60, h: 30 }),
	];
	const picked = snapPick({ name: "click", x: 60, y: 35 }, nested);
	assert.equal(picked?.e.handle, 3, "the innermost control under the point is what the model meant");
	assert.equal(picked?.snap.snapInside, true);
	assert.equal(picked?.snap.snapDistancePx, 0);
	// Order-independent: the smallest rect wins whichever way the tree walk happens to emit them.
	assert.equal(snapPick({ name: "click", x: 60, y: 35 }, [...nested].reverse())?.e.handle, 3);
});

test("snapPick__ReturnsNothing__When__TheActionCarriesNoPoint", () => {
	// An element-addressed action, a key press and a drag all have no x/y, and inventing a snap
	// for them would attach a spatial diagnostic to a step that made no spatial claim.
	assert.equal(snapPick({ name: "click", element_index: 4 }, NAMELESS_COMBOBOXES), undefined);
	assert.equal(snapPick({ name: "press_key", key: "return" }, NAMELESS_COMBOBOXES), undefined);
	assert.equal(snapPick({ name: "drag", from_x: 10, from_y: 10, to_x: 90, to_y: 90 }, NAMELESS_COMBOBOXES), undefined);
	// And a zero-area control is not a snap target: the AX→screenshot transform collapses every
	// rect to 0 when the display scale could not be derived (observation.ts), and snapping to
	// one of those would aim the click at the origin.
	assert.equal(snapPick({ name: "click", x: 5, y: 5 }, [el({ handle: 1, w: 0, h: 0 })]), undefined);
});

test("executeAction__CarriesTargetMetadata__When__TheStepWasSnapped", async () => {
	/**
	 * A snapped step must be indistinguishable from one that addressed the element directly.
	 * `target` used to resolve ~86 lines before the snap ran, so on precisely the steps the snap
	 * had just given a target it stayed undefined: no targetName, no targetRole, no targetRect,
	 * no targetSurface. Channel attribution, procedure harvest and the cursor pass all read those
	 * fields, so a snapped run looked target-less to every consumer downstream of it.
	 */
	const button = el({ handle: 7, role: "button", name: "New Draft", surface: "Library", namedBy: "dom", x: 400, y: 240, w: 100, h: 40 });
	// A nameless decoy earlier in tree order, which is what the old identity re-lookup would
	// have actuated instead of the button the geometry chose.
	const obs = observation([el({ handle: 4, role: "combobox", name: "", x: 400, y: 65, w: 280, h: 30 }), button]);
	// 20px above the button: a miss the stage is meant to rescue, and outside every rect, so
	// nothing but the snap could have produced a target.
	const action: Record<string, unknown> = { name: "click", x: 450, y: 220, target: { name: "New Draft" } };
	const { record, acted } = await withSnapPx("40", () => runStep(action, obs));
	assert.equal(record.snapApplied, true);
	assert.equal(record.snapDistancePx, 20);
	assert.equal(record.snapInside, false);
	assert.equal(record.snapMatchesDeclared, true);
	assert.equal(record.targetName, "New Draft");
	assert.equal(record.targetRole, "button");
	assert.deepEqual(record.targetRect, { x: 400, y: 240, w: 100, h: 40 });
	assert.equal(record.targetSurface, "Library");
	assert.equal(record.targetNamedBy, "dom");
	// The driver was aimed at the element, by handle, with no coordinate left to fall back to.
	assert.deepEqual(acted[0]?.kind === "tool" ? acted[0].args : {}, { pid: 1, window_id: 2, element_index: 7 });
	// The model was shown no list, so the index it never chose must not be scored as attention.
	assert.equal(record.chosenIndex, undefined);
	assert.equal(record.chosenDepth, undefined);
});

test("executeAction__LeavesTheCoordinateUntouched__When__NothingIsWithinTolerance", async () => {
	// The tolerance is the stage's whole claim to being a refinement rather than a substitution:
	// beyond it the model's pixel stands, unedited, and only the diagnostic is written down.
	const button = el({ handle: 7, role: "button", name: "New Draft", surface: "Library", x: 400, y: 300, w: 100, h: 40 });
	const obs = observation([button]);
	const action: Record<string, unknown> = { name: "click", x: 450, y: 250, target: { name: "New Draft" } };
	const { record, acted } = await withSnapPx("10", () => runStep(action, obs));
	assert.equal(record.snapApplied, undefined, "50px away is outside a 10px tolerance");
	assert.equal(record.snapDistancePx, 50, "the diagnostic is recorded whether or not it is acted on");
	assert.equal(record.targetName, undefined, "an unsnapped miss hit no rect, so it addressed no element");
	assert.deepEqual(acted[0]?.kind === "tool" ? acted[0].args : {}, {
		pid: 1,
		window_id: 2,
		x: 450,
		y: 250,
		delivery_mode: "foreground",
	});
});

test("executeAction__RecordsTheDiagnosticAndActsOnNothing__When__SnapPxIsUnset", async () => {
	// Default-off is what lets every existing arm keep its numbers: with SNAP_PX unset the stage
	// costs one pass over an array and changes no behaviour at all.
	const button = el({ handle: 7, role: "button", name: "New Draft", x: 400, y: 240, w: 100, h: 40 });
	const action: Record<string, unknown> = { name: "click", x: 450, y: 250, target: { name: "Publish" } };
	const { record, acted } = await withSnapPx(undefined, () => runStep(action, observation([button])));
	assert.equal(record.snapApplied, undefined);
	assert.equal(record.snapInside, true, "the point was inside the button — a SEMANTIC miss, not a spatial one");
	assert.equal(record.snapName, "New Draft");
	assert.equal(record.snapMatchesDeclared, false, "declared Publish, landed on New Draft");
	assert.equal(acted[0]?.kind === "tool" ? (acted[0].args as Record<string, unknown>).x : undefined, 450);
});
