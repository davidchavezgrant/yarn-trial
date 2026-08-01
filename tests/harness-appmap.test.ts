// First import on purpose: the resetToHome tests below drive observe(), whose probe
// screenshot lands under OUT — snapshotted from dataRoot() at import time. Redirect first
// so those frames go to a temp dir instead of the checkout's real out/.
import "./data-tmp.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { Driver } from "../src/core/driver.js";
import { unifySettingKeys, checkHome, findScopeAmbiguities, resetToHome, rootControlLabels, rootSurface, scopeWarnings } from "../src/core/harness.js";
import type { ActionRequest, AppMap, AppMapEdge, AppMapNode } from "../src/types.js";

// --- appmap graph: the structured companion to the prose map. It earns its place by
// catching the wrong-scope failure prose could not — on Yarn, "Cursor Style" is editable
// brand-wide and per-draft (independent stores), and all four ungrounded runs changed the
// per-draft one while passing verification.

const yarnish: AppMap = {
	app: "Yarn",
	capturedAt: "2026-07-29T00:00:00.000Z",
	provenance: "explore",
	nodes: [
		{ id: "brand-kit/screen-clips", title: "Screen Clip Settings", kind: "surface", scope: "brand" },
		{ id: "brand-kit/screen-clips/cursor-style", title: "Cursor Style", kind: "control", scope: "brand", settingKey: "cursor-style" },
		{ id: "editor/screen-clip-settings/cursor-style", title: "Cursor Style", kind: "control", scope: "document", settingKey: "cursor-style" },
		{ id: "settings/theme", title: "Theme", kind: "control", scope: "app", settingKey: "theme" },
	],
	edges: [{ from: "root", to: "brand-kit/screen-clips", action: 'click "Brand Kit"' }],
};

test("findScopeAmbiguities__ReportsSetting__When__SameKeyEditableAtTwoScopes", () => {
	const found = findScopeAmbiguities(yarnish);
	assert.equal(found.length, 1);
	assert.equal(found[0].settingKey, "cursor-style");
	assert.deepEqual(found[0].nodes.map((n) => n.scope).sort(), ["brand", "document"]);
});

test("findScopeAmbiguities__IgnoresSetting__When__EditableAtOneScopeOnly", () => {
	assert.equal(findScopeAmbiguities(yarnish).some((a) => a.settingKey === "theme"), false);
});

test("findScopeAmbiguities__ReturnsEmpty__When__NoControlsCarrySettingKeys", () => {
	const map: AppMap = { ...yarnish, nodes: yarnish.nodes.map(({ settingKey, ...n }) => n) };
	assert.deepEqual(findScopeAmbiguities(map), []);
});

test("scopeWarnings__NamesBothScopes__When__AmbiguityExists", () => {
	const w = scopeWarnings(yarnish);
	assert.match(w, /cursor-style/);
	// Entries name the SURFACE holding the control, since grouping keys on surface pairs.
	assert.match(w, /brand scope — brand-kit\/screen-clips/);
	assert.match(w, /document scope — editor\/screen-clip-settings/);
	assert.match(w, /SEPARATE stores/);
});

test("scopeWarnings__PresentsBothWithoutPickingOne__When__AmbiguityExists", () => {
	// The harness surfaces the options and the agent decides from task context; baking a
	// "always prefer the broadest scope" rule in here would make the wrong call whenever a
	// task is genuinely about one document.
	const w = scopeWarnings(yarnish);
	assert.match(w, /Both routes are given because either can be correct/);
	assert.match(w, /SAY WHICH YOU CHOSE AND WHY/);
	assert.equal(/prefer the broadest/.test(w), false);
});

test("scopeWarnings__GroupsBySurfacePair__When__ManySettingsShareTwoPanels", () => {
	// Yarn has 16 settings split across the same brand-vs-document panel pair. Listing each
	// separately repeated one pair of routes 15 times and produced a warning nearly twice the
	// size of the appmap it annotates, so entries group by surface pair.
	const many: AppMap = {
		...yarnish,
		nodes: [
			...yarnish.nodes,
			{ id: "brand-kit/screen-clips/shadow-blur", title: "Shadow Blur", kind: "control", scope: "brand", settingKey: "shadow-blur" },
			{ id: "editor/screen-clip-settings/shadow-blur", title: "Shadow Blur", kind: "control", scope: "document", settingKey: "shadow-blur" },
		],
	};
	const w = scopeWarnings(many);
	assert.equal(w.match(/These settings exist at/g)?.length, 1, "both settings share one grouped entry");
	assert.match(w, /cursor-style, shadow-blur/);
});

test("scopeWarnings__IncludesNavigationRoute__When__EdgesRecorded", () => {
	// A scope choice is only actionable if the agent can reach the one it picks.
	assert.match(scopeWarnings(yarnish), /route: click "Brand Kit"/);
});

test("scopeWarnings__CountsScopesNotNodes__When__ASettingHasTwoSameScopeEditors", () => {
	// Two editors of one setting on the same document surface are ONE store and one bullet;
	// counting nodes said "exist at 3 scopes" for a two-store setting and printed the same
	// scope—surface line twice.
	const twoEditors: AppMap = {
		...yarnish,
		nodes: [
			...yarnish.nodes,
			{ id: "editor/screen-clip-settings/cursor-style-quick", title: "Cursor Style (quick)", kind: "control", scope: "document", settingKey: "cursor-style" },
		],
	};
	const w = scopeWarnings(twoEditors);
	assert.match(w, /exist at 2 scopes/);
	assert.equal(w.match(/document scope — editor\/screen-clip-settings/g)?.length, 1, "duplicate scope—surface bullets must dedupe");
});

test("scopeWarnings__ReturnsEmpty__When__NoAmbiguities", () => {
	assert.equal(scopeWarnings({ ...yarnish, nodes: [yarnish.nodes[3]] }), "");
});

// --- Landing surface. Used to answer "is this app usable right now, or sitting at a login
// wall" for any app with a map — the weaker of resetToHome's two tiers, and the one that does
// not need the appmap to declare a home. It never decides where to click.

/** yarnish plus the surfaces an exploration pass records around its starting point. */
const rooted: AppMap = {
	...yarnish,
	nodes: [
		...yarnish.nodes,
		{ id: "root", title: "Yarn", kind: "surface", scope: "app" },
		{ id: "library", title: "Library", kind: "surface", scope: "workspace" },
	],
	edges: [
		...yarnish.edges,
		{ from: "root", to: "library", action: 'click "Library" in the left rail' },
		{ from: "library", to: "editor", action: 'double-click a draft row' },
	],
};

test("rootSurface__FindsStartingPoint__When__OneSurfaceIsNeverAnEdgeTarget", () => {
	// Structural, not a lookup for an id called "root": that spelling is a convention of one
	// exploration pass rather than part of the schema.
	assert.equal(rootSurface(rooted)?.id, "root");
});

test("rootSurface__ReturnsUndefined__When__SeveralSurfacesQualify", () => {
	// A disconnected graph has no single landing state, and picking between candidates would
	// silently pin every future run's start to whichever one sorted first.
	const split: AppMap = { ...rooted, nodes: [...rooted.nodes, { id: "orphan", title: "Orphan", kind: "surface", scope: "app" }] };
	assert.equal(rootSurface(split), undefined);
});

test("rootSurface__ReturnsUndefined__When__EverySurfaceIsReachable", () => {
	const cyclic: AppMap = { ...rooted, edges: [...rooted.edges, { from: "library", to: "root", action: 'click "Home"' }] };
	assert.equal(rootSurface(cyclic), undefined);
});

test("rootControlLabels__QuotesFromOutboundEdges__When__RootIsIdentifiable", () => {
	// The quoted span in an edge action is the label the walk actually observed, so it is the
	// one string in the graph that can be matched against a live observation.
	assert.deepEqual(rootControlLabels(rooted), ["Brand Kit", "Library"]);
});

test("rootControlLabels__IgnoresEdgesLeavingOtherSurfaces__When__CollectingLabels", () => {
	// A label only proves the app is on its landing surface if it LIVES there; a control reached
	// two screens in would report "ready" from wherever the last run happened to stop.
	const deeper: AppMap = { ...rooted, edges: [...rooted.edges, { from: "library", to: "editor", action: 'click "Rename"' }] };
	assert.equal(rootControlLabels(deeper).includes("Rename"), false);
});

test("rootControlLabels__Dedupes__When__TheSameControlAppearsOnSeveralEdges", () => {
	const twice: AppMap = { ...rooted, edges: [...rooted.edges, { from: "root", to: "library", action: 'click "Library" again' }] };
	assert.deepEqual(twice.edges.filter((e) => e.action.includes("Library")).length, 2);
	assert.deepEqual(rootControlLabels(twice), ["Brand Kit", "Library"]);
});

test("rootControlLabels__ReturnsEmpty__When__NoRootCanBeIdentified", () => {
	assert.deepEqual(rootControlLabels(yarnish), []);
});

// --- checkHome(). The declared home is written once by an exploration pass and then governs
// the start state of every later run, with nothing downstream able to tell a wrong label from
// an app that genuinely moved on. So it is checked against the pass's own evidence at write
// time, and discarded rather than trusted — losing normalisation, keeping the readiness check.

const HOME = { surface: "library", control: "Library", description: "left-rail Library view" };

test("checkHome__Accepts__When__SurfaceIsANodeAndControlWasOperated", () => {
	assert.deepEqual(checkHome(HOME, rooted.nodes, rooted.edges), { home: HOME });
});

test("checkHome__Rejects__When__SurfaceIsNotInTheGraph", () => {
	const { home, problem } = checkHome({ ...HOME, surface: "dashboard" }, rooted.nodes, rooted.edges);
	assert.equal(home, undefined);
	assert.match(problem ?? "", /"dashboard" is not a node/);
});

test("checkHome__Rejects__When__NoEdgeActionEverQuotedTheControl", () => {
	// The realistic failure: a plausible label recalled at the end of a long, context-reset
	// transcript rather than read off an observation.
	const { home, problem } = checkHome({ ...HOME, control: "Home" }, rooted.nodes, rooted.edges);
	assert.equal(home, undefined);
	assert.match(problem ?? "", /never recorded operating it/);
});

test("checkHome__Rejects__When__FieldsAreBlank", () => {
	assert.match(checkHome({ ...HOME, control: "  " }, rooted.nodes, rooted.edges).problem ?? "", /both required/);
});

test("checkHome__StaysSilent__When__ThePassDeclaredNoHome", () => {
	// Not an error. Older maps have no home at all, and resetToHome degrades to `root-visible`.
	assert.deepEqual(checkHome(undefined, rooted.nodes, rooted.edges), {});
});

// --- resetToHome(). Two tiers, because the strong one needs a map that declares a home and the
// weak one has to work for every app that does not. The weak tier normalises nothing; it only
// answers "can the app's own landing state be seen", which is what catches a sign-in wall
// without this file knowing what a sign-in wall looks like.

/** Serves one AX payload per observation, in order, and records every act for inspection. */
const scriptedDriver = (screens: unknown[][], acts: ActionRequest[]): Driver => {
	let shown = 0;

	return {
		act: async (req: ActionRequest) => {
			acts.push(req);
			if (req.kind !== "tool" || req.name !== "get_window_state") return { text: "" };
			// Write the file observe() will actually look for. The driver names the screenshot
			// from its own argument, so a fixture writing some other path only passed here
			// because a real run had left a same-named PNG in out/ — these tests failed on any
			// clean checkout, and passed locally for a reason unrelated to what they assert.
			const shot = String((req.args as Record<string, unknown>).screenshot_out_file);
			fs.mkdirSync(shot.replace(/\/[^/]+$/, ""), { recursive: true });
			fs.writeFileSync(shot, "png");
			const elements = screens[Math.min(shown++, screens.length - 1)];

			return { text: "", structuredJson: JSON.stringify({ elements, screenshot_width: 1920, screenshot_height: 1080 }) };
		},
	} as unknown as Driver;
};

const railButton = (label: string) => [
	{ element_index: 0, role: "AXWindow", label: "", frame: { x: 0, y: 0, w: 1920, h: 1080 } },
	{ element_index: 7, role: "AXButton", label, parent_index: 0, frame: { x: 20, y: 100, w: 160, h: 40 } },
];

const withHome: AppMap = { ...rooted, home: HOME };

/**
 * The graph is passed explicitly in all but one case. Omitting it is not the same as passing
 * `undefined` — the parameter defaults to loading the app's real appmap off disk, which is the
 * production path and the only way to test the no-map branch honestly.
 */
const resetIn = async (screens: unknown[][], graph?: AppMap, app = "Yarn") => {
	const acts: ActionRequest[] = [];
	const driver = scriptedDriver(screens, acts);
	const win = { pid: 1, windowId: 1 };
	const prev = process.env.AXDOM;
	process.env.AXDOM = "0"; // the sidecar needs a live app
	try {
		const r = graph ? await resetToHome(driver, win, app, graph) : await resetToHome(driver, win, app);

		return { ...r, acts };
	} finally {
		if (prev === undefined) delete process.env.AXDOM;
		else process.env.AXDOM = prev;
	}
};

test("resetToHome__ClicksTheDeclaredControl__When__TheMapNamesAHome", async () => {
	const { result, detail, acts } = await resetIn([railButton("Library")], withHome);
	assert.equal(result, "reset");
	assert.match(detail, /left-rail Library view/);
	// By element index parsed out of the observation, not by coordinate: the index is the only
	// addressing that survives the window being on a differently-scaled display.
	const click = acts.find((a) => a.kind === "tool" && a.name === "click");
	assert.deepEqual((click as { args: Record<string, unknown> }).args.element_index, 7);
});

test("resetToHome__ReportsRootVisible__When__TheMapHasNoHomeButItsLandingControlsShow", async () => {
	// Deliberately NOT "reset": one of root's controls being on screen proves the app is past
	// its login wall, and proves nothing at all about which surface the run will start on.
	const { result, detail, acts } = await resetIn([railButton("Brand Kit")], rooted);
	assert.equal(result, "root-visible");
	assert.match(detail, /not normalised/);
	assert.equal(acts.some((a) => a.kind === "tool" && a.name === "click"), false);
});

test("resetToHome__Fails__When__NothingFromTheLandingSurfaceIsOnScreen", async () => {
	// What a sign-in wall looks like from here. agent.ts turns this into a refusal to run,
	// which before #28 only fired for the two apps that happened to be in a hardcoded table.
	const { result, detail, acts } = await resetIn([railButton("Sign in with Google")], rooted);
	assert.equal(result, "failed");
	assert.match(detail, /nothing from the landing surface/);
	// One escape first: an overlay left open by a previous run hides the rail from the AX tree
	// entirely, and that used to read as "app is unusable".
	assert.equal(acts.filter((a) => a.kind === "tool" && a.name === "press_key").length, 1);
});

test("resetToHome__RecoversAfterEscape__When__AnOverlayHidTheHomeControl", async () => {
	const { result, detail } = await resetIn([railButton("Cancel"), railButton("Library")], withHome);
	assert.equal(result, "reset");
	assert.match(detail, /escaped a leftover overlay/);
});

test("resetToHome__ReportsNone__When__TheAppHasNoMapAtAll", async () => {
	const { result, detail, acts } = await resetIn([railButton("Library")], undefined, "No Such App");
	assert.equal(result, "none");
	assert.match(detail, /npm run explore/);
	assert.deepEqual(acts, [], "an app with no map is not probed at all");
});

test("resetToHome__ReportsNone__When__TheMapHasNoHomeAndNoIdentifiableRoot", async () => {
	// yarnish's only surface is an edge target, so there is no landing state to look for.
	assert.equal((await resetIn([railButton("Library")], yarnish)).result, "none");
});

// resetToHome's failure detail. "home control X not present" is true and unactionable: a
// sign-in wall, a leftover modal and a different view all produce it, and the operator's next
// move differs for each. These pin the census that tells them apart — without teaching the
// harness what any of those screens look like, which would be app-specific.

const homeGraph: AppMap = {
	app: "Anything",
	capturedAt: "2026-07-30T00:00:00Z",
	provenance: "explore",
	home: { surface: "landing", control: "Library", description: "the library view" },
	nodes: [{ id: "landing", label: "Landing", scope: "app", controls: [] }] as unknown as AppMapNode[],
	edges: [{ from: "landing", to: "landing", action: 'click "Library"' }] as unknown as AppMapEdge[],
};

/** A driver that answers every observation with one fixed element list. */
function driverShowing(elements: { role: string; label: string }[]): Driver {
	// `label` is the driver's key for an element's name — `name` is what the parsed
	// InteractiveElement calls it, and using that here silently produced unnamed controls.
	const payload = JSON.stringify({
		elements: elements.map((e, i) => ({ element_index: i, role: e.role, label: e.label, enabled: true })),
	});

	return {
		act: async (req: ActionRequest) => {
			// Write the PNG observe() looks for, keyed off the driver's own argument. Without
			// this the fixture passed only because a real run had left a same-named file in out/;
			// observe() now deletes any stale frame before capture, so the mock must produce one.
			const shot = req.kind === "tool" ? (req.args as Record<string, unknown>).screenshot_out_file : undefined;
			if (typeof shot === "string") {
				fs.mkdirSync(shot.replace(/\/[^/]+$/, ""), { recursive: true });
				fs.writeFileSync(shot, "png");
			}

			return { text: "", structuredJson: payload };
		},
	} as unknown as Driver;
}

test("resetToHome__NamesWhatIsOnScreen__When__TheHomeControlIsMissing", async () => {
	const driver = driverShowing([
		{ role: "AXTextField", label: "Email" },
		{ role: "AXButton", label: "Continue with Google" },
	]);
	const out = await resetToHome(driver, { pid: 1, windowId: 2 }, "Anything", homeGraph);
	assert.equal(out.result, "failed");
	assert.match(out.detail, /"Library" not present/);
	// The labels are the whole point: a reader recognises a sign-in wall from these, and the
	// harness never has to.
	assert.match(out.detail, /"Email"/);
	assert.match(out.detail, /"Continue with Google"/);
});

test("resetToHome__PutsAppControlsBeforeMenuItems__When__BothAreOnScreen", async () => {
	// Every Mac app exposes the same ~70 menu items. In walk order they arrive first and, on
	// the first real use of this census, buried the four labels that identified the screen.
	const driver = driverShowing([
		{ role: "AXMenuItem", label: "About This Mac" },
		{ role: "AXMenuItem", label: "System Settings…" },
		{ role: "AXButton", label: "Sign in with SSO" },
	]);
	const out = await resetToHome(driver, { pid: 1, windowId: 2 }, "Anything", homeGraph);
	assert.match(out.detail, /instead: "Sign in with SSO"/);
	// Kept, not dropped: an app whose only named controls are menu items is itself a finding.
	assert.match(out.detail, /"About This Mac"/);
});

test("resetToHome__SaysTheAppIsEmpty__When__ThereIsNoContentAtAll", async () => {
	// Distinct from "wrong screen" and pointing somewhere entirely different — this is the
	// locked-display / off-Space shape (LIMITATIONS §1, §12), not an app-state problem.
	const out = await resetToHome(driverShowing([]), { pid: 1, windowId: 2 }, "Anything", homeGraph);
	assert.match(out.detail, /NO content elements/);
});

// The read-only, backend-agnostic home check the CDP path gates on. It matches element
// LABELS from `interactive` (present on both backends), never rendered-line substrings —
// so a combobox whose VALUE happens to read the home label cannot pass for the home.
import { homeVisible } from "../src/core/harness.js";
import type { ObservationBundle } from "../src/core/harness.js";

const wallObs = {
	appContent: 12,
	interactive: [
		{ handle: "e3", role: "button", name: "Continue with Google" },
		{ handle: "e4", role: "button", name: "Sign in with SSO" },
	],
} as unknown as ObservationBundle;

const homeObs = {
	appContent: 40,
	interactive: [
		{ handle: "e2", role: "button", name: "Library" },
		{ handle: "e9", role: "button", name: "New Draft" },
	],
} as unknown as ObservationBundle;

const homedGraph = {
	app: "Yarn",
	capturedAt: "2026-07-30T00:00:00.000Z",
	provenance: "explore",
	home: { control: "Library", evidence: "clicked during exploration" },
	nodes: [],
	edges: [],
} as any;

test("homeVisible__Ready__When__DeclaredControlOnScreen", () => {
	const r = homeVisible("Yarn", homeObs, homedGraph);
	assert.equal(r.ready, true);
	assert.match(r.detail, /"Library"/);
});

test("homeVisible__Fails__When__SignInWallHidesHome", () => {
	const r = homeVisible("Yarn", wallObs, homedGraph);
	assert.equal(r.ready, false);
	// The refusal message must NAME what is on screen — that is how an operator reads
	// "sign-in wall" off a log without a screenshot.
	assert.match(r.detail, /Continue with Google/);
});

test("homeVisible__CannotAnswer__When__NoAppmap", () => {
	const r = homeVisible("Nowhere", wallObs, undefined);
	assert.equal(r.ready, undefined);
	assert.match(r.detail, /no appmap/);
});

test("unifySettingKeys__PairsASettingTheModelKeyedTwoWays__When__ScopesDiffer", () => {
	// settingKey is free text the model invents and nothing validated it. Measured on
	// 2026-08-01, same app and the same two controls: the cdp pass keyed both `cursor-style`
	// and paired them; the ax pass keyed the brand one `screen-clip-cursor-style` and the
	// document one `cursor-style`, so the pair vanished. A split key does not weaken the
	// warning, it DELETES it — indistinguishable from a setting that lives in one place.
	const map: any = {
		nodes: [
			{ id: "brand-kit/screen-clips/cursor-style", title: "Cursor Style", kind: "control", scope: "brand", settingKey: "screen-clip-cursor-style" },
			{ id: "editor/screen-clips/cursor-style", title: "Cursor Style", kind: "control", scope: "document", settingKey: "cursor-style" },
		],
		edges: [],
	};
	assert.deepEqual(findScopeAmbiguities(map).map((a) => a.settingKey), ["cursor-style"]);
	// The unprefixed key wins: the split is always one side carrying a surface prefix, and the
	// setting's own name is the shorter one.
	assert.equal(unifySettingKeys(map).nodes.every((n: any) => n.settingKey === "cursor-style"), true);
});

test("unifySettingKeys__LeavesSameScopeControlsAlone__When__TheyShareATitle", () => {
	// Two editors of ONE store is not an ambiguity, and inventing one would send the agent
	// hunting for a second scope that does not exist. This is the condition that keeps the
	// repair safe: a merge requires the scopes to DIFFER.
	const map: any = {
		nodes: [
			{ id: "brand-kit/type/font", title: "Font", kind: "control", scope: "brand", settingKey: "brand-font" },
			{ id: "brand-kit/overview/font", title: "Font", kind: "control", scope: "brand", settingKey: "font" },
		],
		edges: [],
	};
	assert.deepEqual(findScopeAmbiguities(map), []);
	assert.deepEqual(unifySettingKeys(map).nodes.map((n: any) => n.settingKey), ["brand-font", "font"]);
});

test("unifySettingKeys__IgnoresNodesTheModelDidNotCallSettings__When__TitlesCollide", () => {
	// A merge requires BOTH nodes to already carry a settingKey — the model judged each one a
	// setting. Two "Delete" buttons at different scopes share a title and are not a setting.
	const map: any = {
		nodes: [
			{ id: "brand-kit/delete", title: "Delete", kind: "control", scope: "brand" },
			{ id: "editor/delete", title: "Delete", kind: "control", scope: "document" },
		],
		edges: [],
	};
	assert.deepEqual(findScopeAmbiguities(map), []);
});

test("findScopeAmbiguities__StillPairsOnAnExactKeyMatch__When__NoRepairIsNeeded", () => {
	// The original mechanism is untouched; the repair only adds pairs it would have missed.
	const map: any = {
		nodes: [
			{ id: "a/x", title: "X", kind: "control", scope: "brand", settingKey: "x" },
			{ id: "b/x", title: "Different Label", kind: "control", scope: "document", settingKey: "x" },
		],
		edges: [],
	};
	assert.deepEqual(findScopeAmbiguities(map).map((a) => a.settingKey), ["x"]);
});
