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
	appendChild(c: FakeEl) {
		this.children.push(c);
	},
	removeChild(c: FakeEl) {
		const i = this.children.indexOf(c);
		if (i >= 0) this.children.splice(i, 1);
	},
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
	appendLine(text: string): void;
	line(text: string, owner?: string | null): void;
	errText(e: unknown): string;
	dropStaleSelection(): void;
	selectApp(name: string, url?: string): void;
	notePin(): void;
	render(): void;
	agoLabel(iso: string): string;
	stateFor(app: string): { task: string; log: string[]; url?: string };
	pinned: boolean;
	host: string;
	/** Fire the host's `started` echo, as captured off bus.onStarted at mount. */
	fireStarted(d: { app: string; task: string }): void;
}

/**
 * Instantiate the renderer.
 *
 * The trailing `</script>` is stripped because APP_JS is emitted INTO a script tag — it is
 * markup, not code, and `new Function` rightly refuses it.
 *
 * `busOverrides` swaps individual bus methods so a test can stub the host side — a `run`
 * that records its options, an `appIcon` that rejects — without re-declaring the whole bus.
 */
function mount(busOverrides: Record<string, unknown> = {}): Harness {
	const nodes: Record<string, FakeEl> = {};
	for (const id of IDS) nodes[id] = el();
	let started: (d: { app: string; task: string }) => void = () => {};
	const bus = {
		loadApps: async () => [],
		appIcon: async () => "",
		loadRuns: async () => [],
		loadState: async () => ({ byApp: {} }),
		saveState() {},
		loadHosts: async () => ({ hosts: ["local"] }),
		loadFleet: async () => ({ rows: [], offers: [] }),
		loadCreds: async () => ({ present: false, path: "", modelKey: false }),
		loadHostPref: async () => ({ host: "local" }),
		saveHostPref() {},
		onStarted(cb: (d: { app: string; task: string }) => void) {
			started = cb;
		},
		onLine() {},
		onDone() {},
		videoUrl: (r: string) => r,
		run: async () => undefined,
		ground: async () => undefined,
		stop() {},
		attach: async () => undefined,
		saveKey: async () => ({ ok: true }),
		...busOverrides,
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
		return { get sel(){return sel}, set sel(v){sel=v}, set apps(v){apps=v}, get host(){return host}, set host(v){host=v},
			get pinned(){return pinned}, set pinned(v){pinned=v},
			check, syncUrlRow, selUrl, isBrowser, appendLine, line, errText, dropStaleSelection, selectApp, notePin,
			render, agoLabel, stateFor };`,
	);
	const noTimer = () => 0;
	const api = fn({ __bus: bus, addEventListener() {} }, document, noTimer, noTimer) as Harness;
	api.nodes = nodes;
	api.fireStarted = (d) => started(d);

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
	assert.equal(ui.agoLabel(new Date(Date.now() - 3 * 86_400_000).toISOString()), "3d ago");
	assert.equal(ui.agoLabel("not a date"), "", "an unparseable stamp must render as nothing");
});

test("render__ShowsHowOldTheGroundingIs__When__TheEntryCarriesAStamp", () => {
	const ui = mount();
	const stamp = new Date(Date.now() - 3 * 86_400_000).toISOString();
	ui.apps = [{ name: "Yarn", grounded: true, groundedAt: stamp }];
	ui.render();
	assert.match(ui.nodes.apps.innerHTML, /grounded 3d ago/);
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

test("render__RequestsIconsLazily__When__LocalAppsPaint", async () => {
	const asked: string[] = [];
	const ui = mount({
		appIcon: async (name: string) => {
			asked.push(name);

			return "data:image/png;base64,AAA";
		},
	});
	await settle();
	ui.apps = [{ name: "Yarn" }, { name: "www.notion.so", kind: "web", url: "https://www.notion.so" }];
	ui.render();
	await settle();
	// Web entries have no bundle to ask about; the local app is asked exactly once even
	// though the resolved icon triggers a repaint (which re-enters requestIcons).
	assert.deepEqual(asked, ["Yarn"]);
	assert.ok(ui.nodes.apps.innerHTML.includes('img class="appicon"'), "the resolved icon did not paint");
});

test("render__SkipsIcons__When__TheListIsAnotherMacs", async () => {
	const asked: string[] = [];
	const ui = mount({
		appIcon: async (name: string) => {
			asked.push(name);

			return "";
		},
	});
	await settle();
	ui.host = "mac1";
	ui.apps = [{ name: "Yarn" }];
	ui.render();
	await settle();
	assert.deepEqual(asked, [], "a remote list must not be asked about this Mac's bundles");
	assert.ok(!ui.nodes.apps.innerHTML.includes("appicon"));
});

test("render__SurvivesTheLookup__When__TheIconIpcRejects", async () => {
	// A missing icon must never break the list — the name still paints, nothing rejects
	// unhandled, and the failure caches so the next repaint does not re-ask.
	let asks = 0;
	const ui = mount({
		appIcon: async () => {
			asks++;
			throw new Error("no icon for you");
		},
	});
	await settle();
	ui.apps = [{ name: "Yarn" }];
	assert.doesNotThrow(() => ui.render());
	await settle();
	assert.match(ui.nodes.apps.innerHTML, /Yarn/);
	ui.render();
	await settle();
	assert.equal(asks, 1, "a failed lookup must cache as 'none', not retry per paint");
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
