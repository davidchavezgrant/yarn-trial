import assert from "node:assert/strict";
import test from "node:test";
import { APP_JS, CHROME } from "./ui-page.js";

/**
 * The renderer had no tests, and that is exactly why its coupling is dangerous: `APP_JS` is a
 * `String.raw` literal, so tsc never parses it and a syntax error or a renamed element id
 * ships silently — the window just comes up blank or a button never enables. These tests run
 * the real script against a fake DOM.
 *
 * Not a browser and not trying to be: no layout, no events, no async. Enough to answer "does
 * this parse" and "does the URL box gate the run the way it should".
 */

interface FakeEl {
	value: string;
	textContent: string;
	className: string;
	innerHTML: string;
	style: { display?: string };
	disabled: boolean;
	checked: boolean;
	children: unknown[];
	addEventListener(): void;
	querySelector(): null;
	appendChild(): void;
}

const el = (): FakeEl => ({
	value: "",
	textContent: "",
	className: "",
	innerHTML: "",
	style: {},
	disabled: false,
	checked: false,
	children: [],
	addEventListener() {},
	querySelector: () => null,
	appendChild() {},
});

const IDS = [
	"q", "apps", "url", "urlrow", "urlhint", "task", "warn", "go", "ground", "stop",
	"record", "novision", "host", "log", "runs", "refresh", "status", "attach", "fleet",
	"creds", "key", "savekey",
];

interface Harness {
	nodes: Record<string, FakeEl>;
	sel: string | null;
	apps: unknown[];
	check(): void;
	syncUrlRow(): boolean;
	selUrl(): string | undefined;
	isBrowser(name: string): boolean;
}

/**
 * Instantiate the renderer.
 *
 * The trailing `</script>` is stripped because APP_JS is emitted INTO a script tag — it is
 * markup, not code, and `new Function` rightly refuses it.
 */
function mount(): Harness {
	const nodes: Record<string, FakeEl> = {};
	for (const id of IDS) nodes[id] = el();
	const bus = {
		loadApps: async () => [],
		loadRuns: async () => [],
		loadState: async () => ({ byApp: {} }),
		saveState() {},
		loadHosts: async () => ({ hosts: ["local"] }),
		loadFleet: async () => ({ rows: [], offers: [] }),
		loadCreds: async () => ({ present: false, path: "", modelKey: false }),
		loadHostPref: async () => ({ host: "local" }),
		saveHostPref() {},
		onStarted() {},
		onLine() {},
		onDone() {},
		videoUrl: (r: string) => r,
		run: async () => undefined,
		ground: async () => undefined,
		stop() {},
		attach: async () => undefined,
		saveKey: async () => ({ ok: true }),
	};
	const document = {
		getElementById: (id: string) => nodes[id] ?? el(),
		addEventListener() {},
		createElement: () => el(),
		querySelector: () => null,
		body: el(),
	};
	// The script arms two polling intervals (fleet, gallery) at load. Real ones would keep the
	// test runner's event loop alive forever — the run does not fail, it simply never exits —
	// so timers are injected as no-ops. Nothing under test here is time-dependent.
	const fn = new Function(
		"window",
		"document",
		"setInterval",
		"setTimeout",
		`${APP_JS.replace(/<\/script>\s*$/, "")}
		return { get sel(){return sel}, set sel(v){sel=v}, set apps(v){apps=v}, check, syncUrlRow, selUrl, isBrowser };`,
	);
	const noTimer = () => 0;
	const api = fn({ __bus: bus, addEventListener() {} }, document, noTimer, noTimer) as Harness;
	api.nodes = nodes;

	return api;
}

test("APP_JS__Parses__When__EmittedIntoThePage", () => {
	// The renderer is not typechecked, so this is the only thing standing between a stray
	// backtick and a blank window. One has already shipped: a backtick inside a comment
	// terminated the String.raw literal.
	assert.doesNotThrow(() => mount());
});

test("CHROME__CarriesTheUrlControls__When__Rendered", () => {
	// The script addresses these by id; a rename in one place and not the other is silent.
	for (const id of ["urlrow", "url", "urlhint"]) assert.match(CHROME, new RegExp(`id="${id}"`));
});

test("isBrowser__ReadsTheHostFlag__When__ListApssTaggedTheEntry", () => {
	// The renderer no longer carries its own copy of the browser list: listApps() tags each
	// entry via isBrowserApp(), so there is one list and it lives in target.ts. An app the host
	// did not tag — including one it has never heard of — is simply not a browser.
	const ui = mount();
	ui.apps = [{ name: "Google Chrome", browser: true }, { name: "Yarn" }];
	assert.equal(ui.isBrowser("Google Chrome"), true);
	assert.equal(ui.isBrowser("Yarn"), false);
	assert.equal(ui.isBrowser("Never heard of it"), false);
});

test("syncUrlRow__HidesTheBox__When__TargetIsAnInstalledApp", () => {
	const ui = mount();
	ui.apps = [{ name: "Yarn" }];
	ui.sel = "Yarn";
	assert.equal(ui.syncUrlRow(), false, "a Mac app must not be blocked on a URL");
	assert.equal(ui.nodes.urlrow.style.display, "none");
});

test("syncUrlRow__BlocksTheRun__When__BrowserHasNoUrl", () => {
	// A browser with no URL would open on whatever page it happened to be showing — nobody's
	// intent, and not reproducible.
	const ui = mount();
	ui.apps = [{ name: "Google Chrome", browser: true }];
	ui.sel = "Google Chrome";
	assert.equal(ui.syncUrlRow(), true);
	assert.equal(ui.nodes.urlrow.style.display, "block");
});

test("syncUrlRow__AssumesHttps__When__OnlyAHostIsTyped", () => {
	// "notion.so" is the common case and means https unambiguously.
	const ui = mount();
	ui.apps = [{ name: "Google Chrome", browser: true }];
	ui.sel = "Google Chrome";
	ui.nodes.url.value = "notion.so";
	assert.equal(ui.syncUrlRow(), false);
	assert.equal(ui.selUrl(), "https://notion.so/");
});

test("syncUrlRow__SaysSo__When__TheUrlIsNotNavigable", () => {
	const ui = mount();
	ui.apps = [{ name: "Google Chrome", browser: true }];
	ui.sel = "Google Chrome";
	ui.nodes.url.value = "not a url";
	assert.equal(ui.syncUrlRow(), true);
	assert.match(ui.nodes.urlhint.className, /bad/);
	assert.match(ui.nodes.urlhint.textContent, /web address/);
});

test("check__NamesTheSite__When__RunningABrowserAtAUrl", () => {
	// "Run on Google Chrome" would be a lie about what the run targets.
	const ui = mount();
	ui.apps = [{ name: "Google Chrome", browser: true }];
	ui.sel = "Google Chrome";
	ui.nodes.url.value = "https://www.notion.so";
	ui.nodes.task.value = "change my timezone to Paris";
	ui.check();
	assert.equal(ui.nodes.go.textContent, "Run on www.notion.so");
	assert.equal(ui.nodes.go.disabled, false);
});

test("check__KeepsRunDisabled__When__BrowserSelectedWithoutAUrl", () => {
	const ui = mount();
	ui.apps = [{ name: "Google Chrome", browser: true }];
	ui.sel = "Google Chrome";
	ui.nodes.task.value = "change my timezone to Paris";
	ui.check();
	assert.equal(ui.nodes.go.disabled, true);
	// Grounding is blocked too: there is nothing to map without a site.
	assert.equal(ui.nodes.ground.disabled, true);
});

test("check__LeavesTheAppPathUntouched__When__TargetIsNotABrowser", () => {
	const ui = mount();
	ui.apps = [{ name: "Yarn", grounded: true }];
	ui.sel = "Yarn";
	ui.nodes.task.value = "show me how to change the cursor type";
	ui.check();
	assert.equal(ui.nodes.go.textContent, "Run on Yarn");
	assert.equal(ui.nodes.go.disabled, false);
	assert.equal(ui.nodes.ground.textContent, "Reground");
});

test("check__ReadsGroundedFromTheSite__When__ABrowserIsPointedAtOne", () => {
	// Whether Chrome has an appmap says nothing about whether notion.so does.
	const ui = mount();
	ui.apps = [{ name: "Google Chrome", browser: true, grounded: true }, { name: "www.notion.so", kind: "web", grounded: false }];
	ui.sel = "Google Chrome";
	ui.nodes.url.value = "https://www.notion.so";
	ui.nodes.task.value = "change my timezone to Paris";
	ui.check();
	assert.equal(ui.nodes.ground.textContent, "Ground");
});
