import assert from "node:assert/strict";
import test from "node:test";
import { DOM_ACT_TOOL, DOM_RULES, DomBackend, pickTab, viewportOrigin } from "../src/backends/dom.js";

const tab = (id: string, url: string, title = id) => ({ tab_id: id, url, title });

test("pickTab__ReturnsTheFirstTab__When__NoOriginIsWanted", () => {
	// The historical behaviour, and the right answer for an Electron app with one page. It has
	// to stay exact: the Electron path is the only DOM target that works today.
	assert.equal(pickTab([tab("a", "app://index"), tab("b", "app://other")])?.tab_id, "a");
	assert.equal(pickTab([]), undefined);
	assert.equal(pickTab(undefined), undefined);
});

test("pickTab__FindsTheSite__When__ManyUnrelatedTabsAreOpen", () => {
	// A real browser has twenty tabs and the target is rarely tab zero.
	const t = pickTab(
		[tab("a", "https://mail.google.com/"), tab("b", "https://www.notion.so/some/page"), tab("c", "https://news.example/")],
		"https://www.notion.so",
	);
	assert.equal(t?.tab_id, "b");
});

test("pickTab__Refuses__When__TwoTabsShareTheTargetOrigin", () => {
	// Driving the wrong tab of the RIGHT site is the dangerous case: it looks like it worked.
	// Refuse, as resolveRef does for an ambiguous query.
	assert.throws(
		() => pickTab([tab("a", "https://www.notion.so/one"), tab("b", "https://www.notion.so/two")], "https://www.notion.so"),
		/2 tabs are open/,
	);
});

test("pickTab__TakesTheLoneTab__When__ItsUrlDoesNotMatchYet", () => {
	// Measured twice on a live run: a driver-launched profile sits on about:blank until
	// navigation commits, and notion.so redirects to www.notion.so. Refusing on a strict origin
	// match rejected the very tab we had just navigated, and the whole run died at bind.
	assert.equal(pickTab([tab("a", "about:blank")], "https://www.notion.so")?.tab_id, "a");
	assert.equal(pickTab([tab("a", "https://www.notion.so/x")], "https://notion.so")?.tab_id, "a");
});

test("pickTab__ReturnsUndefined__When__SeveralTabsAndNoneMatch", () => {
	// With a choice to get wrong, guessing is worse than failing: this is the multi-tab browser
	// the origin filter exists for.
	assert.equal(
		pickTab([tab("a", "https://mail.google.com/"), tab("b", "https://news.example/")], "https://www.notion.so"),
		undefined,
	);
});

test("pickTab__IgnoresTheOrigin__When__ATabHasAnUnparseableUrl", () => {
	// chrome://newtab and about:blank are always around; they must not crash the match.
	const t = pickTab([tab("a", "about:blank"), tab("b", ""), tab("c", "https://www.notion.so/x")], "https://www.notion.so");
	assert.equal(t?.tab_id, "c");
});

test("pickTab__DistinguishesByPort__When__OriginsDifferOnlyThere", () => {
	// localhost:3000 and localhost:8080 are different apps.
	const t = pickTab([tab("a", "http://localhost:8080/x"), tab("b", "http://localhost:3000/y")], "http://localhost:3000");
	assert.equal(t?.tab_id, "b");
});

test("DOM_ACT_TOOL__OffersNavigate__When__DrivingAPage", () => {
	const names = (DOM_ACT_TOOL.input_schema as any).properties.action.properties.name.enum;
	assert.ok(names.includes("navigate"), "navigate is not in the action vocabulary");
	assert.ok((DOM_ACT_TOOL.input_schema as any).properties.action.properties.url, "navigate has no url parameter");
});

test("DOM_RULES__WarnsThatCmdKeysReachTheBrowser__When__DrivingAPage", () => {
	// Nothing else prevents this, and cmd+w closes the tab and ends the run.
	assert.match(DOM_RULES, /cmd is the BROWSER/);
});

test("DOM_RULES__SaysNavigateInvalidatesRefs__When__DescribingNavigate", () => {
	// The driver states this explicitly; reusing a ref across a navigate is a silent mis-click.
	assert.match(DOM_RULES, /navigate/);
	assert.match(DOM_RULES, /never reuse a ref across a navigate/);
});

test("DOM_RULES__TellsTheModelTheUrlIsEvidence__When__DrivingAPage", () => {
	assert.match(DOM_RULES, /URL/);
});

const WIN = { x: 0, y: 33 };

test("viewportOrigin__UsesTheWindow__When__ThereIsNoWebArea", () => {
	// The Electron case, and the historical behaviour: the window IS the page. Measured on
	// Notion Calendar — AX (295,129) vs DOM (285,95.5) with the window at (0,33).
	assert.deepEqual(viewportOrigin([{ role: "AXGroup", frame: { x: 0, y: 33, w: 800, h: 600 } }], WIN), WIN);
});

test("viewportOrigin__UsesTheWebArea__When__BrowserChromeSitsAboveThePage", () => {
	// The real-browser case this exists for: subtracting the WINDOW origin would land every
	// click ~87px high, once per tab strip + omnibox. A silent mis-click (LIMITATIONS §4).
	const origin = viewportOrigin(
		[
			{ role: "AXButton", frame: { x: 10, y: 40, w: 30, h: 30 } },
			{ role: "AXWebArea", frame: { x: 0, y: 120, w: 1440, h: 780 } },
		],
		WIN,
	);
	assert.deepEqual(origin, { x: 0, y: 120 });
});

test("viewportOrigin__PicksTheOutermost__When__ThePageHasIframes", () => {
	// A page with iframes reports several web areas; the viewport is measured from the outer one.
	const origin = viewportOrigin(
		[
			{ role: "AXWebArea", frame: { x: 200, y: 300, w: 400, h: 200 } },
			{ role: "AXWebArea", frame: { x: 0, y: 120, w: 1440, h: 780 } },
		],
		WIN,
	);
	assert.deepEqual(origin, { x: 0, y: 120 });
});

test("viewportOrigin__IgnoresAZeroSizedWebArea__When__ThePageHasNotRendered", () => {
	const origin = viewportOrigin([{ role: "AXWebArea", frame: { x: 0, y: 0, w: 0, h: 0 } }], WIN);
	assert.deepEqual(origin, WIN);
});

test("viewportOrigin__ReturnsUndefined__When__NeitherSourceIsAvailable", () => {
	// Skips the coordinate route entirely rather than clicking somewhere arbitrary.
	assert.equal(viewportOrigin([], undefined), undefined);
});

/**
 * A driver whose Nth snapshot call fails the way a live site fails a binding. Dispatches on
 * `snapshot_format`: bind and rebind call get_browser_state WITHOUT it, reads carry it.
 */
function rebindableDriver(opts: { staleMessage: string }) {
	let binds = 0;
	let snapshotAttempts = 0;
	const snapshotArgs: Array<Record<string, unknown>> = [];
	const bindPayload = () => {
		binds++;

		return {
			text: "",
			structuredJson: JSON.stringify({
				target_id: `t${binds}`,
				binding_quality: "exact",
				tabs: [{ tab_id: `tab-of-t${binds}`, title: "page", url: "https://x.example/" }],
			}),
		};
	};

	return {
		snapshotArgs,
		bindCount: () => binds,
		act: async (req: { args: Record<string, unknown> }) => {
			if (!("snapshot_format" in req.args)) return bindPayload();
			snapshotAttempts++;
			if (snapshotAttempts === 1) throw new Error(opts.staleMessage);
			snapshotArgs.push(req.args);

			return {
				text: "",
				structuredJson: JSON.stringify({
					refs: [{ ref: "p1:1", role: "button", name: "Save", value: null, actions: ["click"], visibility: "in_viewport", frame: "" }],
				}),
			};
		},
	};
}

/** bind() and the rebind path narrate to the console; stub it for the same IPC reason as teardown.test.ts. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
	const realLog = console.log;
	console.log = () => {};
	try {
		return await fn();
	} finally {
		console.log = realLog;
	}
}

test("DomBackend__RebindsAndRetries__When__TheBindingGoesStaleMidRun", async () => {
	// Binding invalidation is routine on a live site — a redirect, an OAuth bounce, a tab
	// dragged to another window — so one staleness error must cost a rebind, not the run.
	const driver = rebindableDriver({ staleMessage: "driver error (browser_binding_stale): re-run get_browser_state" });
	await quietly(async () => {
		const backend = await DomBackend.bind(driver as never, { pid: 1, windowId: 2 });
		const matches = await backend.find("Save");
		assert.equal(matches[0]?.ref, "p1:1");
		assert.equal(backend.rebinds, 1);
		assert.equal(driver.bindCount(), 2);
		// The retry must carry the ids the REBIND minted — retrying with the stale ones would
		// just fail again with the same error.
		assert.equal(driver.snapshotArgs[0].target_id, "t2");
		assert.equal(driver.snapshotArgs[0].tab_id, "tab-of-t2");
	});
});

test("DomBackend__PropagatesTheError__When__ItIsNotAStalenessError", async () => {
	// Rebinding on an arbitrary failure would mask real faults behind a retry; only the
	// driver's own staleness codes and prose earn the second attempt.
	const driver = rebindableDriver({ staleMessage: "some unrelated driver failure" });
	await quietly(async () => {
		const backend = await DomBackend.bind(driver as never, { pid: 1, windowId: 2 });
		await assert.rejects(() => backend.find("Save"), /some unrelated driver failure/);
		assert.equal(backend.rebinds, 0);
		assert.equal(driver.bindCount(), 1);
	});
});
