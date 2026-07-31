import assert from "node:assert/strict";
import test from "node:test";
import { APP_JS, CHROME } from "../src/ui/ui-page.js";

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
	children: FakeEl[];
	// Scroll geometry, so the autoscroll pin is observable: notePin reads all three and the
	// paint writes scrollTop. Zero everywhere means "unlaid-out", which notePin treats as pinned.
	clientHeight: number;
	scrollHeight: number;
	scrollTop: number;
	dataset: Record<string, string>;
	onclick?: () => unknown;
	// Recorded rather than dropped, so a test can fire the handler the script installed —
	// the Enter-to-run path is a keydown listener and unobservable otherwise.
	listeners: Record<string, ((e: unknown) => void)[]>;
	addEventListener(type: string, fn: (e: unknown) => void): void;
	querySelector(): null;
	/** Always empty: innerHTML is a plain string here, so markup never becomes children. */
	querySelectorAll(): FakeEl[];
	appendChild(c: FakeEl): void;
	removeChild(c: FakeEl): void;
}

// Children are a real array so the log-cap logic is observable: trimLog counts and removes
// through exactly these two methods, and a no-op appendChild would make the cap untestable.
const el = (): FakeEl => ({
	value: "",
	textContent: "",
	className: "",
	innerHTML: "",
	style: {},
	disabled: false,
	checked: false,
	children: [],
	clientHeight: 0,
	scrollHeight: 0,
	scrollTop: 0,
	dataset: {},
	listeners: {},
	addEventListener(type: string, fn: (e: unknown) => void) {
		(this.listeners[type] ??= []).push(fn);
	},
	querySelector: () => null,
	querySelectorAll: () => [],
	appendChild(c: FakeEl) {
		this.children.push(c);
	},
	removeChild(c: FakeEl) {
		const i = this.children.indexOf(c);
		if (i >= 0) this.children.splice(i, 1);
	},
});

const IDS = [
	"q", "apps", "url", "urlrow", "urlhint", "task", "warn", "go", "ground", "stop", "human", "cancelsignin",
	"record", "host", "log", "runs", "status", "fleet", "busyhint", "fleetsum", "examples", "jobs", "jobswrap",
	"viewerbar", "viewerback", "viewertitle", "taskform", "fleetwrap", "unready",
	// keymsg/keystate are innerHTML-created in the real DOM; the fake's innerHTML is a plain
	// string, so they exist here as first-class nodes instead.
	"creds", "key", "savekey", "keymsg", "keystate",
];

interface Harness {
	nodes: Record<string, FakeEl>;
	sel: string | null;
	apps: unknown[];
	check(): void;
	syncUrlRow(): boolean;
	selUrl(): string | undefined;
	isBrowser(name: string): boolean;
	appendLine(text: string): void;
	line(text: string, owner?: string | null): void;
	errText(e: unknown): string;
	dropStaleSelection(): void;
	selectApp(name: string, url?: string): void;
	notePin(): void;
	render(): void;
	agoLabel(iso: string): string;
	stateFor(app: string): { task: string; log: string[]; url?: string };
	loadRuns(force?: boolean): Promise<void>;
	loadFleet(): Promise<void>;
	pinned: boolean;
	host: string;
	/** Fire the host's `started` echo, as captured off bus.onStarted at mount. */
	fireStarted(d: { app: string; task: string; host?: string }): void;
	/** Live runs, host -> app — the page's one-run-per-host bookkeeping. */
	running: Record<string, string>;
	/** Re-attach offers, write-only: the fleet poll normally fills these. */
	offers: { host: string; jobId: string; app?: string }[];
	renderJobs(): void;
	enterViewer(title: string, owner?: string | null): void;
	exitViewer(): void;
	openJobLog(host: string, jobId: string, appName: string): Promise<void>;
	paneRunHost(): string | null;
	/** The callbacks the page registered on the bus, so tests can fire host events at it. */
	events: {
		started?: (d: { app: string; task: string; host: string }) => void;
		line?: (d: { text: string; app: string; host: string }) => void;
		host?: (d: { app: string; host: string }) => void;
		done?: (d: { code: number | null; elapsed: number; app: string; host: string }) => void;
		portal?: (d: { open: boolean; app?: string; host?: string }) => void;
	};
	/** Hosts the Stop button asked the bus to stop, in click order. */
	stops: unknown[];
}

/**
 * Instantiate the renderer.
 *
 * The trailing `</script>` is stripped because APP_JS is emitted INTO a script tag — it is
 * markup, not code, and `new Function` rightly refuses it.
 *
 * `busOverrides` swaps individual bus methods so a test can stub the host side — a `run`
 * that records its options, a gallery feed (loadRuns,
 * humanizeStatus) — without re-declaring the whole bus.
 */
function mount(busOverrides: Record<string, unknown> = {}): Harness {
	const nodes: Record<string, FakeEl> = {};
	for (const id of IDS) nodes[id] = el();
	// Bus events are captured, not dropped: the run/stop/status tests below ARE the page's
	// reaction to started/line/host/done, and firing them through the real registration is the
	// only way the test exercises the same wiring the shell does.
	const events: Harness["events"] = {};
	const stops: unknown[] = [];
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
		onStarted(cb: Harness["events"]["started"]) {
			events.started = cb;
		},
		onLine(cb: Harness["events"]["line"]) {
			events.line = cb;
		},
		onHost(cb: Harness["events"]["host"]) {
			events.host = cb;
		},
		onDone(cb: Harness["events"]["done"]) {
			events.done = cb;
		},
		videoUrl: (r: string) => r,
		run: async () => undefined,
		ground: async () => undefined,
		stop: async (host: unknown) => {
			stops.push(host);

			return undefined;
		},
		attach: async () => undefined,
		saveKey: async () => ({ ok: true }),
		// No watch by default, so a flow that reaches signin stops there unless a test says more.
		signin: async () => ({ ok: true, message: "" }),
		signinWait: async () => ({ ok: true, message: "" }),
		cancelSignin: async () => ({ ok: true, message: "" }),
		onPortal(cb: Harness["events"]["portal"]) {
			events.portal = cb;
		},
		humanize: async () => undefined,
		humanizeStatus: async () => ({}),
		...busOverrides,
	};
	const document = {
		// Strict like the real DOM: an unknown id is null, so a handler wired to a deleted
		// element crashes HERE the way it crashes the real renderer at boot — that exact bug
		// shipped on 2026-07-31 (el('fleetrefresh') after the button was removed) and this
		// harness's lenient fake was what let 1200 tests miss a blank window.
		getElementById: (id: string) => nodes[id] ?? null,
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
		return { get sel(){return sel}, set sel(v){sel=v}, set apps(v){apps=v}, get host(){return host}, set host(v){host=v},
			get pinned(){return pinned}, set pinned(v){pinned=v},
			get running(){return running}, set offers(v){offers=v},
			check, syncUrlRow, selUrl, isBrowser, appendLine, line, errText, dropStaleSelection, selectApp, notePin,
			render, agoLabel, renderJobs, paneRunHost, stateFor, loadRuns, loadFleet, enterViewer, exitViewer, openJobLog };`,
	);
	const noTimer = () => 0;
	const api = fn({ __bus: bus, addEventListener() {} }, document, noTimer, noTimer) as Harness;
	api.nodes = nodes;
	api.events = events;
	api.stops = stops;
	// Convenience shim over events.started for the tests written against the single-run bus:
	// the page now keys everything by host, so an unstated one means the local machine.
	api.fireStarted = (d) => events.started?.({ host: "local", ...d });

	return api;
}

/** A keydown as the script's listener receives it, with `preventDefault` observable. */
function keydown(node: FakeEl, key: string, shiftKey: boolean): { prevented: boolean } {
	const out = { prevented: false };
	for (const fn of node.listeners.keydown ?? []) fn({ key, shiftKey, preventDefault: () => { out.prevented = true; } });

	return out;
}

/** Settle the microtask queue, so a lazy fetch's .then handlers have run. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

test("APP_JS__Parses__When__EmittedIntoThePage", () => {
	// The renderer is not typechecked, so this is the only thing standing between a stray
	// backtick and a blank window. One has already shipped: a backtick inside a comment
	// terminated the String.raw literal.
	assert.doesNotThrow(() => mount());
});

test("CHROME__DefinesOneSpinner__When__Rendered", () => {
	// One .spin class, used inline in buttons, in status lines and in list rows. A second
	// hand-rolled spinner elsewhere is how two of them end up spinning at different speeds.
	assert.match(CHROME, /\.spin \{/);
	assert.match(CHROME, /@keyframes spin/);
	// Decoration, so it must honour the OS setting rather than animate regardless.
	assert.match(CHROME, /prefers-reduced-motion/);
});

test("check__ClearsADispatchSpinner__When__TheDispatchEnds", () => {
	// The spinner is drawn by replacing the button's innerHTML, so something has to put the
	// label back. check() is where that happens, and it is the ONE exit every dispatch path
	// shares — success, refusal and throw all route through it — which is what guarantees a
	// spinner cannot outlive the call that started it.
	const h = mount();
	const go = h.nodes.go;
	go.textContent = "Run";
	// What dispatchOnce does on the way in.
	go.dataset.label = go.textContent;
	go.innerHTML = '<span class="spin"></span>Run';

	h.check();

	assert.equal(go.textContent, "Run", "the label is restored");
	assert.equal(go.dataset.label, undefined, "and the stash is cleared, so a later paint is not undone twice");
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

test("appendLine__CapsTheDom__When__ARunOutlivesTheScrollback", () => {
	// line() always trimmed its ARRAY to 400, but nothing trimmed the pane: a 40-minute
	// grounding pass grew the DOM without bound and every append got costlier for the run's
	// whole life. The cap must hold in the DOM too.
	const ui = mount();
	for (let i = 0; i < 450; i++) ui.appendLine(`[${i}] click "Save"`);
	assert.ok(ui.nodes.log.children.length <= 400, `log pane holds ${ui.nodes.log.children.length} nodes; the cap is 400`);
	// Oldest dropped, newest kept — a terminal, not a ring of arbitrary rows.
	assert.equal(ui.nodes.log.children[ui.nodes.log.children.length - 1]!.textContent, '[449] click "Save"');
});

test("appendLine__DropsTheLine__When__ItIsInterpreterDeprecationNoise", () => {
	// Pillow deprecates getdata() once per pixelDelta call — one line per STEP — and Node adds
	// its own (node:123) DeprecationWarning chatter. None of it is actionable from this window;
	// the job log on disk keeps the full stderr for toolchain debugging.
	const ui = mount();
	ui.appendLine('<string>:13: DeprecationWarning: Image.Image.getdata is deprecated and will be removed in Pillow 14 (2027-10-15). Use get_flattened_data instead.');
	ui.appendLine("(node:4242) ExperimentalWarning: The Fetch API is an experimental feature");
	ui.appendLine("npm warn config production Use `--omit=dev` instead.");
	ui.appendLine("(Use `node --trace-deprecation ...` to show where the warning was created)");
	assert.equal(ui.nodes.log.children.length, 0, "toolchain noise must not reach the pane");
	ui.appendLine('[3] click "Save"');
	assert.equal(ui.nodes.log.children.length, 1, "real agent output still paints");
});

test("appendLine__PaintsYellow__When__TheRunSurvivesTheTrouble", () => {
	// A failed step check, a retried model call, a revived driver session: the run is still
	// going, and red taught people to reach for Stop on runs that were recovering fine.
	const ui = mount();
	ui.appendLine("    -> ✗ expected 'Paris' in the observation — not found");
	ui.appendLine("    -> model call failed (2/5), retrying in 4s: 500 Internal Server Error");
	ui.appendLine("  driver session 'agent' expired (session_ended) — re-declaring and retrying");
	ui.appendLine("  WARNING: start state is whatever the previous run left behind — NOT comparable for A/B measurement.");
	ui.appendLine("    -> done(success) REFUTED by final observation: no evidence");
	for (const c of ui.nodes.log.children) assert.equal(c.className, "t-warn", `"${c.textContent}" must be a warning, got "${c.className}"`);
});

test("appendLine__PaintsRed__When__TheRunIsDead", () => {
	// Red is reserved for a verdict: the process died, the loop threw, or the run reported
	// failure. Everything else that mentions an error is survivable and yellow above.
	const ui = mount();
	ui.appendLine("■ exited with code 1 after 63s");
	ui.appendLine("agent failed: Error: 5 consecutive model-call failures; last: boom");
	ui.appendLine("=== DONE (failure) after 12 actions ===");
	ui.appendLine("✗ could not start the run: spawn npx ENOENT");
	ui.appendLine("[mac1] ✗ stop failed: no such job");
	for (const c of ui.nodes.log.children) assert.equal(c.className, "t-bad", `"${c.textContent}" must be an error, got "${c.className}"`);
});

test("appendLine__PaintsGreenOrDim__When__TheOutcomeIsGoodOrSummary", () => {
	const ui = mount();
	ui.appendLine("=== DONE (success (goal check passed, all steps verified)) after 9 actions ===");
	ui.appendLine("■ finished after 74s");
	assert.equal(ui.nodes.log.children[0]!.className, "t-ok");
	assert.equal(ui.nodes.log.children[1]!.className, "t-ok");
	// The verification summary restates failure counts; its color must stay dim, not inherit
	// red/yellow from the words inside it.
	ui.appendLine("verification: 8/9 steps verified (8 by text, 0 by geometry, 0 by pixels only); final goal check: PASSED ()");
	assert.equal(ui.nodes.log.children[2]!.className, "t-meta");
});

test("line__FilesUnderTheGivenOwner__When__OneIsPassedExplicitly", () => {
	// The app-list note reports about the SELECTION; before owner existed it was filed into
	// whatever app happened to be mid-run, splicing list chatter into that run's transcript.
	// Ownership is observable through painting: a line owned by an app that is not on screen
	// must be captured for that app's buffer, not drawn into the visible pane.
	const ui = mount();
	ui.sel = "Yarn";
	ui.line("· note about another app", "Notes");
	ui.line("▶ real output");
	const texts = ui.nodes.log.children.map((c) => c.textContent);
	assert.ok(!texts.includes("· note about another app"), "a line owned by another app must not paint into the visible pane");
	assert.ok(texts.includes("▶ real output"), "the selection's own line paints");
});

test("errText__NamesTheFailure__When__TheRejectionIsNotAnError", () => {
	// A main-process handler that throws a string (or nothing) must not render "✗ undefined"
	// in the log — that reads like a value the agent printed.
	const ui = mount();
	assert.equal(ui.errText(new Error("boom")), "boom");
	assert.equal(ui.errText("plain string"), "plain string");
	assert.equal(ui.errText(undefined), "unknown error");
});

test("dropStaleSelection__ClearsSel__When__TheSavedAppIsNotOnThisHost", () => {
	// ui-state.json can name an app deleted since last session, or the selector can point at a
	// different Mac. Run must not offer to dispatch at a target the host will not resolve.
	const ui = mount();
	ui.apps = [{ name: "Notes" }];
	ui.sel = "Yarn";
	ui.dropStaleSelection();
	assert.equal(ui.sel, null);
});

test("dropStaleSelection__KeepsSel__When__TheAppExistsOnTheHost", () => {
	const ui = mount();
	ui.apps = [{ name: "Yarn" }];
	ui.sel = "Yarn";
	ui.dropStaleSelection();
	assert.equal(ui.sel, "Yarn");
});

test("dropStaleSelection__KeepsSel__When__TheSelectionIsATypedUrl", () => {
	// A typed URL is a legitimate target that is never in the apps list.
	const ui = mount();
	ui.apps = [];
	ui.nodes.q.value = "https://www.notion.so";
	ui.sel = "www.notion.so";
	ui.dropStaleSelection();
	assert.equal(ui.sel, "www.notion.so");
});

test("selUrl__SurvivesTheSearchBoxChanging__When__AWebTargetWasSelected", () => {
	// The fresh web entry exists only in the list markup, so its URL used to be re-derived
	// from the search box on every dispatch. Editing the box then silently stripped the URL
	// from a selection still labelled "Run on www.notion.so" — and the host, handed no url,
	// spawned an agent against a Mac app named after the site.
	const ui = mount();
	ui.apps = [];
	ui.selectApp("www.notion.so", "https://www.notion.so/");
	ui.nodes.q.value = "something else entirely";
	assert.equal(ui.selUrl(), "https://www.notion.so/");
	// And the selection is not stale either: the stashed URL keeps it a valid target.
	ui.dropStaleSelection();
	assert.equal(ui.sel, "www.notion.so");
});

test("selectApp__UpdatesTheStashedUrl__When__TheSameEntryIsReclickedWithANewUrl", () => {
	// Retyping a URL and clicking the same host entry again is a re-target, not a no-op.
	const ui = mount();
	ui.apps = [];
	ui.selectApp("www.notion.so", "https://www.notion.so/");
	ui.selectApp("www.notion.so", "https://www.notion.so/product");
	assert.equal(ui.selUrl(), "https://www.notion.so/product");
});

test("notePin__ReleasesThePin__When__TheOperatorScrollsUp", () => {
	// Autoscroll used to be unconditional: scroll up to read step 6 and the next line yanks
	// the view back down, once a second, for the whole run.
	const ui = mount();
	const log = ui.nodes.log;
	log.clientHeight = 200;
	log.scrollHeight = 1000;
	log.scrollTop = 100; // far from the bottom
	ui.notePin();
	assert.equal(ui.pinned, false);
	// Appending while unpinned must not move the view.
	ui.appendLine("[7] click");
	assert.equal(log.scrollTop, 100);
});

test("notePin__ReArmsThePin__When__ScrolledBackNearTheBottom", () => {
	const ui = mount();
	const log = ui.nodes.log;
	log.clientHeight = 200;
	log.scrollHeight = 1000;
	log.scrollTop = 780; // within the one-line slack of the bottom
	ui.notePin();
	assert.equal(ui.pinned, true);
	// A pinned pane follows: the paint writes scrollTop to the (fake) full height.
	ui.appendLine("[8] click");
	assert.equal(log.scrollTop, log.scrollHeight);
});

test("CHROME__PutsRunAndGroundInTheLeftColumn__When__Rendered", () => {
	// The pair acts on the selection, so it lives under the list where the selection is made.
	// Placement is only checkable through source order: both must appear before the middle
	// column opens, and Stop must stay after it, beside the log of the run it interrupts.
	const mid = CHROME.indexOf('class="col mid"');
	assert.ok(mid > 0, "the middle column marker is gone");
	assert.ok(CHROME.indexOf('id="go"') < mid, "Run is not in the left column");
	assert.ok(CHROME.indexOf('id="ground"') < mid, "Ground is not in the left column");
	assert.ok(CHROME.indexOf('id="stop"') > mid, "Stop left the middle column");
});

test("TaskKeydown__DispatchesTheRun__When__PlainEnterAndRunIsEnabled", async () => {
	const calls: { app: string; task: string }[] = [];
	const ui = mount({
		run: async (opts: { app: string; task: string }) => {
			calls.push(opts);

			return undefined;
		},
	});
	// Let the boot chain (restore → loadApps) finish first: it repopulates `apps` from the
	// bus, and arranging state before it lands would be arranging state it overwrites.
	await settle();
	ui.apps = [{ name: "Yarn" }];
	ui.sel = "Yarn";
	ui.nodes.task.value = "show me how to change the cursor type";
	ui.check();
	const { prevented } = keydown(ui.nodes.task, "Enter", false);
	await settle();
	assert.equal(prevented, true, "plain Enter must not also insert a newline");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].app, "Yarn");
	assert.equal(calls[0].task, "show me how to change the cursor type");
});

test("TaskKeydown__InsertsTheNewline__When__ShiftIsHeld", async () => {
	const calls: unknown[] = [];
	const ui = mount({
		run: async (opts: unknown) => {
			calls.push(opts);

			return undefined;
		},
	});
	await settle();
	ui.apps = [{ name: "Yarn" }];
	ui.sel = "Yarn";
	ui.nodes.task.value = "first line";
	ui.check();
	const { prevented } = keydown(ui.nodes.task, "Enter", true);
	await settle();
	assert.equal(prevented, false, "Shift+Enter must keep its default newline");
	assert.equal(calls.length, 0);
});

test("TaskKeydown__DispatchesNothing__When__RunWouldBeDisabled", async () => {
	const calls: unknown[] = [];
	const ui = mount({
		run: async (opts: unknown) => {
			calls.push(opts);

			return undefined;
		},
	});
	await settle();
	// No selection: check() leaves the button disabled, so Enter must be inert.
	ui.nodes.task.value = "a task with no app selected";
	ui.check();
	keydown(ui.nodes.task, "Enter", false);
	await settle();
	assert.equal(calls.length, 0);
});

test("OnStarted__ClearsThePrompt__When__TheSubmittedTaskStarts", () => {
	const ui = mount();
	ui.apps = [{ name: "Yarn" }];
	ui.sel = "Yarn";
	ui.stateFor("Yarn").task = "show me how to change the cursor type";
	ui.nodes.task.value = "show me how to change the cursor type";
	ui.fireStarted({ app: "Yarn", task: "show me how to change the cursor type" });
	assert.equal(ui.nodes.task.value, "", "the accepted submit must consume the textarea");
	assert.equal(ui.stateFor("Yarn").task, "", "the saved task must not reappear on restore");
});

test("OnStarted__KeepsThePrompt__When__AGroundingPassEchoesItsSyntheticTask", () => {
	// Ground echoes 'started' with a task the operator never typed; it must not eat a prompt
	// that is typed but not yet run. Same for attach's "following <job>".
	const ui = mount();
	ui.apps = [{ name: "Yarn" }];
	ui.sel = "Yarn";
	ui.stateFor("Yarn").task = "a task typed but not yet run";
	ui.nodes.task.value = "a task typed but not yet run";
	ui.fireStarted({ app: "Yarn", task: "grounding pass — exploring Yarn" });
	assert.equal(ui.nodes.task.value, "a task typed but not yet run");
	assert.equal(ui.stateFor("Yarn").task, "a task typed but not yet run");
});

test("Go__KeepsThePrompt__When__TheDispatchAnswersAnError", async () => {
	// An error string comes back without a 'started' echo, so the box must keep its text —
	// the operator fixes the task, they do not retype it.
	const ui = mount({ run: async () => "a run is already in progress" });
	await settle();
	ui.apps = [{ name: "Yarn" }];
	ui.sel = "Yarn";
	ui.nodes.task.value = "show me how to change the cursor type";
	ui.check();
	await ui.nodes.go.onclick!();
	assert.equal(ui.nodes.task.value, "show me how to change the cursor type");
});

test("agoLabel__PicksTheReadableUnit__When__StampsAgeAcrossTheScale", () => {
	const ui = mount();
	assert.equal(ui.agoLabel(new Date().toISOString()), "just now");
	assert.equal(ui.agoLabel(new Date(Date.now() - 20 * 60_000).toISOString()), "20m ago");
	assert.equal(ui.agoLabel(new Date(Date.now() - 5 * 3_600_000).toISOString()), "5h ago");
	// Beyond a day the label is a calendar date ("Jul 28"-shaped), not a day count — one
	// implementation serves both the grounded badge and the gallery's recorded-at label.
	const old = new Date(Date.now() - 3 * 86_400_000);
	assert.equal(ui.agoLabel(old.toISOString()), old.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
	assert.equal(ui.agoLabel("not a date"), "", "an unparseable stamp must render as nothing");
});

test("render__ShowsHowOldTheGroundingIs__When__TheEntryCarriesAStamp", () => {
	const ui = mount();
	const stamp = new Date(Date.now() - 5 * 3_600_000).toISOString();
	ui.apps = [{ name: "Yarn", grounded: true, groundedAt: stamp }];
	ui.render();
	assert.match(ui.nodes.apps.innerHTML, /grounded 5h ago/);
	// The full date survives in the tooltip for when the day itself matters.
	assert.ok(ui.nodes.apps.innerHTML.includes(`title="grounded ${stamp}"`));
});

test("render__KeepsThePlainBadge__When__TheMapIsProseOnly", () => {
	// Prose-only maps predate capturedAt; a made-up age would be worse than none.
	const ui = mount();
	ui.apps = [{ name: "Yarn", grounded: true }];
	ui.render();
	assert.match(ui.nodes.apps.innerHTML, />grounded</);
	assert.ok(!ui.nodes.apps.innerHTML.includes("ago"));
	assert.ok(!ui.nodes.apps.innerHTML.includes("title="));
});

/**
 * One run per HOST. The events below arrive tagged {app, host}, and everything the tests
 * assert — which pane a line lands in, which host Run is gated on, which run Stop ends —
 * hangs off that ownership riding the wire instead of a single runningApp guess.
 */

test("onLine__FilesEachRunUnderItsOwnApp__When__TwoRunsAreLive", () => {
	// The exact failure the {app, host} payload exists to prevent: with bare-text lines the
	// page filed everything under one "running app", splicing two transcripts together.
	const ui = mount();
	ui.sel = "Yarn";
	ui.events.started!({ app: "Yarn", task: "t1", host: "mac1" });
	ui.events.started!({ app: "Notion Calendar", task: "t2", host: "local" });
	ui.events.line!({ text: "[1] yarn step", app: "Yarn", host: "mac1" });
	ui.events.line!({ text: "[1] notion step", app: "Notion Calendar", host: "local" });

	const painted = ui.nodes.log.children.map((c) => c.textContent);
	assert.ok(painted.includes("[1] yarn step"), "the selected run's line must paint");
	assert.ok(!painted.includes("[1] notion step"), "another run's line painted into the selected pane");
	// Not lost, either: it is waiting in its own app's buffer for when that pane is selected.
	assert.ok(ui.stateFor("Notion Calendar").log.includes("[1] notion step"));
});

test("onStarted__KeepsTheSharedBuffer__When__TheSameAppStartsOnASecondHost", () => {
	// Buffers key on the app name, so two same-app runs share one. The second start must not
	// wipe the first run's transcript mid-flight — clearing is only for a genuinely new pane.
	const ui = mount();
	ui.events.started!({ app: "Yarn", task: "t1", host: "mac1" });
	ui.events.line!({ text: "[1] first run step", app: "Yarn", host: "mac1" });
	ui.events.started!({ app: "Yarn", task: "t2", host: "mac2" });
	assert.ok(ui.stateFor("Yarn").log.some((l) => l.includes("[1] first run step")), "the live run's transcript was wiped");
});

test("onDone__OpensTheSigninFlowUnasked__When__ARemoteRunRefusesOnReadiness", async () => {
	// Exit 3 on a fleet Mac means "needs a human sign-in" — the person was just told so, and a
	// button that says the same thing again is a step with no decision in it. The flow must
	// fire itself, aimed at the refused run's app and host, not at whatever is selected.
	const calls: unknown[][] = [];
	const ui = mount({
		signin: async (...args: unknown[]) => {
			calls.push(args);

			return { ok: true, message: "Opened a sign-in window for Yarn on mac1" };
		},
	});
	await settle();
	ui.sel = "Notion Calendar";
	ui.events.done!({ code: 3, elapsed: 17, app: "Yarn", host: "mac1" });
	await settle();
	assert.deepEqual(calls, [["mac1", "Yarn"]]);
});

test("onDone__LeavesTheSigninFlowAlone__When__TheRefusalIsLocal", async () => {
	// Locally there is no window to open — the app is on this Mac and the panel's message is
	// the whole remedy.
	const calls: unknown[][] = [];
	const ui = mount({
		signin: async (...args: unknown[]) => {
			calls.push(args);

			return { ok: true, message: "" };
		},
	});
	await settle();
	ui.events.done!({ code: 3, elapsed: 17, app: "Yarn", host: "local" });
	await settle();
	assert.deepEqual(calls, []);
});

test("CHROME__PutsTheHostSelectorAtTheTopOfTheLeftColumn__When__Rendered", () => {
	// The host decides which Mac's apps are listed, so it sits above the search box that
	// filters them — burying it in the middle column made the list's origin a mystery.
	const mid = CHROME.indexOf('class="col mid"');
	const hostAt = CHROME.indexOf('id="host"');
	assert.ok(hostAt > 0 && hostAt < CHROME.indexOf('id="q"'), "the host selector must sit above the app search");
	assert.ok(hostAt < mid, "the host selector left the left column");
});

test("HumanCheckbox__TravelsWithRecording__When__EitherSideChanges", async () => {
	const opts: { record?: boolean; humanize?: boolean }[] = [];
	const ui = mount({
		run: async (o: { record?: boolean; humanize?: boolean }) => {
			opts.push(o);

			return undefined;
		},
	});
	await settle();
	// Ticking Human cursor drags recording on — a render OF the recording needs one.
	ui.nodes.human.checked = true;
	for (const fn of ui.nodes.human.listeners.change ?? []) fn({});
	assert.equal(ui.nodes.record.checked, true);
	// Unticking Record takes the render request with it.
	ui.nodes.record.checked = false;
	for (const fn of ui.nodes.record.listeners.change ?? []) fn({});
	assert.equal(ui.nodes.human.checked, false);
	// And the flag rides the dispatch.
	ui.apps = [{ name: "Yarn" }];
	ui.sel = "Yarn";
	ui.nodes.task.value = "show me how to change the cursor type";
	ui.nodes.record.checked = true;
	ui.nodes.human.checked = true;
	ui.check();
	void ui.nodes.go.onclick!();
	await settle();
	assert.equal(opts.length, 1);
	assert.equal(opts[0].record, true);
	assert.equal(opts[0].humanize, true);
});

test("onDone__ReadsAsAPause__When__TheRunNeedsASignin", () => {
	// Exit 3 is expected and recoverable — the sign-in window opens itself — and painting it
	// as an error taught people to read a routine first run on a Mac as something breaking.
	const ui = mount();
	ui.sel = "Yarn";
	ui.events.started!({ app: "Yarn", task: "t", host: "mac1" });
	ui.events.done!({ code: 3, elapsed: 17, app: "Yarn", host: "mac1" });
	const log = ui.stateFor("Yarn").log;
	assert.ok(log.some((l) => l.includes("paused — sign-in needed")), "exit 3 must read as a pause");
	assert.ok(!log.some((l) => l.includes("exited with code 3")), "exit 3 must not read as a failure");
});

test("onPortal__TogglesTheCancelControl__When__TheSigninViewOpensAndCloses", () => {
	// The embedded view covers the page below the header, so this header control is the one
	// way to back out — it must appear with the session and retire with it.
	const ui = mount();
	ui.events.portal!({ open: true, app: "Yarn", host: "mac1" });
	assert.equal(ui.nodes.cancelsignin.style.display, "inline-block");
	assert.match(ui.nodes.cancelsignin.textContent, /Yarn @ mac1/);
	ui.events.portal!({ open: false });
	assert.equal(ui.nodes.cancelsignin.style.display, "none");
});

test("check__SwapsRunForAnExplanation__When__TheSelectedHostIsBusy", () => {
	// Hidden, not disabled: a control that cannot be used until something else finishes is
	// noise — but a silent void where buttons were reads as breakage, so the hint fills it.
	const ui = mount();
	ui.apps = [{ name: "Yarn" }];
	ui.sel = "Yarn";
	ui.events.started!({ app: "Yarn", task: "t", host: "local" });
	assert.equal(ui.nodes.go.style.display, "none");
	assert.equal(ui.nodes.ground.style.display, "none");
	assert.equal(ui.nodes.busyhint.style.display, "block");
	assert.match(ui.nodes.busyhint.textContent, /This Mac is running Yarn/);

	ui.events.done!({ code: 0, elapsed: 5, app: "Yarn", host: "local" });
	assert.equal(ui.nodes.go.style.display, "");
	assert.equal(ui.nodes.busyhint.style.display, "none");
});

test("loadFleet__OffersOnlyUsableActions__When__RowsAndSelectionDiffer", async () => {
	// A button whose only possible outcome is a refusal teaches people to stop reading
	// outcomes: busy rows offer nothing, and the app-scoped pair needs an app to name.
	const rows = [
		{ name: "mac1", state: "idle", detail: "" },
		{ name: "mac2", state: "busy", detail: "aman · Yarn · 63s" },
	];
	const ui = mount({ loadFleet: async () => ({ rows, offers: [] }) });
	await settle();
	ui.sel = "Yarn";
	await ui.loadFleet();
	const html = ui.nodes.fleet.innerHTML;
	assert.ok(html.includes('data-fact="signout" data-mac="mac1"'), "an idle row with a selection offers sign-out");
	assert.ok(html.includes('data-fact="install" data-mac="mac1"'));
	assert.ok(!html.includes('data-mac="mac2"'), "a busy row offers no far-side actions");
	assert.equal(ui.nodes.fleetsum.textContent, "1 busy", "the folded panel's badge must count busy Macs");

	ui.sel = null;
	await ui.loadFleet();
	assert.ok(!ui.nodes.fleet.innerHTML.includes('data-fact="signout"'), "sign-out needs an app to name");
	assert.ok(ui.nodes.fleet.innerHTML.includes('data-fact="install"'), "install has no app dependency");
});

test("loadFleet__RendersTheQueueWithCancel__When__JobsAreWaiting", async () => {
	const rows = [
		{
			name: "mac1",
			state: "busy",
			detail: "david · Yarn · 63s",
			queue: [
				{ jobId: "j-2", detail: "sam · explore Yarn · waiting 3m 04s" },
				{ jobId: "j-3", detail: "eve · task Yarn · waiting" },
			],
		},
		{ name: "mac2", state: "busy", detail: "aman · Yarn · 10s" },
	];
	const ui = mount({ loadFleet: async () => ({ rows, offers: [] }) });
	await settle();
	await ui.loadFleet();
	const html = ui.nodes.fleet.innerHTML;
	assert.ok(html.includes("sam · explore Yarn · waiting 3m 04s"), "each waiting job renders its own row");
	assert.ok(html.includes('data-fact="cancelq" data-mac="mac1" data-job="j-2"'), "a queued row offers cancel");
	assert.ok(html.includes('data-job="j-3"'));
	// The fold badge counts both dimensions — a closed panel must still say work is stacked.
	assert.equal(ui.nodes.fleetsum.textContent, "2 busy · 2 queued");
});

test("loadRuns__OffersTheRender__When__TheSourceArtifactsExistLocally", async () => {
	// A render button on a card whose frames were never pulled is an error taught as a
	// feature — it exists only when the render could actually complete.
	let renderable = false;
	// RUN itself is renderable (the older render tests need it); strip that here so the
	// no-artifacts branch is actually exercised.
	const { renderable: _always, ...bare } = RUN as { renderable?: boolean } & typeof RUN;
	const ui = mount({ loadRuns: async () => [{ ...bare, ...(renderable ? { renderable: true } : {}) }] });
	await settle();
	await ui.loadRuns(true);
	assert.ok(!ui.nodes.runs.innerHTML.includes("Render cursor"), "no artifacts, no button");
	renderable = true;
	await ui.loadRuns(true);
	assert.ok(ui.nodes.runs.innerHTML.includes("Render cursor"));
});

test("renderJobs__ListsAndClearsTheRun__When__ItStartsAndEnds", () => {
	// The panel is the one place every in-flight thing is visible; it must appear with the
	// first job and vanish with the last, because an empty "Jobs" header is dead weight.
	const ui = mount();
	ui.events.started!({ app: "Yarn", task: "t", host: "mac1" });
	assert.equal(ui.nodes.jobswrap.style.display, "block");
	assert.match(ui.nodes.jobs.innerHTML, /Yarn @ mac1/);
	ui.events.done!({ code: 0, elapsed: 5, app: "Yarn", host: "mac1" });
	assert.equal(ui.nodes.jobswrap.style.display, "none");
});

test("renderJobs__ListsAnotherOperatorsRun__When__TheFleetProbeSeesOne", async () => {
	const rows = [{ name: "mac2", state: "busy", detail: "aman · Yarn · 12m 03s" }];
	const ui = mount({ loadFleet: async () => ({ rows, offers: [] }) });
	await settle();
	await ui.loadFleet();
	assert.equal(ui.nodes.jobswrap.style.display, "block");
	assert.match(ui.nodes.jobs.innerHTML, /mac2 — aman · Yarn/);
	// No ownership badge: the detail leads with the operator's name, which already says whose
	// run it is. "theirs" was dropped 2026-07-31 as redundant with it.
	assert.ok(!ui.nodes.jobs.innerHTML.includes("theirs"), "the redundant ownership badge stays gone");
});

test("renderJobs__ListsQueuedJobsUnderTheRunningOnes__When__AMacHasALine", async () => {
	// The jobs list is the at-a-glance answer to "what is scheduled where": each Mac's queue
	// renders in drain order under the running rows, visually distinct (dashed, ◌, "queued")
	// so a stacked fleet reads at a glance. Management (cancel) stays in the fleet panel.
	const rows = [
		{
			name: "mac1",
			state: "busy",
			detail: "david · Yarn · 2m 10s",
			queue: [
				{ jobId: "j-2", detail: "sam · explore Yarn · waiting 1m 04s" },
				{ jobId: "j-3", detail: "eve · task Yarn · waiting 12s" },
			],
		},
		{ name: "mac2", state: "busy", detail: "aman · Yarn · 9m 00s" },
	];
	const ui = mount({ loadFleet: async () => ({ rows, offers: [] }) });
	await settle();
	await ui.loadFleet();
	const html = ui.nodes.jobs.innerHTML;
	assert.match(html, /mac1 — sam · explore Yarn · waiting 1m 04s/);
	assert.match(html, /mac1 — eve · task Yarn · waiting 12s/);
	assert.ok(html.includes('class="job queued"'), "queued rows are visually distinct");
	assert.match(html, /queued/);
	// Order: every running row precedes every queued row, and drain order survives.
	assert.ok(html.indexOf("aman · Yarn") < html.indexOf("sam · explore Yarn"), "queued rows render under the running ones");
	assert.ok(html.indexOf("sam ·") < html.indexOf("eve ·"), "drain order preserved");
});

test("renderJobs__ListsTheRender__When__AHumanizeIsInFlight", async () => {
	const ui = mount({
		loadRuns: async () => [RUN],
		humanizeStatus: async () => ({ "2026-07-30T01-00-00-yarn": { state: "rendering" } }),
	});
	await settle();
	await ui.loadRuns(true);
	assert.match(ui.nodes.jobs.innerHTML, /rendering cursor — 2026-07-30T01-00-00-yarn/);
});

test("onLine__TagsLinesWithTheHost__When__TheSameAppRunsOnTwoHosts", () => {
	const ui = mount();
	ui.events.started!({ app: "Yarn", task: "t1", host: "mac1" });
	ui.events.line!({ text: "solo line", app: "Yarn", host: "mac1" });
	ui.events.started!({ app: "Yarn", task: "t2", host: "mac2" });
	ui.events.line!({ text: "shared line", app: "Yarn", host: "mac1" });
	// The finish line is tagged too — computed before the run leaves the map, or the last
	// message of a shared buffer would read as the only run the moment it ended.
	ui.events.done!({ code: 0, elapsed: 5, app: "Yarn", host: "mac1" });
	ui.events.line!({ text: "back to one", app: "Yarn", host: "mac2" });

	const log = ui.stateFor("Yarn").log;
	assert.ok(log.includes("solo line"), "a single run's lines must stay untagged");
	assert.ok(log.includes("[mac1] shared line"), "a shared buffer's lines must name their host");
	assert.ok(log.some((l) => l.startsWith("[mac1] ■ finished")), "the finish line must carry the tag");
	assert.ok(log.includes("back to one"), "the tag must retire once the buffer is single again");
});

test("paintStatus__ListsEveryLiveRun__When__TwoHostsAreBusy", () => {
	const ui = mount();
	ui.events.started!({ app: "Yarn", task: "t1", host: "mac1" });
	ui.events.started!({ app: "Notion Calendar", task: "t2", host: "local" });
	assert.equal(ui.nodes.status.textContent, "running: Yarn @ mac1, Notion Calendar @ local");

	// One finishing must not blank the other from the header — that run is still going.
	ui.events.done!({ code: 0, elapsed: 12, app: "Yarn", host: "mac1" });
	assert.equal(ui.nodes.status.textContent, "running: Notion Calendar @ local");
	ui.events.done!({ code: 0, elapsed: 30, app: "Notion Calendar", host: "local" });
	assert.equal(ui.nodes.status.textContent, "idle");
});

test("check__OffersTheQueue__When__ARemoteHostIsBusy", () => {
	// A busy REMOTE host takes the queue path (the runner stacks jobs), so Run stays
	// enabled and relabels; the hint says where the job goes, since the submit is detached
	// and no log pane opens here.
	const ui = mount();
	ui.apps = [{ name: "Notes" }];
	ui.sel = "Notes";
	ui.nodes.task.value = "show me how to make a checklist";
	ui.events.started!({ app: "Yarn", task: "t", host: "mac1" });

	ui.host = "mac1";
	ui.check();
	assert.equal(ui.nodes.go.disabled, false, "a busy remote host queues, it does not refuse");
	assert.equal(ui.nodes.go.textContent, "Queue on mac1");
	assert.equal(ui.nodes.ground.disabled, false);
	assert.equal(ui.nodes.ground.textContent, "Queue grounding on mac1");
	assert.match(ui.nodes.busyhint.textContent, /queue behind/);

	ui.host = "local";
	ui.check();
	assert.equal(ui.nodes.go.disabled, false, "a free host was blocked by a run elsewhere");
	assert.equal(ui.nodes.go.textContent, "Run on Notes");
	assert.equal(ui.nodes.ground.disabled, false);
});

test("check__StillHidesRun__When__ThisMacIsBusy", () => {
	// Local keeps the old posture: local runs never enter the runner registry, so there is
	// no queue to feed, and a second driver session would kill the first (LIMITATIONS §6).
	const ui = mount();
	ui.apps = [{ name: "Notes" }];
	ui.sel = "Notes";
	ui.nodes.task.value = "show me how to make a checklist";
	ui.events.started!({ app: "Yarn", task: "t", host: "local" });

	ui.host = "local";
	ui.check();
	assert.equal(ui.nodes.go.style.display, "none");
	assert.equal(ui.nodes.ground.style.display, "none");
	assert.match(ui.nodes.busyhint.textContent, /This Mac is running Yarn/);
});

test("stop__NamesTheHostOwningTheSelectedPane__When__TwoRunsAreLive", async () => {
	const ui = mount();
	ui.events.started!({ app: "Yarn", task: "t1", host: "mac1" });
	ui.events.started!({ app: "Notion Calendar", task: "t2", host: "local" });

	ui.sel = "Yarn";
	await ui.nodes.stop.onclick!();
	ui.sel = "Notion Calendar";
	await ui.nodes.stop.onclick!();

	assert.deepEqual(ui.stops, ["mac1", "local"], "Stop did not follow the selected pane's run");
});

test("check__ShowsStopOnlyForTheSelectedPane__When__ItsRunIsLive", () => {
	const ui = mount();
	ui.apps = [{ name: "Yarn" }, { name: "Notes" }];
	ui.events.started!({ app: "Yarn", task: "t", host: "mac1" });

	ui.sel = "Yarn";
	ui.check();
	assert.equal(ui.nodes.stop.style.display, "block");

	// An idle app's pane offers no Stop — the button always ends the run on screen, never a
	// hidden one.
	ui.sel = "Notes";
	ui.check();
	assert.equal(ui.nodes.stop.style.display, "none");
});

test("renderJobs__MakesFleetRowsClickable__When__TheyCarryAJobId", async () => {
	// The attach-offer dialog is gone: the jobs rows ARE the offers. A fleet row with a job id
	// opens that job's log on click; rows without one (older runner) stay inert.
	const rows = [
		{ name: "mac2", state: "busy", detail: "aman · Yarn · 2m", label: "aman · Yarn", jobId: "j-theirs" },
		{ name: "mac3", state: "busy", detail: "eve · Yarn · 1m" },
	];
	const ui = mount({ loadFleet: async () => ({ rows, offers: [] }) });
	await settle();
	await ui.loadFleet();
	const html = ui.nodes.jobs.innerHTML;
	assert.ok(html.includes('data-job="j-theirs"'), "a row with a job id is attachable");
	assert.ok(html.includes("mac3 — eve · Yarn"), "a row without one still renders");
});

test("onHost__RekeysTheRun__When__AutoResolvesToAMac", () => {
	// A run submitted to `auto` occupies the auto slot only until dispatch answers; from then
	// on the header, the busy check and Stop must all name the real machine.
	const ui = mount();
	ui.events.started!({ app: "Yarn", task: "t", host: "auto" });
	assert.deepEqual(ui.running, { auto: "Yarn" });

	ui.events.host!({ app: "Yarn", host: "mac2" });
	assert.deepEqual(ui.running, { mac2: "Yarn" });
	assert.equal(ui.nodes.status.textContent, "running: Yarn @ mac2");
	ui.sel = "Yarn";
	assert.equal(ui.paneRunHost(), "mac2");
});

// The gallery tests below drain a macrotask (the shared settle above) before driving
// loadRuns: the boot script fires its own loadRuns() as the module loads, and the runsBusy
// guard would otherwise silently swallow the test's call.

/** A recorded run as the host lists it, minus `humanized` — each test decides that part. */
const RUN = {
	id: "2026-07-30T01-00-00-yarn",
	renderable: true,
	app: "Yarn",
	task: "show me how to change the cursor type",
	success: true,
	actions: 3,
	verified: 3,
	elapsedSec: 40,
	grounding: "explore",
	video: "out/recording/2026-07-30T01-00-00-yarn/window.mp4",
};

test("loadRuns__OffersTheRenderButton__When__ARunHasNoHumanizedVideo", async () => {
	const ui = mount({ loadRuns: async () => [RUN] });
	await settle();
	await ui.loadRuns(true);
	assert.match(ui.nodes.runs.innerHTML, /Render cursor/);
});

test("loadRuns__DropsTheRenderButton__When__TheHumanizedRenderExists", async () => {
	// The button's absence is the card's "done" signal; the humanized file itself plays via
	// attach(), which the fake DOM cannot reach.
	const ui = mount({ loadRuns: async () => [{ ...RUN, humanized: "out/recording/2026-07-30T01-00-00-yarn/humanized.mp4" }] });
	await settle();
	await ui.loadRuns(true);
	assert.doesNotMatch(ui.nodes.runs.innerHTML, /Render cursor/);
});

test("loadRuns__ShowsRendering__When__TheHostReportsARenderInFlight", async () => {
	const ui = mount({
		loadRuns: async () => [RUN],
		humanizeStatus: async () => ({ [RUN.id]: { state: "rendering" } }),
	});
	await settle();
	await ui.loadRuns(true);
	assert.match(ui.nodes.runs.innerHTML, /rendering cursor/);
	// No button while it renders: a second click on the same stamp would only earn a refusal.
	assert.doesNotMatch(ui.nodes.runs.innerHTML, /data-render/);
});

test("loadRuns__ShowsTheFailureLine__When__TheRenderFailed", async () => {
	const ui = mount({
		loadRuns: async () => [RUN],
		humanizeStatus: async () => ({ [RUN.id]: { state: "failed", error: "no frames in out/recording/x/frames" } }),
	});
	await settle();
	await ui.loadRuns(true);
	assert.match(ui.nodes.runs.innerHTML, /no frames in out\/recording\/x\/frames/);
	assert.match(ui.nodes.runs.innerHTML, /Retry render/);
});

test("loadRuns__ShowsWhenTheRunHappened__When__StartedAtIsKnown", async () => {
	// Two hours plus a margin, so the floor cannot land back on "1h" while the test runs.
	const startedAt = new Date(Date.now() - (2 * 3600 + 120) * 1000).toISOString();
	const ui = mount({ loadRuns: async () => [{ ...RUN, startedAt }] });
	await settle();
	await ui.loadRuns(true);
	// The label rides in the meta row with the full local datetime as its tooltip.
	assert.match(ui.nodes.runs.innerHTML, /<span title="[^"]+">2h ago<\/span>/);
});

test("loadRuns__OmitsTheTimeLabel__When__StartedAtIsUnknown", async () => {
	// No label beats "Invalid Date" in every card whose log predates the field.
	const ui = mount({ loadRuns: async () => [{ ...RUN, startedAt: "" }] });
	await settle();
	await ui.loadRuns(true);
	assert.doesNotMatch(ui.nodes.runs.innerHTML, /ago|Invalid/);
});

test("loadRuns__RepaintsTheCard__When__TheHumanizedRenderAppears", async () => {
	// The regression this pins: the redraw signature was ids-only, so a render finishing
	// between polls changed no id and the finished file never appeared until a forced refresh.
	let humanized: string | undefined;
	const ui = mount({ loadRuns: async () => [{ ...RUN, ...(humanized ? { humanized } : {}) }] });
	await settle();
	await ui.loadRuns(true);
	assert.match(ui.nodes.runs.innerHTML, /Render cursor/);
	humanized = "out/recording/2026-07-30T01-00-00-yarn/humanized.mp4";
	await ui.loadRuns(false); // the 4s tick, unforced — the signature alone must trigger the repaint
	assert.doesNotMatch(ui.nodes.runs.innerHTML, /Render cursor/);
});

test("appendLine__StillCapsTheDom__When__NoAnimationFrameEverFires", () => {
	// Electron throttles rAF to zero for hidden windows — during exactly the workload the cap
	// exists for. The synchronous overflow trim has to hold the line without any paint.
	const ui = mount();
	// Simulate "rAF never fires": queue a paint that is never delivered by giving the harness
	// a requestAnimationFrame that swallows its callback.
	(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0;
	try {
		for (let i = 0; i < 1200; i++) ui.appendLine(`[${i}] click`);
		assert.ok(
			ui.nodes.log.children.length <= 801,
			`hidden-window pane grew to ${ui.nodes.log.children.length} nodes; the overflow trim is 2× the 400 cap`,
		);
	} finally {
		delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
	}
});

test("enterViewer__HidesTheTaskForm__When__ALogIsOpened", () => {
	const ui = mount();
	ui.enterViewer("j-1 @ mac2", "Yarn");
	assert.equal(ui.nodes.taskform.style.display, "none");
	assert.equal(ui.nodes.viewerbar.style.display, "flex");
	assert.equal(ui.nodes.viewertitle.textContent, "j-1 @ mac2");

	ui.exitViewer();
	assert.equal(ui.nodes.taskform.style.display, "");
	assert.equal(ui.nodes.viewerbar.style.display, "none");
});

test("line__PaintsOnlyTheViewedOwner__When__ViewerModeIsOpen", () => {
	// The pane belongs to the opened job; the selection's own lines buffer silently and are
	// back on screen the moment the viewer closes.
	const ui = mount();
	ui.apps = [{ name: "Notes" }];
	ui.sel = "Notes";
	ui.enterViewer("j-1 @ mac2", "Yarn");
	ui.line("from the viewed job", "Yarn");
	ui.line("from the selection", "Notes");
	const painted = ui.nodes.log.children.map((c) => c.textContent);
	assert.ok(painted.includes("from the viewed job"));
	assert.ok(!painted.includes("from the selection"), "selection lines must not bleed into the viewer");
	assert.ok(ui.stateFor("Notes").log.includes("from the selection"), "buffered, not dropped");
});

test("openJobLog__AttachesUnderTheViewer__When__AJobRowIsClicked", async () => {
	const attached: unknown[][] = [];
	const ui = mount({ attach: async (host: string, jobId: string, app?: string) => { attached.push([host, jobId, app]); return undefined; } });
	await ui.openJobLog("mac2", "j-9", "Yarn");
	assert.deepEqual(attached, [["mac2", "j-9", "Yarn"]]);
	assert.equal(ui.nodes.viewertitle.textContent, "j-9 @ mac2");
	assert.equal(ui.nodes.taskform.style.display, "none");
});
