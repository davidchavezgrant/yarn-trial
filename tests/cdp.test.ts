import assert from "node:assert/strict";
import test from "node:test";
import { CDP_ACT_TOOL, CDP_RULES, cdpActTool, cdpRules, demoClickPlan, originMatches, parseAiSnapshot, playwrightKey, webPageChoice } from "../src/backends/cdp.js";

// A real ai-mode snapshot shape, taken from the live probe that preceded this backend
// (headless Chrome 139, playwright-core 1.62): roles, quoted names, [ref]/[box]/flag
// brackets, option children carrying [selected], and a textbox with a trailing value.
const SNAPSHOT = `- generic [active] [ref=e1] [box=8,8,725,3042]:
  - heading "Probe page" [level=1] [ref=e2] [box=8,8,740,37]
  - combobox [ref=e2b] [box=8,9,91,19]:
    - option "Original" [selected] [box=0,0,0,0]
    - option "Pointer-first" [box=0,0,0,0]
  - textbox "Your name" [ref=e3] [box=103,8,153,21]: Paris
  - button "Save changes" [ref=e4] [box=260,8,34,21]
  - generic [ref=e5] [box=8,29,725,3000]: tall
  - button "Deep button" [ref=e6] [box=8,3029,89,21] [disabled]
  - text: Loose page text
`;

test("parseAiSnapshot__ExtractsRefRoleNameBox__When__RowsCarryAll", () => {
	const { rows } = parseAiSnapshot(SNAPSHOT);
	const save = rows.find((r) => r.name === "Save changes")!;
	assert.equal(save.ref, "e4");
	assert.equal(save.role, "button");
	assert.deepEqual({ x: save.x, y: save.y, w: save.w, h: save.h }, { x: 260, y: 8, w: 34, h: 21 });
	assert.equal(save.interactive, true);
});

test("parseAiSnapshot__CarriesTheTextboxValue__When__ItTrailsTheRow", () => {
	// The value is what the mutation journal diffs — without it detectMutation is blind here.
	const { rows } = parseAiSnapshot(SNAPSHOT);
	assert.equal(rows.find((r) => r.name === "Your name")?.value, "Paris");
});

test("parseAiSnapshot__LiftsTheSelectedOption__When__AComboboxRendersItsChildren", () => {
	// A closed <select> has no value of its own in the snapshot; its [selected] child IS
	// the value. Losing this reintroduces the exact blindness controlReads() exists for.
	const { rows } = parseAiSnapshot(SNAPSHOT);
	assert.equal(rows.find((r) => r.role === "combobox")?.value, "Original");
});

test("parseAiSnapshot__LiftsOptionValueOntoItsOwnCombobox__When__ASelectedTabExistsElsewhere", () => {
	// Every active TAB carries [selected] too; only an option under a combobox/listbox
	// ANCESTOR is that control's value. A tab lifted onto a header combobox makes
	// switching tabs read as a combobox mutation the teardown then tries to "restore".
	const page = `- generic [ref=e1]:
  - combobox "Font" [ref=e2] [box=0,0,50,20]:
    - option "Inter" [selected] [box=0,0,0,0]
    - option "Mono" [box=0,0,0,0]
  - tablist [ref=e5] [box=0,30,200,20]:
    - tab "Advanced" [selected] [ref=e6] [box=0,30,60,20]
`;
	const { rows } = parseAiSnapshot(page);
	assert.equal(rows.find((r) => r.role === "combobox")?.value, "Inter");
});

test("parseAiSnapshot__LeavesTheComboboxValueEmpty__When__TheSelectedRowIsNotItsDescendant", () => {
	// The old lift attributed the name to the nearest PRECEDING combobox in document
	// order: a valueless combobox in a page header adopted the active tab below it, and
	// a selected option in a sibling container adopted the same way.
	const page = `- generic [ref=e1]:
  - combobox "Jump to" [ref=e2] [box=0,0,50,20]
  - tablist [ref=e3]:
    - tab "General" [selected] [ref=e4] [box=0,30,60,20]
  - group [ref=e5]:
    - option "Red" [selected] [ref=e6] [box=0,60,10,10]
`;
	const { rows } = parseAiSnapshot(page);
	assert.equal(rows.find((r) => r.role === "combobox")?.value, "");
});

test("parseAiSnapshot__IgnoresBrackets__When__TheyAppearInsideAValue", () => {
	// Bracket groups are only meaningful before the ": value" separator; a value that
	// happens to contain "[disabled]" must not scan as a flag (or [box=…] as geometry).
	const { rows } = parseAiSnapshot(`- textbox "Notes" [ref=e5] [box=1,2,30,40]: draft [disabled] [box=9,9,9,9] tail\n`);
	const notes = rows.find((r) => r.name === "Notes")!;
	assert.equal(notes.value, "draft [disabled] [box=9,9,9,9] tail");
	assert.equal(notes.flags.has("disabled"), false);
	assert.equal(notes.interactive, true);
	assert.deepEqual({ x: notes.x, y: notes.y, w: notes.w, h: notes.h }, { x: 1, y: 2, w: 30, h: 40 });
});

test("parseAiSnapshot__MarksDisabledControlsNotInteractive__When__TheFlagIsPresent", () => {
	const { rows } = parseAiSnapshot(SNAPSHOT);
	assert.equal(rows.find((r) => r.name === "Deep button")?.interactive, false);
});

test("parseAiSnapshot__CollectsLooseText__When__TextNodesAppear", () => {
	const { texts } = parseAiSnapshot(SNAPSHOT);
	assert.ok(texts.includes("Loose page text"));
});

test("parseAiSnapshot__NamesTheSurface__When__AnAncestorIsNamed", () => {
	const nested = `- generic [ref=e1]:
  - dialog "Settings" [ref=e2]:
    - button "Close" [ref=e3] [box=1,2,3,4]
`;
	const { rows } = parseAiSnapshot(nested);
	// The journal matches controls across observations by (name, surface) — element
	// handles renumber every snapshot, so the surface is load-bearing, not cosmetic.
	assert.equal(rows.find((r) => r.name === "Close")?.surface, "Settings");
});

test("parseAiSnapshot__UnescapesQuotedNames__When__TheNameContainsQuotes", () => {
	const { rows } = parseAiSnapshot(`- button "Say \\"hi\\"" [ref=e1] [box=0,0,1,1]\n`);
	assert.equal(rows[0].name, 'Say "hi"');
});

test("parseAiSnapshot__TreatsCursorPointerAsInteractive__When__TheRoleIsGeneric", () => {
	// ai-mode marks clickably-styled elements; an onclick div is reachable through this
	// and nothing else — the CDP equivalent of "does not advertise AXPress but works".
	const { rows } = parseAiSnapshot(`- generic "Card" [ref=e9] [cursor=pointer] [box=0,0,10,10]\n`);
	assert.equal(rows[0].interactive, true);
});

test("originMatches__RefusesAPrefixSibling__When__TheHostMerelyStartsWithTheOrigin", () => {
	// startsWith adopted https://x.community for https://x.com. The same comparison was in the
	// dom backend's pickTab; that backend is deleted, this is where the rule lives now.
	assert.equal(originMatches("https://x.community/feed", "https://x.com"), false);
	assert.equal(originMatches("https://x.com/settings?tab=1", "https://x.com"), true);
});

test("originMatches__TreatsTheUrlAsNonMatching__When__ItHasNoHttpOrigin", () => {
	assert.equal(originMatches("about:blank", "https://x.com"), false);
	assert.equal(originMatches("", "https://x.com"), false);
	assert.equal(originMatches("devtools://devtools/bundled/x.html", "https://x.com"), false);
});

test("playwrightKey__MapsModelVocabulary__When__TheModelSpeaksAXNames", () => {
	// The model's key vocabulary is shared across backends (escape/return + cmd/option);
	// this is the one place it meets playwright's DOM key values.
	assert.equal(playwrightKey("escape"), "Escape");
	assert.equal(playwrightKey("return"), "Enter");
	assert.equal(playwrightKey("a", ["cmd"]), "Meta+a");
	assert.equal(playwrightKey("z", ["cmd", "shift"]), "Meta+Shift+z");
	assert.equal(playwrightKey("down", ["option"]), "Alt+ArrowDown");
});

test("CDP_ACT_TOOL__OmitsDeliveryMode__When__TheBackendHasNoUseForIt", () => {
	// delivery_mode is a cua concept; presenting a dead knob invites the model to reason
	// about it. Its absence is part of the backend's contract, so pin it.
	const props = (CDP_ACT_TOOL.input_schema as any).properties.action.properties;
	assert.equal(props.delivery_mode, undefined);
	assert.ok(props.ref);
	assert.ok(props.query);
});

test("CDP_RULES__StateTheKeyBoundary__When__TheModelReadsThem", () => {
	// The single most important behavioural difference from the other backends: keys
	// reach the renderer only. A model told otherwise will "press cmd+," forever.
	assert.match(CDP_RULES, /PAGE RENDERER/);
	assert.match(CDP_RULES, /file pickers/);
});

test("demoClickPlan__PointsAtTheBoxCentre__When__PlanningAClick", () => {
	// Centre is exact by construction on this backend: box and screenshot share the
	// renderer's CSS-pixel space, so there is no capture-scale offset to compensate.
	const plan = demoClickPlan({ x: 100, y: 40, width: 60, height: 20 }, "click");
	assert.deepEqual(plan.point, { x: 130, y: 50 });
	assert.equal(plan.button, "left");
	assert.equal(plan.clickCount, 1);
});

test("demoClickPlan__DwellsWithinTheHoverWindow__When__AnyVerbIsPlanned", () => {
	// 150–250ms per the plan: long enough for a :hover transition to render into polled
	// frames, short enough not to read as hesitation on film.
	const plan = demoClickPlan({ x: 0, y: 0, width: 10, height: 10 }, "click");
	assert.ok(plan.dwellMs >= 150 && plan.dwellMs <= 250, `dwell ${plan.dwellMs}ms outside 150–250`);
});

test("demoClickPlan__UsesTheRightButton__When__TheVerbIsRightClick", () => {
	assert.equal(demoClickPlan({ x: 0, y: 0, width: 4, height: 4 }, "right_click").button, "right");
});

test("demoClickPlan__DoublesTheClickCount__When__TheVerbIsDoubleClick", () => {
	// mouse.click with clickCount 2 performs two down/up cycles with escalating
	// clickCount — the same composition playwright's own dblclick uses.
	assert.equal(demoClickPlan({ x: 0, y: 0, width: 4, height: 4 }, "double_click").clickCount, 2);
});

test("cdpRules__SwapTheTypingContract__When__DemoModeIsOn", () => {
	// A model told "replaces" while the backend types at the caret produces the exact
	// pre-filled-field trap ("New YorkParis") fill() was chosen to kill.
	assert.match(cdpRules(false), /type_text REPLACES/);
	assert.doesNotMatch(cdpRules(true), /type_text REPLACES/);
	assert.match(cdpRules(true), /caret/);
	assert.match(cdpRules(true), /cmd\+a/);
	// The invariant lines survive both modes.
	assert.match(cdpRules(true), /PAGE RENDERER/);
	assert.match(cdpRules(true), /file pickers/);
});

test("cdpActTool__MatchesTheTypingContract__When__DemoModeIsOn", () => {
	// The schema is read by the model too; it must never contradict the rules.
	const text = (demo: boolean) => (cdpActTool(demo).input_schema as any).properties.action.properties.text.description;
	assert.match(text(false), /Replaces/);
	assert.match(text(true), /caret/);
	assert.doesNotMatch(text(true), /Replaces/);
});

// ---- webPageChoice: which tab a web run drives, and whether the run OWNS it ----------------
// Ownership is what teardown needs: a bench run's created tab left open on Wikipedia was what
// an operator's sign-in viewer opened onto (2026-07-31). Adopted tabs are the operator's (or
// browser-login's seed) and must survive the run; a tab the run created — or a blank one it
// colonized, whose entire content is run residue — is the run's to close.

test("webPageChoice__AdoptsTheTargetTab__When__OneMatchesTheOrigin", () => {
	assert.deepEqual(
		webPageChoice(["chrome://newtab/", "https://en.wikipedia.org/wiki/Ada_Lovelace"], "https://en.wikipedia.org"),
		{ index: 1, owned: false },
	);
});

test("webPageChoice__Refuses__When__TwoTabsMatchTheOrigin", () => {
	assert.throws(
		() => webPageChoice(["https://en.wikipedia.org/wiki/A", "https://en.wikipedia.org/wiki/B"], "https://en.wikipedia.org"),
		/2 tabs are open/,
	);
});

test("webPageChoice__ColonizesABlankTabAsOwned__When__NoneMatchTheOrigin", () => {
	assert.deepEqual(
		webPageChoice(["https://example.com/", "about:blank"], "https://en.wikipedia.org"),
		{ index: 1, owned: true },
	);
});

test("webPageChoice__CreatesAPageAsOwned__When__NothingSuitableExists", () => {
	// -1 = no usable tab: the caller newPage()s, and that page is the run's to close.
	assert.deepEqual(webPageChoice(["https://example.com/"], "https://en.wikipedia.org"), { index: -1, owned: true });
});
