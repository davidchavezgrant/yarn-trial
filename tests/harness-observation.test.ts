import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { Driver } from "../src/core/driver.js";
import { observationBlocks, observe, screenIsLocked, TargetNotObservableError } from "../src/core/harness.js";
import type { ObservationBundle } from "../src/core/harness.js";

// --no-vision A/B arm: the text block must be identical across arms so the only
// difference the model sees is the presence of the image.

const bundle: ObservationBundle = {
	elementsText: '[3] AXButton "Save" @(10,20 80x30)',
	frames: new Map([["Save", { x: 10, y: 20 }]]),
	haystack: "save",
	screenshotB64: "aGk=",
	title: "Settings",
	interactive: [{ handle: 3, role: "AXButton", name: "Save", surface: "", value: "", x: 10, y: 20, w: 80, h: 30 }],
	appContent: 1,
	domEnriched: 0,
};

test("observationBlocks__OmitsImageBlock__When__VisionDisabled", () => {
	const blocks = observationBlocks(bundle, false);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].type, "text");
});

test("observationBlocks__KeepsTextIdentical__When__VisionDisabled", () => {
	const withVision = observationBlocks(bundle, true);
	const without = observationBlocks(bundle, false);
	assert.equal(withVision.length, 2);
	assert.equal(withVision[1].type, "image");
	assert.deepEqual(without[0], withVision[0]);
});

test("observationBlocks__OmitsElements__When__AxDisabled", () => {
	// The vision-only arm: the model loses the element list but keeps the screenshot and the
	// window title. The bundle itself is untouched — verify()/journal/teardown still read it.
	const blocks = observationBlocks(bundle, true, false);
	assert.equal(blocks.length, 2);
	assert.equal(blocks[0].type, "text");
	const text = (blocks[0] as { text: string }).text;
	assert.match(text, /Settings/);
	assert.doesNotMatch(text, /AXButton/);
	assert.doesNotMatch(text, /Save/);
	assert.equal(blocks[1].type, "image");
});

// --- observe(): the frontier's only input. AX frames are screen-global LOGICAL POINTS while
// coordinate actions consume SCREENSHOT PIXELS, so observe() converts — and if that conversion
// is wrong the ledger silently credits the wrong control, which nothing downstream can detect.
// Measured on Yarn: a 1920-wide window shot at 1568 (scale 0.81667) on a display left of the
// primary, hence the negative origin in this fixture.

const fakeDriver = (payload: Record<string, unknown>, shotPath: string): Driver =>
	({
		act: async () => {
			fs.mkdirSync(shotPath.replace(/\/[^/]+$/, ""), { recursive: true });
			fs.writeFileSync(shotPath, "png");

			return { text: "", structuredJson: JSON.stringify(payload) };
		},
	}) as unknown as Driver;

const axWindow = { element_index: 0, role: "AXWindow", label: "", frame: { x: -2181, y: 763, w: 1920, h: 1080 } };

const observeFixture = async (elements: unknown[], opts: { webAreaOnly?: boolean } = {}): Promise<ObservationBundle> => {
	const shot = `${process.cwd()}/out/test-observe.png`;
	const prev = process.env.AXDOM;
	process.env.AXDOM = "0"; // the sidecar needs a live app; this test is about the join-free path
	try {
		return await observe(fakeDriver({ elements, screenshot_width: 1568, screenshot_height: 882 }, shot), { pid: 1, windowId: 1 }, "test-observe", opts);
	} finally {
		if (prev === undefined) delete process.env.AXDOM;
		else process.env.AXDOM = prev;
	}
};

test("observe__ReportsInteractiveElements__When__ElementsAreClickable", async () => {
	const obs = await observeFixture([
		axWindow,
		{ element_index: 1, role: "AXGroup", label: "Toolbar", parent_index: 0, frame: { x: -2181, y: 763, w: 400, h: 60 } },
		{ element_index: 2, role: "AXButton", label: "Save", parent_index: 1, frame: { x: -2081, y: 823, w: 120, h: 40 } },
		{ element_index: 3, role: "AXStaticText", label: "Untitled", parent_index: 1, frame: { x: -2000, y: 900, w: 80, h: 20 } },
	]);
	// Static text is not actuatable, so it never joins the frontier however well-labelled.
	assert.deepEqual(obs.interactive.map((e) => e.name), ["Save"]);
	assert.equal(obs.interactive[0].surface, "Toolbar");
	// (-2081 - -2181) * 1568/1920 = 81.67 -> 82; (823 - 763) * 0.81667 = 49; 120 -> 98.
	assert.deepEqual([obs.interactive[0].x, obs.interactive[0].y, obs.interactive[0].w], [82, 49, 98]);
});

test("observe__OmitsControl__When__ItIsDisabled", async () => {
	// A disabled control cannot be actuated, so a frontier entry for it is one nothing can
	// ever clear — the run would then always end on the time cap.
	const obs = await observeFixture([
		axWindow,
		{ element_index: 1, role: "AXButton", label: "Publish", parent_index: 0, enabled: false, frame: { x: -2181, y: 763, w: 10, h: 10 } },
	]);
	assert.deepEqual(obs.interactive, []);
});

test("observe__ReportsZeroGeometry__When__WindowFrameIsUnavailable", async () => {
	// No AXWindow means no scale and no origin. Zeroing is what makes the ledger's
	// containment test MISS rather than match wrongly.
	const obs = await observeFixture([{ element_index: 1, role: "AXButton", label: "Save", frame: { x: 10, y: 20, w: 30, h: 40 } }]);
	assert.deepEqual([obs.interactive[0].x, obs.interactive[0].y, obs.interactive[0].w, obs.interactive[0].h], [0, 0, 0, 0]);
});

test("observe__KeepsTheTrueValue__When__ValueDuplicatesTheLabel", async () => {
	// The rendered line suppresses a value that repeats the label; the STRUCT must not. The
	// mutation journal restores from this field, and a text field whose content equals its
	// label used to reach it as before:"" — teardown then "restored" a field that had text
	// by clearing it.
	const obs = await observeFixture([
		axWindow,
		{ element_index: 1, role: "AXTextField", label: "Untitled", value: "Untitled", parent_index: 0, frame: { x: -2181, y: 763, w: 100, h: 20 } },
	]);
	assert.equal(obs.interactive[0].value, "Untitled");
	assert.doesNotMatch(obs.elementsText, /value="Untitled"/);
});

// TargetNotObservableError: one symptom, two causes. Until 2026-07-30 the class asserted the
// wrong one unconditionally, and two Macs with locked screens were read as a Spaces problem
// and answered with a relaunch that could not possibly have helped. These pin the split.

test("TargetNotObservableError__NamesTheLockScreen__When__TheDisplayIsLocked", () => {
	const msg = new TargetNotObservableError("Yarn", "1974 AX elements, none of them app content", true).message;
	assert.match(msg, /THE SCREEN IS LOCKED/);
	// The operator must be sent to the unlock, not to a Space. Naming Spaces here is the
	// regression itself: it is advice that cannot work on a locked machine.
	assert.doesNotMatch(msg, /Space/);
	assert.match(msg, /\.\/run signin/);
});

test("TargetNotObservableError__KeepsTheSpacesGuidance__When__TheDisplayIsUnlocked", () => {
	// Still the right answer for the other cause, and it must say the screen is unlocked so
	// the reader knows the lock was checked rather than never considered.
	const msg = new TargetNotObservableError("Yarn", "3 AX elements, none of them app content", false).message;
	assert.match(msg, /inactive\s+macOS Space/);
	assert.match(msg, /screen is unlocked/);
	assert.doesNotMatch(msg, /LOCKED/);
});

test("TargetNotObservableError__AssumesUnlocked__When__NoLockStateIsPassed", () => {
	// The default must be the message that merely misdirects, never the one that asserts a
	// lock: telling someone to unlock an already-unlocked Mac is an unanswerable instruction.
	assert.doesNotMatch(new TargetNotObservableError("Yarn", "no content").message, /LOCKED/);
});

test("screenIsLocked__ReturnsABoolean__When__AskedOnThisMachine", () => {
	// Deliberately not asserting WHICH: this test runs on developer laptops and colo Macs
	// alike. What matters is that it answers instead of throwing — it is called from inside
	// an error path and from ensureObservable's catch, where a throw would replace a real
	// diagnosis with a diagnostic's own failure.
	assert.equal(typeof screenIsLocked(), "boolean");
});

/**
 * A Chrome window as AX reports it: browser furniture hanging off the window, and the page
 * itself nested under an AXWebArea. Deliberately nests the page button DEEP — real page
 * controls sit tens of levels below their web area, which is why the filter cannot borrow
 * ancestorOf's 12-hop bound.
 */
function chromeWindowElements(pageDepth = 30): unknown[] {
	const els: unknown[] = [
		axWindow,
		{ element_index: 1, role: "AXButton", label: "Reload", parent_index: 0, frame: { x: -2181, y: 763, w: 30, h: 30 } },
		{ element_index: 2, role: "AXTextField", label: "Address and search bar", parent_index: 0, frame: { x: -2100, y: 763, w: 800, h: 30 } },
		{ element_index: 3, role: "AXButton", label: "New Tab", parent_index: 0, frame: { x: -1200, y: 763, w: 30, h: 30 } },
		{ element_index: 4, role: "AXMenuItem", label: "Bookmarks", parent_index: 0, frame: { x: -2181, y: 740, w: 90, h: 20 } },
		{ element_index: 10, role: "AXWebArea", label: "", parent_index: 0, frame: { x: -2181, y: 800, w: 1920, h: 1000 } },
	];
	let parent = 10;
	for (let i = 0; i < pageDepth; i++) {
		els.push({ element_index: 100 + i, role: "AXGroup", label: "", parent_index: parent, frame: { x: -2181, y: 800, w: 1920, h: 1000 } });
		parent = 100 + i;
	}
	els.push({ element_index: 900, role: "AXButton", label: "Share page", parent_index: parent, frame: { x: -2000, y: 900, w: 100, h: 30 } });

	return els;
}

test("observe__KeepsBrowserChrome__When__WebAreaOnlyIsOff", async () => {
	// The default must be byte-identical to the Mac-app path: no existing caller opts in.
	const obs = await observeFixture(chromeWindowElements());
	assert.ok(obs.interactive.some((e) => e.name === "Reload"));
	assert.ok(obs.interactive.some((e) => e.name === "Share page"));
});

test("observe__DropsBrowserChromeFromTheFrontier__When__WebAreaOnly", async () => {
	// The tab strip, omnibox and Chrome's menu bar are perfectly good AXButtons. Left in the
	// frontier they dominate it, and the pass spends its dismiss budget on browser furniture
	// instead of the app it was pointed at.
	const obs = await observeFixture(chromeWindowElements(), { webAreaOnly: true });
	assert.deepEqual(obs.interactive.map((e) => e.name), ["Share page"]);
});

test("observe__KeepsDeeplyNestedPageControls__When__WebAreaOnly", async () => {
	// The bound must be the element count, not ancestorOf's 12: a page control 40 levels down
	// is ordinary, and dropping it would look like a site with almost no controls.
	const obs = await observeFixture(chromeWindowElements(40), { webAreaOnly: true });
	assert.deepEqual(obs.interactive.map((e) => e.name), ["Share page"]);
});

test("observe__StillListsBrowserChrome__When__WebAreaOnlyFiltersTheFrontier", async () => {
	// Filtering the frontier must not blind the model: if a page fails to load, the omnibox is
	// how it sees where it actually is.
	const obs = await observeFixture(chromeWindowElements(), { webAreaOnly: true });
	assert.match(obs.elementsText, /Address and search bar/);
});

test("observationBlocks__OmitsImageBlock__When__FrameWasNotCaptured", () => {
	// The DOM path degrades a missing screenshot to "" rather than throwing, so this is the
	// guard that stops that empty string reaching the API as a malformed image block — which
	// would fail the request and end the run, the very outcome the degradation prevents.
	const blocks = observationBlocks({ ...bundle, screenshotB64: "" }, true);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].type, "text");
});
